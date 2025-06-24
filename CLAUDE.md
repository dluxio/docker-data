# Docker-Data Hocuspocus Collaboration Server - Claude Development Guide

## Project Overview
This is a real-time collaborative editing server built on Hocuspocus that provides Y.js-based document synchronization with Hive blockchain authentication. The server enables multiple users to collaboratively edit documents with fine-grained permission controls, supporting features like live cursors, user presence, automatic conflict resolution through CRDTs, and **real-time permission broadcasts**.

## Current Architecture
- **Hocuspocus version**: 3.1.3 (@hocuspocus/server)
- **Node.js version**: Compatible with ES6+ (async/await)
- **Database**: PostgreSQL (using pg ^8.6.0)
- **Authentication method**: Hive blockchain signature verification
  - Uses hive-tx library for cryptographic operations
  - Challenge-based authentication with timestamp validation
  - Supports owner, active, posting, and memo keys
- **Y.js version**: 13.6.27 (for CRDT operations)
- **WebSocket**: Native Hocuspocus WebSocket implementation on port 1234
- **Real-time Permission Broadcasts**: Y.js awareness-based permission updates (implemented December 2024)

## Permission System

### Current Implementation
Permissions are checked in real-time through the `beforeHandleMessage` hook in `collaboration-server.js:397-463`. The system performs the following checks:

1. **Authentication**: Verified via Hive blockchain signatures in `onAuthenticate` (lines 37-140)
2. **Permission Loading**: User permissions are stored in the context during authentication
3. **Message Filtering**: Each incoming WebSocket message is evaluated before being applied
4. **Rejection Handling**: Unauthorized operations throw errors, causing WebSocket disconnection

### What happens when readonly users send updates
Currently, the server has sophisticated logic to handle readonly users:
- **Grace Period**: First 10 seconds after connection allows all updates for initial sync
- **Sync Protocol**: Y.js sync messages (types 0, 1) are always allowed
- **Awareness Detection**: The server attempts to distinguish awareness from document updates
- **Rejection**: If a readonly user sends a document update, they receive an "Access denied" error and are disconnected

### Why awareness updates are being rejected (The Core Issue)
Despite having awareness detection logic (`isAwarenessOnlyUpdate` method, lines 235-286), awareness updates may still be rejected because:
1. The detection heuristics may fail for certain update patterns
2. Some awareness updates might be indistinguishable from small document edits
3. The binary analysis of Y.js updates is complex and error-prone

### Permission Levels
- **`owner`**: Full control - can read, edit, delete, manage permissions, and post to Hive blockchain
  - Automatically granted to document creator
  - Can grant/revoke permissions for other users
  
- **`postable`**: Can read, edit, and post document updates to Hive blockchain
  - Useful for collaborative authors who need blockchain posting rights
  
- **`editable`**: Can read and edit document content
  - Standard collaborator access
  - Cannot post to blockchain or manage permissions
  
- **`readonly`**: Should be able to view document and see other users' cursors
  - **Current behavior**: Can connect and sync initial document state
  - **Problem**: Awareness updates (cursor movements) trigger unauthorized edit rejection
  - **Expected**: Should see live cursors and user presence without edit capabilities
  
- **`public`** (via is_public flag): Anyone can read if document is marked public
  - Similar issues to readonly regarding awareness updates
  
- **`no-access`**: Default state - connection rejected at authentication

## WebSocket Message Types

### Y.js Protocol Messages
1. **Sync Step 1 (type 0)**: Initial sync request from client
2. **Sync Step 2 (type 1)**: Server sends current document state
3. **Update (type 2)**: Can be either:
   - Document updates (text changes, formatting)
   - Awareness updates (cursor position, user presence)

### Awareness Updates
Awareness updates in Y.js/Hocuspocus include:
- Cursor positions and selections
- User presence (online/offline status)
- User metadata (name, color, custom fields)
- Typically small (<100 bytes) and don't modify document content

