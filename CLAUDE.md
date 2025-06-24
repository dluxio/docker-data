# Docker-Data Hocuspocus Collaboration Server - Claude Development Guide

## Project Overview
This is a real-time collaborative editing server built on Hocuspocus that provides Y.js-based document synchronization with Hive blockchain authentication. The server enables multiple users to collaboratively edit documents with fine-grained permission controls, supporting features like live cursors, user presence, and automatic conflict resolution through CRDTs (Conflict-free Replicated Data Types).

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

## Key Server Files
- `collaboration-server.js` - Main Hocuspocus server implementation
  - Lines 1-822: Complete server setup
  - Lines 21-360: HiveAuthExtension class with permission logic
  - Lines 397-463: beforeHandleMessage hook (permission enforcement)
  - Lines 235-286: isAwarenessOnlyUpdate method (awareness detection)
- `collaboration-auth.js` - Hive blockchain authentication utilities
- `api/collaboration.js` - REST API endpoints for document management
- `config.js` - Database and environment configuration
- `collaboration-example.html` - Client-side reference implementation

## Implementation Plan

### Phase 1: Improve Awareness Detection
1. **Import Y.awareness protocol** (if not already available)
   ```javascript
   const awarenessProtocol = require('y-protocols/awareness')
   ```

2. **Update isAwarenessOnlyUpdate** to use protocol-level detection

3. **Add detailed logging** for debugging awareness vs document updates

### Phase 2: Refine Permission Logic
1. **Separate handling** for awareness and document updates in beforeHandleMessage

2. **Implement fallback** for edge cases where detection fails

3. **Add metrics** to track successful awareness updates from readonly users

### Phase 3: Testing and Validation
1. **Create test scenarios** for various update types

2. **Verify backwards compatibility** with existing clients

3. **Load test** with multiple readonly users

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

### Success Criteria
- Readonly users can move cursors without disconnection
- Other users see readonly users' cursors
- Document edits are still blocked for readonly users
- No client-side workarounds needed

## Key Server Files to Check

Based on the Hocuspocus structure in this codebase:
1. **collaboration-server.js** - Main server with all hooks
   - `onAuthenticate` (lines 37-140) - Where permissions are set
   - `beforeHandleMessage` (lines 397-463) - Where the bug is
   - `isAwarenessOnlyUpdate` (lines 235-286) - Failing detection
2. **collaboration-auth.js** - Authentication utilities
3. **HiveAuthExtension class** - Contains the permission logic

## Summary

The server has all the right intentions but fails at execution:
- It tries to detect awareness updates but uses unreliable heuristics
- The detection fails, causing ALL updates from readonly users to be rejected
- This creates the observed pattern: connect → sync → cursor move → disconnect

The fix requires replacing the heuristic-based `isAwarenessOnlyUpdate` with proper Y.js protocol message type detection. The server already has the infrastructure; it just needs better message classification.