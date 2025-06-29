const { Pool } = require("pg");
const config = require("../config");
const crypto = require('crypto');

const pool = new Pool({
  connectionString: config.dbcs,
});

// ==================================================================
// PRESENCE SESSION MANAGEMENT
// ==================================================================

// Create or update presence session
exports.createPresenceSession = async (req, res) => {
  try {
    const {
      socket_id,
      user_account,
      space_type,
      space_id,
      subspace = 'main',
      position = null,
      avatar_data = null,
      voice_enabled = false,
      creator_account = null // Space creator for capacity calculation
    } = req.body;

    if (!socket_id || !space_type || !space_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // First ensure the presence_sessions table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS presence_sessions (
        id SERIAL PRIMARY KEY,
        socket_id varchar(255) UNIQUE NOT NULL,
        user_account varchar(16),
        space_type varchar(20) NOT NULL,
        space_id varchar(255) NOT NULL,
        subspace varchar(255) DEFAULT 'main',
        position jsonb,
        avatar_data jsonb,
        voice_enabled boolean DEFAULT false,
        connected_at timestamp DEFAULT CURRENT_TIMESTAMP,
        last_activity timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // For guest users, check if they can join (one space limit)
    if (!user_account) {
      const guestEligibility = await checkGuestSpaceEligibility(socket_id, space_type, space_id);
      if (!guestEligibility.canJoin) {
        return res.status(429).json({ 
          error: guestEligibility.reason,
          message: guestEligibility.message,
          existingSpace: guestEligibility.existingSpace
        });
      }
    }

    // Calculate enhanced capacity for this space
    const capacityInfo = await calculateSpaceCapacity(space_type, space_id, creator_account);
    
    // For premium users, they don't count toward limits, so always allow
    let isPremiumUser = false;
    if (user_account && capacityInfo.premiumUsers) {
      isPremiumUser = capacityInfo.premiumUsers.includes(user_account);
    }
    
    // Check capacity (premium users bypass this check)
    if (!isPremiumUser && !capacityInfo.hasCapacity) {
      return res.status(429).json({ 
        error: 'Space is full',
        capacity: capacityInfo.capacityInfo,
        upgrade_message: 'Upgrade to Premium to host more users or join full spaces!',
        viral_message: `Premium users in this space are hosting ${capacityInfo.guestSlotsFromPremium} additional guest slots!`
      });
    }

    const query = `
      INSERT INTO presence_sessions 
      (socket_id, user_account, space_type, space_id, subspace, position, avatar_data, voice_enabled, connected_at, last_activity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT (socket_id) DO UPDATE SET
        user_account = $2, space_type = $3, space_id = $4, 
        subspace = $5, position = $6, avatar_data = $7, 
        voice_enabled = $8, last_activity = NOW()
      RETURNING *
    `;

    const result = await pool.query(query, [
      socket_id, user_account, space_type, space_id, subspace, 
      position ? JSON.stringify(position) : null,
      avatar_data ? JSON.stringify(avatar_data) : null,
      voice_enabled
    ]);

    // Log space activity for analytics
    await this.logSpaceActivity({
      body: {
        space_type,
        space_id,
        user_account,
        activity_type: 'user_joined',
        activity_data: {
          is_premium: isPremiumUser,
          capacity_used: capacityInfo.capacityInfo,
          subspace
        }
      }
    }, { json: () => {} }); // Mock response object

    res.json({
      success: true,
      session: result.rows[0],
      capacity: capacityInfo.capacityInfo,
      is_premium: isPremiumUser,
      viral_impact: isPremiumUser ? 'You are providing 5 guest slots to this space!' : null,
      node: config.username
    });

  } catch (error) {
    console.error('Error creating presence session:', error);
    res.status(500).json({ error: 'Failed to create presence session' });
  }
};

// Update presence session activity
exports.updatePresenceActivity = async (req, res) => {
  try {
    const { socket_id } = req.params;
    const { position = null, voice_enabled = false } = req.body;

    const query = `
      UPDATE presence_sessions 
      SET last_activity = NOW(), position = $2, voice_enabled = $3
      WHERE socket_id = $1
      RETURNING *
    `;

    const result = await pool.query(query, [
      socket_id, 
      position ? JSON.stringify(position) : null,
      voice_enabled
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      success: true,
      session: result.rows[0],
      node: config.username
    });

  } catch (error) {
    console.error('Error updating presence activity:', error);
    res.status(500).json({ error: 'Failed to update presence activity' });
  }
};

// Remove presence session
exports.removePresenceSession = async (req, res) => {
  try {
    const { socket_id } = req.params;

    const query = `DELETE FROM presence_sessions WHERE socket_id = $1 RETURNING *`;
    const result = await pool.query(query, [socket_id]);

    res.json({
      success: true,
      removed: result.rowCount,
      node: config.username
    });

  } catch (error) {
    console.error('Error removing presence session:', error);
    res.status(500).json({ error: 'Failed to remove presence session' });
  }
};

// ==================================================================
// CHAT MESSAGING
// ==================================================================

// Send chat message
exports.sendChatMessage = async (req, res) => {
  try {
    const {
      space_type,
      space_id,
      subspace = 'main',
      user_account = null,
      guest_id = null,
      message_type = 'text',
      content,
      parent_message_id = null
    } = req.body;

    if (!space_type || !space_id || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (content.length > 2000) {
      return res.status(400).json({ error: 'Message too long' });
    }

    // Ensure chat_messages table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        space_type varchar(20) NOT NULL,
        space_id varchar(255) NOT NULL,
        subspace varchar(255) DEFAULT 'main',
        user_account varchar(16),
        guest_id varchar(255),
        message_type varchar(20) DEFAULT 'text',
        content text NOT NULL,
        metadata jsonb,
        parent_message_id INTEGER REFERENCES chat_messages(id),
        thread_count integer DEFAULT 0,
        is_edited boolean DEFAULT false,
        is_deleted boolean DEFAULT false,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const query = `
      INSERT INTO chat_messages 
      (space_type, space_id, subspace, user_account, guest_id, message_type, content, parent_message_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const result = await pool.query(query, [
      space_type, space_id, subspace, user_account, guest_id, message_type, content, parent_message_id
    ]);

    res.json({
      success: true,
      message: result.rows[0],
      node: config.username
    });

  } catch (error) {
    console.error('Error sending chat message:', error);
    res.status(500).json({ error: 'Failed to send chat message' });
  }
};

// ==================================================================
// DOCUMENT COLLABORATION
// ==================================================================

// Add document comment
exports.addDocumentComment = async (req, res) => {
  try {
    const { document_id } = req.params;
    const {
      user_account,
      content,
      comment_type = 'comment',
      document_section = null,
      position_data = null,
      parent_comment_id = null
    } = req.body;

    if (!user_account || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ensure document_comments table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS document_comments (
        id SERIAL PRIMARY KEY,
        document_id INTEGER NOT NULL,
        user_account varchar(16) NOT NULL,
        content text NOT NULL,
        comment_type varchar(20) DEFAULT 'comment',
        document_section varchar(255),
        position_data jsonb,
        parent_comment_id INTEGER REFERENCES document_comments(id),
        thread_count integer DEFAULT 0,
        is_resolved boolean DEFAULT false,
        is_edited boolean DEFAULT false,
        is_deleted boolean DEFAULT false,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const query = `
      INSERT INTO document_comments 
      (document_id, user_account, content, comment_type, document_section, position_data, parent_comment_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const result = await pool.query(query, [
      document_id, user_account, content, comment_type, document_section,
      position_data ? JSON.stringify(position_data) : null, parent_comment_id
    ]);

    res.json({
      success: true,
      comment: result.rows[0],
      node: config.username
    });

  } catch (error) {
    console.error('Error adding document comment:', error);
    res.status(500).json({ error: 'Failed to add document comment' });
  }
};

// ==================================================================
// SPACE AUDIO CONFIGURATION
// ==================================================================

// Update space audio configuration
exports.updateSpaceAudioConfig = async (req, res) => {
  try {
    const { space_type, space_id } = req.params;
    const {
      audio_mode,
      current_speaker = null,
      spatial_audio_range_meters = 5.0,
      superambient_neighbor_count = 2,
      created_by
    } = req.body;

    if (!space_type || !space_id || !audio_mode || !created_by) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate audio mode
    const validModes = ['announcement', 'stage', 'ambient', 'superambient'];
    if (!validModes.includes(audio_mode)) {
      return res.status(400).json({ error: 'Invalid audio mode', valid_modes: validModes });
    }

    // Ensure space_audio_config table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS space_audio_config (
        id SERIAL PRIMARY KEY,
        space_type varchar(20) NOT NULL,
        space_id varchar(255) NOT NULL,
        audio_mode varchar(20) DEFAULT 'ambient',
        current_speaker varchar(16),
        max_speaker_duration_minutes integer DEFAULT 10,
        spatial_audio_range_meters decimal(5,2) DEFAULT 5.0,
        superambient_neighbor_count integer DEFAULT 2,
        created_by varchar(16) NOT NULL,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(space_type, space_id)
      )
    `);

    const query = `
      INSERT INTO space_audio_config 
      (space_type, space_id, audio_mode, current_speaker, spatial_audio_range_meters, superambient_neighbor_count, created_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (space_type, space_id) 
      DO UPDATE SET 
        audio_mode = $3,
        current_speaker = $4,
        spatial_audio_range_meters = $5,
        superambient_neighbor_count = $6,
        updated_at = NOW()
      RETURNING *
    `;

    const result = await pool.query(query, [
      space_type, space_id, audio_mode, current_speaker, 
      spatial_audio_range_meters, superambient_neighbor_count, created_by
    ]);

    res.json({
      success: true,
      audio_config: result.rows[0],
      node: config.username
    });

  } catch (error) {
    console.error('Error updating space audio config:', error);
    res.status(500).json({ error: 'Failed to update space audio config' });
  }
};

// Start audio session
exports.startAudioSession = async (req, res) => {
  try {
    const {
      space_type,
      space_id,
      user_account,
      audio_mode,
      listener_count = 0
    } = req.body;

    if (!space_type || !space_id || !user_account || !audio_mode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ensure audio_sessions table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audio_sessions (
        id SERIAL PRIMARY KEY,
        space_type varchar(20) NOT NULL,
        space_id varchar(255) NOT NULL,
        user_account varchar(16) NOT NULL,
        audio_mode varchar(20) NOT NULL,
        session_start timestamp DEFAULT CURRENT_TIMESTAMP,
        session_end timestamp,
        duration_seconds integer,
        audio_quality jsonb,
        listener_count integer DEFAULT 0,
        ended_reason varchar(50) DEFAULT 'manual',
        passed_to varchar(16)
      )
    `);

    const query = `
      INSERT INTO audio_sessions (space_type, space_id, user_account, audio_mode, listener_count)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const result = await pool.query(query, [space_type, space_id, user_account, audio_mode, listener_count]);

    res.json({
      success: true,
      session: result.rows[0],
      node: config.username
    });

  } catch (error) {
    console.error('Error starting audio session:', error);
    res.status(500).json({ error: 'Failed to start audio session' });
  }
};

// End audio session
exports.endAudioSession = async (req, res) => {
  try {
    const { session_id } = req.params;
    const { ended_reason = 'manual', passed_to = null } = req.body;

    const query = `
      UPDATE audio_sessions 
      SET session_end = NOW(), 
          duration_seconds = EXTRACT(EPOCH FROM (NOW() - session_start)),
          ended_reason = $2,
          passed_to = $3
      WHERE id = $1 AND session_end IS NULL
      RETURNING *
    `;

    const result = await pool.query(query, [session_id, ended_reason, passed_to]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found or already ended' });
    }

    res.json({
      success: true,
      session: result.rows[0],
      node: config.username
    });

  } catch (error) {
    console.error('Error ending audio session:', error);
    res.status(500).json({ error: 'Failed to end audio session' });
  }
};

// ==================================================================
// SPACE ACTIVITY LOGGING
// ==================================================================

// Log space activity
exports.logSpaceActivity = async (req, res) => {
  try {
    const {
      space_type,
      space_id,
      user_account = null,
      activity_type,
      activity_data = null,
      is_public = true
    } = req.body;

    if (!space_type || !space_id || !activity_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ensure space_activity table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS space_activity (
        id SERIAL PRIMARY KEY,
        space_type varchar(20) NOT NULL,
        space_id varchar(255) NOT NULL,
        user_account varchar(16),
        activity_type varchar(50) NOT NULL,
        activity_data jsonb,
        is_public boolean DEFAULT true,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const query = `
      INSERT INTO space_activity (space_type, space_id, user_account, activity_type, activity_data, is_public)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const result = await pool.query(query, [
      space_type, space_id, user_account, activity_type,
      activity_data ? JSON.stringify(activity_data) : null, is_public
    ]);

    res.json({
      success: true,
      activity: result.rows[0],
      node: config.username
    });

  } catch (error) {
    console.error('Error logging space activity:', error);
    res.status(500).json({ error: 'Failed to log space activity' });
  }
};

// ==================================================================
// UTILITY FUNCTIONS
// ==================================================================

// Generate guest ID for anonymous users
function generateGuestId(req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = req.get?.('User-Agent') || req.headers?.['user-agent'] || '';
  return crypto.createHash('md5').update(ip + userAgent).digest('hex').slice(0, 8);
}

// Middleware to extract guest ID
exports.extractGuestId = (req, res, next) => {
  if (!req.user) {
    req.guestId = generateGuestId(req);
  }
  next();
};

// Health check for presence API
exports.presenceHealthCheck = async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: 'dlux-presence-api',
      timestamp: new Date().toISOString(),
      node: config.username
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: 'Database connection failed',
      node: config.username
    });
  }
};

