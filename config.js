require('dotenv').config();
const ENV = process.env;
const port = ENV.PORT || 3000;
const dbcs = ENV.DATABASE_URL || '';
const dluxapi = ENV.DLUXAPI || "https://token.dlux.io/"
var clientURL = ENV.APIURL || "https://rpc.ecency.com/"
let config = {
    dluxapi,
    dbcs,
    port,
    clientURL,
    username: 'dlux-io'
};

module.exports = config;