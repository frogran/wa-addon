require('dotenv').config();
const db = require('./src/db');
const server = require('./src/server');
const bridge = require('./src/bridge');
const scheduler = require('./src/scheduler');

db.init();
server.init();
bridge.init();
scheduler.init(bridge.sendMessage);
