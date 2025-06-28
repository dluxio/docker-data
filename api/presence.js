const { Pool } = require("pg");
const config = require("../config");

const pool = new Pool({
  connectionString: config.dbcs,
});

// Generate TURN credentials using HMAC
function generateTurnCredentials(username = null) {
  const crypto = require('crypto');
  const secret = process.env.TURN_SECRET || 'default_secret';
  const ttl = 3600; // 1 hour
  
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const turnUsername = username ? `${timestamp}:${username}` : `${timestamp}:temp`;
  
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(turnUsername);
  const turnPassword = hmac.digest('base64');
  
  return {
    username: turnUsername,
    password: turnPassword,
    ttl: ttl,
    uris: [
      'stun:presence.dlux.io:3478',
      'turn:presence.dlux.io:3478?transport=udp',
      'turn:presence.dlux.io:3478?transport=tcp',
      'turns:presence.dlux.io:5349?transport=tcp'
    ]
  };
}

// Get VR spaces available to user (posts, communities, documents)
async function getAvailableSpaces(userAccount = null) {
  try {
    const spaces = [];
    
    // Get recent posts that can be VR spaces
    const postsQuery = `
      SELECT 'post' as space_type, 
             CONCAT(author, '/', permlink) as space_id,
             author || '/' || permlink as display_name,
             'Post: ' || LEFT(permlink, 50) as description,
             type,
             votes,
             rating
      FROM posts 
      WHERE type IN ('360', 'vrml', 'aframe', 'blog', 'art', 'game')
        AND NOT hidden 
        AND NOT flagged
      ORDER BY block DESC 
      LIMIT 20
    `;
    
    const postsResult = await pool.query(postsQuery);
    spaces.push(...postsResult.rows);
    
    // Get collaboration documents that can be VR spaces
    const docsQuery = `
      SELECT 'document' as space_type,
             id::text as space_id,
             title as display_name,
             'Collaborative Document' as description,
             'document' as type,
             0 as votes,
             0 as rating
      FROM collaboration_documents
      WHERE is_public = true OR creator = $1
      ORDER BY updated_at DESC
      LIMIT 10
    `;
    
    const docsResult = await pool.query(docsQuery, [userAccount]);
    spaces.push(...docsResult.rows);
    
    // Add global lobby space
    spaces.unshift({
      space_type: 'global',
      space_id: 'lobby',
      display_name: 'Global Lobby',
      description: 'Main social VR space for all users',
      type: 'lobby',
      votes: 0,
      rating: 0
    });
    
    return spaces;
  } catch (error) {
    console.error('Error getting available spaces:', error);
    throw error;
  }
}

// Get details for a specific VR space
async function getSpaceDetails(spaceType, spaceId, userAccount = null) {
  try {
    let spaceData = null;
    
    if (spaceType === 'post') {
      const [author, permlink] = spaceId.split('/');
      const query = `
        SELECT author, permlink, type, votes, rating, nsfw, 
               block, voteweight, promote
        FROM posts 
        WHERE author = $1 AND permlink = $2
          AND NOT hidden AND NOT flagged
      `;
      const result = await pool.query(query, [author, permlink]);
      spaceData = result.rows[0];
    } else if (spaceType === 'document') {
      const query = `
        SELECT id, title, content, creator, is_public, 
               created_at, updated_at
        FROM collaboration_documents 
        WHERE id = $1 AND (is_public = true OR creator = $2)
      `;
      const result = await pool.query(query, [spaceId, userAccount]);
      spaceData = result.rows[0];
    } else if (spaceType === 'global' && spaceId === 'lobby') {
      spaceData = {
        space_id: 'lobby',
        title: 'Global Lobby',
        description: 'Welcome to DLUX Presence VR',
        is_public: true
      };
    }
    
    if (!spaceData) {
      return null;
    }
    
    // Get active users in this space
    const sessionsQuery = `
      SELECT COUNT(*) as active_users,
             array_agg(DISTINCT user_account) FILTER (WHERE user_account IS NOT NULL) as authenticated_users
      FROM presence_sessions 
      WHERE space_type = $1 AND space_id = $2 
        AND last_activity > NOW() - INTERVAL '5 minutes'
    `;
    
    const sessionsResult = await pool.query(sessionsQuery, [spaceType, spaceId]);
    const sessionData = sessionsResult.rows[0];
    
    // Get space settings
    const settingsQuery = `
      SELECT settings FROM presence_space_settings
      WHERE space_type = $1 AND space_id = $2
    `;
    
    const settingsResult = await pool.query(settingsQuery, [spaceType, spaceId]);
    const settings = settingsResult.rows[0]?.settings || {};
    
    return {
      ...spaceData,
      space_type: spaceType,
      space_id: spaceId,
      active_users: parseInt(sessionData.active_users) || 0,
      authenticated_users: sessionData.authenticated_users || [],
      vr_settings: settings
    };
  } catch (error) {
    console.error('Error getting space details:', error);
    throw error;
  }
}