// ==================================================================
// ENHANCED PRESENCE SESSION MANAGEMENT WITH VIRAL CAPACITY
// ==================================================================

/**
 * Calculate enhanced space capacity based on premium subscribers present
 * - Premium+ subscribers don't count toward base limits
 * - Each premium+ subscriber adds 5 guest slots
 * - Guests can only be in one enhanced space at a time
 */
async function calculateSpaceCapacity(spaceType, spaceId, creatorAccount = null) {
  try {
    // Get current users in the space
    const sessionsQuery = `
      SELECT user_account, 
             CASE WHEN user_account IS NULL THEN 'guest' ELSE 'user' END as user_type
      FROM presence_sessions 
      WHERE space_type = $1 AND space_id = $2 
        AND last_activity > NOW() - INTERVAL '15 minutes'
    `;
    
    const sessionsResult = await pool.query(sessionsQuery, [spaceType, spaceId]);
    const currentUsers = sessionsResult.rows;
    
    // Separate users and guests
    const authenticatedUsers = currentUsers.filter(u => u.user_type === 'user').map(u => u.user_account);
    const guestCount = currentUsers.filter(u => u.user_type === 'guest').length;
    
    // Check which authenticated users are premium+ subscribers
    let premiumUsers = [];
    if (authenticatedUsers.length > 0) {
      const subscriptionQuery = `
        SELECT DISTINCT us.user_account
        FROM user_subscriptions us
        JOIN subscription_tiers st ON us.tier_id = st.id
        WHERE us.user_account = ANY($1)
          AND us.status = 'active'
          AND us.expires_at > NOW()
          AND st.tier_code IN ('premium', 'pro')
      `;
      
      const subscriptionResult = await pool.query(subscriptionQuery, [authenticatedUsers]);
      premiumUsers = subscriptionResult.rows.map(row => row.user_account);
    }
    
    // Get space creator's subscription status for base limit
    let baseLimit = 5; // Default free tier limit
    if (creatorAccount) {
      const creatorSubQuery = `
        SELECT st.max_event_attendees
        FROM user_subscriptions us
        JOIN subscription_tiers st ON us.tier_id = st.id
        WHERE us.user_account = $1
          AND us.status = 'active'
          AND us.expires_at > NOW()
        LIMIT 1
      `;
      
      const creatorSubResult = await pool.query(creatorSubQuery, [creatorAccount]);
      if (creatorSubResult.rows.length > 0) {
        baseLimit = creatorSubResult.rows[0].max_event_attendees;
      }
    }
    
    // Calculate enhanced capacity
    const regularUsers = authenticatedUsers.filter(u => !premiumUsers.includes(u));
    const premiumCount = premiumUsers.length;
    const guestSlotsFromPremium = premiumCount * 5;
    
    // Enhanced capacity = base limit + guest slots from premium users
    // Premium users don't count toward the limit
    const enhancedCapacity = baseLimit + guestSlotsFromPremium;
    const currentRegularLoad = regularUsers.length + guestCount;
    
    return {
      baseLimit,
      enhancedCapacity,
      currentUsers: currentUsers.length,
      premiumUsers,
      premiumCount,
      regularUsers,
      guestCount,
      guestSlotsFromPremium,
      currentRegularLoad,
      hasCapacity: currentRegularLoad < enhancedCapacity,
      capacityInfo: {
        total: enhancedCapacity,
        used: currentRegularLoad,
        available: enhancedCapacity - currentRegularLoad,
        premiumBonus: guestSlotsFromPremium
      }
    };
    
  } catch (error) {
    console.error('Error calculating space capacity:', error);
    // Fallback to basic capacity
    return {
      baseLimit: 5,
      enhancedCapacity: 5,
      currentUsers: 0,
      hasCapacity: true,
      capacityInfo: { total: 5, used: 0, available: 5, premiumBonus: 0 },
      error: error.message
    };
  }
}

