const { Server } = require('@hocuspocus/server')
const { Database } = require('@hocuspocus/extension-database')

const { Pool } = require('pg')
const config = require('./config')
const { CollaborationAuth } = require('./collaboration-auth')
const { createHash } = require('crypto')
const Y = require('yjs')

// Initialize database pool
const pool = new Pool({
  connectionString: config.dbcs,
})

// SHA256 hash function for signature verification
const sha256 = (data) => {
  return createHash('sha256').update(data).digest()
}

// Custom Hive authentication for WebSocket connections
class HiveAuthExtension {
  // Protocol messages that should ALWAYS be allowed regardless of permissions
  static PROTOCOL_MESSAGE_TYPES = [
    'awareness',
    'sync',
    'queryAwareness',
    'awarenessUpdate'
  ]

  // Y.js update types that are awareness-only (not document content)
  static AWARENESS_UPDATE_TYPES = new Set([
    0,  // Sync step 1
    1,  // Sync step 2  
    2   // Update (but could be awareness only)
  ])

  async onAuthenticate(data) {
    const { token, documentName } = data
    try {
      // Parse token - should contain auth headers as JSON
      const authData = JSON.parse(token)
      const { account, challenge, pubkey, signature } = authData
      
      // Validate required fields
      if (!account || !challenge || !pubkey || !signature) {
        throw new Error('Missing authentication headers')
      }
      
      // Validate challenge timestamp (must be within 1 hour for WebSocket)
      const challengeTime = parseInt(challenge)
      const now = Math.floor(Date.now() / 1000)
      const maxAge = 24 * 60 * 60 // 1 hour in seconds
      
      if (isNaN(challengeTime) || (now - challengeTime) > maxAge || challengeTime > (now + 300)) {
        throw new Error('Invalid challenge timestamp')
      }
      
      // Get account keys from HIVE blockchain
      const accountKeys = await CollaborationAuth.getAccountKeys(account)
      if (!accountKeys) {
        throw new Error(`Account @${account} not found on HIVE blockchain`)
      }
      
      // Check if the provided public key belongs to the account
      const allKeys = [
        ...accountKeys.owner,
        ...accountKeys.active,
        ...accountKeys.posting,
        accountKeys.memo
      ].filter(Boolean)
      
      if (!allKeys.includes(pubkey)) {
        throw new Error('Public key does not belong to the specified account')
      }
      
      // Verify the signature
      const isValidSignature = await CollaborationAuth.verifySignature(challenge.toString(), signature, pubkey)
      if (!isValidSignature) {
        throw new Error('Invalid signature')
      }
      
      // Parse document name (format: owner/permlink)
      const [owner, permlink] = documentName.split('/')
      if (!owner || !permlink) {
        throw new Error('Invalid document format. Expected: owner/permlink')
      }
      
      // Check document permissions
      const permissions = await this.checkDocumentAccess(account, owner, permlink)
      if (!permissions.hasAccess) {
        throw new Error('Access denied to document')
      }
      
      // Log connection activity
      await this.logActivity(owner, permlink, account, 'connect', {
        socketId: data.socketId,
        timestamp: new Date().toISOString(),
        permissions: permissions.permissionType
      })
      
      return {
        user: {
          id: account,
          name: account,
          color: this.generateUserColor(account, permissions.permissionType),
          // Store permissions in user context for later use
          permissions: permissions,
          // Add connection timestamp for grace period handling
          connectedAt: Date.now()
        }
      }
    } catch (error) {
      console.error('Authentication failed:', error)
      throw error
    }
  }
  
  async checkDocumentAccess(account, owner, permlink) {
    const client = await pool.connect()
    try {
      // Owner always has full access
      if (account === owner) {
        return {
          hasAccess: true,
          canRead: true,
          canEdit: true,
          canPostToHive: true,
          permissionType: 'owner'
        }
      }
      
      // Check explicit permissions first (higher priority than public access)
      const permResult = await client.query(
        'SELECT permission_type, can_read, can_edit, can_post_to_hive FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
        [owner, permlink, account]
      )
      
      if (permResult.rows.length > 0) {
        const perm = permResult.rows[0]
        return {
          hasAccess: perm.can_read,
          canRead: perm.can_read,
          canEdit: perm.can_edit,
          canPostToHive: perm.can_post_to_hive,
          permissionType: perm.permission_type
        }
      }
      
      // Check if document is public (lower priority than explicit permissions)
      const docResult = await client.query(
        'SELECT is_public FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (docResult.rows.length > 0 && docResult.rows[0].is_public) {
        return {
          hasAccess: true,
          canRead: true,
          canEdit: false,
          canPostToHive: false,
          permissionType: 'public'
        }
      }
      
      return {
        hasAccess: false,
        canRead: false,
        canEdit: false,
        canPostToHive: false,
        permissionType: 'none'
      }
    } finally {
      client.release()
    }
  }
  
