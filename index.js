require('dotenv').config();
const db = require('./src/db');
const server = require('./src/server');
const bridge = require('./src/bridge');
const scheduler = require('./src/scheduler');
const backfill = require('./src/backfill');

db.init();
server.init();
bridge.init();
scheduler.init(bridge.sendMessage);

const lastProcessed = db.getSetting('backfill_last_processed_id');
if (!lastProcessed && db.countInboundMessages() > 0) {
  console.log('Starting initial backfill...');
  backfill.run(null).catch(err => console.error('Initial backfill error:', err.message));
}