/**
 * Check if a guest user can join enhanced spaces
 * Guests can only be in one enhanced space at a time
 */
async function checkGuestSpaceEligibility(socketId, spaceType, spaceId) {
  try {
    // Check if this guest is already in another space
    const existingSessionQuery = `
      SELECT space_type, space_id, subspace
      FROM presence_sessions 
      WHERE socket_id = $1 
        AND user_account IS NULL
        AND (space_type != $2 OR space_id != $3)
        AND last_activity > NOW() - INTERVAL '5 minutes'
    `;
    
    const existingResult = await pool.query(existingSessionQuery, [socketId, spaceType, spaceId]);
    
    if (existingResult.rows.length > 0) {
      const existingSpace = existingResult.rows[0];
      return {
        canJoin: false,
        reason: 'guest_already_in_space',
        existingSpace: `${existingSpace.space_type}/${existingSpace.space_id}/${existingSpace.subspace}`,
        message: 'Guests can only be in one space at a time. Please leave your current space first.'
      };
    }
    
    return { canJoin: true };
    
  } catch (error) {
    console.error('Error checking guest eligibility:', error);
    return { canJoin: true }; // Allow on error to avoid blocking
  }
}

// Get enhanced space capacity information
exports.getSpaceCapacity = async (req, res) => {
  try {
    const { space_type, space_id } = req.params;
    const { creator_account } = req.query;
    
    const capacityInfo = await calculateSpaceCapacity(space_type, space_id, creator_account);
    
    res.json({
      success: true,
      space: {
        space_type,
        space_id,
        capacity: capacityInfo.capacityInfo,
        users: {
          total: capacityInfo.currentUsers,
          premium: capacityInfo.premiumCount,
          regular: capacityInfo.regularUsers.length,
          guests: capacityInfo.guestCount
        },
        viral_metrics: {
          premium_users_hosting: capacityInfo.premiumCount,
          additional_guest_slots: capacityInfo.guestSlotsFromPremium,
          base_limit: capacityInfo.baseLimit,
          enhanced_capacity: capacityInfo.enhancedCapacity
        }
      },
      node: config.username
    });
    
  } catch (error) {
    console.error('Error getting space capacity:', error);
    res.status(500).json({ error: 'Failed to get space capacity' });
  }
};

// Get user's current spaces (for guest limitation enforcement)
exports.getUserSpaces = async (req, res) => {
  try {
    const { socket_id } = req.params;
    
    const query = `
      SELECT space_type, space_id, subspace, user_account,
             connected_at, last_activity
      FROM presence_sessions 
      WHERE socket_id = $1
        AND last_activity > NOW() - INTERVAL '15 minutes'
    `;
    
    const result = await pool.query(query, [socket_id]);
    
    res.json({
      success: true,
      spaces: result.rows,
      is_guest: result.rows.length > 0 && !result.rows[0].user_account,
      guest_limit_info: result.rows.length > 0 && !result.rows[0].user_account ? 
        'Guests can only be in one space at a time. Upgrade to Premium for unlimited access!' : null,
      node: config.username
    });
    
  } catch (error) {
    console.error('Error getting user spaces:', error);
    res.status(500).json({ error: 'Failed to get user spaces' });
  }
};

// ==================================================================
// VIRAL ANALYTICS FOR SUBSCRIPTION GROWTH
// ==================================================================

