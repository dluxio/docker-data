const config = require("./config");
const { Pool } = require("pg");
const express = require("express");
const cors = require("cors");
const api = express();
const pool = new Pool({
  connectionString: config.dbcs,
});

exports.pool = pool;

const API = require("./api/index");
const { router: onboardingRouter, setupDatabase, initializeWebSocketMonitor } = require('./api/onboarding');

// Trust proxy setting for rate limiting and real client IP detection
// This is required when running behind Docker/nginx/load balancer
// Using 1 to trust only the first proxy (more secure than true)
api.set('trust proxy', 1);

async function initializeDatabase() {
  try {
    // Set up onboarding tables
    await setupDatabase();
    
    // You can add other table setup here

  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

var http = require("http").Server(api);

// Initialize WebSocket monitor AFTER HTTP server is created
const wsMonitor = initializeWebSocketMonitor(http);

api.use(API.https_redirect);
api.use(cors());
api.use(onboardingRouter);

// Serve admin dashboard static files
api.use('/admin', express.static('admin'));

// Redirect /admin/ to /admin/index.html for convenience
api.get('/admin/', (req, res) => {
  res.redirect('/admin/index.html');
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

http.listen(config.port, async function () {

  await initializeDatabase();
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    wsMonitor.shutdown();
    http.close(() => {
      process.exit(0);
    });
  });
  
  process.on('SIGINT', () => {
    wsMonitor.shutdown();
    http.close(() => {
      process.exit(0);
    });
  });
});