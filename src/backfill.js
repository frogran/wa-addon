const db = require('./db');
const llm = require('./llm');

const BATCH_SIZE = 20;
let isRunning = false;

async function processBatches() {
  const total = db.countInboundMessages();
  db.setSetting('backfill_total', String(total));

  let lastId = parseInt(db.getSetting('backfill_last_processed_id') || '0', 10);
  let processed = parseInt(db.getSetting('backfill_processed') || '0', 10);

  while (true) {
    const batch = db.getInboundMessagesAfter(lastId, BATCH_SIZE);
    if (!batch.length) break;

    const taskMap = await llm.extractTasksBatch(
      batch.map(m => ({ id: m.id, contactName: m.contact_name, body: m.body }))
    );

    for (const msg of batch) {
      const tasks = taskMap[msg.id] || [];
      tasks.forEach(body => db.createTask(msg.contact_id, msg.id, body));
    }

    lastId = batch[batch.length - 1].id;
    processed += batch.length;
    db.setSetting('backfill_last_processed_id', String(lastId));
    db.setSetting('backfill_processed', String(processed));
  }
}

async function run(getChatsFunc) {
  if (isRunning) return;
  isRunning = true;
  db.setSetting('backfill_status', 'running');
  db.setSetting('backfill_processed', '0');

  try {
    if (getChatsFunc) {
      await fetchAndStore(getChatsFunc);
    }
    await processBatches();
    db.setSetting('backfill_status', 'done');
  } catch (err) {
    console.error('Backfill error:', err.message);
    db.setSetting('backfill_status', 'error');
  } finally {
    isRunning = false;
  }
}

async function fetchAndStore(getChatsFunc) {
  const chats = await getChatsFunc();
  for (const chat of chats) {
    if (chat.isGroup) continue;
    const messages = await chat.fetchMessages({ limit: 500 });
    const contactId = db.upsertContact(
      chat.id._serialized,
      chat.name || chat.id._serialized
    );
    for (const msg of messages) {
      if (!msg.body) continue;
      const direction = msg.fromMe ? 'out' : 'in';
      db.insertMessage(contactId, direction, msg.body, Math.floor(msg.timestamp), msg.id.id);
    }
  }
}

module.exports = { run, processBatches };
