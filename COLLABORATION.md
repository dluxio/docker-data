# Hive Collaboration API Documentation

## Overview

The Hive Collaboration API provides real-time collaborative editing capabilities using Y.js CRDT (Conflict-free Replicated Data Type) technology with custom WebSocket integration and [Tiptap](https://github.com/ueberdosis/tiptap) support. Documents are authenticated using Hive blockchain keypairs and stored in PostgreSQL.

## Base URL

```
https://data.dlux.io/api/collaboration
```

## Authentication

All API endpoints (except public info endpoints) require Hive blockchain authentication using the following headers:

- `x-account`: Hive username
- `x-challenge`: Unix timestamp (must be within 24 hours for API, 1 hour for WebSocket)
- `x-pubkey`: Your Hive public key (posting key recommended)
- `x-signature`: Signature of the challenge using your private key

## Document Format

Documents are identified by the format: `owner-hive-account/permlink`

Example: `alice/my-document-2024`



### 3. List Documents

```http
GET /api/collaboration/documents
```

**Query Parameters:**
- `limit` (optional): Number of documents to return (default: 50, max: 100)
- `offset` (optional): Pagination offset (default: 0)
- `type` (optional): Filter by access type
  - `all`: All accessible documents (default)
  - `owned`: Documents owned by the user
  - `shared`: Documents shared with the user

**Response:**
```json
{
  "success": true,
  "documents": [
    {
      "owner": "alice",
      "permlink": "my-document-2024",
      "documentPath": "alice/my-document-2024",
      "isPublic": false,
      "hasContent": true,
      "contentSize": 1024,
      "accessType": "owner",
      "createdAt": "2024-01-01T12:00:00Z",
      "updatedAt": "2024-01-01T15:30:00Z"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

### 4. Create Document

```http
POST /collaboration/documents
```

**Request Body:**
```json
{
  "permlink": "my-new-document",
  "isPublic": false,
  "title": "My New Document",
  "description": "A collaborative document"
}
```

**Response:**
```json
{
  "success": true,
  "document": {
    "owner": "alice",
    "permlink": "my-new-document",
    "documentPath": "alice/my-new-document",
    "isPublic": false,
    "websocketUrl": "/collaboration/alice/my-new-document",
    "authHeaders": {
      "x-account": "alice",
      "x-challenge": "timestamp",
      "x-pubkey": "key",
      "x-signature": "signature"
    },
    "createdAt": "2024-01-01T12:00:00Z"
  }
}
```

### 5. Delete Document

```http
DELETE /collaboration/documents/{owner}/{permlink}
```

**Note:** Only document owners can delete documents.

**Response:**
```json
{
  "success": true,
  "message": "Document deleted successfully"
}
```

### 6. Get Document Permissions

```http
GET /collaboration/permissions/{owner}/{permlink}
```

**Response:**
```json
{
  "success": true,
  "document": "alice/my-document",
  "permissions": [
    {
      "account": "bob",
      "permissionType": "editable",
      "capabilities": {
        "canRead": true,
        "canEdit": true,
        "canPostToHive": false
      },
      "grantedBy": "alice",
      "grantedAt": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### 7. Grant Permission

```http
POST /collaboration/permissions/{owner}/{permlink}
```

**Request Body:**
```json
{
  "targetAccount": "bob",
  "permissionType": "editable"
}
```

**Permission Types:**
- `readonly`: Can view and connect to document (read-only access)
- `editable`: Can view and edit document content 
- `postable`: Can view, edit, and post document to Hive blockchain

**Permission Capabilities:**
- `canRead`: User can view the document and connect via WebSocket
- `canEdit`: User can make changes to the document content
- `canPostToHive`: User can publish the document to Hive blockchain

**Response:**
```json
{
  "success": true,
  "message": "editable permission granted to @bob",
  "permission": {
    "account": "bob",
    "permissionType": "editable",
    "grantedBy": "alice",
    "grantedAt": "2024-01-01T12:00:00Z"
  }
}
```

### 8. Revoke Permission

```http
DELETE /collaboration/permissions/{owner}/{permlink}/{targetAccount}
```

**Response:**
```json
{
  "success": true,
  "message": "Permission revoked from @bob"
}
```

### 9. Get Activity Log

```http
GET /collaboration/activity/{owner}/{permlink}
```

**Query Parameters:**
- `limit` (optional): Number of activities to return (default: 50)
- `offset` (optional): Pagination offset (default: 0)

**Response:**
```json
{
  "success": true,
  "document": "alice/my-document",
  "activity": [
    {
      "account": "bob",
      "activity_type": "connect",
      "activity_data": {
        "socketId": "abc123",
        "timestamp": "2024-01-01T12:00:00Z"
      },
      "created_at": "2024-01-01T12:00:00Z"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

### 10. Get Document Statistics

```http
GET /collaboration/stats/{owner}/{permlink}
```

**Response:**
```json
{
  "success": true,
  "document": "alice/my-document",
  "stats": {
    "total_users": 3,
    "active_users": 1,
    "last_activity": "2024-01-01T15:30:00Z",
    "total_edits": 42,
    "document_size": 2048,
    "permissions_summary": {
      "total_users": "2",
      "readonly_users": "1",
      "editable_users": "1",
      "postable_users": "0"
    },
    "recent_activity": [
      {
        "activity_type": "connect",
        "count": "5",
        "last_occurrence": "2024-01-01T15:30:00Z"
      }
    ],
    "inactivity_days": 2
  }
}
```

### 11. Get Detailed Permissions

```http
GET /collaboration/permissions-detailed/{owner}/{permlink}
```

**Response:**
```json
{
  "success": true,
  "document": "alice/my-document",
  "permissions": [
    {
      "account": "bob",
      "permissionType": "editable",
      "capabilities": {
        "canRead": true,
        "canEdit": true,
        "canPostToHive": false
      },
      "grantedBy": "alice",
      "grantedAt": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### 12. Manual Document Cleanup

```http
POST /collaboration/cleanup/manual/{owner}/{permlink}
```

**Note:** Only document owners can trigger manual cleanup.

**Response:**
```json
{
  "success": true,
  "message": "Document cleaned up successfully",
  "action": "Document data archived, metadata preserved"
}
```

## Collaboration Features

The Hive Collaboration API provides comprehensive real-time collaboration capabilities:

### Real-time Editing
- **Conflict-free**: Uses Y.js CRDT (Conflict-free Replicated Data Type)
- **Operational Transform**: Automatic conflict resolution for simultaneous edits
- **Persistence**: All changes automatically saved to PostgreSQL
- **History**: Complete edit history maintained by Y.js

### Cursor Sharing & User Awareness
- **Live Cursors**: See other users' cursor positions in real-time
- **User Presence**: Track who's currently editing the document
- **Selection Sharing**: View other users' text selections
- **User Colors**: Each user gets a unique color for identification

### Permission-based Access
- **Granular Control**: `readonly`, `editable`, and `postable` permissions
- **Real-time Enforcement**: Permissions checked on WebSocket connection
- **Hive Integration**: Post documents directly to Hive blockchain with `postable` permission

### Activity Tracking
- **Connection Logs**: Track user connections and disconnections
- **Edit Statistics**: Monitor document changes and user activity
- **Permission Auditing**: Log all permission grants and revocations

## Frontend Integration


### Authentication Helper

```javascript
import { PrivateKey } from 'hive-tx'

async function generateAuthHeaders(username, privateKey) {
  const challenge = Math.floor(Date.now() / 1000)
  const publicKey = PrivateKey.from(privateKey).createPublic().toString()
  
  // Sign the challenge
  const signature = PrivateKey.from(privateKey)
    .sign(Buffer.from(challenge.toString(), 'utf8'))
    .toString()
  
  return {
    'x-account': username,
    'x-challenge': challenge.toString(),
    'x-pubkey': publicKey,
    'x-signature': signature
  }
}

// Usage
const authHeaders = await generateAuthHeaders('alice', 'your-private-posting-key')
```

## Database Schema

The collaboration system uses three main tables:

### collaboration_documents
```sql
CREATE TABLE collaboration_documents (
  id SERIAL PRIMARY KEY,
  owner VARCHAR(50) NOT NULL,
  permlink VARCHAR(255) NOT NULL,
  document_data TEXT,
  is_public BOOLEAN DEFAULT false,
  last_activity TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(owner, permlink)
);
```

### collaboration_permissions
```sql
CREATE TABLE collaboration_permissions (
  id SERIAL PRIMARY KEY,
  owner VARCHAR(50) NOT NULL,
  permlink VARCHAR(255) NOT NULL,
  account VARCHAR(50) NOT NULL,
  permission_type VARCHAR(20) DEFAULT 'readonly',
  can_read BOOLEAN DEFAULT true,
  can_edit BOOLEAN DEFAULT false,
  can_post_to_hive BOOLEAN DEFAULT false,
  granted_by VARCHAR(50) NOT NULL,
  granted_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(owner, permlink, account)
);
```

### collaboration_activity
```sql
CREATE TABLE collaboration_activity (
  id SERIAL PRIMARY KEY,
  owner VARCHAR(50) NOT NULL,
  permlink VARCHAR(255) NOT NULL,
  account VARCHAR(50) NOT NULL,
  activity_type VARCHAR(50) NOT NULL,
  activity_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### collaboration_stats
```sql
CREATE TABLE collaboration_stats (
  id SERIAL PRIMARY KEY,
  owner VARCHAR(50) NOT NULL,
  permlink VARCHAR(255) NOT NULL,
  total_users INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  last_activity TIMESTAMP DEFAULT NOW(),
  total_edits INTEGER DEFAULT 0,
  document_size INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(owner, permlink)
);
```

## Error Handling

All endpoints return errors in the following format:

```json
{
  "success": false,
  "error": "Error message description"
}
```

Common error codes:
- `400`: Bad Request (invalid parameters)
- `401`: Unauthorized (invalid authentication)
- `403`: Forbidden (insufficient permissions)
- `404`: Not Found (document/resource doesn't exist)
- `500`: Internal Server Error

## Document Cleanup Strategy

The collaboration system includes automatic cleanup to manage inactive documents:

### Automatic Cleanup
- **Trigger**: Documents inactive for 30+ days
- **Schedule**: Runs every 24 hours
- **Action**: Archives document data (removes Y.js content, preserves metadata)
- **Logging**: All cleanup actions are logged in the activity table

### Manual Cleanup
- **Access**: Document owners only
- **Endpoint**: `POST /api/collaboration/cleanup/manual/{owner}/{permlink}`
- **Action**: Immediately archives the document data
- **Use Case**: Clean up documents before the 30-day threshold

### Cleanup Process
1. Document data (`document_data`) is set to NULL
2. Metadata (permissions, activity, stats) is preserved
3. Activity log entry is created with cleanup details
4. Document can still be accessed but will start with empty content