// Track viral events that could drive subscriptions
exports.trackViralEvent = async (req, res) => {
  try {
    const {
      event_type, // 'space_full_upgrade_prompt', 'guest_joined_premium_space', 'creator_got_premium_boost'
      space_type,
      space_id,
      user_account = null,
      event_data = {}
    } = req.body;
    
    // Ensure viral_events table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS viral_events (
        id SERIAL PRIMARY KEY,
        event_type varchar(50) NOT NULL,
        space_type varchar(20),
        space_id varchar(255),
        user_account varchar(16),
        event_data jsonb DEFAULT '{}',
        created_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    const query = `
      INSERT INTO viral_events (event_type, space_type, space_id, user_account, event_data)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    
    const result = await pool.query(query, [
      event_type, space_type, space_id, user_account, JSON.stringify(event_data)
    ]);
    
    res.json({
      success: true,
      event: result.rows[0],
      node: config.username
    });
    
  } catch (error) {
    console.error('Error tracking viral event:', error);
    res.status(500).json({ error: 'Failed to track viral event' });
  }
};

// Get viral growth analytics
exports.getViralAnalytics = async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const query = `
      SELECT 
        event_type,
        COUNT(*) as event_count,
        COUNT(DISTINCT user_account) as unique_users,
        COUNT(DISTINCT space_type || '/' || space_id) as unique_spaces,
        DATE_TRUNC('day', created_at) as event_date
      FROM viral_events 
      WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY event_type, event_date
      ORDER BY event_date DESC, event_count DESC
    `;
    
    const result = await pool.query(query);
    
    res.json({
      success: true,
      analytics: result.rows,
      period_days: days,
      node: config.username
    });
    
  } catch (error) {
    console.error('Error getting viral analytics:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
};

/**
 * Test endpoint for viral capacity system with waitlist
 * Demonstrates premium multipliers, queue priority, and conversion opportunities
 */
exports.testViralCapacitySystem = async (req, res) => {
  try {
    const { spaceType = 'test', spaceId = 'viral-demo', scenario = 'basic' } = req.query;
    
    console.log(`[Presence API] Testing viral capacity system with waitlist: ${scenario}`);
    
    // Create test scenarios to demonstrate viral growth and waitlist system
    const testScenarios = {
      'basic': {
        name: 'Basic Free User Space',
        creator_tier: 'free',
        base_capacity: 5,
        users: [
          { name: 'alice', tier: 'free', type: 'regular' },
          { name: 'bob', tier: 'free', type: 'regular' },
          { name: 'charlie', tier: 'free', type: 'regular' },
          { name: 'guest1', tier: null, type: 'guest' },
          { name: 'guest2', tier: null, type: 'guest' }
        ],
        queue: []
      },
      'viral': {
        name: 'Viral Growth with Premium Users + Queue',
        creator_tier: 'premium',
        base_capacity: 50,
        users: [
          { name: 'creator', tier: 'premium', type: 'premium' },
          { name: 'premium_host1', tier: 'premium', type: 'premium' },
          { name: 'premium_host2', tier: 'pro', type: 'premium' },
          { name: 'user1', tier: 'basic', type: 'regular' },
          { name: 'user2', tier: 'free', type: 'regular' },
          { name: 'user3', tier: 'free', type: 'regular' },
          { name: 'guest1', tier: null, type: 'guest' },
          { name: 'guest2', tier: null, type: 'guest' },
          { name: 'guest3', tier: null, type: 'guest' },
          { name: 'guest4', tier: null, type: 'guest' },
          { name: 'guest5', tier: null, type: 'guest' },
          { name: 'guest6', tier: null, type: 'guest' },
          { name: 'guest7', tier: null, type: 'guest' },
          { name: 'guest8', tier: null, type: 'guest' }
        ],
        queue: [
          { name: 'hive_user1', tier: 'free', type: 'hive', queue_position: 1, wait_time: 5 },
          { name: 'guest_queued1', tier: null, type: 'guest', queue_position: 2, wait_time: 15 },
          { name: 'hive_user2', tier: 'free', type: 'hive', queue_position: 3, wait_time: 10 },
          { name: 'guest_queued2', tier: null, type: 'guest', queue_position: 4, wait_time: 25 }
        ]
      },
      'conversion': {
        name: 'Conversion Opportunity - Space Full with Queue',
        creator_tier: 'free',
        base_capacity: 5,
        users: [
          { name: 'creator', tier: 'free', type: 'regular' },
          { name: 'user1', tier: 'free', type: 'regular' },
          { name: 'user2', tier: 'free', type: 'regular' },
          { name: 'user3', tier: 'free', type: 'regular' },
          { name: 'user4', tier: 'free', type: 'regular' }
        ],
        queue: [
          { name: 'hive_waiting1', tier: 'free', type: 'hive', queue_position: 1, wait_time: 5 },
          { name: 'hive_waiting2', tier: 'free', type: 'hive', queue_position: 2, wait_time: 10 },
          { name: 'guest_waiting1', tier: null, type: 'guest', queue_position: 3, wait_time: 20 },
          { name: 'guest_waiting2', tier: null, type: 'guest', queue_position: 4, wait_time: 25 },
          { name: 'guest_waiting3', tier: null, type: 'guest', queue_position: 5, wait_time: 30 }
        ],
        trying_to_join: { name: 'new_user', tier: 'free', type: 'hive' }
      },
      'queue_priority': {
        name: 'Queue Priority System Demo (2:1 Hive to Guest)',
        creator_tier: 'free',
        base_capacity: 5,
        users: [
          { name: 'creator', tier: 'free', type: 'regular' },
          { name: 'user1', tier: 'free', type: 'regular' },
          { name: 'user2', tier: 'free', type: 'regular' },
          { name: 'user3', tier: 'free', type: 'regular' },
          { name: 'guest1', tier: null, type: 'guest' }
        ],
        queue: [
          { name: 'hive_priority1', tier: 'free', type: 'hive', queue_position: 1, wait_time: 3 },
          { name: 'hive_priority2', tier: 'free', type: 'hive', queue_position: 2, wait_time: 7 },
          { name: 'guest_lower_priority1', tier: null, type: 'guest', queue_position: 3, wait_time: 15 },
          { name: 'hive_priority3', tier: 'free', type: 'hive', queue_position: 4, wait_time: 12 },
          { name: 'guest_lower_priority2', tier: null, type: 'guest', queue_position: 5, wait_time: 25 }
        ]
      }
    };
    
    const currentScenario = testScenarios[scenario] || testScenarios.basic;
    
    // Calculate capacity using viral algorithm
    const premiumUsers = currentScenario.users.filter(u => 
      ['premium', 'pro'].includes(u.tier) && u.type !== 'trying_to_join'
    );
    const regularUsers = currentScenario.users.filter(u => 
      u.type === 'regular' && u.type !== 'trying_to_join'
    );
    const guests = currentScenario.users.filter(u => 
      u.type === 'guest' && u.type !== 'trying_to_join'
    );
    
    const baseCapacity = currentScenario.base_capacity;
    const premiumBonus = premiumUsers.length * 5;
    const enhancedCapacity = baseCapacity + premiumBonus;
    const currentLoad = regularUsers.length + guests.length;
    const available = Math.max(0, enhancedCapacity - currentLoad);
    
    // Analyze queue composition
    const queueAnalysis = currentScenario.queue ? {
      total_queued: currentScenario.queue.length,
      hive_users_queued: currentScenario.queue.filter(u => u.type === 'hive').length,
      guests_queued: currentScenario.queue.filter(u => u.type === 'guest').length,
      queue_positions: currentScenario.queue.map(u => ({
        name: u.name,
        type: u.type,
        position: u.queue_position,
        estimated_wait_minutes: u.wait_time
      })),
      priority_ratio: {
        hive_to_guest: '2:1',
        explanation: 'For every 2 Hive users admitted, 1 guest is admitted'
      }
    } : null;
    
    // Simulate joining attempt
    const tryingToJoin = currentScenario.trying_to_join;
    const canJoinDirectly = available > 0 || (tryingToJoin?.tier && ['premium', 'pro'].includes(tryingToJoin.tier));
    
    // Generate viral messaging
    let viralMessage = '';
    let conversionMessage = '';
    let queueMessage = '';
    
    if (premiumUsers.length > 0) {
      viralMessage = `🚀 ${premiumUsers.length} Premium users are hosting ${premiumBonus} bonus guest slots!`;
    }
    
    if (!canJoinDirectly && tryingToJoin) {
      const userType = tryingToJoin.tier ? 'hive' : 'guest';
      if (tryingToJoin.tier && ['premium', 'pro'].includes(tryingToJoin.tier)) {
        conversionMessage = 'Premium user - skips all queues and joins instantly!';
      } else if (userType === 'hive') {
        queueMessage = 'Hive user - gets 2x priority in queue over guests!';
        conversionMessage = 'Upgrade to Premium to skip the queue entirely.';
      } else {
        queueMessage = 'Guest user - lower priority in queue. Create Hive account for 2x faster processing!';
        conversionMessage = 'Upgrade to Premium to skip queues, or create Hive account for better queue priority.';
      }
    }
    
    const testResult = {
      scenario: {
        name: currentScenario.name,
        description: `Testing ${scenario} scenario with waitlist system`,
        demonstrates: getScenarioDemonstration(scenario)
      },
      space: {
        space_type: spaceType,
        space_id: spaceId,
        creator_tier: currentScenario.creator_tier
      },
      capacity: {
        base: baseCapacity,
        premium_bonus: premiumBonus,
        enhanced_total: enhancedCapacity,
        used: currentLoad,
        available: available,
        utilization_percentage: Math.round((currentLoad / enhancedCapacity) * 100)
      },
      users: {
        total_in_space: currentScenario.users.length - (tryingToJoin ? 1 : 0),
        premium: premiumUsers.length,
        regular: regularUsers.length,
        guests: guests.length,
        breakdown: currentScenario.users.filter(u => u.type !== 'trying_to_join')
      },
      queue_system: queueAnalysis,
      viral_mechanics: {
        has_premium_multiplier: premiumUsers.length > 0,
        bonus_slots_provided: premiumBonus,
        viral_message: viralMessage,
        social_proof: premiumUsers.length > 0 ? 
          `Premium users ${premiumUsers.map(u => u.name).join(', ')} are making this space more accessible!` : 
          null
      },
      waitlist_mechanics: {
        active_queue: queueAnalysis !== null,
        priority_system: {
          enabled: true,
          hive_to_guest_ratio: '2:1',
          premium_skip: 'Premium users bypass queue entirely'
        },
        queue_message: queueMessage,
        priority_demonstration: scenario === 'queue_priority' ? 
          'Notice how Hive users get positions 1, 2, 4 while guests get 3, 5 - maintaining 2:1 ratio' : 
          null
      },
      conversion_opportunity: {
        space_is_full: !canJoinDirectly,
        can_join_directly: canJoinDirectly,
        user_trying_to_join: tryingToJoin?.name || null,
        user_tier: tryingToJoin?.tier || null,
        user_type: tryingToJoin ? (tryingToJoin.tier ? 'hive' : 'guest') : null,
        conversion_message: conversionMessage,
        queue_position_message: queueMessage,
        upgrade_value_props: {
          premium: 'Skip all queues + provide guest slots to help others',
          hive: 'Get 2x faster queue processing than guests'
        }
      },
      business_impact: {
        additional_users_enabled: premiumBonus,
        conversion_touchpoints: (!canJoinDirectly ? 1 : 0) + (queueAnalysis ? 1 : 0),
        viral_coefficient: premiumUsers.length > 0 ? (premiumBonus / premiumUsers.length) : 0,
        queue_conversions: queueAnalysis ? queueAnalysis.total_queued : 0
      },
      recommendations: generateEnhancedRecommendations(currentScenario, premiumUsers, canJoinDirectly, tryingToJoin, queueAnalysis)
    };
    
    res.json({
      success: true,
      message: 'Enhanced viral capacity + waitlist system test completed',
      test_result: testResult,
      next_scenarios: {
        basic: '/api/presence/test/viral-capacity?scenario=basic',
        viral: '/api/presence/test/viral-capacity?scenario=viral',
        conversion: '/api/presence/test/viral-capacity?scenario=conversion',
        queue_priority: '/api/presence/test/viral-capacity?scenario=queue_priority'
      }
    });
    
  } catch (error) {
    console.error('[Presence API] Error testing viral capacity system:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test viral capacity system',
      details: error.message
    });
  }
};

/**
 * Get demonstration description for each scenario
 */
function getScenarioDemonstration(scenario) {
  const demonstrations = {
    'basic': 'Standard capacity limits without premium users or queue system',
    'viral': 'Premium users providing bonus capacity + active queue with priority system',
    'conversion': 'Full space with queue showing conversion opportunities for different user types',
    'queue_priority': 'Detailed demonstration of 2:1 Hive to guest priority algorithm'
  };
  
  return demonstrations[scenario] || 'Basic capacity demonstration';
}

/**
 * Generate enhanced recommendations including waitlist system
 */
function generateEnhancedRecommendations(scenario, premiumUsers, canJoin, tryingToJoin, queueAnalysis) {
  const recommendations = [];
  
  // Premium conversion opportunities
  if (premiumUsers.length === 0) {
    recommendations.push({
      type: 'creator_conversion',
      message: 'Upgrade to Premium to unlock unlimited hosting capacity and provide guest slots to attract more users.',
      action: 'Show upgrade prompt to space creator',
      impact: 'High - enables viral growth multiplier'
    });
  }
  
  // Queue-based conversion opportunities
  if (!canJoin && tryingToJoin) {
    const userType = tryingToJoin.tier ? 'hive' : 'guest';
    
    if (userType === 'guest') {
      recommendations.push({
        type: 'hive_account_conversion',
        message: 'Promote Hive account creation with 2x queue priority messaging.',
        action: 'Display Hive signup with queue priority benefits',
        impact: 'Medium - improves user experience and platform engagement'
      });
    }
    
    recommendations.push({
      type: 'premium_conversion',
      message: 'Show premium upgrade with queue skip benefits and viral impact messaging.',
      action: 'Display conversion modal highlighting instant access',
      impact: 'High - direct revenue and viral multiplier'
    });
  }
  
  // Queue management recommendations
  if (queueAnalysis && queueAnalysis.total_queued > 0) {
    recommendations.push({
      type: 'queue_engagement',
      message: `${queueAnalysis.total_queued} users waiting - great conversion opportunity!`,
      action: 'Show queue management and upgrade prompts to queued users',
      impact: 'High - captive audience for conversions'
    });
    
    if (queueAnalysis.guests_queued > queueAnalysis.hive_users_queued) {
      recommendations.push({
        type: 'hive_promotion',
        message: 'More guests than Hive users in queue - promote Hive account benefits.',
        action: 'Highlight 2x priority for Hive accounts in queue messaging',
        impact: 'Medium - drives account creation'
      });
    }
  }
  
  // Viral amplification recommendations
  if (premiumUsers.length > 0) {
    recommendations.push({
      type: 'viral_amplification',
      message: `Highlight that ${premiumUsers.length} Premium users are enabling ${premiumUsers.length * 5} additional guest slots.`,
      action: 'Display viral impact message prominently to all users',
      impact: 'Medium - social proof drives conversions'
    });
  }
  
  // Creator-specific recommendations
  if (scenario.creator_tier === 'free' && scenario.users.length >= 4) {
    recommendations.push({
      type: 'creator_upgrade_prompt',
      message: 'Space is popular! Show creator how Premium unlocks unlimited capacity.',
      action: 'Send creator-specific upgrade messaging with growth statistics',
      impact: 'High - creator conversions have highest retention'
    });
  }
  
  return recommendations;
}

// ==================================================================
// WAITLIST/QUEUE SYSTEM FOR FULL SPACES
// ==================================================================

/**
 * Initialize waitlist tables for queue management
 */
async function initializeWaitlistTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS space_waitlist (
      id SERIAL PRIMARY KEY,
      space_type VARCHAR(20) NOT NULL,
      space_id VARCHAR(255) NOT NULL,
      socket_id VARCHAR(255) NOT NULL,
      user_account VARCHAR(16), -- NULL for guests
      user_type VARCHAR(10) NOT NULL, -- 'hive', 'guest'
      queue_position INTEGER NOT NULL,
      joined_queue_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notified_at TIMESTAMP,
      expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 minutes'),
      status VARCHAR(20) DEFAULT 'waiting', -- 'waiting', 'admitted', 'expired', 'left'
      UNIQUE(space_type, space_id, socket_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_waitlist_space ON space_waitlist(space_type, space_id);
    CREATE INDEX IF NOT EXISTS idx_waitlist_position ON space_waitlist(space_type, space_id, queue_position);
    CREATE INDEX IF NOT EXISTS idx_waitlist_status ON space_waitlist(status);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist_admissions (
      id SERIAL PRIMARY KEY,
      space_type VARCHAR(20) NOT NULL,
      space_id VARCHAR(255) NOT NULL,
      waitlist_id INTEGER REFERENCES space_waitlist(id),
      user_account VARCHAR(16),
      user_type VARCHAR(10) NOT NULL,
      admitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      admission_reason VARCHAR(50) DEFAULT 'capacity_available' -- 'capacity_available', 'premium_user_left'
    )
  `);
}