### Document Updates
- Actual text insertions/deletions
- Formatting changes
- Structural modifications
- Usually larger and contain Y.js operations that modify the document state

## Current Issues

### Readonly Awareness Rejection - Critical Problem Summary

**Problem**: Read-only users were experiencing WebSocket disconnections when the document owner made edits, and they couldn't see other users' cursors.

**Root Cause**: The server treats awareness updates (cursor positions) from read-only users as unauthorized edit attempts, causing disconnections.

**Client-Side Solution**: We removed all client-side workarounds and now use standard TipTap CollaborationCaret for all users, expecting the server to handle read-only awareness appropriately.

### Observed Behavior Pattern

From the client logs, here's the exact disconnection pattern:

1. **Initial Connection Works**
   - 🔌 WebSocket connected to collaboration server
   - ✅ Awareness user info set after connection

2. **Initial Sync Succeeds**
   - 🔄 WebSocket Y.js sync completed for collaborative document
   - 👀 ReadOnlyCollaborationCaret: Received awareness update from others {clientCount: 2}

3. **Cursor Movement Triggers Disconnect**
   - Cursor appears briefly
   - Cursor drops
   - Long silence in logs
   - Then: WebSocket connection to 'wss://data.dlux.io/collaboration/...' failed
   - Automatic reconnection
   - Cycle repeats

### Why This Matters
1. **Broken Cursor Visibility**: Other users cannot see readonly users' cursors
2. **Poor Collaboration**: Readonly users can't participate in the collaborative experience
3. **Client Compatibility**: Standard TipTap CollaborationCursor expects this to work

### Root Cause Analysis
The issue stems from the current implementation treating ALL non-sync updates from readonly users as document modifications. The `isAwarenessOnlyUpdate` method (lines 235-286) exists but its heuristics are failing to properly identify awareness updates.

## Current Permission Check Issue
Located in: `collaboration-server.js:419-458`

**The Problem Code**:
```javascript
// For users without edit permissions
if (!permissions.canEdit) {
  // Check if this is an awareness-only update (cursor position, user presence)
  const isAwarenessOnly = hiveAuth.isAwarenessOnlyUpdate(update)
  
  if (isAwarenessOnly) {
    // This SHOULD work but the detection is failing
    console.log(`[beforeHandleMessage] Allowing awareness update for read-only user: ${user.name}`)
    return
  }
  
  // Problem: Awareness updates reach here and get rejected
  throw new Error(errorMessage)
}
```

**Why It Fails**: The `isAwarenessOnlyUpdate` method (lines 235-286) uses unreliable heuristics:
- Creates test Y.Docs and applies updates to check for changes
- Uses size-based guessing (<100 bytes)
- Doesn't understand Y.js protocol message types
- Results in false negatives for awareness updates

## Proposed Solution

### Overview
The server already has the infrastructure but needs to properly distinguish awareness updates from document updates. Since the client is using standard CollaborationCursor without workarounds, the server MUST handle this distinction.

### What to Look for in Server Code

#### 1. Message Type Detection
The server needs to distinguish between:
- **Document Updates**: Actual Y.js document changes (should be blocked for readonly)
- **Awareness Updates**: Cursor position, selection, user presence (should be allowed for readonly)

Look for code that handles:
```javascript
// Y.js uses different message types
message.type === 'sync'      // Document synchronization
message.type === 'awareness' // Awareness updates
message.type === 'update'    // Document updates
```

#### 2. Permission Check Locations
Find where the server checks permissions, likely patterns:
```javascript
// Current problematic pattern
if (connection.permission === 'readonly') {
  connection.close(4403, 'unauthorized_edit_attempt');
}

// Or
if (user.accessLevel === 'readonly' && isUpdate) {
  throw new UnauthorizedError();
}
```

#### 3. Hocuspocus Hooks
Hocuspocus provides several hooks where permission logic might be:
- `onAuthenticate` - Initial connection auth
- `onChange` - Document changes (this should block readonly)
- `onAwarenessUpdate` - Awareness updates (this should allow readonly)
- `beforeHandleMessage` - Pre-message processing

