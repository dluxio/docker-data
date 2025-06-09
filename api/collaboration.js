const express = require('express')
const { Pool } = require('pg')
const config = require('../config')
const { createAuthMiddleware } = require('./onboarding')

const router = express.Router()

// Initialize database pool
const pool = new Pool({
  connectionString: config.dbcs,
})

// Auth middleware - any valid HIVE user can use collaboration
const authMiddleware = createAuthMiddleware(false, false)

// Test endpoint (no auth required)
router.get('/api/collaboration/test', (req, res) => {
  res.json({
    success: true,
    message: 'Collaboration API is working!',
    endpoints: [
      'GET /api/collaboration/documents',
      'POST /api/collaboration/documents', 
      'GET /api/collaboration/info/:owner/:permlink',
      'GET /api/collaboration/permissions/:owner/:permlink',
      'POST /api/collaboration/permissions/:owner/:permlink',
      'GET /api/collaboration/activity/:owner/:permlink',
      'GET /api/collaboration/debug/:owner/:permlink'
    ],
    websocket: 'ws://localhost:1234/{owner}/{permlink}',
    databases: 'Collaboration tables will be auto-created by WebSocket server'
  })
})

// Debug endpoint to inspect document content (no auth required for debugging)
router.get('/api/collaboration/debug/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const showContent = req.query.content === 'true'
    const showRaw = req.query.raw === 'true'
    
    validateDocumentPath(owner, permlink)
    
    const client = await pool.connect()
    try {
      const result = await client.query(
        'SELECT *, LENGTH(document_data) as content_size, OCTET_LENGTH(document_data) as byte_size FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found in database',
          suggestion: 'Document may not have been created via API or may only exist in Hocuspocus memory'
        })
      }
      
      const doc = result.rows[0]
      const contentSize = parseInt(doc.content_size) || 0
      const byteSize = parseInt(doc.byte_size) || 0
      
      // Log to console for server debugging
      console.log('=== DOCUMENT DEBUG ===')
      console.log(`Document: ${owner}/${permlink}`)
      console.log(`Content Size: ${contentSize} characters`)
      console.log(`Byte Size: ${byteSize} bytes`)
      console.log(`Is Public: ${doc.is_public}`)
      console.log(`Created: ${doc.created_at}`)
      console.log(`Updated: ${doc.updated_at}`)
      console.log(`Last Activity: ${doc.last_activity}`)
      
      if (doc.document_data) {
        console.log(`Content Preview (first 200 chars): ${doc.document_data.substring(0, 200)}${doc.document_data.length > 200 ? '...' : ''}`)
        console.log(`Content Type: ${typeof doc.document_data}`)
        console.log(`Has Actual Content: ${doc.document_data.trim().length > 0}`)
      } else {
        console.log('Document data is NULL or undefined')
      }
      console.log('=====================')
      
      const response = {
        success: true,
        document: {
          owner: doc.owner,
          permlink: doc.permlink,
          documentPath: `${doc.owner}/${doc.permlink}`,
          isPublic: doc.is_public,
          contentSize,
          byteSize,
          hasContent: contentSize > 0,
          hasActualContent: doc.document_data ? doc.document_data.trim().length > 0 : false,
          contentType: typeof doc.document_data,
          isNull: doc.document_data === null,
          isUndefined: doc.document_data === undefined,
          isEmpty: !doc.document_data || doc.document_data.trim().length === 0,
          createdAt: doc.created_at,
          updatedAt: doc.updated_at,
          lastActivity: doc.last_activity
        }
      }
      
      if (showContent && doc.document_data) {
        response.content = {
          preview: doc.document_data.substring(0, 500),
          isTruncated: doc.document_data.length > 500
        }
      }
      
      if (showRaw && doc.document_data) {
        response.rawContent = doc.document_data
      }
      
      res.json(response)
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error debugging document:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Apply auth middleware to all other collaboration routes (except test)
router.use('/api/collaboration', (req, res, next) => {
  if (req.path === '/test') {
    return next()
  }
  return authMiddleware(req, res, next)
})