/**
 * Add user to waitlist with Hive user priority (2:1 ratio)
 */
async function addToWaitlist(spaceType, spaceId, socketId, userAccount = null) {
  try {
    await initializeWaitlistTables();
    
    const userType = userAccount ? 'hive' : 'guest';
    
    // Check if user is already in queue
    const existingQuery = `
      SELECT id, queue_position, status FROM space_waitlist
      WHERE space_type = $1 AND space_id = $2 AND socket_id = $3
        AND status = 'waiting'
    `;
    const existingResult = await pool.query(existingQuery, [spaceType, spaceId, socketId]);
    
    if (existingResult.rows.length > 0) {
      return {
        success: true,
        already_queued: true,
        queue_position: existingResult.rows[0].queue_position,
        waitlist_id: existingResult.rows[0].id
      };
    }
    
    // Calculate queue position based on 2:1 Hive to guest priority
    const queuePosition = await calculateQueuePosition(spaceType, spaceId, userType);
    
    const insertQuery = `
      INSERT INTO space_waitlist 
      (space_type, space_id, socket_id, user_account, user_type, queue_position)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    
    const result = await pool.query(insertQuery, [
      spaceType, spaceId, socketId, userAccount, userType, queuePosition
    ]);
    
    // Track viral event
    await trackWaitlistEvent('user_joined_queue', spaceType, spaceId, userAccount, {
      user_type: userType,
      queue_position: queuePosition
    });
    
    return {
      success: true,
      waitlist_entry: result.rows[0],
      queue_position: queuePosition,
      estimated_wait_time: await estimateWaitTime(spaceType, spaceId, queuePosition)
    };
    
  } catch (error) {
    console.error('Error adding to waitlist:', error);
    throw error;
  }
}

/**
 * Calculate queue position with 2:1 Hive to guest priority
 */
async function calculateQueuePosition(spaceType, spaceId, userType) {
  try {
    // Get current queue counts
    const queueQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE user_type = 'hive') as hive_count,
        COUNT(*) FILTER (WHERE user_type = 'guest') as guest_count,
        COALESCE(MAX(queue_position), 0) as max_position
      FROM space_waitlist
      WHERE space_type = $1 AND space_id = $2 AND status = 'waiting'
    `;
    
    const queueResult = await pool.query(queueQuery, [spaceType, spaceId]);
    const { hive_count, guest_count, max_position } = queueResult.rows[0];
    
    if (userType === 'hive') {
      // Hive users get better positioning
      // For every 2 Hive users, 1 guest gets priority
      const idealHivePosition = Math.floor((parseInt(hive_count) + parseInt(guest_count)) * 2/3) + 1;
      return Math.max(idealHivePosition, parseInt(max_position) + 1);
    } else {
      // Guests get lower priority
      // They fill the remaining 1/3 slots
      const idealGuestPosition = Math.floor((parseInt(hive_count) + parseInt(guest_count)) * 2/3) + parseInt(guest_count) + 1;
      return Math.max(idealGuestPosition, parseInt(max_position) + 1);
    }
    
  } catch (error) {
    console.error('Error calculating queue position:', error);
    return 1;
  }
}