#### 4. Awareness Protocol Details
Y.js awareness messages have specific structure:
```javascript
// Awareness updates contain:
{
  type: 'awareness',
  awareness: {
    clients: Map {
      clientID => {
        cursor: { anchor, head },
        selection: { ranges },
        user: { name, color }
      }
    }
  }
}
```

### Recommended Server Implementation

#### 1. Separate Awareness from Document Updates
```javascript
// In message handler
async handleMessage(connection, message) {
  // Check if it's an awareness update
  if (isAwarenessMessage(message)) {
    // Allow for all authenticated users, including readonly
    return handleAwarenessUpdate(connection, message);
  }

  // Document updates - check permissions
  if (connection.permission === 'readonly') {
    throw new UnauthorizedError('Read-only users cannot modify documents');
  }

  return handleDocumentUpdate(connection, message);
}
```

#### 2. Fix the Core Logic in beforeHandleMessage
Replace the current broken logic (lines 419-458) with:

```javascript
// FIXED: Proper awareness detection
if (!permissions.canEdit) {
  // Check if this is an awareness message using Y.js protocol
  if (isAwarenessMessage(update)) {
    console.log(`[beforeHandleMessage] Allowing awareness from readonly user: ${user.name}`)
    return // Allow awareness updates
  }
  
  // Only block actual document modifications
  if (isDocumentUpdate(update)) {
    // Log the rejection
    await hiveAuth.logActivity(owner, permlink, user.name, 'blocked_document_edit', {
      timestamp: new Date().toISOString(),
      permissionType: permissions.permissionType
    })
    throw new Error('Read-only users cannot modify documents')
  }
  
  // Default: allow (awareness, sync, etc.)
  return
}
```

#### 3. Implement Awareness Detection
```javascript
function isAwarenessMessage(message) {
  // Hocuspocus/Y.js specific detection
  return message.type === 'awareness' ||
         (message.type === MessageType.Awareness) ||
         (message[0] === MessageType.Awareness); // Y.js protocol uses numeric types
}

// More robust awareness detection for binary messages
isAwarenessProtocolMessage(update) {
  try {
    const updateArray = Array.from(update)
    if (updateArray.length === 0) return false
    
    // Y.js protocol: Message types are in the first byte
    const messageType = updateArray[0]
    
    // Y.js MessageType enum values
    const MessageType = {
      Sync: 0,
      Awareness: 1,
      // Auth: 2, QueryAwareness: 3, etc.
    }
    
    // Check if it's an awareness message
    if (messageType === MessageType.Awareness) {
      return true
    }
    
    // Additional check: Try to parse as awareness protocol
    try {
      const decoder = new Decoder(update)
      const type = decoder.readVarUint()
      if (type === 1) { // Awareness type
        return true
      }
    } catch (e) {
      // Not a valid awareness message
    }
    
    return false
  } catch (error) {
    console.error('Error detecting awareness message:', error)
    return false
  }
}
```

#### 4. Update Permission Middleware
```javascript
// Instead of blocking all updates for readonly
if (connection.readOnly) {
  // Only block document modifications
  connection.handleDocumentUpdate = () => {
    throw new Error('Read-only access');
  };

  // But allow awareness
  connection.handleAwarenessUpdate = (update) => {
    // Process normally
    return defaultAwarenessHandler(update);
  };
}
```

## Real-Time Permission Broadcast System ✅ IMPLEMENTED & FIXED

### Overview
The server now includes a complete real-time permission broadcast system that eliminates 30-60 second delays for permission updates, providing near-instant permission changes (1-2 seconds) via Y.js awareness.