  async logActivity(owner, permlink, account, activityType, data) {
    try {
      const client = await pool.connect()
      try {
        await client.query(`
          INSERT INTO collaboration_activity (owner, permlink, account, activity_type, activity_data)
          VALUES ($1, $2, $3, $4, $5)
        `, [owner, permlink, account, activityType, JSON.stringify(data)])
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Error logging activity:', error)
    }
  }
  
  generateUserColor(account, permissionType = 'owner') {
    // Generate a consistent color for the user based on their account name
    const hash = account.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0)
      return a & a
    }, 0)
    
    const hue = Math.abs(hash) % 360
    
    // Slightly muted colors for read-only users
    if (permissionType === 'public') {
      return `hsl(${hue}, 50%, 65%)`
    }
    
    return `hsl(${hue}, 70%, 60%)`
  }

  // Enhanced function to determine if an update is awareness-only or contains document content
  isAwarenessOnlyUpdate(update) {
    try {
      // Create test documents to analyze the update
      const beforeDoc = new Y.Doc()
      const afterDoc = new Y.Doc()
      
      // Get initial state
      const beforeText = beforeDoc.getText('content')
      const beforeContent = beforeText.toString()
      const beforeLength = beforeText.length
      
      // Apply update
      Y.applyUpdate(afterDoc, update)
      const afterText = afterDoc.getText('content')
      const afterContent = afterText.toString()
      const afterLength = afterText.length
      
      // Check if document content changed
      const contentChanged = beforeContent !== afterContent || beforeLength !== afterLength
      
      // If content didn't change, this is likely an awareness-only update
      if (!contentChanged) {
        return true
      }
      
      // Additional check: see if this is a small update that might be cursor positioning
      // Awareness updates are typically small (< 100 bytes)
      if (update.length < 100) {
        // Analyze the update structure to see if it contains only awareness data
        const updateArray = Array.from(update)
        
        // Y.js awareness updates often start with specific byte patterns
        // This is a heuristic check - Y.js internal structure may vary
        const hasAwarenessPattern = updateArray.length < 50 && (
          updateArray[0] === 0 || // Common sync protocol start
          updateArray[0] === 1 || // Sync step
          updateArray[0] === 2    // Update that might be awareness
        )
        
        if (hasAwarenessPattern) {
          console.log(`[isAwarenessOnlyUpdate] Small update detected (${update.length} bytes), likely awareness`)
          return true
        }
      }
      
      return false
    } catch (error) {
      // If we can't analyze safely, assume it contains document content (safer)
      console.log('Error analyzing update for awareness, assuming document content:', error.message)
      return false
    }
  }

  // Helper function to determine if an update modifies document content
  isDocumentContentUpdate(update) {
    return !this.isAwarenessOnlyUpdate(update)
  }

  // Check if user is in grace period (first 10 seconds after connection)
  isInGracePeriod(user) {
    if (!user || !user.connectedAt) return false
    const gracePeriodMs = 10000 // 10 seconds
    return (Date.now() - user.connectedAt) < gracePeriodMs
  }

  // Enhanced Y.js sync protocol handling
  isSyncProtocolMessage(update) {
    try {
      // Check if this is a Y.js sync protocol message
      const updateArray = Array.from(update)
      
      // Y.js sync messages typically start with specific bytes
      // Step 1 (SyncStep1): requests document state
      // Step 2 (SyncStep2): sends document state
      // These should be allowed regardless of permissions
      
      if (updateArray.length > 0) {
        const messageType = updateArray[0]
        
        // Common Y.js protocol message types
        if (messageType === 0 || messageType === 1) {
          console.log(`[isSyncProtocolMessage] Detected sync protocol message type ${messageType}`)
          return true
        }
      }
      
      return false
    } catch (error) {
      console.log('Error checking sync protocol message:', error.message)
      return false
    }
  }

  // Helper function to decode Y.js update for debugging
  decodeUpdateForDebug(update) {
    try {
      // Create a temporary Y.js document to apply the update
      const tempDoc = new Y.Doc()
      const yText = tempDoc.getText('content')
      
      // Apply the update to see what changes it contains
      Y.applyUpdate(tempDoc, update)
      
      // Get the resulting text content
      const content = yText.toString()
      
      // Also try to analyze the update structure
      const updateInfo = {
        size: update.length,
        content: content,
        contentLength: content.length,
        updateHex: Buffer.from(update).toString('hex') // First 50 bytes as hex
      }
      
      return updateInfo
    } catch (error) {
      // If we can't decode it, at least show some basic info
      return {
        size: update.length,
        error: error.message,
        updateHex: Buffer.from(update).toString('hex'),
        firstBytes: Array.from(update.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')
      }
    }
  }
}