/**
 * Process waitlist when space capacity becomes available
 */
async function processWaitlist(spaceType, spaceId, availableSlots = 1) {
  try {
    await initializeWaitlistTables();
    
    console.log(`[Waitlist] Processing ${availableSlots} available slots for ${spaceType}/${spaceId}`);
    
    // Get next users from queue with 2:1 Hive to guest ratio
    const nextUsers = await getNextWaitlistUsers(spaceType, spaceId, availableSlots);
    
    for (const user of nextUsers) {
      // Mark as admitted
      await pool.query(`
        UPDATE space_waitlist 
        SET status = 'admitted', notified_at = NOW()
        WHERE id = $1
      `, [user.id]);
      
      // Log admission
      await pool.query(`
        INSERT INTO waitlist_admissions 
        (space_type, space_id, waitlist_id, user_account, user_type)
        VALUES ($1, $2, $3, $4, $5)
      `, [spaceType, spaceId, user.id, user.user_account, user.user_type]);
      
      // Track viral event
      await trackWaitlistEvent('user_admitted_from_queue', spaceType, spaceId, user.user_account, {
        user_type: user.user_type,
        wait_time_minutes: Math.round((Date.now() - new Date(user.joined_queue_at)) / 60000)
      });
    }
    
    // Update queue positions for remaining users
    await reorderQueue(spaceType, spaceId);
    
    return nextUsers;
    
  } catch (error) {
    console.error('Error processing waitlist:', error);
    return [];
  }
}

/**
 * Get next users from queue respecting 2:1 Hive to guest ratio
 */
