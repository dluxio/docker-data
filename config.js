require('dotenv').config();
const ENV = process.env;
const port = ENV.PORT || 3000;
const dbcs = ENV.DATABASE_URL || '';
const honeycombapi = ENV.HCAPI || "https://token.dlux.io/"
const username = ENV.USERNAME || 'dlux-io'
const key = ENV.KEY || ''
var clientURL = ENV.APIURL || "https://api.hive.blog/"
let config = {
    honeycombapi,
    dbcs,
    port,
    clientURL,
    username,
    key
};

module.exports = config;