// Initialize extensions
const hiveAuth = new HiveAuthExtension()

// Configure the Hocuspocus server
const server = new Server({
  port: 1234,
  
  // CORS configuration
  cors: {
    origin: [
      'https://vue.dlux.io',
      'https://dlux.io', 
      'http://www.dlux.io',
      'http://localhost:3001',
      'http://localhost:5508',
      'http://localhost:5509',
      // Add any other origins you need
    ],
    credentials: false, // Set to false since client works better with credentials: 'omit'
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-account',
      'x-challenge', 
      'x-pubkey',
      'x-signature',
    ]
  },
  
  // Authentication
  async onAuthenticate(data) {
    return await hiveAuth.onAuthenticate(data)
  },
  
  // Prevent unauthorized changes BEFORE they are applied
  async beforeHandleMessage(data) {
    const { documentName, context, update } = data
    
    // Check if user has edit permissions
    if (context.user && context.user.permissions) {
      const permissions = context.user.permissions
      const user = context.user
      
      // Allow all updates during grace period for initial sync
      if (hiveAuth.isInGracePeriod(user)) {
        console.log(`[beforeHandleMessage] Grace period active for ${user.name}, allowing sync protocol`)
        return
      }
      
      // Always allow Y.js sync protocol messages regardless of permissions
      if (hiveAuth.isSyncProtocolMessage(update)) {
        console.log(`[beforeHandleMessage] Allowing Y.js sync protocol message for ${user.name}`)
        return
      }
      
      // For users without edit permissions
      if (!permissions.canEdit) {
        // Check if this is an awareness-only update (cursor position, user presence)
        const isAwarenessOnly = hiveAuth.isAwarenessOnlyUpdate(update)
        
        if (isAwarenessOnly) {
          // Allow awareness updates - these are just cursor position and user presence
          console.log(`[beforeHandleMessage] Allowing awareness update for read-only user: ${user.name}`)
          return
        }
        
        // This is a document content update - block it
        const updateInfo = hiveAuth.decodeUpdateForDebug(update)
        
        // Log unauthorized edit attempt
        const [owner, permlink] = documentName.split('/')
        await hiveAuth.logActivity(owner, permlink, user.name, 'unauthorized_edit_attempt', {
          timestamp: new Date().toISOString(),
          permissionType: permissions.permissionType,
          updateSize: update.length,
          attemptedChanges: updateInfo
        })
        
        // Enhanced logging with decoded update
        console.log(`[beforeHandleMessage] Blocking unauthorized document edit:`)
        console.log(`  User: ${user.name}`)
        console.log(`  Permission: ${permissions.permissionType}`)
        console.log(`  Document: ${documentName}`)
        console.log(`  Update size: ${update.length} bytes`)
        console.log(`  Update info:`, JSON.stringify(updateInfo, null, 2))
        
        // Provide clear error message based on user's permission level
        let errorMessage = `Access denied: User ${user.name} has ${permissions.permissionType} access.`
        if (permissions.permissionType === 'public') {
          errorMessage += ' You can view the document and see other users\' cursors, but cannot edit the content.'
        } else {
          errorMessage += ' You can only view this document.'
        }
        
        throw new Error(errorMessage)
      } else {
        // User has edit permissions - log successful edit capability
        console.log(`[beforeHandleMessage] User ${user.name} has edit permissions (${permissions.permissionType})`)
      }
    }
  },
  
  // Log successful changes after they are applied
  async onChange(data) {
    const { documentName, context, update } = data
    
    // Log successful edit for audit
    if (context.user && context.user.permissions) {
      const [owner, permlink] = documentName.split('/')
      await hiveAuth.logActivity(owner, permlink, context.user.name, 'document_edit', {
        timestamp: new Date().toISOString(),
        permissionType: context.user.permissions.permissionType,
        updateSize: update.length
      })
    }
  },
  
  // Connection management
  async onConnect(data) {
    const { documentName, context } = data
    const [owner, permlink] = documentName.split('/')
    
    if (context.user) {
      const user = context.user
      const permissions = user.permissions
      
      // Log connection with permission info
      console.log(`[onConnect] User ${user.name} connected to ${documentName}`)
      console.log(`  Permission: ${permissions.permissionType}`)
      console.log(`  Can Edit: ${permissions.canEdit}`)
      console.log(`  Can Read: ${permissions.canRead}`)
      
      // Update active user count
      try {
        const client = await pool.connect()
        try {
          await client.query(`
            INSERT INTO collaboration_stats (owner, permlink, active_users, last_activity, updated_at)
            VALUES ($1, $2, 1, NOW(), NOW())
            ON CONFLICT (owner, permlink)
            DO UPDATE SET 
              active_users = collaboration_stats.active_users + 1,
              last_activity = NOW(),
              updated_at = NOW()
          `, [owner, permlink])
        } finally {
          client.release()
        }
      } catch (error) {
        console.error('Error updating active users:', error)
      }
      
      // Log detailed connection activity
      await hiveAuth.logActivity(owner, permlink, user.name, 'detailed_connect', {
        timestamp: new Date().toISOString(),
        permissions: permissions,
        userAgent: data.request?.headers?.['user-agent'] || 'unknown',
        ip: data.request?.socket?.remoteAddress || 'unknown'
      })
    }
  },
  
  // Handle when document sync is complete for a user
  async onSynced(data) {
    const { documentName, context } = data
    
    if (context.user) {
      const user = context.user
      const permissions = user.permissions
      const [owner, permlink] = documentName.split('/')
      
      console.log(`[onSynced] Document sync completed for ${user.name}`)
      console.log(`  Permission: ${permissions.permissionType}`)
      console.log(`  Document: ${documentName}`)
      
      // Log sync completion
      await hiveAuth.logActivity(owner, permlink, user.name, 'sync_completed', {
        timestamp: new Date().toISOString(),
        permissionType: permissions.permissionType,
        canEdit: permissions.canEdit,
        canRead: permissions.canRead
      })
      
      // For read-only users, ensure they understand their capabilities
      if (!permissions.canEdit) {
        console.log(`[onSynced] Read-only user ${user.name} sync completed - awareness enabled, editing disabled`)
      }
    }
  },
  
  async onDisconnect(data) {
    const { documentName, context } = data
    const [owner, permlink] = documentName.split('/')
    
    if (context.user) {
      // Log disconnect activity
      await hiveAuth.logActivity(owner, permlink, context.user.name, 'disconnect', {
        timestamp: new Date().toISOString()
      })
      
      // Update active user count
      try {
        const client = await pool.connect()
        try {
          await client.query(`
            UPDATE collaboration_stats 
            SET active_users = GREATEST(0, active_users - 1),
                updated_at = NOW()
            WHERE owner = $1 AND permlink = $2
          `, [owner, permlink])
        } finally {
          client.release()
        }
      } catch (error) {
        console.error('Error updating active users:', error)
      }
    }
  },
  
  // Error handling
  async onDestroy() {
    await pool.end()
  },
  
  extensions: [
    // Use official Hocuspocus Database extension instead of custom handlers
    new Database({
      // Fetch Y.js document from PostgreSQL
      fetch: async ({ documentName }) => {
        const [owner, permlink] = documentName.split('/')
        
        if (!owner || !permlink) {
          throw new Error('Invalid document format')
        }
        
        try {
          const client = await pool.connect()
          try {
            const result = await client.query(
              'SELECT document_data FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
              [owner, permlink]
            )
            
            if (result.rows.length > 0 && result.rows[0].document_data) {
              const rawData = result.rows[0].document_data
              
              try {
                // Try to decode as Y.js binary data (base64 encoded)
                const documentBuffer = Buffer.from(rawData, 'base64')
                const uint8Array = new Uint8Array(documentBuffer)
                
                // Validate that this is Y.js binary data
                const testDoc = new Y.Doc()
                Y.applyUpdate(testDoc, uint8Array)
                
                return uint8Array
              } catch (yError) {
                // If not Y.js format, convert plain text to Y.js
                const yDoc = new Y.Doc()
                const yText = yDoc.getText('content')
                yText.insert(0, rawData)
                
                const update = Y.encodeStateAsUpdate(yDoc)
                
                // Store converted Y.js data back to database
                const documentData = Buffer.from(update).toString('base64')
                await client.query(`
                  UPDATE collaboration_documents 
                  SET document_data = $1, updated_at = NOW()
                  WHERE owner = $2 AND permlink = $3
                `, [documentData, owner, permlink])
                
                return update
              }
            }
            return null
          } finally {
            client.release()
          }
        } catch (error) {
          console.error('Error loading document:', error)
          return null
        }
      },
      
      // Store Y.js document to PostgreSQL
      store: async ({ documentName, state }) => {
        const [owner, permlink] = documentName.split('/')
        
        if (!owner || !permlink) {
          throw new Error('Invalid document format')
        }
        
        try {
          const client = await pool.connect()
          try {
            // Encode Y.js state as base64 for storage
            const documentData = Buffer.from(state).toString('base64')
            
            await client.query(`
              INSERT INTO collaboration_documents (owner, permlink, document_data, last_activity, updated_at)
              VALUES ($1, $2, $3, NOW(), NOW())
              ON CONFLICT (owner, permlink)
              DO UPDATE SET 
                document_data = EXCLUDED.document_data,
                last_activity = NOW(),
                updated_at = NOW()
            `, [owner, permlink, documentData])
            
            // Update statistics
            await client.query(`
              INSERT INTO collaboration_stats (owner, permlink, last_activity, total_edits, updated_at)
              VALUES ($1, $2, NOW(), 1, NOW())
              ON CONFLICT (owner, permlink)
              DO UPDATE SET 
                last_activity = NOW(),
                total_edits = collaboration_stats.total_edits + 1,
                updated_at = NOW()
            `, [owner, permlink])
            

          } finally {
            client.release()
          }
        } catch (error) {
          console.error('Error storing document:', error)
          throw error
        }
      }
    }),
  ],
})