async function getNextWaitlistUsers(spaceType, spaceId, maxSlots) {
  try {
    const queueQuery = `
      SELECT id, user_account, user_type, queue_position, joined_queue_at,
             ROW_NUMBER() OVER (
               PARTITION BY user_type 
               ORDER BY queue_position ASC, joined_queue_at ASC
             ) as type_rank
      FROM space_waitlist
      WHERE space_type = $1 AND space_id = $2 AND status = 'waiting'
        AND expires_at > NOW()
      ORDER BY queue_position ASC, joined_queue_at ASC
    `;
    
    const queueResult = await pool.query(queueQuery, [spaceType, spaceId]);
    const waitingUsers = queueResult.rows;
    
    const admittedUsers = [];
    let hiveAdmitted = 0;
    let guestAdmitted = 0;
    
    for (const user of waitingUsers) {
      if (admittedUsers.length >= maxSlots) break;
      
      if (user.user_type === 'hive') {
        // Admit Hive user if within 2:1 ratio
        const wouldViolateRatio = (hiveAdmitted + 1) > (guestAdmitted * 2 + 2);
        if (!wouldViolateRatio || guestAdmitted === 0) {
          admittedUsers.push(user);
          hiveAdmitted++;
        }
      } else if (user.user_type === 'guest') {
        // Admit guest if it maintains or improves ratio
        const canAdmitGuest = hiveAdmitted >= (guestAdmitted + 1) * 2 || admittedUsers.length === maxSlots - 1;
        if (canAdmitGuest) {
          admittedUsers.push(user);
          guestAdmitted++;
        }
      }
    }
    
    return admittedUsers;
    
  } catch (error) {
    console.error('Error getting next waitlist users:', error);
    return [];
  }
}

/**
 * Reorder queue positions after admissions
 */
async function reorderQueue(spaceType, spaceId) {
  try {
    const reorderQuery = `
      WITH ordered_queue AS (
        SELECT id, 
               ROW_NUMBER() OVER (ORDER BY queue_position ASC, joined_queue_at ASC) as new_position
        FROM space_waitlist
        WHERE space_type = $1 AND space_id = $2 AND status = 'waiting'
      )
      UPDATE space_waitlist 
      SET queue_position = ordered_queue.new_position
      FROM ordered_queue
      WHERE space_waitlist.id = ordered_queue.id
    `;
    
    await pool.query(reorderQuery, [spaceType, spaceId]);
    
  } catch (error) {
    console.error('Error reordering queue:', error);
  }
}

/**
 * Estimate wait time based on queue position and historical data
 */
async function estimateWaitTime(spaceType, spaceId, queuePosition) {
  try {
    // Simple estimation: assume 1 user leaves every 10 minutes on average
    const averageSessionMinutes = 15;
    const estimatedMinutes = Math.max(5, queuePosition * 5);
    
    return {
      estimated_minutes: estimatedMinutes,
      estimated_message: estimatedMinutes < 10 ? 
        'Less than 10 minutes' : 
        `About ${Math.round(estimatedMinutes / 5) * 5} minutes`
    };
    
  } catch (error) {
    console.error('Error estimating wait time:', error);
    return { estimated_minutes: 10, estimated_message: 'About 10 minutes' };
  }
}

/**
 * Remove user from waitlist (when they leave or join another space)
 */
async function removeFromWaitlist(socketId, spaceType = null, spaceId = null) {
  try {
    let query, params;
    
    if (spaceType && spaceId) {
      query = `
        UPDATE space_waitlist 
        SET status = 'left' 
        WHERE socket_id = $1 AND space_type = $2 AND space_id = $3 AND status = 'waiting'
        RETURNING *
      `;
      params = [socketId, spaceType, spaceId];
    } else {
      query = `
        UPDATE space_waitlist 
        SET status = 'left' 
        WHERE socket_id = $1 AND status = 'waiting'
        RETURNING *
      `;
      params = [socketId];
    }
    
    const result = await pool.query(query, params);
    
    // Reorder remaining queues
    for (const entry of result.rows) {
      await reorderQueue(entry.space_type, entry.space_id);
    }
    
    return result.rows;
    
  } catch (error) {
    console.error('Error removing from waitlist:', error);
    return [];
  }
}

/**
 * Track waitlist events for analytics
 */
async function trackWaitlistEvent(eventType, spaceType, spaceId, userAccount, eventData = {}) {
  try {
    await pool.query(`
      INSERT INTO viral_events (event_type, space_type, space_id, user_account, event_data)
      VALUES ($1, $2, $3, $4, $5)
    `, [eventType, spaceType, spaceId, userAccount, JSON.stringify(eventData)]);
  } catch (error) {
    console.error('Error tracking waitlist event:', error);
  }
}

/**
 * Clean up expired waitlist entries
 */
async function cleanupWaitlist() {
  try {
    const cleanupQuery = `
      UPDATE space_waitlist 
      SET status = 'expired' 
      WHERE status = 'waiting' AND expires_at < NOW()
      RETURNING space_type, space_id
    `;
    
    const result = await pool.query(cleanupQuery);
    
    // Reorder affected queues
    const affectedSpaces = [...new Set(result.rows.map(r => `${r.space_type}/${r.space_id}`))];
    for (const spaceKey of affectedSpaces) {
      const [spaceType, spaceId] = spaceKey.split('/');
      await reorderQueue(spaceType, spaceId);
    }
    
    console.log(`[Waitlist] Cleaned up ${result.rowCount} expired waitlist entries`);
    
  } catch (error) {
    console.error('Error cleaning up waitlist:', error);
  }
}

// Schedule waitlist cleanup every 5 minutes
setInterval(cleanupWaitlist, 5 * 60 * 1000);

// ==================================================================
// ENHANCED PRESENCE SESSION MANAGEMENT WITH WAITLIST
// ==================================================================

