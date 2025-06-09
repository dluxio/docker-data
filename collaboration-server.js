const { Server } = require('@hocuspocus/server')
const { Database } = require('@hocuspocus/extension-database')
const { Logger } = require('@hocuspocus/extension-logger')
const { Pool } = require('pg')
const config = require('./config')
const { CollaborationAuth } = require('./collaboration-auth')
const { PrivateKey, PublicKey, Signature } = require('hive-tx')
const { createHash } = require('crypto')

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
  async onAuthenticate(data) {
    const { token, documentName } = data
    console.log({token})
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
      const maxAge = 60 * 60 // 1 hour in seconds
      
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
      const hasAccess = await this.checkDocumentAccess(account, owner, permlink)
      if (!hasAccess) {
        throw new Error('Access denied to document')
      }
      
      // Log connection activity
      await this.logActivity(owner, permlink, account, 'connect', {
        socketId: data.socketId,
        timestamp: new Date().toISOString()
      })
      
      return {
        user: {
          id: account,
          name: account,
          color: this.generateUserColor(account)
        }
      }
    } catch (error) {
      console.error('Authentication failed:', error)
      throw error
    }
  }
  
  async checkDocumentAccess(account, owner, permlink) {
    try {
      const client = await pool.connect()
      try {
        // Check if user is the owner
        if (account === owner) {
          return true
        }
        
        // Check if document is public
        const docResult = await client.query(
          'SELECT is_public FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
          [owner, permlink]
        )
        
        if (docResult.rows.length > 0 && docResult.rows[0].is_public) {
          return true
        }
        
        // Check explicit permissions
        const permResult = await client.query(
          'SELECT permission_type FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
          [owner, permlink, account]
        )
        
        return permResult.rows.length > 0
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Error checking document access:', error)
      return false
    }
  }
  
  async logActivity(owner, permlink, account, activityType, data) {
    try {
      const client = await pool.connect()
      try {
        await client.query(
          'INSERT INTO collaboration_activity (owner, permlink, account, activity_type, activity_data) VALUES ($1, $2, $3, $4, $5)',
          [owner, permlink, account, activityType, data]
        )
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Error logging activity:', error)
    }
  }
  
  generateUserColor(account) {
    // Generate a consistent color for each user based on their account name
    const hash = createHash('md5').update(account).digest('hex')
    const hue = parseInt(hash.substr(0, 2), 16) * 360 / 255
    return `hsl(${hue}, 70%, 50%)`
  }
}

// Custom database extension for PostgreSQL storage
class PostgreSQLDatabase {
  constructor() {
    this.pool = pool
  }
  
  async onStoreDocument(data) {
    const { documentName, document } = data
    const [owner, permlink] = documentName.split('/')
    
    if (!owner || !permlink) {
      throw new Error('Invalid document format')
    }
    
    try {
      const client = await this.pool.connect()
      try {
        // Store the Y.js document data
        const documentData = Buffer.from(document).toString('base64')
        
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
        await this.updateDocumentStats(owner, permlink, client)
        
        console.log(`Document stored: ${documentName}`)
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Error storing document:', error)
      throw error
    }
  }
  
  async onLoadDocument(data) {
    const { documentName } = data
    const [owner, permlink] = documentName.split('/')
    
    if (!owner || !permlink) {
      throw new Error('Invalid document format')
    }
    
    try {
      const client = await this.pool.connect()
      try {
        const result = await client.query(
          'SELECT document_data FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
          [owner, permlink]
        )
        
        if (result.rows.length > 0 && result.rows[0].document_data) {
          const documentData = Buffer.from(result.rows[0].document_data, 'base64')
          console.log(`Document loaded: ${documentName}`)
          return documentData
        }
        
        console.log(`New document: ${documentName}`)
        return null
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Error loading document:', error)
      return null
    }
  }
  
  async updateDocumentStats(owner, permlink, client) {
    try {
      // Update or create stats entry
      await client.query(`
        INSERT INTO collaboration_stats (owner, permlink, last_activity, total_edits, updated_at)
        VALUES ($1, $2, NOW(), 1, NOW())
        ON CONFLICT (owner, permlink)
        DO UPDATE SET 
          last_activity = NOW(),
          total_edits = collaboration_stats.total_edits + 1,
          updated_at = NOW()
      `, [owner, permlink])
    } catch (error) {
      console.error('Error updating document stats:', error)
    }
  }
}

// Initialize extensions
const hiveAuth = new HiveAuthExtension()
const postgresDB = new PostgreSQLDatabase()

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
      // Add any other origins you need
    ],
    credentials: true,
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
  
  // Document storage
  async onStoreDocument(data) {
    return await postgresDB.onStoreDocument(data)
  },
  
  async onLoadDocument(data) {
    return await postgresDB.onLoadDocument(data)
  },
  
  // Connection management
  async onConnect(data) {
    const { documentName, context } = data
    const [owner, permlink] = documentName.split('/')
    
    if (context.user) {
      console.log(`User ${context.user.name} connected to ${documentName}`)
      
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
    }
  },
  
  async onDisconnect(data) {
    const { documentName, context } = data
    const [owner, permlink] = documentName.split('/')
    
    if (context.user) {
      console.log(`User ${context.user.name} disconnected from ${documentName}`)
      
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
    console.log('Hocuspocus server shutting down...')
    await pool.end()
  },
  
  extensions: [
    new Logger(),
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
          document_data TEXT,
          is_public BOOLEAN DEFAULT false,
          last_activity TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(owner, permlink)
        )
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
      
      console.log('Collaboration database tables created successfully')
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
    console.log('🚀 Hocuspocus collaboration server started on port 1234')
    console.log('📡 WebSocket endpoint: ws://localhost:1234/{owner}/{permlink}')
  } catch (error) {
    console.error('Failed to start collaboration server:', error)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...')
  await server.destroy()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...')
  await server.destroy()
  process.exit(0)
})

// Start the server if this file is run directly
if (require.main === module) {
  startCollaborationServer()
}

module.exports = { server, setupCollaborationDatabase } 