// Setup database tables for collaboration
async function setupCollaborationDatabase() {
  try {
    const client = await pool.connect()
    try {
      // Create collaboration_documents table
      await client.query(`
        CREATE TABLE IF NOT EXISTS collaboration_documents (
          id SERIAL PRIMARY KEY,
          owner VARCHAR(50) NOT NULL,
          permlink VARCHAR(255) NOT NULL,
          document_name VARCHAR(500) DEFAULT '',
          document_data TEXT,
          is_public BOOLEAN DEFAULT false,
          last_activity TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(owner, permlink)
        )
      `)
      
      // Add document_name column if it doesn't exist (for existing databases)
      await client.query(`
        ALTER TABLE collaboration_documents 
        ADD COLUMN IF NOT EXISTS document_name VARCHAR(500) DEFAULT ''
      `)
      
      // Create collaboration_permissions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS collaboration_permissions (
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
        )
      `)
      
      // Create collaboration_activity table
      await client.query(`
        CREATE TABLE IF NOT EXISTS collaboration_activity (
          id SERIAL PRIMARY KEY,
          owner VARCHAR(50) NOT NULL,
          permlink VARCHAR(255) NOT NULL,
          account VARCHAR(50) NOT NULL,
          activity_type VARCHAR(50) NOT NULL,
          activity_data JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `)
      
      // Create collaboration_stats table
      await client.query(`
        CREATE TABLE IF NOT EXISTS collaboration_stats (
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
        )
      `)
      
      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_collab_docs_owner_permlink ON collaboration_documents(owner, permlink);
        CREATE INDEX IF NOT EXISTS idx_collab_permissions_owner_permlink ON collaboration_permissions(owner, permlink);
        CREATE INDEX IF NOT EXISTS idx_collab_permissions_account ON collaboration_permissions(account);
        CREATE INDEX IF NOT EXISTS idx_collab_activity_owner_permlink ON collaboration_activity(owner, permlink);
        CREATE INDEX IF NOT EXISTS idx_collab_activity_account ON collaboration_activity(account);
        CREATE INDEX IF NOT EXISTS idx_collab_stats_owner_permlink ON collaboration_stats(owner, permlink);
      `)
      

    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error setting up collaboration database:', error)
    throw error
  }
}

// Initialize and start server
async function startCollaborationServer() {
  try {
    // Setup database tables
    await setupCollaborationDatabase()
    
    // Start the server
    server.listen()
  } catch (error) {
    console.error('Failed to start collaboration server:', error)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  await server.destroy()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await server.destroy()
  process.exit(0)
})

// Start the server if this file is run directly
if (require.main === module) {
  startCollaborationServer()
}



module.exports = { server, setupCollaborationDatabase } 