// Helper function to validate document format
function validateDocumentPath(owner, permlink) {
  if (!owner || !permlink) {
    throw new Error('Invalid document format. Expected: owner/permlink')
  }
  if (owner.length > 50 || permlink.length > 255) {
    throw new Error('Owner or permlink too long')
  }
  return true
}

// Helper function to check document access
async function checkDocumentAccess(account, owner, permlink, requiredPermission = 'read') {
  const client = await pool.connect()
  try {
    // Owner always has full access
    if (account === owner) {
      return true
    }
    
    // Check if document is public (for read access)
    if (requiredPermission === 'read') {
      const docResult = await client.query(
        'SELECT is_public FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (docResult.rows.length > 0 && docResult.rows[0].is_public) {
        return true
      }
    }
    
    // Check explicit permissions
    const permResult = await client.query(
      'SELECT permission_type, can_read, can_edit, can_post_to_hive FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
      [owner, permlink, account]
    )
    
    if (permResult.rows.length === 0) {
      return false
    }
    
    const perm = permResult.rows[0]
    switch (requiredPermission) {
      case 'read':
        return perm.can_read
      case 'edit':
        return perm.can_edit
      case 'post':
        return perm.can_post_to_hive
      default:
        return false
    }
  } finally {
    client.release()
  }
}

