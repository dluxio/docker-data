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
const { router: onboardingRouter, setupDatabase } = require('./api/onboarding');
const wsMonitor = initializeWebSocketMonitor(api);
async function initializeDatabase() {
  try {
    // Set up onboarding tables
    await setupDatabase();
    
    // You can add other table setup here
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

var http = require("http").Server(api);

api.use(API.https_redirect);
api.use(cors());
api.use(onboardingRouter);
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
  console.log(`DLUX DATA API listening on port ${config.port}`);
  await initializeDatabase();
  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    wsMonitor.shutdown();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
  
  process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    wsMonitor.shutdown();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});