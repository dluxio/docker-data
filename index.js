const config = require("./config");
const { Pool } = require("pg");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const api = express();
const pool = new Pool({
  connectionString: config.dbcs,
});

exports.pool = pool;

const API = require("./api/index");
const { router: onboardingRouter, setupDatabase, initializeWebSocketMonitor, initializeOnboardingService } = require('./api/onboarding');
const collaborationRouter = require('./api/collaboration');
const { 
    setupDeviceDatabase, 
    createPairing, 
    connectToDevice, 
    createSigningRequest, 
    getPendingRequests, 
    respondToRequest, 
    disconnectDevice, 
    getDeviceStatus, 
    waitForResponse,
    testDeviceConnection
} = require('./api/device-connection');
// Test endpoints (can be removed in production)
const { testWebSocketIntegration } = require('./api/test-device-websocket');
const { testMessageDirection } = require('./api/test-message-direction');
const { getProtocolSummary } = require('./api/device-protocol-summary');
const { createAuthMiddleware } = require('./api/onboarding');
const hiveMonitor = require('./hive-monitor');

// Trust proxy setting for real client IP detection
// This is required when running behind Docker/nginx/load balancer
// Using 1 to trust only the first proxy (more secure than true)
api.set('trust proxy', 1);

async function initializeDatabase() {
  try {
    // Set up onboarding tables
    await setupDatabase();
    
    // Set up device connection tables
    await setupDeviceDatabase();

    // Set up Hive state table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hive_state (
        id INTEGER PRIMARY KEY,
        last_block BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Initialize hive_state if not exists
    await pool.query(`
      INSERT INTO hive_state (id, last_block)
      VALUES (1, 0)
      ON CONFLICT (id) DO NOTHING
    `);

    // Set up script security tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS script_whitelist (
        id SERIAL PRIMARY KEY,
        script_hash VARCHAR(64) UNIQUE NOT NULL,
        script_name VARCHAR(255),
        description TEXT,
        whitelisted_by VARCHAR(50) NOT NULL,
        whitelisted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        risk_level VARCHAR(20) DEFAULT 'medium',
        usage_count INTEGER DEFAULT 0,
        last_used TIMESTAMP WITH TIME ZONE,
        notes TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS script_reviews (
        id SERIAL PRIMARY KEY,
        script_hash VARCHAR(64) UNIQUE NOT NULL,
        script_content TEXT NOT NULL,
        request_source VARCHAR(50) NOT NULL,
        requested_by VARCHAR(50) NOT NULL,
        request_context JSONB,
        risk_assessment JSONB,
        auto_flagged BOOLEAN DEFAULT false,
        flagged_reasons TEXT[],
        status VARCHAR(20) DEFAULT 'pending',
        reviewed_by VARCHAR(50),
        reviewed_at TIMESTAMP WITH TIME ZONE,
        reviewer_notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS script_execution_logs (
        id SERIAL PRIMARY KEY,
        script_hash VARCHAR(64) NOT NULL,
        executed_by VARCHAR(50) NOT NULL,
        execution_context JSONB,
        success BOOLEAN NOT NULL,
        error_message TEXT,
        execution_time_ms INTEGER,
        request_ip INET,
        user_agent TEXT,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for script security tables
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_script_whitelist_hash ON script_whitelist(script_hash);
      CREATE INDEX IF NOT EXISTS idx_script_whitelist_active ON script_whitelist(is_active);
      CREATE INDEX IF NOT EXISTS idx_script_reviews_hash ON script_reviews(script_hash);
      CREATE INDEX IF NOT EXISTS idx_script_reviews_status ON script_reviews(status);
      CREATE INDEX IF NOT EXISTS idx_script_execution_logs_hash ON script_execution_logs(script_hash);
      CREATE INDEX IF NOT EXISTS idx_script_execution_logs_executed_at ON script_execution_logs(executed_at);
    `);

    // Set up notification tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT,
        data JSONB,
        status VARCHAR(20) DEFAULT 'unread',
        read_at TIMESTAMP WITH TIME ZONE,
        expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        last_read TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        email_notifications BOOLEAN DEFAULT true,
        push_notifications BOOLEAN DEFAULT true,
        notification_frequency VARCHAR(20) DEFAULT 'immediate',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for notification tables
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_notifications_username ON user_notifications(username);
      CREATE INDEX IF NOT EXISTS idx_user_notifications_status ON user_notifications(status);
      CREATE INDEX IF NOT EXISTS idx_user_notifications_created ON user_notifications(created_at);
      CREATE INDEX IF NOT EXISTS idx_notification_settings_username ON notification_settings(username);
    `);

    // Add new columns to posts table for ReMix content
    try {
      // Check if posts table exists
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'posts'
        )
      `);
      
      if (tableCheck.rows[0].exists) {
        console.log('Posts table exists, checking for new columns...');
        
        // Add remix_cid column if it doesn't exist
        try {
          await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS remix_cid TEXT');
          console.log('✓ Added remix_cid column to posts table');
        } catch (error) {
          console.log('remix_cid column already exists or error:', error.message);
        }
        
        // Add license column if it doesn't exist
        try {
          await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS license VARCHAR(255)');
          console.log('✓ Added license column to posts table');
        } catch (error) {
          console.log('license column already exists or error:', error.message);
        }
        
        // Add tags column if it doesn't exist (PostgreSQL array)
        try {
          await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags TEXT[]');
          console.log('✓ Added tags column to posts table');
        } catch (error) {
          console.log('tags column already exists or error:', error.message);
        }
        
        // Create indexes for the new columns
        try {
          await pool.query('CREATE INDEX IF NOT EXISTS idx_posts_remix_cid ON posts(remix_cid) WHERE remix_cid IS NOT NULL');
          await pool.query('CREATE INDEX IF NOT EXISTS idx_posts_license ON posts(license) WHERE license IS NOT NULL');
          await pool.query('CREATE INDEX IF NOT EXISTS idx_posts_tags ON posts USING GIN(tags) WHERE tags IS NOT NULL');
          console.log('✓ Created indexes for new columns');
        } catch (error) {
          console.log('Error creating indexes:', error.message);
        }
      }
    } catch (error) {
      console.error('Error updating posts table schema:', error);
    }

    // Create ReMix applications tracking tables
    try {
      // Table to track unique ReMix applications (CIDs)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS remix_applications (
          remix_cid TEXT PRIMARY KEY,
          first_author VARCHAR(50) NOT NULL,
          first_permlink VARCHAR(255) NOT NULL,
          first_seen_block BIGINT NOT NULL,
          license VARCHAR(255),
          title VARCHAR(500),
          description TEXT,
          usage_count INTEGER DEFAULT 1,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✓ Created remix_applications table');

      // Table to track derivative works using ReMix applications
      await pool.query(`
        CREATE TABLE IF NOT EXISTS remix_derivatives (
          id SERIAL PRIMARY KEY,
          remix_cid TEXT NOT NULL,
          author VARCHAR(50) NOT NULL,
          permlink VARCHAR(255) NOT NULL,
          block BIGINT NOT NULL,
          license VARCHAR(255),
          tags TEXT[],
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(remix_cid, author, permlink),
          FOREIGN KEY (remix_cid) REFERENCES remix_applications(remix_cid) ON DELETE CASCADE
        )
      `);
      console.log('✓ Created remix_derivatives table');

      // Create indexes for performance
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_remix_applications_usage ON remix_applications(usage_count DESC);
        CREATE INDEX IF NOT EXISTS idx_remix_applications_created ON remix_applications(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_remix_derivatives_cid ON remix_derivatives(remix_cid);
        CREATE INDEX IF NOT EXISTS idx_remix_derivatives_author ON remix_derivatives(author);
        CREATE INDEX IF NOT EXISTS idx_remix_derivatives_block ON remix_derivatives(block DESC);
        CREATE INDEX IF NOT EXISTS idx_remix_derivatives_tags ON remix_derivatives USING GIN(tags) WHERE tags IS NOT NULL;
      `);
      console.log('✓ Created indexes for ReMix tables');

    } catch (error) {
      console.error('Error creating ReMix tracking tables:', error);
    }

    console.log('Database initialization completed successfully');

  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

var http = require("http").Server(api);

// Initialize WebSocket monitor AFTER HTTP server is created
const wsMonitor = initializeWebSocketMonitor(http);




// Apply CORS middleware FIRST to ensure all endpoints have proper CORS headers
api.use(cors());

// Non-authenticated system endpoints (after CORS but before auth middleware)
api.get('/api/system/versions', async (req, res) => {
  try {
    // Get package.json to read versions
    const packageJson = require('./package.json')
    
    // Core collaboration packages
    const collaborationPackages = {
      '@hocuspocus/server': packageJson.dependencies['@hocuspocus/server'],
      '@hocuspocus/extension-database': packageJson.dependencies['@hocuspocus/extension-database'],
      '@hocuspocus/extension-logger': packageJson.dependencies['@hocuspocus/extension-logger'],
      'hocuspocus-extension-postgres': packageJson.dependencies['hocuspocus-extension-postgres'],
      'yjs': packageJson.dependencies['yjs'],
      'y-protocols': packageJson.dependencies['y-protocols']
    }
    
    // Blockchain packages
    const blockchainPackages = {
      '@hiveio/hive-js': packageJson.dependencies['@hiveio/hive-js'],
      'hive-tx': packageJson.dependencies['hive-tx'],
      '@solana/web3.js': packageJson.dependencies['@solana/web3.js'],
      'ethers': packageJson.dependencies['ethers'],
      'bitcoinjs-lib': packageJson.dependencies['bitcoinjs-lib'],
      'monero-javascript': packageJson.dependencies['monero-javascript'],
      'monero-ts': packageJson.dependencies['monero-ts']
    }
    
    // Core infrastructure packages
    const infrastructurePackages = {
      'express': packageJson.dependencies['express'],
      'pg': packageJson.dependencies['pg'],
      'ws': packageJson.dependencies['ws'],
      'cors': packageJson.dependencies['cors'],
      'axios': packageJson.dependencies['axios'],
      'node-fetch': packageJson.dependencies['node-fetch']
    }
    
    // Cryptography packages
    const cryptoPackages = {
      'bip32': packageJson.dependencies['bip32'],
      'bip39': packageJson.dependencies['bip39'],
      'tiny-secp256k1': packageJson.dependencies['tiny-secp256k1']
    }
    
    // System information
    const systemInfo = {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptime: Math.floor(process.uptime()),
      memoryUsage: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        external: Math.round(process.memoryUsage().external / 1024 / 1024)
      }
    }
    
    // Available endpoints and their authentication requirements
    const endpointInfo = {
      public: [
        'GET /api/system/versions - System version information (no auth)',
        'GET /stats - System statistics (no auth)',
        'GET /hc/tickers - Health check tickers (no auth)'
      ],
      authenticated: [
        'POST /api/onboarding/* - Account onboarding (HIVE auth)',
        'GET|POST /api/collaboration/* - Real-time collaboration (HIVE auth)',
        'POST /api/device/* - Device pairing and signing (HIVE auth)'
      ],
      authenticationMethods: {
        hiveKeys: {
          description: 'HIVE blockchain cryptographic signatures',
          headers: ['x-account', 'x-challenge', 'x-pubkey', 'x-signature'],
          keyTypes: ['posting', 'active', 'owner', 'memo'],
          challengeWindow: '24 hours'
        }
      }
    }
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      
      application: {
        name: packageJson.name,
        version: packageJson.version,
        description: packageJson.description || 'DLUX Data Collaboration Server',
        license: packageJson.license
      },
      
      packages: {
        collaboration: collaborationPackages,
        blockchain: blockchainPackages,
        infrastructure: infrastructurePackages,
        cryptography: cryptoPackages
      },
      
      system: systemInfo,
      
      features: {
        realTimeCollaboration: {
          enabled: true,
          websocketServer: 'Hocuspocus',
          conflictResolution: 'CRDT (Yjs)',
          persistence: 'PostgreSQL'
        },
        blockchainIntegration: {
          hive: true,
          solana: true,
          ethereum: true,
          bitcoin: true,
          monero: true
        },
        authentication: {
          hiveKeys: true,
          multiChain: true,
          cryptographicSignatures: true
        }
      },
      
      endpoints: endpointInfo
    })
    
  } catch (error) {
    console.error('Error getting version information:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve version information',
      message: error.message
    })
  }
})

