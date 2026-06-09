require('dotenv').config();
const db = require('./src/db');
const server = require('./src/server');
const bridge = require('./src/bridge');

db.init();
server.init();
bridge.init();
