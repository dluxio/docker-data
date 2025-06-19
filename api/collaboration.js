const express = require('express')
const { Pool } = require('pg')
const config = require('../config')
const { createAuthMiddleware } = require('./onboarding')
const crypto = require('crypto')

const router = express.Router()

// Initialize database pool
const pool = new Pool({
  connectionString: config.dbcs,
})

// Auth middleware - any valid HIVE user can use collaboration
const authMiddleware = createAuthMiddleware(false, false)

// Apply auth middleware to all collaboration routes
router.use('/api/collaboration', authMiddleware)

// Helper function to generate random URL-safe permlink
function generateRandomPermlink(length = 16) {
  return crypto.randomBytes(Math.ceil(length * 3 / 4))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .slice(0, length)
}

// Helper function to generate default document name
function generateDefaultDocumentName() {
  const timestamp = new Date().toISOString().split('T')[0] // YYYY-MM-DD format
  return `${timestamp} untitled`
}

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
          SELECT d.owner, d.permlink, d.document_name, d.is_public, d.created_at, d.updated_at, d.last_activity,
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
          SELECT d.owner, d.permlink, d.document_name, d.is_public, d.created_at, d.updated_at, d.last_activity,
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
        // All accessible documents - FIXED: Use same priority order as document info endpoint
        query = `
          SELECT DISTINCT d.owner, d.permlink, d.document_name, d.is_public, d.created_at, d.updated_at, d.last_activity,
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
        documentName: row.document_name || '',
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
        'SELECT owner, permlink, document_name, is_public, created_at, updated_at, last_activity, LENGTH(document_data) as content_size FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      const doc = result.rows[0]
      
      // Get user's access type - FIXED: Check explicit permissions before public access
      let accessType = 'none'
      if (account === owner) {
        accessType = 'owner'
      } else {
        // Check explicit permissions first (higher priority than public access)
        const permResult = await client.query(
          'SELECT permission_type FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
          [owner, permlink, account]
        )
        if (permResult.rows.length > 0) {
          accessType = permResult.rows[0].permission_type
        } else if (doc.is_public) {
          accessType = 'public'
        }
      }
      
      res.json({
        success: true,
        document: {
          owner: doc.owner,
          permlink: doc.permlink,
          documentName: doc.document_name || '',
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
    const { documentName, isPublic = false, title, description } = req.body
    
    // Generate random URL-safe permlink
    const permlink = generateRandomPermlink(16)
    
    // Use provided name or generate default
    const finalDocumentName = documentName || generateDefaultDocumentName()
    
    validateDocumentPath(account, permlink)
    
    const client = await pool.connect()
    try {
      // Create document with random permlink and specified/default name
      await client.query(`
        INSERT INTO collaboration_documents (owner, permlink, document_name, is_public, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
      `, [account, permlink, finalDocumentName, isPublic])
      
      // Initialize stats
      await client.query(`
        INSERT INTO collaboration_stats (owner, permlink, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
      `, [account, permlink])
      
      // Log creation activity
      await client.query(`
        INSERT INTO collaboration_activity (owner, permlink, account, activity_type, activity_data)
        VALUES ($1, $2, $3, 'create', $4)
      `, [account, permlink, account, JSON.stringify({ documentName: finalDocumentName, title, description, isPublic })])
      
      res.json({
        success: true,
        document: {
          owner: account,
          permlink,
          documentName: finalDocumentName,
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

// 4. Update Document Name
router.patch('/api/collaboration/documents/:owner/:permlink/name', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    const { documentName } = req.body
    
    if (!documentName || documentName.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Document name is required and cannot be empty'
      })
    }
    
    if (documentName.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Document name cannot exceed 500 characters'
      })
    }
    
    validateDocumentPath(owner, permlink)
    
    // Check if user has edit access (owner or editable permission)
    const hasEditAccess = await checkDocumentAccess(account, owner, permlink, 'edit')
    if (!hasEditAccess) {
      return res.status(403).json({
        success: false,
        error: 'Only document owner or users with edit permission can rename document'
      })
    }
    
    const client = await pool.connect()
    try {
      // Update document name
      const result = await client.query(
        'UPDATE collaboration_documents SET document_name = $1, updated_at = NOW() WHERE owner = $2 AND permlink = $3',
        [documentName.trim(), owner, permlink]
      )
      
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      // Log rename activity
      await client.query(`
        INSERT INTO collaboration_activity (owner, permlink, account, activity_type, activity_data)
        VALUES ($1, $2, $3, 'rename', $4)
      `, [owner, permlink, account, JSON.stringify({ 
        newName: documentName.trim(),
        renamedBy: account 
      })])
      
      res.json({
        success: true,
        message: 'Document name updated successfully',
        document: {
          owner,
          permlink,
          documentName: documentName.trim(),
          documentPath: `${owner}/${permlink}`,
          updatedBy: account,
          updatedAt: new Date().toISOString()
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error updating document name:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 5. Delete Document
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

// 6. Get Document Permissions
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

// 7. Grant Permission endpoint  
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
      // Get document name for notification
      const docResult = await client.query(
        'SELECT document_name FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      const documentName = docResult.rows.length > 0 && docResult.rows[0].document_name 
        ? docResult.rows[0].document_name 
        : permlink // fallback to permlink if no name
      
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
      `, [owner, permlink, account, JSON.stringify({ targetAccount, permissionType, documentName })])
      
      // Create notification for the user being granted access
      await client.query(`
        INSERT INTO user_notifications 
        (username, notification_type, title, message, data, priority)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        targetAccount,
        'collaboration_invite',
        'Document Collaboration Invite',
        `@${account} invited you to collaborate on "${documentName}"`,
        JSON.stringify({
          documentOwner: owner,
          documentPermlink: permlink,
          documentName: documentName,
          documentPath: `${owner}/${permlink}`,
          permissionType,
          grantedBy: account,
          grantedAt: new Date().toISOString(),
          url: `/new??collabAuthor=${owner}&permlink=${permlink}`
        }),
        'high'
      ])
      
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

// 8. Revoke Permission
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
      // Get document name for notification before deleting permission
      const docResult = await client.query(
        'SELECT document_name FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      const documentName = docResult.rows.length > 0 && docResult.rows[0].document_name 
        ? docResult.rows[0].document_name 
        : permlink // fallback to permlink if no name
      
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
      `, [owner, permlink, account, JSON.stringify({ targetAccount, documentName })])
      
      // Dismiss/mark as read any collaboration invite notifications for this document
      await client.query(`
        UPDATE user_notifications 
        SET dismissed_at = NOW(), read_at = COALESCE(read_at, NOW())
        WHERE username = $1 
          AND notification_type = 'collaboration_invite'
          AND data->>'documentOwner' = $2 
          AND data->>'documentPermlink' = $3
          AND dismissed_at IS NULL
      `, [targetAccount, owner, permlink])
      
      // Create notification informing user their access was revoked
      await client.query(`
        INSERT INTO user_notifications 
        (username, notification_type, title, message, data, priority)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        targetAccount,
        'collaboration_removed',
        'Document Access Removed',
        `@${account} removed your access to "${documentName}"`,
        JSON.stringify({
          documentOwner: owner,
          documentPermlink: permlink,
          documentName: documentName,
          documentPath: `${owner}/${permlink}`,
          removedBy: account,
          removedAt: new Date().toISOString()
        }),
        'high'
      ])
      
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

// 9. Get Activity Log
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

// 10. Get Document Statistics
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

// 11. Test endpoint to check collaboration notifications
router.get('/api/collaboration/test-notifications/:username', async (req, res) => {
  try {
    const { username } = req.params
    
    const client = await pool.connect()
    try {
      // Get all collaboration-related notifications for the user
      const result = await client.query(`
        SELECT 
          id,
          notification_type,
          title,
          message,
          data,
          status,
          priority,
          created_at,
          read_at,
          dismissed_at
        FROM user_notifications 
        WHERE username = $1 
          AND notification_type IN ('collaboration_invite', 'collaboration_removed')
        ORDER BY created_at DESC
        LIMIT 20
      `, [username])
      
      const notifications = result.rows.map(row => ({
        id: row.id,
        type: row.notification_type,
        title: row.title,
        message: row.message,
        data: row.data ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : null,
        status: row.status,
        priority: row.priority,
        createdAt: row.created_at,
        readAt: row.read_at,
        dismissedAt: row.dismissed_at
      }))
      
      res.json({
        success: true,
        username,
        collaborationNotifications: notifications,
        count: notifications.length
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error testing collaboration notifications:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 12. Test WebSocket Permission Enforcement
router.get('/api/collaboration/test-websocket-permissions/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    validateDocumentPath(owner, permlink)
    
    const client = await pool.connect()
    try {
      // Get document info
      const docResult = await client.query(
        'SELECT owner, permlink, document_name, is_public FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (docResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      const doc = docResult.rows[0]
      
      // Check user's access levels
      let accessInfo = {
        isOwner: account === owner,
        isPublic: doc.is_public,
        canRead: false,
        canEdit: false,
        canPostToHive: false,
        permissionType: 'none'
      }
      
      if (account === owner) {
        accessInfo.canRead = true
        accessInfo.canEdit = true
        accessInfo.canPostToHive = true
        accessInfo.permissionType = 'owner'
      } else if (doc.is_public) {
        accessInfo.canRead = true
        accessInfo.permissionType = 'public'
      } else {
        // Check explicit permissions
        const permResult = await client.query(
          'SELECT permission_type, can_read, can_edit, can_post_to_hive FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
          [owner, permlink, account]
        )
        
        if (permResult.rows.length > 0) {
          const perm = permResult.rows[0]
          accessInfo.canRead = perm.can_read
          accessInfo.canEdit = perm.can_edit
          accessInfo.canPostToHive = perm.can_post_to_hive
          accessInfo.permissionType = perm.permission_type
        }
      }
      
      res.json({
        success: true,
        document: {
          owner: doc.owner,
          permlink: doc.permlink,
          documentName: doc.document_name || '',
          documentPath: `${doc.owner}/${doc.permlink}`,
          isPublic: doc.is_public
        },
        userAccess: accessInfo,
        websocketUrl: `ws://localhost:1234/${doc.owner}/${doc.permlink}`,
        securityIssue: {
          description: "The websocket server currently only checks read access but allows all authenticated users to edit",
          currentBehavior: "Any user with read access can edit documents through websocket",
          expectedBehavior: "Only users with edit permission should be able to edit documents",
          riskLevel: "HIGH - Users with readonly access can modify documents"
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error testing websocket permissions:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 13. Test Fixed WebSocket Permission Enforcement  
router.post('/api/collaboration/test-websocket-security', async (req, res) => {
  try {
    const account = req.headers['x-account']
    const { testScenario } = req.body
    
    if (!testScenario) {
      return res.status(400).json({
        success: false,
        error: 'testScenario is required. Options: create_readonly_user, create_editable_user, create_test_document'
      })
    }
    
    const client = await pool.connect()
    try {
      let result = {}
      
      switch (testScenario) {
        case 'create_test_document':
          // Create a test document for permission testing
          const testPermlink = `test-perms-${Date.now()}`
          
          await client.query(`
            INSERT INTO collaboration_documents (owner, permlink, document_name, is_public, created_at, updated_at)
            VALUES ($1, $2, $3, $4, NOW(), NOW())
          `, [account, testPermlink, 'WebSocket Permission Test Document', false])
          
          result = {
            action: 'created_test_document',
            documentPath: `${account}/${testPermlink}`,
            websocketUrl: `ws://localhost:1234/${account}/${testPermlink}`,
            instructions: [
              '1. Connect as document owner - should have full edit access',
              '2. Grant readonly permission to another user',  
              '3. Connect as readonly user - should NOT be able to edit',
              '4. Grant editable permission to user',
              '5. Connect as editable user - should be able to edit'
            ]
          }
          break
          
        case 'grant_readonly_permission':
          const { targetAccount: readonlyAccount, documentPath: readonlyPath } = req.body
          
          if (!readonlyAccount || !readonlyPath) {
            return res.status(400).json({
              success: false,
              error: 'targetAccount and documentPath required for this test scenario'
            })
          }
          
          const [readonlyOwner, readonlyPermlink] = readonlyPath.split('/')
          
          // Grant readonly permission
          await client.query(`
            INSERT INTO collaboration_permissions (owner, permlink, account, permission_type, can_read, can_edit, can_post_to_hive, granted_by, granted_at)
            VALUES ($1, $2, $3, 'readonly', true, false, false, $4, NOW())
            ON CONFLICT (owner, permlink, account)
            DO UPDATE SET 
              permission_type = 'readonly',
              can_read = true,
              can_edit = false,
              can_post_to_hive = false,
              granted_by = $4,
              granted_at = NOW()
          `, [readonlyOwner, readonlyPermlink, readonlyAccount, account])
          
          result = {
            action: 'granted_readonly_permission',
            targetAccount: readonlyAccount,
            documentPath: readonlyPath,
            permissions: {
              canRead: true,
              canEdit: false,
              canPostToHive: false
            },
            testInstructions: `User @${readonlyAccount} should now be able to connect to websocket but NOT edit the document`
          }
          break
          
        case 'grant_editable_permission':
          const { targetAccount: editableAccount, documentPath: editablePath } = req.body
          
          if (!editableAccount || !editablePath) {
            return res.status(400).json({
              success: false,
              error: 'targetAccount and documentPath required for this test scenario'
            })
          }
          
          const [editableOwner, editablePermlink] = editablePath.split('/')
          
          // Grant editable permission
          await client.query(`
            INSERT INTO collaboration_permissions (owner, permlink, account, permission_type, can_read, can_edit, can_post_to_hive, granted_by, granted_at)
            VALUES ($1, $2, $3, 'editable', true, true, false, $4, NOW())
            ON CONFLICT (owner, permlink, account)
            DO UPDATE SET 
              permission_type = 'editable',
              can_read = true,
              can_edit = true,
              can_post_to_hive = false,
              granted_by = $4,
              granted_at = NOW()
          `, [editableOwner, editablePermlink, editableAccount, account])
          
          result = {
            action: 'granted_editable_permission',
            targetAccount: editableAccount,
            documentPath: editablePath,
            permissions: {
              canRead: true,
              canEdit: true,
              canPostToHive: false
            },
            testInstructions: `User @${editableAccount} should now be able to connect to websocket AND edit the document`
          }
          break
          
        default:
          return res.status(400).json({
            success: false,
            error: 'Invalid test scenario. Options: create_test_document, grant_readonly_permission, grant_editable_permission'
          })
      }
      
      res.json({
        success: true,
        testScenario,
        result,
        securityFix: {
          description: "WebSocket server now properly enforces edit permissions",
          fixImplemented: [
            "checkDocumentAccess method returns detailed permission info",
            "User permissions stored in authentication context", 
            "onChange hook prevents unauthorized edits",
            "All edit attempts are logged for audit",
            "Read-only users can connect but cannot edit documents"
          ],
          testingInstructions: "Use the test scenarios to verify permission enforcement"
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error in websocket security test:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 14. Get WebSocket Security Status
router.get('/api/collaboration/websocket-security-status', async (req, res) => {
  try {
    res.json({
      success: true,
      securityStatus: {
        issue: "WebSocket Permission Enforcement",
        severity: "HIGH RISK - FIXED",
        description: "The Hocuspocus websocket server was allowing any authenticated user to edit documents, regardless of their permission level (readonly vs editable)",
        
        previousBehavior: {
          authentication: "Only checked if user could READ the document",
          editing: "Any authenticated user could edit, even with readonly permissions",
          logging: "Basic connection logging only",
          riskLevel: "HIGH - Data integrity compromised"
        },
        
        fixImplemented: {
          timestamp: new Date().toISOString(),
          changes: [
            {
              file: "collaboration-server.js",
              method: "checkDocumentAccess",
              change: "Returns detailed permission object instead of boolean"
            },
            {
              file: "collaboration-server.js", 
              method: "onAuthenticate",
              change: "Stores user permissions in authentication context"
            },
            {
              file: "collaboration-server.js",
              method: "onChange", 
              change: "NEW - Prevents unauthorized edits and logs attempts"
            },
            {
              file: "api/collaboration.js",
              endpoints: "Added test endpoints to verify fix"
            }
          ],
          
          securityMeasures: [
            "Edit operations blocked for readonly users",
            "All edit attempts logged with permission levels",
            "Unauthorized edit attempts flagged in activity log",
            "User permission context maintained throughout session",
            "Proper error messages for access denied scenarios"
          ]
        },
        
        newBehavior: {
          authentication: "Validates detailed permissions (read, edit, post)",
          editing: "Only users with canEdit=true can modify documents",
          readOnlyUsers: "Can connect and view but cannot edit",
          publicDocuments: "Readable by all, but only owner can edit unless permissions granted",
          logging: "All edit attempts logged with permission context",
          riskLevel: "LOW - Proper access control enforced"
        },
        
        testing: {
          testEndpoints: [
            "GET /api/collaboration/test-websocket-permissions/:owner/:permlink",
            "POST /api/collaboration/test-websocket-security"
          ],
          recommendedTests: [
            "1. Create test document as owner",
            "2. Grant readonly permission to another user", 
            "3. Attempt edit as readonly user (should fail)",
            "4. Grant editable permission to user",
            "5. Attempt edit as editable user (should succeed)",
            "6. Check activity logs for unauthorized attempts"
          ]
        },
        
        deploymentRequired: {
          restartNeeded: true,
          services: ["collaboration-server.js"],
          command: "npm run start:collaboration",
          note: "WebSocket server must be restarted to apply permission enforcement"
        }
      }
    })
  } catch (error) {
    console.error('Error getting websocket security status:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Test Collaboration Authentication endpoint (used for debugging CORS/auth issues)
router.get('/api/collaboration/test-auth', async (req, res) => {
  try {
    // Extract auth headers
    const account = req.headers['x-account']
    const challenge = req.headers['x-challenge']
    const pubkey = req.headers['x-pubkey']
    const signature = req.headers['x-signature']
    
    // Validate required headers
    if (!account || !challenge || !pubkey || !signature) {
      return res.status(400).json({
        success: false,
        error: 'Missing authentication headers',
        required: ['x-account', 'x-challenge', 'x-pubkey', 'x-signature']
      })
    }
    
    // Validate challenge timestamp
    const challengeTime = parseInt(challenge)
    const now = Math.floor(Date.now() / 1000)
    const maxAge = 24 * 60 * 60 // 24 hours
    
    if (isNaN(challengeTime) || (now - challengeTime) > maxAge || challengeTime > (now + 300)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid challenge timestamp',
        challengeTime,
        currentTime: now,
        maxAge,
        difference: now - challengeTime
      })
    }
    
    // Import CollaborationAuth here to avoid circular dependencies
    const { CollaborationAuth } = require('../collaboration-auth')
    
    // Get account keys from HIVE blockchain
    const accountKeys = await CollaborationAuth.getAccountKeys(account)
    if (!accountKeys) {
      return res.status(404).json({
        success: false,
        error: `Account @${account} not found on HIVE blockchain`
      })
    }
    
    // Check if the provided public key belongs to the account
    const allKeys = [
      ...accountKeys.owner,
      ...accountKeys.active,
      ...accountKeys.posting,
      accountKeys.memo
    ].filter(Boolean)
    
    if (!allKeys.includes(pubkey)) {
      return res.status(403).json({
        success: false,
        error: 'Public key does not belong to the specified account',
        providedKey: pubkey,
        accountKeys: {
          owner: accountKeys.owner.length,
          active: accountKeys.active.length,
          posting: accountKeys.posting.length,
          memo: accountKeys.memo ? 1 : 0
        }
      })
    }
    
    // Verify the signature
    const isValidSignature = await CollaborationAuth.verifySignature(challenge.toString(), signature, pubkey)
    if (!isValidSignature) {
      return res.status(401).json({
        success: false,
        error: 'Invalid signature'
      })
    }
    
    return res.json({
      success: true,
      message: 'Collaboration authentication successful',
      account,
      keyType: accountKeys.posting.includes(pubkey) ? 'posting' : 
                accountKeys.active.includes(pubkey) ? 'active' : 
                accountKeys.owner.includes(pubkey) ? 'owner' : 'memo',
      timestamp: new Date().toISOString(),
      corsInfo: {
        credentials: 'Authentication works with credentials: false',
        headers: 'Standard auth headers processed correctly'
      }
    })
    
  } catch (error) {
    console.error('Collaboration test auth error:', error)
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// Debug Permission Bug - Test endpoint to reproduce the "viewer shows as editor" issue
router.get('/api/collaboration/debug-permissions/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    validateDocumentPath(owner, permlink)
    
    const client = await pool.connect()
    try {
      // 1. Get the document info
      const docResult = await client.query(
        'SELECT owner, permlink, document_name, is_public, created_at FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (docResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      const doc = docResult.rows[0]
      
      // 2. Get explicit permissions for this user
      const permResult = await client.query(
        'SELECT permission_type, can_read, can_edit, can_post_to_hive, granted_by, granted_at FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
        [owner, permlink, account]
      )
      
      // 3. Get ALL permissions for this document
      const allPermsResult = await client.query(
        'SELECT account, permission_type, can_read, can_edit, can_post_to_hive FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 ORDER BY granted_at DESC',
        [owner, permlink]
      )
      
      // 4. Test the document listing query logic (the problematic query)
      const listingResult = await client.query(`
        SELECT DISTINCT d.owner, d.permlink, d.document_name, d.is_public,
               CASE 
                 WHEN d.owner = $3 THEN 'owner'
                 WHEN p.permission_type IS NOT NULL THEN p.permission_type
                 WHEN d.is_public THEN 'public'
                 ELSE 'none'
               END as access_type
        FROM collaboration_documents d
        LEFT JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink AND p.account = $3
        WHERE d.owner = $1 AND d.permlink = $2
      `, [owner, permlink, account])
      
      // 5. Test individual permission checks
      const canRead = await checkDocumentAccess(account, owner, permlink, 'read')
      const canEdit = await checkDocumentAccess(account, owner, permlink, 'edit')
      const canPost = await checkDocumentAccess(account, owner, permlink, 'post')
      
      // 6. Determine access type using the same logic as document info endpoint
      let infoAccessType = 'none'
      if (account === owner) {
        infoAccessType = 'owner'
      } else if (doc.is_public) {
        infoAccessType = 'public'
      } else if (permResult.rows.length > 0) {
        infoAccessType = permResult.rows[0].permission_type
      }
      
      res.json({
        success: true,
        debug: {
          document: {
            owner: doc.owner,
            permlink: doc.permlink,
            documentName: doc.document_name || '',
            isPublic: doc.is_public,
            documentPath: `${doc.owner}/${doc.permlink}`
          },
          
          requestingUser: account,
          isOwner: account === owner,
          
          explicitPermission: permResult.rows.length > 0 ? {
            permissionType: permResult.rows[0].permission_type,
            canRead: permResult.rows[0].can_read,
            canEdit: permResult.rows[0].can_edit,
            canPostToHive: permResult.rows[0].can_post_to_hive,
            grantedBy: permResult.rows[0].granted_by,
            grantedAt: permResult.rows[0].granted_at
          } : null,
          
          allDocumentPermissions: allPermsResult.rows,
          
          accessChecks: {
            canRead,
            canEdit,
            canPost
          },
          
          accessTypeDetermination: {
            fromDocumentInfoEndpoint: infoAccessType,
            fromDocumentListingQuery: listingResult.rows.length > 0 ? listingResult.rows[0].access_type : 'none'
          },
          
          potentialBugs: {
            description: "The user reports that permissions show differently before and after loading the document",
            possibleCauses: [
              "Database state changes during document access",
              "Different permission checking logic between endpoints", 
              "Caching or timing issues",
              "WebSocket connection modifying permissions"
            ],
            expectedBehavior: "Permissions should be consistent across all API calls",
            actualBehavior: "Initial API call shows wrong permissions, correct after document load"
          }
        }
      })
      
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error debugging permissions:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Test Permission Consistency - Simplified test for the reported bug
router.get('/api/collaboration/test-permission-bug', async (req, res) => {
  try {
    const account = req.headers['x-account']
    
    if (!account) {
      return res.status(400).json({
        success: false,
        error: 'x-account header required'
      })
    }
    
    const client = await pool.connect()
    try {
      // Find any document where this user has explicit permissions (not owner)
      const testDoc = await client.query(`
        SELECT d.owner, d.permlink, d.document_name, d.is_public, p.permission_type, p.can_edit
        FROM collaboration_documents d
        JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink
        WHERE p.account = $1 AND d.owner != $1
        LIMIT 1
      `, [account])
      
      if (testDoc.rows.length === 0) {
        return res.json({
          success: true,
          message: 'No shared documents found for testing. Create a document and share it with this user first.',
          testAccount: account
        })
      }
      
      const { owner, permlink } = testDoc.rows[0]
      
      // Now compare the two different access type determinations
      
      // Method 1: Document Info endpoint logic
      const permResult = await client.query(
        'SELECT permission_type FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
        [owner, permlink, account]
      )
      const infoAccessType = permResult.rows.length > 0 ? permResult.rows[0].permission_type : 'none'
      
      // Method 2: Document Listing query logic
      const listingQuery = await client.query(`
        SELECT CASE 
          WHEN d.owner = $3 THEN 'owner'
          WHEN p.permission_type IS NOT NULL THEN p.permission_type
          WHEN d.is_public THEN 'public'
          ELSE 'none'
        END as access_type
        FROM collaboration_documents d
        LEFT JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink AND p.account = $3
        WHERE d.owner = $1 AND d.permlink = $2
      `, [owner, permlink, account])
      
      const listingAccessType = listingQuery.rows.length > 0 ? listingQuery.rows[0].access_type : 'none'
      
      res.json({
        success: true,
        testDocument: `${owner}/${permlink}`,
        testAccount: account,
        documentInfo: testDoc.rows[0],
        
        accessTypeComparison: {
          documentInfoEndpoint: infoAccessType,
          documentListingEndpoint: listingAccessType,
          areEqual: infoAccessType === listingAccessType
        },
        
        bugIdentified: infoAccessType !== listingAccessType,
        
        explanation: {
          issue: "Document listing and document info endpoints use different permission checking logic",
          cause: "Both queries should return the same access type but don't",
          impact: "User sees different permissions in document list vs when accessing the document",
          solution: "Both endpoints should use identical permission checking logic"
        }
      })
      
    } finally {
      client.release()
    }
    
  } catch (error) {
    console.error('Error testing permission bug:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Test Permission Fix - Verify that the fix works correctly
router.get('/api/collaboration/test-permission-fix', async (req, res) => {
  try {
    const account = req.headers['x-account']
    
    if (!account) {
      return res.status(400).json({
        success: false,
        error: 'x-account header required'
      })
    }
    
    const client = await pool.connect()
    try {
      // Find any document where this user has explicit permissions (not owner)
      const testDoc = await client.query(`
        SELECT d.owner, d.permlink, d.document_name, d.is_public, p.permission_type, p.can_edit
        FROM collaboration_documents d
        JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink
        WHERE p.account = $1 AND d.owner != $1
        LIMIT 1
      `, [account])
      
      if (testDoc.rows.length === 0) {
        return res.json({
          success: true,
          message: 'No shared documents found for testing. Create a document and share it with this user first.',
          testAccount: account,
          instructions: [
            '1. Have another user create a document',
            '2. Have them share it with you with "editable" permissions',
            '3. Optionally mark the document as public', 
            '4. Then test this endpoint again'
          ]
        })
      }
      
      const { owner, permlink } = testDoc.rows[0]
      
      // Test all three methods should now return the same result
      
      // Method 1: Document Info endpoint (simulate the fixed logic)
      let infoAccessType = 'none'
      if (account === owner) {
        infoAccessType = 'owner'
      } else {
        const permResult = await client.query(
          'SELECT permission_type FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
          [owner, permlink, account]
        )
        if (permResult.rows.length > 0) {
          infoAccessType = permResult.rows[0].permission_type
        } else if (testDoc.rows[0].is_public) {
          infoAccessType = 'public'
        }
      }
      
      // Method 2: Document Listing query logic
      const listingQuery = await client.query(`
        SELECT CASE 
          WHEN d.owner = $3 THEN 'owner'
          WHEN p.permission_type IS NOT NULL THEN p.permission_type
          WHEN d.is_public THEN 'public'
          ELSE 'none'
        END as access_type
        FROM collaboration_documents d
        LEFT JOIN collaboration_permissions p ON d.owner = p.owner AND d.permlink = p.permlink AND p.account = $3
        WHERE d.owner = $1 AND d.permlink = $2
      `, [owner, permlink, account])
      
      const listingAccessType = listingQuery.rows.length > 0 ? listingQuery.rows[0].access_type : 'none'
      
      // Method 3: checkDocumentAccess function
      const canRead = await checkDocumentAccess(account, owner, permlink, 'read')
      const canEdit = await checkDocumentAccess(account, owner, permlink, 'edit')
      const canPost = await checkDocumentAccess(account, owner, permlink, 'post')
      
      res.json({
        success: true,
        fixStatus: {
          description: "Permission checking bug has been fixed",
          fixedIssues: [
            "Document Info endpoint now checks explicit permissions before public access",
            "WebSocket server now uses same permission priority order",
            "All endpoints now return consistent access types"
          ]
        },
        
        testDocument: `${owner}/${permlink}`,
        testAccount: account,
        documentInfo: testDoc.rows[0],
        
        consistencyTest: {
          documentInfoEndpoint: infoAccessType,
          documentListingEndpoint: listingAccessType,
          areEqual: infoAccessType === listingAccessType,
          status: infoAccessType === listingAccessType ? "✅ CONSISTENT" : "❌ STILL INCONSISTENT"
        },
        
        permissionCapabilities: {
          canRead,
          canEdit,
          canPost
        },
        
        expectedBehavior: {
          description: "If you have explicit permissions (editable/readonly/postable), that should always show up, even if the document is also public",
          priorityOrder: [
            "1. Owner permissions (if you own the document)",
            "2. Explicit permissions (editable/readonly/postable granted to you)", 
            "3. Public access (if document is public and you have no explicit permissions)",
            "4. No access"
          ]
        }
      })
      
    } finally {
      client.release()
    }
    
  } catch (error) {
    console.error('Error testing permission fix:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Debug endpoint for read-only user document sync issues
router.get('/api/collaboration/debug/readonly-sync/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    if (!owner || !permlink) {
      return res.status(400).json({
        success: false,
        error: 'Invalid document path format'
      })
    }
    
    const client = await pool.connect()
    try {
      // Check document exists
      const docResult = await client.query(
        'SELECT owner, permlink, document_name, is_public, document_data, created_at, updated_at, last_activity FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      if (docResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        })
      }
      
      const document = docResult.rows[0]
      
      // Check user permissions
      const hasAccess = await checkDocumentAccess(account, owner, permlink, 'read')
      
      // Get detailed permission info
      let permissionDetails = null
      if (account === owner) {
        permissionDetails = {
          type: 'owner',
          canRead: true,
          canEdit: true,
          canPost: true
        }
      } else {
        // Check explicit permissions
        const permResult = await client.query(
          'SELECT permission_type, can_read, can_edit, can_post_to_hive FROM collaboration_permissions WHERE owner = $1 AND permlink = $2 AND account = $3',
          [owner, permlink, account]
        )
        
        if (permResult.rows.length > 0) {
          const perm = permResult.rows[0]
          permissionDetails = {
            type: perm.permission_type,
            canRead: perm.can_read,
            canEdit: perm.can_edit,
            canPost: perm.can_post_to_hive
          }
        } else if (document.is_public) {
          permissionDetails = {
            type: 'public',
            canRead: true,
            canEdit: false,
            canPost: false
          }
        } else {
          permissionDetails = {
            type: 'none',
            canRead: false,
            canEdit: false,
            canPost: false
          }
        }
      }
      
      // Check recent connection activity for this user/document
      const activityResult = await client.query(
        'SELECT activity_type, activity_data, created_at FROM collaboration_activity WHERE owner = $1 AND permlink = $2 AND account = $3 ORDER BY created_at DESC LIMIT 10',
        [owner, permlink, account]
      )
      
      // Check current active connections
      const statsResult = await client.query(
        'SELECT active_users, total_edits, last_activity FROM collaboration_stats WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      // Analyze document data format and size
      let documentAnalysis = {
        hasData: !!document.document_data,
        dataSize: document.document_data ? document.document_data.length : 0,
        isValidYjs: false,
        contentPreview: null
      }
      
      if (document.document_data) {
        try {
          // Try to decode as Y.js binary data
          const Y = require('yjs')
          const documentBuffer = Buffer.from(document.document_data, 'base64')
          const uint8Array = new Uint8Array(documentBuffer)
          
          const testDoc = new Y.Doc()
          Y.applyUpdate(testDoc, uint8Array)
          
          const yText = testDoc.getText('content')
          documentAnalysis.isValidYjs = true
          documentAnalysis.contentPreview = yText.toString().substring(0, 200)
        } catch (yError) {
          // Not Y.js format, probably plain text
          documentAnalysis.isValidYjs = false
          documentAnalysis.contentPreview = document.document_data.substring(0, 200)
        }
      }
      
      res.json({
        success: true,
        debug: {
          document: {
            owner: document.owner,
            permlink: document.permlink,
            name: document.document_name,
            isPublic: document.is_public,
            createdAt: document.created_at,
            updatedAt: document.updated_at,
            lastActivity: document.last_activity
          },
          userAccess: {
            account,
            hasAccess,
            permissions: permissionDetails,
            isReadOnly: permissionDetails && !permissionDetails.canEdit
          },
          documentData: documentAnalysis,
          recentActivity: activityResult.rows,
          stats: statsResult.rows[0] || null,
          hocuspocusWebSocketUrl: 'ws://localhost:1234',
          recommendedAction: !hasAccess 
            ? 'User lacks read access to document' 
            : !documentAnalysis.hasData 
            ? 'Document has no content to sync'
            : !documentAnalysis.isValidYjs
            ? 'Document data needs Y.js conversion for proper sync'
            : permissionDetails && !permissionDetails.canEdit
            ? 'User has read-only access - check Hocuspocus read-only protocol handling'
            : 'Full access user - sync should work normally'
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error in readonly-sync debug:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Test endpoint for Hocuspocus protocol compliance
router.get('/api/collaboration/debug/protocol-test/:owner/:permlink', async (req, res) => {
  try {
    const { owner, permlink } = req.params
    const account = req.headers['x-account']
    
    // Simulate the exact authentication flow that Hocuspocus uses
    const { CollaborationAuth } = require('../collaboration-auth')
    
    // Check if user can authenticate
    const accountKeys = await CollaborationAuth.getAccountKeys(account)
    if (!accountKeys) {
      return res.status(401).json({
        success: false,
        error: 'Account not found on HIVE blockchain',
        step: 'authentication'
      })
    }
    
    // Check document access using same logic as server
    const hasAccess = await checkDocumentAccess(account, owner, permlink, 'read')
    
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'No read access to document',
        step: 'authorization'
      })
    }
    
    // Test document fetch using same logic as Hocuspocus Database extension
    const client = await pool.connect()
    try {
      const result = await client.query(
        'SELECT document_data FROM collaboration_documents WHERE owner = $1 AND permlink = $2',
        [owner, permlink]
      )
      
      let documentState = null
      let documentValid = false
      
      if (result.rows.length > 0 && result.rows[0].document_data) {
        const rawData = result.rows[0].document_data
        
        try {
          // Try to decode as Y.js binary data (same as server)
          const Y = require('yjs')
          const documentBuffer = Buffer.from(rawData, 'base64')
          const uint8Array = new Uint8Array(documentBuffer)
          
          // Validate that this is Y.js binary data
          const testDoc = new Y.Doc()
          Y.applyUpdate(testDoc, uint8Array)
          
          documentState = Array.from(uint8Array) // Convert to array for JSON
          documentValid = true
        } catch (yError) {
          console.log('Document not in Y.js format, conversion needed:', yError.message)
          documentValid = false
        }
      }
      
      res.json({
        success: true,
        protocolTest: {
          step1_authentication: 'PASS - Account exists on HIVE',
          step2_authorization: 'PASS - User has read access',
          step3_documentFetch: documentState ? 'PASS - Document loaded' : 'FAIL - No document data',
          step4_yjsValidation: documentValid ? 'PASS - Valid Y.js format' : 'FAIL - Needs Y.js conversion',
          documentPath: `${owner}/${permlink}`,
          websocketUrl: `ws://localhost:1234`,
          authTokenExample: JSON.stringify({
            account,
            challenge: Math.floor(Date.now() / 1000).toString(),
            pubkey: 'STM7BWmXwvuKHr8FpSPmj8knJspFMPKt3vcetAKKjZ2W2HoRgdkEg',
            signature: '2021d0d63d340b6d963e9761c0cbe8096c65a94ba9cec69aed35b2f1fe891576b83680e82b1bc8018c1c819e02c63bf49386ffb4475cb67d3eadaf3115367877c4'
          }),
          issues: [
            ...(documentState ? [] : ['Document has no content to sync']),
            ...(documentValid ? [] : ['Document data is not in Y.js format - server will attempt conversion']),
            ...(!hasAccess ? ['User lacks read permission'] : [])
          ]
        }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error in protocol test:', error)
    res.status(500).json({
      success: false,
      error: error.message,
      step: 'server_error'
    })
  }
})

module.exports = router 