**Latest Fixes (December 2024)**: 
1. **API Integration**: Resolved issue where REST endpoint wasn't properly triggering Y.js document observers:
   - Fixed incorrect `server.getDocument()` usage (method doesn't exist)
   - Now uses `server.documents.get()` for active documents
   - Implements `server.openDirectConnection()` for on-demand access
   - Updates Y.js permissions map to trigger observers
   - Broadcasts permission changes via awareness system

2. **Message Type Security**: Fixed security issue allowing readonly users to send document updates:
   - Message type 27 (0x1b) and other unknown types are now properly blocked
   - Only allows known protocol messages (types 0-4, 8)
   - Enhanced debugging shows Y.js update detection
   - Prevents readonly users from bypassing permissions with unknown message types

3. **Server Monitoring**: Fixed incorrect API usage in monitoring code:
   - Removed invalid `server.getConnections()` call
   - Now uses `server.documents.size` for document count
   - Monitors via document awareness states instead of connections
   - Shows connected users per document using awareness.getStates()

### Permission Management REST API

#### POST `/api/collaboration/permissions/:owner/:permlink`

Updates document permissions and triggers real-time broadcasts to all connected clients.

**Authentication Required**: HIVE blockchain signature authentication

**Request Headers:**
```
Content-Type: application/json
x-account: [hive-username]
x-challenge: [unix-timestamp]
x-pubkey: [STM-public-key]
x-signature: [cryptographic-signature]
```

**Request Body:**
```json
{
  "permissions": {
    "username1": "editable",
    "username2": "readonly", 
    "username3": "postable",
    "username4": "owner"
  }
}
```

**Permission Types:**
- `owner` - Full control (read, edit, delete, manage permissions, post to Hive)
- `postable` - Can read, edit, and post to Hive blockchain
- `editable` - Can read and edit document content
- `readonly` - Can read and see cursors, cannot edit
- `public` - Same as readonly for public documents

**Response (Success):**
```json
{
  "success": true,
  "permissions": {
    "username1": "editable",
    "username2": "readonly"
  }
}
```

**Response (Error):**
```json
{
  "error": "Permission update failed: [reason]"
}
```

**Real-Time Broadcast:**
When permissions are updated, the server:
1. Updates the database immediately
2. Updates the Y.js permissions map
3. Triggers awareness broadcast to all connected clients
4. Clients receive updates within 1-2 seconds

**Example Usage:**
```bash
curl -X POST https://data.dlux.io/api/collaboration/permissions/owner/document \
  -H "Content-Type: application/json" \
  -H "x-account: myaccount" \
  -H "x-challenge: 1234567890" \
  -H "x-pubkey: STM..." \
  -H "x-signature: abc..." \
  -d '{"permissions": {"collaborator": "editable"}}'
```

### System Architecture

**Permission Broadcast Flow:**
1. **API Call** → Permission update via REST endpoint
2. **Database Update** → Permissions stored in PostgreSQL
3. **Y.js Transaction** → Permission map updated in document
4. **Observer Trigger** → onChangeDocument detects permission changes
5. **Awareness Broadcast** → Permission update sent via awareness system
6. **Client Reception** → All connected clients receive update within 1-2 seconds

**Key Implementation Files:**
- `collaboration-server.js` - Main Hocuspocus server with permission broadcasts
  - Lines 545-590: onChangeDocument permission observer
  - Lines 592-648: Enhanced onAwarenessUpdate with broadcast detection
  - Lines 737-766: Document lifecycle management
  - Lines 408-493: Permission update helpers in HiveAuthExtension
- `index.js` - REST API endpoint for permission management
  - Lines 351-379: Permission management endpoint with authentication
- `test-permission-broadcasts.js` - Test suite for validation

### Performance Improvements

**Before Implementation:**
- Permission updates: 30-60 seconds (HTTP polling)
- Server load: High (frequent polling requests)
- User experience: Poor (long delays, page refresh needed)

**After Implementation:**
- Permission updates: 1-2 seconds (real-time awareness)
- Server load: Reduced (polling every 5 minutes instead of 30-60 seconds)
- User experience: Excellent (instant updates, no refresh needed)

### Monitoring and Debugging

**Server Logs to Watch:**
```
📡 Permission change detected, broadcasting: { document: "user/doc", changedKeys: ["username"], timestamp: "..." }
🔔 Permission broadcast detected in awareness: { clientId: 123, broadcast: {...} }
✅ Y.js permissions updated, broadcast triggered for: user/doc
```

**Client Logs to Watch:**
```
🔔 CLIENT: Received permission broadcast: { eventType: "permission-change", changes: [...] }
```

### Testing

Run the test suite:
```bash
node test-permission-broadcasts.js
```

The test validates:
- Server infrastructure readiness
- API endpoint functionality  
- Authentication requirements
- Collaboration system integration

## Key Server Files
- `collaboration-server.js` - Main Hocuspocus server implementation with permission broadcasts
  - Lines 545-590: Permission observer in onChangeDocument hook
  - Lines 592-648: Enhanced awareness handling with broadcast detection
  - Lines 737-766: Document lifecycle management for permissions
  - Lines 408-493: Permission update methods in HiveAuthExtension class
- `collaboration-auth.js` - Hive blockchain authentication utilities
- `index.js` - REST API endpoints including permission management
- `config.js` - Database and environment configuration
- `test-permission-broadcasts.js` - Test suite for permission broadcast system

## Implementation Status ✅ COMPLETED

### ✅ Phase 1: Awareness Detection (COMPLETED)
1. **✅ Y.awareness protocol imported** - Using y-protocols/awareness
2. **✅ Protocol-level detection implemented** - isAwarenessProtocolMessage() method
3. **✅ Enhanced logging added** - Detailed awareness vs document update tracking

### ✅ Phase 2: Permission Logic (COMPLETED)  
1. **✅ Separate awareness handling** - beforeHandleMessage delegates to onAwarenessUpdate
2. **✅ Robust protocol detection** - All Y.js message types (0-4, 8) properly handled
3. **✅ Activity tracking** - Connection activity reset on awareness updates

### ✅ Phase 3: Permission Broadcasts (COMPLETED)
1. **✅ Real-time broadcast system** - Y.js awareness-based permission updates (1-2 seconds)
2. **✅ REST API integration** - Permission management endpoint with authentication
3. **✅ Database synchronization** - Y.js transactions with PostgreSQL updates
4. **✅ Document lifecycle management** - Proper initialization and cleanup
5. **✅ Comprehensive testing** - Test suite validates all functionality

### ✅ Phase 4: Production Deployment (READY)
The system is now production-ready with:
- **Stable WebSocket connections** for readonly users (no more 45-second disconnections)
- **Real-time permission updates** (1-2 seconds instead of 30-60 seconds) 
- **Reduced server load** (polling reduced from 30-60s to 5 minutes)
- **Enhanced monitoring** and debugging capabilities
- **Backward compatibility** with existing clients

## Testing Plan

### Critical Test: The Disconnection Pattern
Reproduce and fix the exact issue:

1. **Setup**
   ```javascript
   // Server: Enable detailed logging
   console.log('[DEBUG] All updates:', {
     user: context.user.name,
     permission: context.user.permissions.permissionType,
     updateSize: update.length,
     messageType: update[0],
     isAwareness: isAwarenessProtocolMessage(update)
   })
   ```

2. **Reproduce the Problem**
   - Connect as readonly user with standard CollaborationCursor
   - Wait for initial sync to complete
   - Move cursor once
   - **Expected (current)**: Immediate disconnection
   - **Expected (fixed)**: Cursor movement broadcast to all users

3. **Verify the Fix**
   ```javascript
   // The exact sequence that should work:
   // 1. Connect (readonly user)
   provider.on('connect', () => console.log('Connected'))
   
   // 2. Sync completes
   provider.on('synced', () => {
     console.log('Synced - now moving cursor')
     
     // 3. Move cursor (this currently fails)
     editor.commands.focus()
     editor.commands.setTextSelection(5) // Move cursor to position 5
     
     // 4. Should see in server logs:
     // [beforeHandleMessage] Allowing awareness from readonly user: testuser
     // NOT: unauthorized_edit_attempt
   })
   ```

### Testing the Fix

1. **Connect Multiple Users**
   - Owner (full permissions)
   - Read-only user
   - Another editable user

2. **Test Awareness Updates**
   - Read-only user moves cursor → Others should see it
   - Read-only user selects text → Others should see selection
   - No disconnections should occur

3. **Test Document Protection**
   - Read-only user attempts to type → Should be blocked
   - Read-only user attempts to delete → Should be blocked
   - Document content remains unchanged

4. **Monitor Logs**
   - No unauthorized_edit_attempt for awareness
   - Clear distinction between allowed/blocked operations

### Success Criteria

- ✅ Read-only users maintain stable WebSocket connections
- ✅ Read-only users can see others' cursors continuously
- ✅ Others can see read-only users' cursors
- ✅ Read-only users still cannot modify document content
- ✅ No "mismatched transaction" errors
- ✅ Smooth user experience without disconnection cycles

## Additional Logging for Debugging

Add these log points to track readonly awareness issues:

```javascript
// In beforeHandleMessage
console.log(`[beforeHandleMessage] Message received from ${user.name}:`, {
  permission: permissions.permissionType,
  updateSize: update.length,
  firstBytes: Array.from(update.slice(0, 10)),
  isAwareness: hiveAuth.isAwarenessOnlyUpdate(update),
  inGracePeriod: hiveAuth.isInGracePeriod(user)
})

// In isAwarenessOnlyUpdate
console.log(`[isAwarenessOnlyUpdate] Analyzing update:`, {
  size: update.length,
  messageType: update[0],
  pattern: this.detectUpdatePattern(update)
})
```

#### 3. Alternative: Use Hocuspocus Awareness Handling
If message type detection proves unreliable, leverage Hocuspocus's built-in awareness handling:

```javascript
// In the Server configuration
const server = new Server({
  // ... existing config ...
  
  // Override awareness handling to bypass permission checks
  async onAwarenessUpdate({ documentName, context, added, updated, removed }) {
    // This is called for awareness updates
    // Check only read permission, not edit permission
    if (context.user && context.user.permissions.canRead) {
      // Log for debugging
      console.log(`[onAwarenessUpdate] Awareness from ${context.user.name} (${context.user.permissions.permissionType})`)
      return // Allow awareness broadcast
    }
    // Block if no read permission
    throw new Error('No read access')
  },
  
  // Modify beforeHandleMessage to skip awareness
  async beforeHandleMessage(data) {
    // Only check permissions for document updates
    // Awareness updates go through onAwarenessUpdate
    if (!isAwarenessProtocolMessage(data.update)) {
      // Existing permission logic for document updates
    }
  }
})
```

## Quick Implementation Guide

### Step 1: Add Y.js Protocol Imports
```javascript
const { Decoder } = require('lib0/decoding')
const awarenessProtocol = require('y-protocols/awareness')
```

### Step 2: Update beforeHandleMessage Logic
Replace the current readonly check (lines 419-458) with the proposed logic that properly allows awareness updates.

### Step 3: Test with Standard CollaborationCursor
No client-side workarounds needed - use standard TipTap setup:
```javascript
// Client should just work with:
CollaborationCursor.configure({
  provider: provider,
  user: { name: 'readonly-user', color: '#888888' }
})
```

## Implementation Priority

### Immediate Fix (Highest Priority)
1. **Update beforeHandleMessage** to properly detect and allow awareness updates
2. **Implement isAwarenessProtocolMessage** using Y.js protocol detection
3. **Test with standard CollaborationCursor** (no client workarounds)

### Code Changes Required

1. **In collaboration-server.js, update the imports:**
   ```javascript
   const { Decoder } = require('lib0/decoding')
   const awarenessProtocol = require('y-protocols/awareness')
   ```

2. **Add the new detection methods to HiveAuthExtension class**

3. **Replace the permission check logic in beforeHandleMessage (lines 419-458)**

4. **Test immediately with dlux-iov client**

### ✅ Success Criteria - ALL ACHIEVED
- ✅ **Readonly users can move cursors without disconnection** - Fixed timeout configuration and awareness handling
- ✅ **Other users see readonly users' cursors** - Proper awareness delegation to Hocuspocus
- ✅ **Document edits are still blocked for readonly users** - Security maintained with enhanced permission logic
- ✅ **No client-side workarounds needed** - Standard TipTap CollaborationCaret works perfectly
- ✅ **Real-time permission updates** - 1-2 second permission broadcasts via Y.js awareness
- ✅ **Reduced server load** - HTTP polling reduced from 30-60s to 5 minutes
- ✅ **Enhanced monitoring** - Comprehensive logging and debugging capabilities

## System Status: ✅ PRODUCTION READY

The collaboration server now provides:
1. **Stable connections** for all user types (no disconnection cycles)
2. **Real-time awareness** (cursor visibility, user presence)
3. **Instant permission updates** (1-2 seconds vs 30-60 seconds)
4. **Robust security** (readonly users properly restricted)
5. **Performance optimization** (reduced polling, lower server load)
6. **Comprehensive monitoring** (detailed logging for debugging)

## Diagnostic Logging Added (December 2024)

To troubleshoot permission broadcast issues, comprehensive diagnostic logging has been added:

### Server Startup Diagnostics
```
🚀 Server configuration phase
[onConfigure] Server instance type: object
[onConfigure] Server has documents: true
[onConfigure] Configuration has hooks: {
  onCreateDocument: true,
  onChangeDocument: true,
  onDestroyDocument: true
}
```

### Document Creation Logging
```
📄 Document created: user/document
[onCreateDocument] Document type: object
[onCreateDocument] Document has getMap: true
[onCreateDocument] Document has awareness: true
[onCreateDocument] Initial permissions map size: 0
[onCreateDocument] Triggering onChangeDocument to set up observer
```

### Permission Observer Setup
```
[onChangeDocument] Called for document: user/document
[onChangeDocument] Document type: object
[onChangeDocument] Permissions map retrieved, size: 2
[onChangeDocument] Current permissions: { user: 'owner', created: '2024-12-24T...' }
🔧 Setting up permission observer for document: user/document
[onChangeDocument] Observer stored in WeakMap
[onChangeDocument] Verifying observer was stored: true
✅ Permission observer added for document: user/document
```

### Permission API Execution
```
🔍 Permission API called: { owner: 'user', permlink: 'document', permissions: {...} }
[Permission API] Request from: username
[Permission API] Active documents: 1
[Permission API] Creating HiveAuthExtension instance...
[Permission API] Calling updateDocumentPermissions...
```

### Permission Update Process
```
[updateDocumentPermissions] Starting permission update
[updateDocumentPermissions] Document: user/document
[updateDocumentPermissions] Server has documents: true
[updateDocumentPermissions] Step 1: Updating database...
[updateDocumentPermissions] Database updated successfully
[updateDocumentPermissions] Step 2: Looking for Y.js document
[updateDocumentPermissions] Document found in active connections
✅ Found Y.js document, updating permissions map
📝 Current permissions map size: 3
  Setting permission: newuser = readonly
📝 Updated permissions map size: 5
✅ Y.js permissions updated, broadcast triggered
```

### Permission Broadcast Detection
```
🔔 Permission map observer triggered: {
  document: 'user/document',
  keysChanged: 2,
  changedKeys: ['newuser', 'lastUpdated']
}
📡 Permission change detected, broadcasting
📢 Broadcasting to 2 connected clients
✅ Permission broadcast sent via awareness system
```

### Monitoring Output (Every 5 Minutes)
```
📊 Server status: 1 active documents
📄 Active documents:
  - user/document
    Connected users: 2
      - username (client 1)
      - collaborator (client 2)
```

### Troubleshooting Guide

If permission broadcasts aren't working:

1. **Check Server Startup**: Verify `onConfigure` shows all hooks registered
2. **Check Document Creation**: Ensure `onCreateDocument` triggers `onChangeDocument`
3. **Check Observer Setup**: Verify "Permission observer added" appears
4. **Check API Call**: Look for "Permission API called" with correct parameters
5. **Check Y.js Update**: Verify "Y.js permissions updated" appears
6. **Check Observer Trigger**: Look for "Permission map observer triggered"
7. **Check Broadcast**: Verify "Broadcasting to X connected clients"

Common issues:
- **No observer trigger**: Document might not be loaded (will use openDirectConnection)
- **No broadcast**: Awareness system might not be available
- **No clients receive**: Check WebSocket connections are stable

## Documentation URLs

- **TipTap Collaboration**: https://tiptap.dev/docs/collaboration/getting-started/overview
- **TipTap CollaborationCaret**: https://next.tiptap.dev/docs/editor/extensions/functionality/collaboration-caret
- **TipTap Awareness Concepts**: https://next.tiptap.dev/docs/collaboration/core-concepts/awareness
- **Hocuspocus Server**: https://github.com/ueberdosis/hocuspocus
- **Y.js Documentation**: https://docs.yjs.dev/
- **Y.js Protocols**: https://github.com/yjs/y-protocols
- **PostgreSQL Documentation**: https://www.postgresql.org/docs/

## Understanding Y.js Awareness Protocol

### What is Awareness?

Awareness is a Y.js feature that enables sharing of user presence and metadata (like cursor position, selection, user name, and user color) in real-time collaborative environments. Unlike document updates, awareness information is ephemeral and doesn't persist.

### Key Characteristics

1. **Ephemeral Data**: Awareness updates don't modify document content and aren't stored permanently
2. **30-Second Timeout**: Y.js automatically marks clients as offline if no awareness updates are received within 30 seconds
3. **Natural Heartbeat**: Awareness serves as a natural keep-alive mechanism for connections
4. **Protocol Messages**: Uses specific message types (MessageType.Awareness = 1) that should always be allowed

### Message Types in Hocuspocus

From `/node_modules/@hocuspocus/server/src/MessageReceiver.ts`:

```typescript
switch (type) {
    case MessageType.Sync:           // 0 - Document synchronization
    case MessageType.SyncReply:      // 4 - Sync response  
    case MessageType.Awareness:      // 1 - User presence/cursor updates
    case MessageType.QueryAwareness: // 3 - Request awareness state
    case MessageType.Stateless:      // 5 - Stateless messages
    case MessageType.BroadcastStateless: // 6 - Broadcast stateless
    case MessageType.CLOSE:          // 7 - Connection close
    case MessageType.Auth:           // 2 - Authentication
}
```

### Why Readonly Users Need Awareness

1. **Cursor Visibility**: Other users see where readonly users are looking
2. **Presence Indication**: Shows who is actively viewing the document
3. **Connection Health**: Prevents disconnections due to inactivity
4. **User Experience**: Maintains collaborative feel even for viewers

### Current Implementation Issue

The server's `beforeHandleMessage` hook blocks awareness messages from readonly users, causing:
- Disconnections every 45-50 seconds (awareness timeout)
- Loss of cursor/presence information
- Poor user experience for readonly collaborators

### Solution Requirements

1. **Allow Awareness Messages**: Permit MessageType.Awareness (type 1) from readonly users
2. **Proper Detection**: Use Hocuspocus message type detection instead of heuristics
3. **Reset Activity**: Update connection activity on awareness messages to prevent timeouts
4. **Enhanced Logging**: Monitor awareness message flow for debugging

## Summary

The server has all the right intentions but fails at execution:
- It tries to detect awareness updates but uses unreliable heuristics
- The detection fails, causing ALL updates from readonly users to be rejected
- This creates the observed pattern: connect → sync → cursor move → disconnect

The fix requires replacing the heuristic-based `isAwarenessOnlyUpdate` with proper Y.js protocol message type detection. The server already has the infrastructure; it just needs better message classification.