// Enhanced create presence session with waitlist support
const originalCreatePresenceSession = exports.createPresenceSession;
exports.createPresenceSession = async (req, res) => {
  try {
    const {
      socket_id,
      user_account,
      space_type,
      space_id,
      subspace = 'main',
      position = null,
      avatar_data = null,
      voice_enabled = false,
      creator_account = null
    } = req.body;

    if (!socket_id || !space_type || !space_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if user is premium (they skip waitlist)
    let isPremiumUser = false;
    if (user_account) {
      const premiumCheck = await pool.query(`
        SELECT 1 FROM user_subscriptions us
        JOIN subscription_tiers st ON us.tier_id = st.id
        WHERE us.user_account = $1 AND us.status = 'active' 
          AND us.expires_at > NOW()
          AND st.tier_code IN ('premium', 'pro')
      `, [user_account]);
      isPremiumUser = premiumCheck.rows.length > 0;
    }

    // Premium users bypass all waitlist logic
    if (isPremiumUser) {
      return originalCreatePresenceSession(req, res);
    }

    // Calculate enhanced capacity
    const capacityInfo = await calculateSpaceCapacity(space_type, space_id, creator_account);
    
    // If space has capacity, join directly
    if (capacityInfo.hasCapacity) {
      return originalCreatePresenceSession(req, res);
    }

    // Space is full - add to waitlist
    const waitlistResult = await addToWaitlist(space_type, space_id, socket_id, user_account);
    
    const userType = user_account ? 'hive' : 'guest';
    const priorityMessage = userType === 'hive' ? 
      'Hive users get 2x priority in the queue!' : 
      'Create a Hive account for faster queue access!';
    
    res.status(202).json({ // 202 Accepted - request acknowledged but not completed
      success: false,
      queued: true,
      message: 'Space is full - you have been added to the waitlist',
      queue_info: {
        position: waitlistResult.queue_position,
        user_type: userType,
        estimated_wait: waitlistResult.estimated_wait_time,
        priority_message: priorityMessage
      },
      capacity: capacityInfo.capacityInfo,
      upgrade_options: {
        premium_message: 'Upgrade to Premium to skip all queues and get instant access!',
        hive_message: userType === 'guest' ? 'Create a Hive account for 2x faster queue processing!' : null
      },
      viral_info: {
        premium_users_hosting: capacityInfo.premiumCount,
        bonus_slots_from_premium: capacityInfo.guestSlotsFromPremium
      },
      node: config.username
    });

  } catch (error) {
    console.error('Error in enhanced presence session creation:', error);
    res.status(500).json({ error: 'Failed to create presence session' });
  }
};

// Enhanced remove presence session with waitlist processing
const originalRemovePresenceSession = exports.removePresenceSession;
exports.removePresenceSession = async (req, res) => {
  try {
    const { socket_id } = req.params;
    
    // Get session info before removal
    const sessionQuery = `
      SELECT space_type, space_id, user_account 
      FROM presence_sessions 
      WHERE socket_id = $1
    `;
    const sessionResult = await pool.query(sessionQuery, [socket_id]);
    
    // Remove from presence
    const removeResult = await originalRemovePresenceSession(req, res);
    
    // If someone left a space, process waitlist for that space
    if (sessionResult.rows.length > 0) {
      const { space_type, space_id } = sessionResult.rows[0];
      
      // Remove from any waitlists they might be in
      await removeFromWaitlist(socket_id);
      
      // Process waitlist for the space they left (1 new slot available)
      const admittedUsers = await processWaitlist(space_type, space_id, 1);
      
      if (admittedUsers.length > 0) {
        console.log(`[Waitlist] Admitted ${admittedUsers.length} users from queue for ${space_type}/${space_id}`);
        
        // Here you would normally notify the admitted users via WebSocket
        // For now, we just log the event
      }
    }
    
    return removeResult;
    
  } catch (error) {
    console.error('Error in enhanced presence session removal:', error);
    return originalRemovePresenceSession(req, res);
  }
};

// ==================================================================
// WAITLIST API ENDPOINTS
// ==================================================================

// Get waitlist status for a user
exports.getWaitlistStatus = async (req, res) => {
  try {
    const { socket_id } = req.params;
    
    const query = `
      SELECT sw.*, 
             (SELECT COUNT(*) FROM space_waitlist sw2 
              WHERE sw2.space_type = sw.space_type AND sw2.space_id = sw.space_id 
                AND sw2.queue_position < sw.queue_position AND sw2.status = 'waiting') as users_ahead
      FROM space_waitlist sw
      WHERE sw.socket_id = $1 AND sw.status = 'waiting'
      ORDER BY sw.joined_queue_at DESC
    `;
    
    const result = await pool.query(query, [socket_id]);
    
    res.json({
      success: true,
      waitlist_entries: result.rows.map(entry => ({
        ...entry,
        estimated_wait: estimateWaitTime(entry.space_type, entry.space_id, entry.queue_position)
      })),
      node: config.username
    });
    
  } catch (error) {
    console.error('Error getting waitlist status:', error);
    res.status(500).json({ error: 'Failed to get waitlist status' });
  }
};

// Get queue information for a space
exports.getSpaceQueueInfo = async (req, res) => {
  try {
    const { space_type, space_id } = req.params;
    
    const queueQuery = `
      SELECT 
        COUNT(*) as total_waiting,
        COUNT(*) FILTER (WHERE user_type = 'hive') as hive_waiting,
        COUNT(*) FILTER (WHERE user_type = 'guest') as guest_waiting,
        AVG(EXTRACT(EPOCH FROM (NOW() - joined_queue_at))/60)::integer as avg_wait_minutes
      FROM space_waitlist
      WHERE space_type = $1 AND space_id = $2 AND status = 'waiting'
    `;
    
    const admissionQuery = `
      SELECT 
        COUNT(*) as total_admitted_today,
        COUNT(*) FILTER (WHERE user_type = 'hive') as hive_admitted_today,
        COUNT(*) FILTER (WHERE user_type = 'guest') as guest_admitted_today
      FROM waitlist_admissions
      WHERE space_type = $1 AND space_id = $2 
        AND admitted_at > CURRENT_DATE
    `;
    
    const [queueResult, admissionResult] = await Promise.all([
      pool.query(queueQuery, [space_type, space_id]),
      pool.query(admissionQuery, [space_type, space_id])
    ]);
    
    const queueStats = queueResult.rows[0];
    const admissionStats = admissionResult.rows[0];
    
    res.json({
      success: true,
      queue_info: {
        current_queue: queueStats,
        today_admissions: admissionStats,
        priority_system: {
          hive_to_guest_ratio: '2:1',
          description: 'Hive users get admitted at 2x the rate of guests'
        }
      },
      node: config.username
    });
    
  } catch (error) {
    console.error('Error getting space queue info:', error);
    res.status(500).json({ error: 'Failed to get space queue info' });
  }
};

// Leave waitlist
exports.leaveWaitlist = async (req, res) => {
  try {
    const { socket_id } = req.params;
    const { space_type, space_id } = req.body;
    
    const removedEntries = await removeFromWaitlist(socket_id, space_type, space_id);
    
    res.json({
      success: true,
      removed_entries: removedEntries.length,
      message: 'Successfully left waitlist',
      node: config.username
    });
    
  } catch (error) {
    console.error('Error leaving waitlist:', error);
    res.status(500).json({ error: 'Failed to leave waitlist' });
  }
};

// ==================================================================
// WAITLIST ANALYTICS
// ==================================================================

// Get waitlist analytics
exports.getWaitlistAnalytics = async (req, res) => {
  try {
    const { days = 7 } = req.query;
    
    const analyticsQuery = `
      SELECT 
        DATE_TRUNC('day', joined_queue_at) as date,
        user_type,
        COUNT(*) as users_queued,
        COUNT(*) FILTER (WHERE status = 'admitted') as users_admitted,
        AVG(EXTRACT(EPOCH FROM (COALESCE(notified_at, NOW()) - joined_queue_at))/60)::integer as avg_wait_minutes
      FROM space_waitlist
      WHERE joined_queue_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE_TRUNC('day', joined_queue_at), user_type
      ORDER BY date DESC, user_type
    `;
    
    const conversionQuery = `
      SELECT 
        event_type,
        COUNT(*) as event_count,
        DATE_TRUNC('day', created_at) as date
      FROM viral_events
      WHERE event_type LIKE '%queue%' OR event_type LIKE '%waitlist%'
        AND created_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY event_type, DATE_TRUNC('day', created_at)
      ORDER BY date DESC, event_count DESC
    `;
    
    const [analyticsResult, conversionResult] = await Promise.all([
      pool.query(analyticsQuery),
      pool.query(conversionQuery)
    ]);
    
    res.json({
      success: true,
      analytics: {
        waitlist_stats: analyticsResult.rows,
        conversion_events: conversionResult.rows,
        period_days: days
      },
      node: config.username
    });
    
  } catch (error) {
    console.error('Error getting waitlist analytics:', error);
    res.status(500).json({ error: 'Failed to get waitlist analytics' });
  }
}; 