const { Server } = require('@hocuspocus/server')
const { Database } = require('@hocuspocus/extension-database')

const { Pool } = require('pg')
const config = require('./config')
const { CollaborationAuth } = require('./collaboration-auth')
const { createHash } = require('crypto')
const Y = require('yjs')
const { decoding } = require('lib0')
const awarenessProtocol = require('y-protocols/awareness')

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
      
      // Validate challenge timestamp (must be within 24 hours for WebSocket)
      const challengeTime = parseInt(challenge)
      const now = Math.floor(Date.now() / 1000)
      const maxAge = 24 * 60 * 60 // 24 hours in seconds
      const ageDifference = now - challengeTime
      const isFromFuture = challengeTime > (now + 300)
      
      if (isNaN(challengeTime)) {
        console.error(`[onAuthenticate] Invalid challenge format:`, { challenge, account })
        throw new Error('Challenge must be a valid timestamp')
      }
      
      if (ageDifference > maxAge) {
        console.error(`[onAuthenticate] Challenge too old:`, { 
          challenge: challengeTime, 
          now, 
          ageDifference, 
          maxAge,
          account 
        })
        throw new Error(`Challenge timestamp too old (${Math.floor(ageDifference / 3600)} hours old, max 24 hours)`)
      }
      
      if (isFromFuture) {
        console.error(`[onAuthenticate] Challenge from future:`, { 
          challenge: challengeTime, 
          now, 
          futureBy: challengeTime - now,
          account 
        })
        throw new Error('Challenge timestamp cannot be from the future (max 5 minutes ahead)')
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

  // Properly detect Y.js awareness protocol messages
  isAwarenessProtocolMessage(update) {
    try {
      // In Hocuspocus, the message format is:
      // [messageType, ...data]
      // Where messageType 1 = Awareness (from Hocuspocus MessageType enum)
      const updateArray = new Uint8Array(update)
      if (updateArray.length === 0) return false
      
      const messageType = updateArray[0]
      
      // Hocuspocus MessageType.Awareness = 1
      if (messageType === 1) {
        // Additional validation: awareness messages should have specific structure
        // They contain awareness update data after the message type
        if (updateArray.length > 1) {
          console.log(`[isAwarenessProtocolMessage] Detected Hocuspocus awareness message (type ${messageType}, size ${updateArray.length})`)
          return true
        }
      }
      
      return false
    } catch (error) {
      console.error('[isAwarenessProtocolMessage] Error:', error)
      return false
    }
  }

  // Legacy method kept for backwards compatibility but deprecated
  isAwarenessOnlyUpdate(update) {
    // Use the new protocol-based detection
    return this.isAwarenessProtocolMessage(update)
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
      const updateArray = new Uint8Array(update)
      
      if (updateArray.length > 0) {
        const messageType = updateArray[0]
        
        // Hocuspocus MessageType enum:
        // Sync = 0 (includes both sync step 1 and 2)
        // SyncReply = 4 (same as Sync but won't trigger another SyncStep1)
        if (messageType === 0 || messageType === 4) {
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
  
  // Debug helper to identify message types
  debugMessageType(update) {
    const updateArray = new Uint8Array(update)
    const messageType = updateArray.length > 0 ? updateArray[0] : -1
    
    const typeNames = {
      0: 'Sync',
      1: 'Awareness',
      2: 'Auth',
      3: 'Query Awareness',
      4: 'Sync Reply',
      5: 'Stateless',
      6: 'Broadcast Stateless',
      7: 'Close',
      8: 'Sync Status'
    }
    
    return {
      type: messageType,
      typeName: typeNames[messageType] || 'Unknown',
      size: update.length,
      isAwareness: this.isAwarenessProtocolMessage(update),
      isSync: this.isSyncProtocolMessage(update),
      isAuth: messageType === 2,
      isQueryAwareness: messageType === 3,
      firstBytes: Array.from(updateArray.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(' ')
    }
  }
  
  // Check if this is a protocol message that should always be allowed
  isProtocolMessage(update) {
    const updateArray = new Uint8Array(update)
    if (updateArray.length === 0) return false
    
    const messageType = updateArray[0]
    
    // Check specific message types
    switch (messageType) {
      case 0:  // Sync - always allow for initial sync
      case 1:  // Awareness - always allow for cursor/presence
      case 2:  // Auth - always allow for authentication
      case 3:  // Query Awareness - always allow awareness queries
      case 4:  // Sync Reply - always allow sync responses
      case 8:  // Sync Status - always allow status updates
        return true
        
      default:
        // For unknown types, check if it looks like a Y.js document update
        // Y.js document updates typically have more complex structure
        if (updateArray.length > 10) {
          // Check if this might be a Y.js update by looking for typical patterns
          // Y.js updates often have specific byte patterns we can detect
          try {
            // Try to decode as Y.js update - if it fails, it's likely not a document update
            const tempDoc = new Y.Doc()
            Y.applyUpdate(tempDoc, update)
            // If we get here, it's a valid Y.js update - check if it modifies content
            const hasContent = tempDoc.getText('content').length > 0
            return !hasContent // Allow if it doesn't contain document content
          } catch (e) {
            // Not a Y.js update, likely a protocol message
            return true
          }
        }
        return false
    }
  }

  // ✅ STEP 3: Permission update helper for API integration
  async updateDocumentPermissions(server, owner, permlink, newPermissions) {
    try {
      // 1. Update permissions in database
      await this.updatePermissionsInDatabase(owner, permlink, newPermissions)

      // 2. Update Y.js permissions map to trigger broadcast
      const documentId = `${owner}/${permlink}`
      const yjsDocument = server.getDocument(documentId)

      if (yjsDocument) {
        // Use Y.js transaction to update permissions map
        yjsDocument.transact(() => {
          const permissionsMap = yjsDocument.getMap('permissions')

          // Update each permission that changed
          Object.entries(newPermissions).forEach(([username, permission]) => {
            permissionsMap.set(username, permission)
          })

          // Add timestamp for debugging
          permissionsMap.set('lastUpdated', new Date().toISOString())

        }, 'permission-api-update') // Origin tag for transaction

        console.log('✅ Y.js permissions updated, broadcast triggered for:', documentId)
      }

      return { success: true, permissions: newPermissions }

    } catch (error) {
      console.error('❌ Permission update failed:', error)
      throw error
    }
  }

  // Helper to update permissions in database
  async updatePermissionsInDatabase(owner, permlink, newPermissions) {
    const client = await pool.connect()
    try {
      // Update each permission
      for (const [account, permissionData] of Object.entries(newPermissions)) {
        if (typeof permissionData === 'string') {
          // Simple permission type string
          await client.query(`
            INSERT INTO collaboration_permissions (owner, permlink, account, permission_type, can_read, can_edit, can_post_to_hive, granted_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (owner, permlink, account)
            DO UPDATE SET 
              permission_type = EXCLUDED.permission_type,
              can_read = EXCLUDED.can_read,
              can_edit = EXCLUDED.can_edit,
              can_post_to_hive = EXCLUDED.can_post_to_hive,
              granted_by = EXCLUDED.granted_by,
              granted_at = NOW()
          `, [
            owner, permlink, account, permissionData,
            this.getPermissionFlags(permissionData).canRead,
            this.getPermissionFlags(permissionData).canEdit,
            this.getPermissionFlags(permissionData).canPostToHive,
            owner // Assume owner is granting permissions
          ])
        }
      }
    } finally {
      client.release()
    }
  }

  // Helper to get permission flags from permission type
  getPermissionFlags(permissionType) {
    switch (permissionType) {
      case 'owner':
        return { canRead: true, canEdit: true, canPostToHive: true }
      case 'postable':
        return { canRead: true, canEdit: true, canPostToHive: true }
      case 'editable':
        return { canRead: true, canEdit: true, canPostToHive: false }
      case 'readonly':
        return { canRead: true, canEdit: false, canPostToHive: false }
      case 'public':
        return { canRead: true, canEdit: false, canPostToHive: false }
      default:
        return { canRead: false, canEdit: false, canPostToHive: false }
    }
  }
}

// Initialize extensions
const hiveAuth = new HiveAuthExtension()

// Configure the Hocuspocus server
const server = new Server({
  port: 1234,
  
  // WebSocket timeout configuration (CRITICAL: Must align with Y.js awareness timeout)
  timeout: 30000, // 30 seconds (matches Y.js awareness timeout)
  debounce: 2000,  // 2 seconds debounce for document updates
  maxDebounce: 10000, // 10 seconds max debounce
  quiet: false, // Enable logging to help debug connection issues
  
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
      
      // Debug: Log all messages for readonly users
      if (!permissions.canEdit) {
        const messageInfo = hiveAuth.debugMessageType(update)
        console.log(`[beforeHandleMessage] DEBUG - Message from readonly user ${user.name}:`, messageInfo)
      }
      
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
      
      // IMPORTANT: Let Hocuspocus handle awareness messages via onAwarenessUpdate
      // This avoids the broken heuristic detection and uses proper protocol handling
      if (hiveAuth.isAwarenessProtocolMessage(update)) {
        console.log(`[beforeHandleMessage] Delegating awareness message to Hocuspocus for ${user.name}`)
        return // Let Hocuspocus process this via onAwarenessUpdate
      }
      
      // For users without edit permissions
      if (!permissions.canEdit) {
        // CRITICAL: Allow ALL Y.js protocol messages (types 0-4, 8) for readonly users
        // Only reject document content changes (type 0 with actual content)
        if (hiveAuth.isProtocolMessage(update)) {
          const messageInfo = hiveAuth.debugMessageType(update)
          console.log(`[beforeHandleMessage] Allowing protocol message (type ${messageInfo.type}: ${messageInfo.typeName}) from read-only user: ${user.name}`)
          return // Allow all protocol messages: 0-4, 8
        }
        
        // This is a document content update - block it
        const updateInfo = hiveAuth.decodeUpdateForDebug(update)
        
        // Log as document edit attempt (not unauthorized_edit_attempt for clarity)
        const [owner, permlink] = documentName.split('/')
        await hiveAuth.logActivity(owner, permlink, user.name, 'blocked_document_edit', {
          timestamp: new Date().toISOString(),
          permissionType: permissions.permissionType,
          updateSize: update.length,
          messageType: hiveAuth.debugMessageType(update).type,
          attemptedChanges: updateInfo
        })
        
        // Enhanced logging with decoded update
        console.log(`[beforeHandleMessage] Blocking document edit from read-only user:`)
        console.log(`  User: ${user.name}`)
        console.log(`  Permission: ${permissions.permissionType}`)
        console.log(`  Document: ${documentName}`)
        console.log(`  Update size: ${update.length} bytes`)
        console.log(`  Message type: ${hiveAuth.debugMessageType(update).typeName}`)
        console.log(`  Update info:`, JSON.stringify(updateInfo, null, 2))
        
        // Clear error message
        let errorMessage = `Document editing not allowed. User ${user.name} has ${permissions.permissionType} access.`
        if (permissions.permissionType === 'public' || permissions.permissionType === 'readonly') {
          errorMessage += ' You can view the document and see other users\' cursors, but cannot edit content.'
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

  // ✅ STEP 1: Core Permission Observer - Real-time permission broadcasts
  async onChangeDocument(data) {
    const { documentName, document } = data

    try {
      // Get permissions map from Y.js document
      const permissionsMap = document.getMap('permissions')

      // Set up observer for permission changes (only once per document)
      if (!permissionsMap._hasPermissionObserver) {
        permissionsMap.observe((event) => {
          if (event.type === 'update' && event.changes.keys.size > 0) {
            
            console.log('📡 Permission change detected, broadcasting:', {
              document: documentName,
              changedKeys: Array.from(event.changes.keys.keys()),
              timestamp: new Date().toISOString()
            })

            // Broadcast permission update via Y.js awareness
            document.awareness.setLocalStateField('permissionUpdate', {
              timestamp: Date.now(),
              changes: Array.from(event.changes.keys.keys()),
              documentName: documentName,
              eventType: 'permission-change'
            })

            // Clear the broadcast after 5 seconds to prevent memory accumulation
            setTimeout(() => {
              if (document.awareness) {
                document.awareness.setLocalStateField('permissionUpdate', null)
              }
            }, 5000)
          }
        })

        // Mark that we've added the observer to prevent duplicates
        permissionsMap._hasPermissionObserver = true

        console.log('✅ Permission observer added for document:', documentName)
      }

    } catch (error) {
      console.error('❌ Error setting up permission observer:', error)
    }
  },
  
  // ✅ STEP 2: Enhanced Awareness Handling with Permission Broadcasts
  async onAwarenessUpdate(data) {
    const { documentName, context, connection, added, updated, removed, awareness } = data
    
    // CRITICAL: Allow awareness updates for ALL authenticated users (including readonly)
    // This should NOT reject awareness updates from readonly users
    
    // Log awareness activity for debugging
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      console.log('👥 Awareness update:', {
        document: documentName,
        added: added.length,
        updated: updated.length,
        removed: removed.length,
        totalClients: awareness.getStates().size
      })

      // ✅ STEP 2: Check for permission broadcasts in awareness states
      awareness.getStates().forEach((state, clientId) => {
        if (state.permissionUpdate) {
          console.log('🔔 Permission broadcast detected in awareness:', {
            clientId,
            broadcast: state.permissionUpdate,
            document: documentName
          })
        }
      })
    }
    
    if (context.user) {
      const user = context.user
      const permissions = user.permissions
      
      console.log(`[onAwarenessUpdate] From user: ${user.name} (${permissions.permissionType})`)
      
      // CRITICAL: Reset connection activity to prevent timeouts
      if (connection) {
        connection.lastActivity = Date.now()
        connection.isAlive = true
        console.log(`[onAwarenessUpdate] Connection activity reset for ${user.name}`)
      }
      
      // Log awareness activity for monitoring
      const [owner, permlink] = documentName.split('/')
      await hiveAuth.logActivity(owner, permlink, user.name, 'awareness_update', {
        timestamp: new Date().toISOString(),
        permissionType: permissions.permissionType,
        added: added.length,
        updated: updated.length,
        removed: removed.length,
        totalAwarenessUsers: awareness ? awareness.getStates().size : 0
      })
    }
    
    // IMPORTANT: Always allow awareness updates to proceed (including permission broadcasts)
    return true
  },

  // ✅ STEP 4: Document Lifecycle Management
  async onCreateDocument(data) {
    const { documentName, document } = data

    console.log('📄 Document created:', documentName)

    // Initialize permissions map if it doesn't exist
    const permissionsMap = document.getMap('permissions')
    if (permissionsMap.size === 0) {
      // Set default permissions for document creator
      const [owner] = documentName.split('/')
      permissionsMap.set(owner, 'owner')
      permissionsMap.set('created', new Date().toISOString())
      
      console.log('✅ Default permissions set for document owner:', owner)
    }
  },

  async onDestroyDocument(data) {
    const { documentName, document } = data

    console.log('🗑️ Document destroyed:', documentName)

    // Cleanup - remove permission observer flag
    const permissionsMap = document.getMap('permissions')
    if (permissionsMap._hasPermissionObserver) {
      delete permissionsMap._hasPermissionObserver
      console.log('✅ Permission observer cleaned up for:', documentName)
    }
  },

  // Connection management
  async onConnect(data) {
    const { documentName, context, connection } = data
    const [owner, permlink] = documentName.split('/')
    
    if (context.user) {
      const user = context.user
      const permissions = user.permissions
      
      // Enhanced connection logging
      console.log(`[onConnect] User ${user.name} connected to ${documentName}`)
      console.log(`  Permission: ${permissions.permissionType}`)
      console.log(`  Can Edit: ${permissions.canEdit}`)
      console.log(`  Can Read: ${permissions.canRead}`)
      console.log(`  Connection ID: ${connection?.id || 'unknown'}`)
      console.log(`  Timestamp: ${new Date().toISOString()}`)
      
      // Mark connection as alive for keep-alive tracking
      if (connection) {
        connection.isAlive = true
        connection.lastActivity = Date.now()
        console.log(`[onConnect] Connection marked as alive for user ${user.name}`)
      }
      
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
    const { documentName, context, connection } = data
    const [owner, permlink] = documentName.split('/')
    
    if (context.user) {
      const user = context.user
      
      // Enhanced disconnect logging to debug the issue
      console.log(`[onDisconnect] User ${user.name} disconnected from ${documentName}`)
      console.log(`  Timestamp: ${new Date().toISOString()}`)
      console.log(`  Connection ID: ${connection?.id || 'unknown'}`)
      if (connection) {
        const connectionDuration = connection.lastActivity ? Date.now() - connection.lastActivity : 'unknown'
        console.log(`  Connection duration: ${connectionDuration}ms`)
      }
      
      // Log disconnect activity
      await hiveAuth.logActivity(owner, permlink, user.name, 'disconnect', {
        timestamp: new Date().toISOString(),
        connectionDuration: connection?.lastActivity ? Date.now() - connection.lastActivity : null
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

// Keep-alive interval reference
let keepAliveInterval = null

// Initialize and start server
async function startCollaborationServer() {
  try {
    // Setup database tables
    await setupCollaborationDatabase()
    
    // Start the server
    server.listen()
    
    console.log(`🚀 Hocuspocus collaboration server started with permission broadcasts enabled`)
    console.log(`[Server] Port: 1234`)
    console.log(`[Server] Timeout: ${server.configuration.timeout}ms`)
    console.log(`[Server] Permission broadcasts: ✅ ENABLED`)
    
    // ✅ STEP 5: Enhanced monitoring with permission broadcast tracking
    keepAliveInterval = setInterval(() => {
      const connections = server.getConnections()
      const documentCount = server.getDocumentsCount ? server.getDocumentsCount() : 'N/A'
      
      console.log(`📊 Server status: ${documentCount} active documents, ${connections.length} connections`)
      
      connections.forEach(connection => {
        if (connection.context?.user) {
          const user = connection.context.user
          const now = Date.now()
          const lastActivity = connection.lastActivity || connection.connectedAt || now
          const idleTime = now - lastActivity
          
          console.log(`[KeepAlive] User ${user.name}: idle for ${Math.round(idleTime / 1000)}s`)
        }
      })
    }, 300000) // Log every 5 minutes (as suggested in instructions)
    
  } catch (error) {
    console.error('Failed to start collaboration server:', error)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[Server] Shutting down...')
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval)
  }
  await server.destroy()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('[Server] Shutting down...')
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval)
  }
  await server.destroy()
  process.exit(0)
})

// Start the server if this file is run directly
if (require.main === module) {
  startCollaborationServer()
}



module.exports = { server, setupCollaborationDatabase, HiveAuthExtension } 