api.use(API.https_redirect);
api.use(express.json());
api.use(onboardingRouter);
api.use(collaborationRouter);

// Serve admin dashboard static files
api.use('/admin', express.static('admin'));

// Redirect /admin/ to /admin/index.html for convenience
api.get('/admin/', (req, res) => {
  res.redirect('/admin/index.html');
});

// Device connection endpoints (must be before generic API route)
const deviceAuthMiddleware = createAuthMiddleware(false, false);
api.post("/api/device/pair", deviceAuthMiddleware, createPairing);
api.post("/api/device/connect", connectToDevice);
api.post("/api/device/request", createSigningRequest);
api.get("/api/device/requests", deviceAuthMiddleware, getPendingRequests);
api.post("/api/device/respond", deviceAuthMiddleware, respondToRequest);
api.post("/api/device/disconnect", disconnectDevice);
api.get("/api/device/status", getDeviceStatus);
api.post("/api/device/wait-response", waitForResponse);
api.get("/api/device/test", testDeviceConnection);
// Test endpoints (can be removed in production)
api.get("/api/device/test-websocket", testWebSocketIntegration);
api.get("/api/device/test-message-direction", testMessageDirection);
api.get("/api/device/protocol-summary", getProtocolSummary);

// Collaboration monitoring endpoints
api.get("/api/collaboration/activity/:owner/:permlink", API.getCollaborationActivity);
api.get("/api/collaboration/stats/:owner/:permlink", API.getCollaborationStats);
api.get("/api/collaboration/test-awareness", API.getCollaborationTestInfo);

