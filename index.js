const config = require("./config");
const express = require("express");
const cors = require("cors");
const API = require("./api/index");
const api = express();
var http = require("http").Server(api);
const fetch = require("node-fetch");

api.use(API.https_redirect);
api.use(cors());
api.get("/api/:api_type/:api_call", API.hive_api);
api.get("/dapps/@:author/:permlink", API.getPostRoute);
api.get("/dapps/@:author", API.getAuthorPosts);
api.get("/new", API.getNewPosts);
api.get("/search/:search_term", API.getSearchResults);
api.get("/trending", API.getTrendingPosts);
api.get("/promoted", API.getPromotedPosts);
api.get("/pfp/:user", API.getPFP);
api.get("/details/:script/:uid", API.detailsNFT);
api.get("/img/details/:set/:uid", API.detailsNFT);
api.get("/render/:script/:uid", API.renderNFT);
api.get("/img/render/:set/:uid", API.renderNFT);
api.get("/hc/tickers", API.tickers);

http.listen(config.port, function () {
  console.log(`DLUX DATA API listening on port ${config.port}`);
});

fetch(`${config.dluxapi}api/sets`)
  .then((r) => r.json())
  .then((json) => {
    let scripts = {};
    for (var item = 0; item < json.result.length; item++) {
      scripts[json.result[item].set] = json.result[item].script;
      console.log(json.result[item].script);
    }
    API.start(scripts);
  })
  .catch((e) => console.log(e));