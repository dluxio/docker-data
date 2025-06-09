# Hive Hocuspocus Collaboration Server

A standalone [Hocuspocus](https://tiptap.dev/docs/hocuspocus/getting-started) server for real-time collaborative editing with Hive blockchain authentication.

## Features

- ✅ **Real-time Collaboration**: Uses Y.js CRDT for conflict-free collaborative editing
- ✅ **Hive Authentication**: Secure authentication using Hive blockchain keypairs
- ✅ **PostgreSQL Storage**: Documents stored in PostgreSQL with your existing database
- ✅ **Permission System**: Fine-grained access control (readonly, editable, postable)
- ✅ **Activity Tracking**: Complete audit log of user connections and edits
- ✅ **User Awareness**: Live cursors and user presence indicators
- ✅ **Document Management**: Create, share, and manage collaborative documents

## Quick Start

### 1. Install Dependencies

The required packages should already be installed:

```bash
npm install @hocuspocus/server y-protocols yjs
```

### 2. Start the Collaboration Server

```bash
# Start the collaboration server on port 1234
npm run start:collaboration

# Or run directly
node collaboration-server.js
```

The server will automatically:
- Connect to your existing PostgreSQL database
- Create necessary collaboration tables
- Start listening on port 1234

### 3. Configure Reverse Proxy

Configure your Caddy server to proxy `/collaboration/` traffic to the Hocuspocus server:

```caddy
# In your Caddyfile
handle_path /collaboration/* {
    reverse_proxy localhost:1234
}
```

## Usage

### Frontend Integration

```javascript
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { PrivateKey } from 'hive-tx'

// Generate authentication token
function generateAuthToken(account, privateKey) {
  const challenge = Math.floor(Date.now() / 1000)
  const publicKey = PrivateKey.from(privateKey).createPublic().toString()
  const signature = PrivateKey.from(privateKey)
    .sign(Buffer.from(challenge.toString(), 'utf8'))
    .toString()

  return JSON.stringify({
    account,
    challenge: challenge.toString(),
    pubkey: publicKey,
    signature
  })
}

// Connect to document
const yDoc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: 'wss://your-domain.com/collaboration',
  name: 'alice/my-document-2024', // owner/permlink format
  token: generateAuthToken('alice', 'your-private-posting-key'),
  document: yDoc,
})

// Get shared text for editing
const yText = yDoc.getText('content')

// Listen to changes
yText.observe(() => {
  console.log('Document updated:', yText.toString())
})

// Make changes
yText.insert(0, 'Hello collaborative world!')
```

### Document Format

Documents are identified using the Hive format: `owner/permlink`

Examples:
- `alice/my-blog-post-2024`
- `bob/project-notes`
- `team/meeting-minutes-jan-2024`

### Authentication

The server uses the same Hive authentication as your main API:

```http
Headers (as JSON token):
{
  "account": "alice",
  "challenge": "1704067200",
  "pubkey": "STM7BWmXwvuKHr8FpSPmj8knJspFMPKt3vcetAKKjZ2W2HoRgdkEg",
  "signature": "2021d0d63d340b6d963e9761c0cbe8096c65a94ba9cec69aed35b2f1fe891576b8..."
}
```

## API Integration

The Hocuspocus server works alongside your existing collaboration API. Use the HTTP API for:

- Creating documents
- Managing permissions  
- Getting document lists
- Viewing activity logs

Use the WebSocket (Hocuspocus) server for:

- Real-time collaborative editing
- Live user presence
- Automatic document synchronization

## Database Tables

The server automatically creates these tables:

### `collaboration_documents`
Stores Y.js document data and metadata.

### `collaboration_permissions` 
Manages user access permissions per document.

### `collaboration_activity`
Logs all user connections and activities.

### `collaboration_stats`
Tracks document statistics and usage metrics.

## Configuration

The server uses your existing configuration from `config.js`:

- **Database**: Uses `DATABASE_URL` environment variable
- **Port**: Fixed at 1234 (configurable in code)
- **Authentication**: Integrates with existing Hive auth system

## Development

### Test the Server

1. Start the collaboration server:
   ```bash
   npm run start:collaboration
   ```

2. Open `collaboration-example.html` in your browser

3. Enter your Hive credentials and test collaborative editing

### WebSocket Endpoint

```
ws://localhost:1234/{owner}/{permlink}
```

### Authentication Flow

1. Client generates signed challenge using Hive private key
2. Client connects with authentication token via WebSocket
3. Server verifies signature against Hive blockchain
4. Server checks document permissions
5. Connection established for collaborative editing

## Security

- **1-hour challenge window**: WebSocket challenges expire after 1 hour
- **Signature verification**: All connections verified against Hive blockchain
- **Permission enforcement**: Access control enforced in real-time
- **Activity logging**: All connections and activities logged for audit

## Troubleshooting

### Connection Issues

1. **"Authentication failed"**: Check your private key and account name
2. **"Access denied"**: Ensure you have permission to the document
3. **"Invalid challenge"**: Generate a fresh timestamp (within 1 hour)

### Database Issues

1. **Tables not created**: Server automatically creates tables on startup
2. **Connection errors**: Check your `DATABASE_URL` environment variable

### Performance

- Documents are automatically saved to PostgreSQL
- Active user counts are tracked in real-time
- Inactive documents are cleaned up after 30 days

## Production Deployment

### Docker

```dockerfile
# Add to your existing Dockerfile
EXPOSE 1234
```

### Environment Variables

Uses the same environment variables as your main application:

- `DATABASE_URL`: PostgreSQL connection string
- `PORT`: Main API port (collaboration server uses 1234)

### Monitoring

The server logs all connections and provides metrics via the existing API:

```bash
# View collaboration statistics
GET /api/collaboration/stats/{owner}/{permlink}

# View activity logs  
GET /api/collaboration/activity/{owner}/{permlink}
```

## Integration with TipTap

For rich text editing with TipTap:

```javascript
import { Editor } from '@tiptap/core'
import { Collaboration } from '@tiptap/extension-collaboration'
import { CollaborationCursor } from '@tiptap/extension-collaboration-cursor'

const editor = new Editor({
  extensions: [
    // ... other extensions
    Collaboration.configure({
      document: yDoc,
    }),
    CollaborationCursor.configure({
      provider: provider,
      user: {
        name: 'alice',
        color: '#f783ac',
      },
    }),
  ],
})
```

## License

Same license as the main project. 