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

  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

var http = require("http").Server(api);

// Initialize WebSocket monitor AFTER HTTP server is created
const wsMonitor = initializeWebSocketMonitor(http);

// Non-authenticated system endpoints (MUST BE FIRST - before any auth middleware)
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
api.use(cors());
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

// Content and search routes
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

// Generic API route (should be last among GET routes with similar paths)
api.get("/api/:api_type/:api_call", API.hive_api);

http.listen(config.port, async function () {

  await initializeDatabase();
  
  // Initialize the full onboarding service including blockchain monitoring
  await initializeOnboardingService();
  
  // Start Hive blockchain monitoring
  await hiveMonitor.start();
  
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