// 1. List Documents
router.get('/api/collaboration/documents', async (req, res) => {
  try {
    const account = req.headers['x-account']
    const limit = Math.min(parseInt(req.query.limit) || 50, 100)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)
    const type = req.query.type || 'all'
    
    const client = await pool.connect()
    try {
      let query, params
      
      if (type === 'owned') {
        query = `
          SELECT d.owner, d.permlink, d.is_public, d.created_at, d.updated_at, d.last_activity,
                 LENGTH(d.document_data) as content_size,
                 'owner' as access_type
          FROM collaboration_documents d
          WHERE d.owner = $1
          ORDER BY d.last_activity DESC
          LIMIT $2 OFFSET $3
        `
        params = [account, limit, offset]
      } else if (type === 'shared') {
        query = `
          SELECT d.owner, d.permlink, d.is_public, d.created_at, d.updated_at, d.last_activity,
                 LENGTH(d.document_data) as content_size,
                 p.permission_type as access_type
          FROM collaboration_documents d
          JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink
          WHERE p.account = $1
          ORDER BY d.last_activity DESC
          LIMIT $2 OFFSET $3
        `
        params = [account, limit, offset]
      } else {
        // All accessible documents
        query = `
          SELECT DISTINCT d.owner, d.permlink, d.is_public, d.created_at, d.updated_at, d.last_activity,
                 LENGTH(d.document_data) as content_size,
                 CASE 
                   WHEN d.owner = $1 THEN 'owner'
                   WHEN p.permission_type IS NOT NULL THEN p.permission_type
                   WHEN d.is_public THEN 'public'
                   ELSE 'none'
                 END as access_type
          FROM collaboration_documents d
          LEFT JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink AND p.account = $1
          WHERE d.owner = $1 OR d.is_public = true OR p.account = $1
          ORDER BY d.last_activity DESC
          LIMIT $2 OFFSET $3
        `
        params = [account, limit, offset]
      }
      
      const result = await client.query(query, params)
      
      // Get total count for pagination
      const countQuery = type === 'owned' 
        ? 'SELECT COUNT(*) FROM collaboration_documents WHERE owner = $1'
        : type === 'shared'
        ? 'SELECT COUNT(*) FROM collaboration_documents d JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink WHERE p.account = $1'
        : 'SELECT COUNT(DISTINCT d.id) FROM collaboration_documents d LEFT JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink AND p.account = $1 WHERE d.owner = $1 OR d.is_public = true OR p.account = $1'
      
      const countParams = type === 'all' ? [account] : [account]
      const countResult = await client.query(countQuery, countParams)
      const total = parseInt(countResult.rows[0].count)
      
      const documents = result.rows.map(row => ({
        owner: row.owner,
        permlink: row.permlink,
        documentPath: `${row.owner}/${row.permlink}`,
        isPublic: row.is_public,
        hasContent: row.content_size > 0,
        contentSize: parseInt(row.content_size) || 0,
        accessType: row.access_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastActivity: row.last_activity
      }))
      
      res.json({
        success: true,
        documents,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error listing documents:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 2. Get Document Info
router.get('/api/collaboration/info/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    validateDocumentPath(owner, permlink)
    
    const hasAccess = await checkDocumentAccess(account, owner, permlink, 'read')
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to document'
      })
    }
    
    const client = await pool.connect()
    try {
      const result = await client.query(
        'SELECT owner, permlink, is_public, created_at, updated_at, last_activity, LENGTH(document_data) as content_size FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      const doc = result.rows[0]
      
      // Get user's access type
      let accessType = 'none'
      if (account === owner) {
        accessType = 'owner'
      } else if (doc.is_public) {
        accessType = 'public'
      } else {
        const permResult = await client.query(
          'SELECT permission_type FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
          [owner, permlink, account]
        )
        if (permResult.rows.length > 0) {
          accessType = permResult.rows[0].permission_type
        }
      }
      
      res.json({
        success: true,
        document: {
          owner: doc.owner,
          permlink: doc.permlink,
          documentPath: `${doc.owner}/${doc.permlink}`,
          isPublic: doc.is_public,
          hasContent: parseInt(doc.content_size) > 0,
          contentSize: parseInt(doc.content_size) || 0,
          accessType,
          websocketUrl: `ws://localhost:1234/${doc.owner}/${doc.permlink}`,
          createdAt: doc.created_at,
          updatedAt: doc.updated_at,
          lastActivity: doc.last_activity
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error getting document info:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 3. Create Document
router.post('/api/collaboration/documents', async (req, res) => {
  try {
    const account = req.headers['x-account']
    const { permlink, isPublic = false, title, description } = req.body
    
    if (!permlink) {
      return res.status(400).json({
        success: false,
        error: 'Permlink is required'
      })
    }
    
    validateDocumentPath(account, permlink)
    
    const client = await pool.connect()
    try {
      // Check if document already exists
      const existingDoc = await client.query(
        'SELECT id FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [account, permlink]
      )
      
      if (existingDoc.rows.length > 0) {
        return res.status(409).json({
          success: false,
          error: 'Document already exists'
        })
      }
      
      // Create document
      await client.query(`
        INSERT INTO collaboration_documents (owner, permlink, is_public, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), NOW())
      `, [account, permlink, isPublic])
      
      // Initialize stats
      await client.query(`
        INSERT INTO collaboration_stats (owner, permlink, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
      `, [account, permlink])
      
      // Log creation activity
      await client.query(`
        INSERT INTO collaboration_activity (owner, permlink, account, activity_type, activity_data)
        VALUES ($1, $2, $3, 'create', $4)
      `, [account, permlink, account, JSON.stringify({ title, description, isPublic })])
      
      res.json({
        success: true,
        document: {
          owner: account,
          permlink,
          documentPath: `${account}/${permlink}`,
          isPublic,
          websocketUrl: `ws://localhost:1234/${account}/${permlink}`,
          createdAt: new Date().toISOString()
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error creating document:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 4. Delete Document
router.delete('/api/collaboration/documents/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    validateDocumentPath(owner, permlink)
    
    // Only owner can delete
    if (account !== owner) {
      return res.status(403).json({
        success: false,
        error: 'Only document owner can delete document'
      })
    }
    
    const client = await pool.connect()
    try {
      // Delete in correct order due to foreign key constraints
      await client.query('DELETE FROM collaboration_activity WHERE owner = $1 AND permlink = $2', [owner, permlink])
      await client.query('DELETE FROM collaboration_permissions WHERE owner = $1 AND permlink = $2', [owner, permlink])
      await client.query('DELETE FROM collaboration_stats WHERE owner = $1 AND permlink = $2', [owner, permlink])
      const result = await client.query('DELETE FROM collaboration_documents WHERE owner = $1 AND permlink = $2', [owner, permlink])
      
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      res.json({
        success: true,
        message: 'Document deleted successfully'
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error deleting document:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 5. Get Document Permissions
router.get('/api/collaboration/permissions/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    validateDocumentPath(owner, permlink)
    
    // Only owner can view permissions
    if (account !== owner) {
      return res.status(403).json({
        success: false,
        error: 'Only document owner can view permissions'
      })
    }
    
    const client = await pool.connect()
    try {
      const result = await client.query(
        'SELECT account, permission_type, can_read, can_edit, can_post_to_hive, granted_by, granted_at FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 ORDER BY granted_at DESC',
        [owner, permlink]
      )
      
      const permissions = result.rows.map(row => ({
        account: row.account,
        permissionType: row.permission_type,
        capabilities: {
          canRead: row.can_read,
          canEdit: row.can_edit,
          canPostToHive: row.can_post_to_hive
        },
        grantedBy: row.granted_by,
        grantedAt: row.granted_at
      }))
      
      res.json({
        success: true,
        document: `${owner}/${permlink}`,
        permissions
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error getting permissions:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Grant Permission endpoint  
router.post('/api/collaboration/permissions/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    const { targetAccount, permissionType } = req.body
    
    validateDocumentPath(owner, permlink)
    
    if (!targetAccount || !permissionType) {
      return res.status(400).json({
        success: false,
        error: 'targetAccount and permissionType are required'
      })
    }
    
    // Only owner can grant permissions
    if (account !== owner) {
      return res.status(403).json({
        success: false,
        error: 'Only document owner can grant permissions'
      })
    }
    
    // Validate permission type
    const validTypes = ['readonly', 'editable', 'postable']
    if (!validTypes.includes(permissionType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid permission type. Must be one of: ${validTypes.join(', ')}`
      })
    }
    
    const client = await pool.connect()
    try {
      // Set capabilities based on permission type
      const capabilities = {
        readonly: { can_read: true, can_edit: false, can_post_to_hive: false },
        editable: { can_read: true, can_edit: true, can_post_to_hive: false },
        postable: { can_read: true, can_edit: true, can_post_to_hive: true }
      }
      
      const caps = capabilities[permissionType]
      
      // Insert or update permission
      await client.query(`
        INSERT INTO collaboration_permissions (owner, permlink, account, permission_type, can_read, can_edit, can_post_to_hive, granted_by, granted_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (owner, permlink, account)
        DO UPDATE SET 
          permission_type = EXCLUDED.permission_type,
          can_read = EXCLUDED.can_read,
          can_edit = EXCLUDED.can_edit,
          can_post_to_hive = EXCLUDED.can_post_to_hive,
          granted_by = EXCLUDED.granted_by,
          granted_at = NOW()
      `, [owner, permlink, targetAccount, permissionType, caps.can_read, caps.can_edit, caps.can_post_to_hive, account])
      
      // Log activity
      await client.query(`
        INSERT INTO collaboration_activity (owner, permlink, account, activity_type, activity_data)
        VALUES ($1, $2, $3, 'permission_granted', $4)
      `, [owner, permlink, account, JSON.stringify({ targetAccount, permissionType })])
      
      res.json({
        success: true,
        message: `${permissionType} permission granted to @${targetAccount}`,
        permission: {
          account: targetAccount,
          permissionType,
          grantedBy: account,
          grantedAt: new Date().toISOString()
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error granting permission:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 7. Revoke Permission
router.delete('/api/collaboration/permissions/:owner/:permlink/:targetAccount', async (req, res) => {
  try {
    const { owner, permlink, targetAccount } = req.params
    const account = req.headers['x-account']
    
    validateDocumentPath(owner, permlink)
    
    // Only owner can revoke permissions
    if (account !== owner) {
      return res.status(403).json({
        success: false,
        error: 'Only document owner can revoke permissions'
      })
    }
    
    const client = await pool.connect()
    try {
      const result = await client.query(
        'DELETE FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
        [owner, permlink, targetAccount]
      )
      
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: 'Permission not found'
        })
      }
      
      // Log activity
      await client.query(`
        INSERT INTO collaboration_activity (owner, permlink, account, activity_type, activity_data)
        VALUES ($1, $2, $3, 'permission_revoked', $4)
      `, [owner, permlink, account, JSON.stringify({ targetAccount })])
      
      res.json({
        success: true,
        message: `Permission revoked from @${targetAccount}`
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error revoking permission:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 8. Get Activity Log
router.get('/api/collaboration/activity/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    const limit = Math.min(parseInt(req.query.limit) || 50, 100)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)
    
    validateDocumentPath(owner, permlink)
    
    const hasAccess = await checkDocumentAccess(account, owner, permlink, 'read')
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to document'
      })
    }
    
    const client = await pool.connect()
    try {
      const result = await client.query(
        'SELECT account, activity_type, activity_data, created_at FROM collaboration_activity WHERE owner = $1 AND permlink = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',
        [owner, permlink, limit, offset]
      )
      
      const countResult = await client.query(
        'SELECT COUNT(*) FROM collaboration_activity WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      const total = parseInt(countResult.rows[0].count)
      
      res.json({
        success: true,
        document: `${owner}/${permlink}`,
        activity: result.rows,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error getting activity:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 9. Get Document Statistics
router.get('/api/collaboration/stats/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    validateDocumentPath(owner, permlink)
    
    const hasAccess = await checkDocumentAccess(account, owner, permlink, 'read')
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to document'
      })
    }
    
    const client = await pool.connect()
    try {
      // Get basic stats
      const statsResult = await client.query(
        'SELECT total_users, active_users, last_activity, total_edits, document_size FROM collaboration_stats WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (statsResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      const stats = statsResult.rows[0]
      
      // Get permissions summary
      const permSummary = await client.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN permission_type = 'readonly' THEN 1 END) as readonly_users,
          COUNT(CASE WHEN permission_type = 'editable' THEN 1 END) as editable_users,
          COUNT(CASE WHEN permission_type = 'postable' THEN 1 END) as postable_users
        FROM collaboration_permissions 
        WHERE owner = $1 AND permlink = $2
      `, [owner, permlink])
      
      // Get recent activity summary
      const recentActivity = await client.query(`
        SELECT 
          activity_type,
          COUNT(*) as count,
          MAX(created_at) as last_occurrence
        FROM collaboration_activity 
        WHERE owner = $1 AND permlink = $2 
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY activity_type
        ORDER BY count DESC
      `, [owner, permlink])
      
      // Calculate inactivity days
      const lastActivity = stats.last_activity ? new Date(stats.last_activity) : new Date()
      const inactivityDays = Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
      
      res.json({
        success: true,
        document: `${owner}/${permlink}`,
        stats: {
          total_users: parseInt(stats.total_users) || 0,
          active_users: parseInt(stats.active_users) || 0,
          last_activity: stats.last_activity,
          total_edits: parseInt(stats.total_edits) || 0,
          document_size: parseInt(stats.document_size) || 0,
          permissions_summary: {
            total_users: permSummary.rows[0].total_users,
            readonly_users: permSummary.rows[0].readonly_users,
            editable_users: permSummary.rows[0].editable_users,
            postable_users: permSummary.rows[0].postable_users
          },
          recent_activity: recentActivity.rows,
          inactivity_days: inactivityDays
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error getting stats:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

module.exports = router 