// Check if user has permission to access a VR space
async function checkSpacePermission(spaceType, spaceId, userAccount = null) {
  try {
    // Global spaces are always accessible
    if (spaceType === 'global') {
      return { hasAccess: true, permission: 'access' };
    }
    
    // Posts are accessible based on content policy
    if (spaceType === 'post') {
      const [author, permlink] = spaceId.split('/');
      const query = `
        SELECT hidden, flagged, nsfw FROM posts 
        WHERE author = $1 AND permlink = $2
      `;
      const result = await pool.query(query, [author, permlink]);
      const post = result.rows[0];
      
      if (!post || post.hidden || post.flagged) {
        return { hasAccess: false, reason: 'Content not available' };
      }
      
      return { hasAccess: true, permission: 'access' };
    }
    
    // Documents require explicit permission or public access
    if (spaceType === 'document') {
      const docQuery = `
        SELECT creator, is_public FROM collaboration_documents 
        WHERE id = $1
      `;
      const docResult = await pool.query(docQuery, [spaceId]);
      const doc = docResult.rows[0];
      
      if (!doc) {
        return { hasAccess: false, reason: 'Document not found' };
      }
      
      // Public documents or creator access
      if (doc.is_public || doc.creator === userAccount) {
        return { hasAccess: true, permission: 'access' };
      }
      
      // Check explicit permissions
      if (userAccount) {
        const permQuery = `
          SELECT permission FROM presence_permissions
          WHERE space_type = 'document' AND space_id = $1 AND user_account = $2
        `;
        const permResult = await pool.query(permQuery, [spaceId, userAccount]);
        
        if (permResult.rows.length > 0) {
          return { hasAccess: true, permission: permResult.rows[0].permission };
        }
      }
      
      return { hasAccess: false, reason: 'Insufficient permissions' };
    }
    
    return { hasAccess: false, reason: 'Unknown space type' };
  } catch (error) {
    console.error('Error checking space permission:', error);
    return { hasAccess: false, reason: 'Permission check failed' };
  }
}

// Log user joining/leaving VR space
async function logPresenceActivity(userAccount, action, spaceType, spaceId, details = {}, req = null) {
  try {
    const query = `
      INSERT INTO presence_audit_log 
      (user_account, action, space_type, space_id, details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    
    const ipAddress = req ? (req.ip || req.connection.remoteAddress) : null;
    const userAgent = req ? req.get('User-Agent') : null;
    
    await pool.query(query, [
      userAccount, action, spaceType, spaceId, 
      JSON.stringify(details), ipAddress, userAgent
    ]);
  } catch (error) {
    console.error('Error logging presence activity:', error);
  }
}

// Express route handlers
exports.getTurnCredentials = async (req, res) => {
  try {
    const userAccount = req.user?.account || null;
    const credentials = generateTurnCredentials(userAccount);
    res.json(credentials);
  } catch (error) {
    console.error('Error generating TURN credentials:', error);
    res.status(500).json({ error: 'Failed to generate TURN credentials' });
  }
};

exports.getSpaces = async (req, res) => {
  try {
    const userAccount = req.user?.account || null;
    const spaces = await getAvailableSpaces(userAccount);
    res.json({ spaces, node: config.username });
  } catch (error) {
    console.error('Error getting spaces:', error);
    res.status(500).json({ error: 'Failed to get spaces' });
  }
};

exports.getSpaceDetails = async (req, res) => {
  try {
    const { spaceType, spaceId } = req.params;
    const userAccount = req.user?.account || null;
    
    // Check permissions
    const permission = await checkSpacePermission(spaceType, spaceId, userAccount);
    if (!permission.hasAccess) {
      return res.status(403).json({ error: permission.reason });
    }
    
    const spaceDetails = await getSpaceDetails(spaceType, spaceId, userAccount);
    if (!spaceDetails) {
      return res.status(404).json({ error: 'Space not found' });
    }
    
    res.json({ space: spaceDetails, permission: permission.permission, node: config.username });
  } catch (error) {
    console.error('Error getting space details:', error);
    res.status(500).json({ error: 'Failed to get space details' });
  }
};

exports.joinSpace = async (req, res) => {
  try {
    const { spaceType, spaceId } = req.params;
    const { subspace = 'main' } = req.body;
    const userAccount = req.user?.account || null;
    
    // Check permissions
    const permission = await checkSpacePermission(spaceType, spaceId, userAccount);
    if (!permission.hasAccess) {
      return res.status(403).json({ error: permission.reason });
    }
    
    // Log the activity
    await logPresenceActivity(userAccount, 'join_space', spaceType, spaceId, { subspace }, req);
    
    const spaceDetails = await getSpaceDetails(spaceType, spaceId, userAccount);
    res.json({ 
      success: true, 
      space: spaceDetails, 
      subspace,
      node: config.username 
    });
  } catch (error) {
    console.error('Error joining space:', error);
    res.status(500).json({ error: 'Failed to join space' });
  }
};

// Export utility functions for use by Socket.IO handlers
exports.getSpaceDetails = getSpaceDetails;
exports.checkSpacePermission = checkSpacePermission;
exports.logPresenceActivity = logPresenceActivity; 