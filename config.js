require('dotenv').config();
const ENV = process.env;
const port = ENV.PORT || 3000;
const dbcs = ENV.DATABASE_URL || '';
const dluxapi = ENV.DLUXAPI || "https://token.dlux.io/"
const username = ENV.USERNAME || 'dlux-io'
var clientURL = ENV.APIURL || "https://api.hive.blog/"
let config = {
    dluxapi,
    dbcs,
    port,
    clientURL,
    username
};

module.exports = config;