// ✅ STEP 3: Permission management endpoint with real-time broadcasts
const collaborationAuthMiddleware = createAuthMiddleware(true, true);
api.post("/api/collaboration/permissions/:owner/:permlink", collaborationAuthMiddleware, async (req, res) => {
  const { owner, permlink } = req.params;
  const { permissions } = req.body;

  try {
    console.log('[Permissions] Update requested by:', req.headers['x-account']);
    
    // Import collaboration server to access the server instance
    const { server: collaborationServer, HiveAuthExtension } = require('./collaboration-server');
    
    // Check for documents on hocuspocus instance
    let documentsMap = null;
    const hocuspocus = collaborationServer.hocuspocus;
    
    // Check for documents on hocuspocus instance
    
    if (hocuspocus && hocuspocus.documents instanceof Map) {
      documentsMap = hocuspocus.documents;
      // Found documents Map on hocuspocus
    } else {
      console.error('[Permissions] ERROR: No valid documents Map found');
    }
    
    // Create instance to use the permission update method
    const hiveAuth = new HiveAuthExtension();
    const result = await hiveAuth.updateDocumentPermissions(collaborationServer, owner, permlink, permissions);
    
    console.log('[Permissions] Broadcast triggered for:', `${owner}/${permlink}`);
    res.json(result);
  } catch (error) {
    console.error('[Permissions] Update API failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Script management endpoints (with authentication)
const scriptAuthMiddleware = createAuthMiddleware(true, true);
api.get("/api/scripts/stats", scriptAuthMiddleware, API.getScriptStats);
api.get("/api/scripts/pending", scriptAuthMiddleware, API.getPendingScriptReviews);
api.get("/api/scripts/review/:reviewId", scriptAuthMiddleware, API.getScriptReviewDetails);
api.post("/api/scripts/review/:reviewId/action", scriptAuthMiddleware, API.reviewScript);
api.get("/api/scripts/whitelist", scriptAuthMiddleware, API.getWhitelistedScripts);
api.delete("/api/scripts/whitelist/:scriptHash", scriptAuthMiddleware, API.removeFromWhitelist);
api.post("/api/scripts/whitelist/:scriptHash/reactivate", scriptAuthMiddleware, API.reactivateScript);
api.put("/api/scripts/whitelist/:scriptHash/update", scriptAuthMiddleware, API.updateScript);
api.get("/api/scripts/logs", scriptAuthMiddleware, API.getScriptExecutionLogs);







// Debug endpoint removed after troubleshooting session

// Test endpoint removed after confirming functionality works

// Set last read notifications endpoint
api.post('/api/set-last-read/:txid', async (req, res) => {
  const { txid } = req.params;
  
  if (!txid) {
    return res.status(400).json({
      success: false,
      error: 'Transaction ID is required'
    });
  }

  try {
    // Import hive monitor here to avoid circular dependency
    const hiveMonitor = require('./hive-monitor');
    
    console.log(`Looking for transaction ${txid} for read notification...`);
    
    // Wait for the transaction to be processed (2 minute timeout)
    const txData = await hiveMonitor.waitForReadTransaction(txid, 120000);
    
    console.log(`Found transaction ${txid} for user ${txData.username}`);
    
    // Now perform the database operations that we removed from the blockchain monitor
    const readDate = new Date(txData.data.data.date);
    
    // Update local notifications
    const localResult = await pool.query(`
        UPDATE user_notifications 
        SET read_at = $1, status = 'read'
        WHERE username = $2 
        AND (read_at IS NULL OR read_at < $1)
        AND (expires_at IS NULL OR expires_at > NOW())
    `, [readDate, txData.username]);

    // Update notification settings for Hive Bridge notifications
    const settingsResult = await pool.query(`
        INSERT INTO notification_settings (username, last_read)
        VALUES ($1, $2)
        ON CONFLICT (username) 
        DO UPDATE SET last_read = $2
        WHERE notification_settings.last_read < $2
    `, [txData.username, readDate]);
    
    console.log(`Updated notifications for ${txData.username}: ${localResult.rowCount} local notifications, settings updated`);
    
    res.json({
      success: true,
      message: 'Notifications marked as read',
      data: {
        txId: txid,
        username: txData.username,
        readDate: readDate,
        localNotificationsUpdated: localResult.rowCount,
        settingsUpdated: true,
        blockNum: txData.data.blockNum
      }
    });
    
  } catch (error) {
    console.error(`Error processing set-last-read for ${txid}:`, error);
    
    if (error.message.includes('not found within timeout')) {
      res.status(408).json({
        success: false,
        error: 'Transaction not found within timeout period',
        message: 'The transaction may not exist or has not been processed yet'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to process read notification',
        message: error.message
      });
    }
  }
});

// Debug endpoint to check transaction status
api.get('/api/debug/read-transactions', async (req, res) => {
  try {
    const hiveMonitor = require('./hive-monitor');
    const status = hiveMonitor.getStatus();
    
    res.json({
      success: true,
      data: {
        monitorStatus: status,
        pendingTransactions: Array.from(hiveMonitor.pendingReadTransactions.entries()).map(([txId, data]) => ({
          txId,
          username: data.username,
          timestamp: new Date(data.timestamp).toISOString(),
          ageMinutes: Math.round((Date.now() - data.timestamp) / 60000)
        })),
        activeResolvers: Array.from(hiveMonitor.readTransactionResolvers.keys())
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

api.get("/api/:api_type/:api_call", API.hive_api);
api.get("/dapps/@:author/:permlink", API.getPostRoute);
api.get("/dapps/@:author", API.getAuthorPosts);
api.get("/new", API.getNewPosts);
api.get("/stats", API.stats);
api.get("/search/:search_term", API.getSearchResults);
api.get("/trending", API.getTrendingPosts);
api.get("/promoted", API.getPromotedPosts);
api.get("/pfp/:user", API.getPFP);
api.get("/img/pfp/:user", API.getPFP);
api.get("/details/:script/:uid", API.detailsNFT);
api.get("/img/details/:set/:uid", API.detailsNFT);
api.get("/render/:script/:uid", API.renderNFT);
api.get("/img/render/:set/:uid", API.renderNFT);
api.get("/hc/tickers", API.tickers);

// ReMix API routes
api.get("/remix/new", API.getNewReMixPosts);
api.get("/remix/trending", API.getTrendingReMixPosts);
api.get("/remix/licenses", API.getReMixLicenses);
api.get("/remix/tags", API.getReMixTags);

// ReMix Applications API routes
api.get("/remix/apps/popular", API.getPopularReMixApplications);
api.get("/remix/apps/newest", API.getNewestReMixApplications);
api.get("/remix/apps/stats", API.getReMixApplicationStats);
api.get("/remix/apps/:remixCid", API.getReMixApplicationDetails);
api.get("/remix/derivatives/@:author", API.getDerivativeWorksByAuthor);

// Monitoring API routes
api.get("/monitor/blocks", API.getBlockMonitorStatus);
api.get("/monitor/hive", API.getHiveMonitorStatus);

// Test routes (for admin use)
api.get("/test/hive-api", API.testHiveAPI);
api.post("/test/remix", API.testReMixData);

// DLUX Presence VR API routes
const presenceAPI = require('./api/presence');
const presenceWriteAPI = require('./api/presence-api');

// Read operations (existing presence API)
api.get("/api/presence/turn-credentials", presenceAPI.getTurnCredentials);
api.get("/api/presence/spaces", presenceAPI.getSpaces);
api.get("/api/presence/spaces/:spaceType/:spaceId", presenceAPI.getSpaceDetails);
api.post("/api/presence/spaces/:spaceType/:spaceId/join", presenceAPI.joinSpace);

// Write operations (new presence write API)
api.get("/api/presence/health", presenceWriteAPI.presenceHealthCheck);

// Session management
api.post("/api/presence/sessions", presenceWriteAPI.createPresenceSession);
api.put("/api/presence/sessions/:socket_id", presenceWriteAPI.updatePresenceActivity);
api.delete("/api/presence/sessions/:socket_id", presenceWriteAPI.removePresenceSession);

// Chat messaging
api.post("/api/presence/chat/messages", presenceWriteAPI.sendChatMessage);

// Document collaboration
api.post("/api/presence/documents/:document_id/comments", presenceWriteAPI.addDocumentComment);

// Space audio configuration
api.put("/api/presence/spaces/:space_type/:space_id/audio", presenceWriteAPI.updateSpaceAudioConfig);
api.post("/api/presence/audio/sessions", presenceWriteAPI.startAudioSession);
api.put("/api/presence/audio/sessions/:session_id/end", presenceWriteAPI.endAudioSession);

// Activity logging
api.post("/api/presence/activity", presenceWriteAPI.logSpaceActivity);

// Enhanced viral capacity system routes
api.get("/api/presence/spaces/:space_type/:space_id/capacity", presenceWriteAPI.getSpaceCapacity);
api.get("/api/presence/users/:socket_id/spaces", presenceWriteAPI.getUserSpaces);
api.post("/api/presence/viral/track", presenceWriteAPI.trackViralEvent);
api.get("/api/presence/viral/analytics", presenceWriteAPI.getViralAnalytics);

// Waitlist/Queue system routes
api.get("/api/presence/waitlist/:socket_id/status", presenceWriteAPI.getWaitlistStatus);
api.get("/api/presence/spaces/:space_type/:space_id/queue", presenceWriteAPI.getSpaceQueueInfo);
api.delete("/api/presence/waitlist/:socket_id/leave", presenceWriteAPI.leaveWaitlist);
api.get("/api/presence/waitlist/analytics", presenceWriteAPI.getWaitlistAnalytics);

// Test endpoint for viral capacity system
api.get("/api/presence/test/viral-capacity", presenceWriteAPI.testViralCapacitySystem);

// ==================================================================
// SUBSCRIPTION SYSTEM API ROUTES
// ==================================================================

// Database initialization and status endpoints
api.get("/api/init-subscription-system", API.initSubscriptionSystem);
api.get("/api/check-subscription-tables", API.checkSubscriptionTables);

const subscriptionAPI = require('./api/subscription-api');

// Public subscription endpoints
api.get("/api/subscriptions/tiers", subscriptionAPI.getSubscriptionTiers);
api.get("/api/subscriptions/user/:userAccount", subscriptionAPI.getUserSubscription);
api.get("/api/subscriptions/user/:userAccount/access", subscriptionAPI.checkSubscriptionAccess);
api.get("/api/subscriptions/user/:userAccount/payments", subscriptionAPI.getPaymentHistory);
api.post("/api/subscriptions/calculate-price", subscriptionAPI.calculateSubscriptionPrice);

// Admin subscription endpoints (should have proper auth in production)
api.get("/api/admin/subscriptions/stats", subscriptionAPI.getSubscriptionStats);
api.post("/api/admin/subscriptions/promo-codes", subscriptionAPI.createPromoCode);
api.get("/api/admin/subscriptions/promo-codes", subscriptionAPI.getPromoCodes);

// Payment notification endpoints (admin)
api.get("/api/admin/subscriptions/notifications/stats", subscriptionAPI.getNotificationStats);
api.post("/api/admin/subscriptions/notifications/run-checks", subscriptionAPI.runNotificationChecks);

// Subscription monitoring status endpoint
api.get("/api/subscriptions/monitor/stats", async (req, res) => {
  try {
    const SubscriptionMonitor = require('./subscription-monitor');
    const subscriptionMonitor = require('./subscription-monitor-instance');
    const stats = await subscriptionMonitor.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting subscription monitor stats:', error);
    res.status(500).json({ error: 'Failed to get subscription monitor stats' });
  }
});

http.listen(config.port, async function () {

  await initializeDatabase();
  
  // Initialize the full onboarding service including blockchain monitoring
  await initializeOnboardingService();
  
  // Start Hive blockchain monitoring
  await hiveMonitor.start();
  
  // Initialize and start subscription monitoring
  const SubscriptionMonitor = require('./subscription-monitor');
  const subscriptionMonitor = new SubscriptionMonitor();
  await subscriptionMonitor.initialize(hiveMonitor);
  
  // Store subscription monitor instance for API access
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(
    path.join(__dirname, 'subscription-monitor-instance.js'),
    `module.exports = ${JSON.stringify(subscriptionMonitor)};`
  );
  
  console.log('✅ Subscription monitoring system initialized');
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await hiveMonitor.stop();
    wsMonitor.shutdown();
    http.close(() => {
      process.exit(0);
    });
  });
  
  process.on('SIGINT', async () => {
    await hiveMonitor.stop();
    wsMonitor.shutdown();
    http.close(() => {
      process.exit(0);
    });
  });
});