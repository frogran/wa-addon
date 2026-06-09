const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function getDb() {
  if (!db) throw new Error('db not initialised — call db.init() first');
  return db;
}

function init(dbPath) {
  if (db) throw new Error('db already initialised — call db.close() first');
  const resolved = dbPath || path.join(__dirname, '..', 'data', 'wa.db');
  if (resolved !== ':memory:') {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS clusters (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      phone                TEXT UNIQUE NOT NULL,
      name                 TEXT,
      category             TEXT,
      language             TEXT DEFAULT 'en',
      relationship_summary TEXT,
      style_to_contact     TEXT,
      cluster_id           INTEGER REFERENCES clusters(id),
      notes                TEXT,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      direction  TEXT NOT NULL CHECK(direction IN ('in','out')),
      body       TEXT NOT NULL,
      timestamp  INTEGER NOT NULL,
      wa_id      TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      body       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id    INTEGER NOT NULL REFERENCES contacts(id),
      body          TEXT NOT NULL,
      send_at       INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','sent','failed','cancelled')),
      error         TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS reply_suggestions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id   INTEGER NOT NULL REFERENCES messages(id),
      contact_id   INTEGER NOT NULL REFERENCES contacts(id),
      suggestion_1 TEXT,
      suggestion_2 TEXT,
      suggestion_3 TEXT,
      status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','ready','used','dismissed','failed')),
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS user_profile (
      id           INTEGER PRIMARY KEY CHECK(id = 1),
      global_style TEXT,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.prepare('INSERT OR IGNORE INTO user_profile (id) VALUES (1)').run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('bridge_status', 'disconnected')").run();
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

function upsertContact(phone, name) {
  // Single atomic statement avoids a race between SELECT and INSERT/UPDATE
  const row = getDb().prepare(`
    INSERT INTO contacts (phone, name) VALUES (?, ?)
    ON CONFLICT(phone) DO UPDATE SET name = excluded.name
    RETURNING id
  `).get(phone, name);
  return row.id;
}

function insertMessage(contactId, direction, body, timestamp, waId) {
  const result = getDb().prepare(
    'INSERT OR IGNORE INTO messages (contact_id, direction, body, timestamp, wa_id) VALUES (?, ?, ?, ?, ?)'
  ).run(contactId, direction, body, timestamp, waId);
  return result.changes === 0 ? null : result.lastInsertRowid;
}

function getStatus() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'bridge_status'").get();
  return row ? row.value : 'disconnected';
}

function setStatus(status) {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('bridge_status', ?)").run(status);
}

// ── Scheduled message helpers ─────────────────────────────────────────────

function createScheduledMessage(contactId, body, sendAt) {
  const result = getDb().prepare(
    'INSERT INTO scheduled_messages (contact_id, body, send_at) VALUES (?, ?, ?)'
  ).run(contactId, body, sendAt);
  return result.lastInsertRowid;
}

function getScheduledMessage(id) {
  return getDb().prepare(
    'SELECT id, contact_id, body, send_at, status, error, attempt_count, created_at FROM scheduled_messages WHERE id = ?'
  ).get(id);
}

function getDueScheduledMessages() {
  return getDb().prepare(`
    SELECT sm.*, c.phone, c.name AS contact_name
    FROM scheduled_messages sm
    JOIN contacts c ON c.id = sm.contact_id
    WHERE sm.send_at <= ? AND sm.status = 'pending' AND sm.attempt_count < 3
    ORDER BY sm.send_at ASC
  `).all(Math.floor(Date.now() / 1000));
}

function getPendingScheduledMessages() {
  return getDb().prepare(`
    SELECT sm.*, c.phone, c.name AS contact_name
    FROM scheduled_messages sm
    JOIN contacts c ON c.id = sm.contact_id
    WHERE sm.status = 'pending'
    ORDER BY sm.send_at ASC
  `).all();
}

function updateScheduledMessageStatus(id, status, error = null) {
  getDb().prepare(
    'UPDATE scheduled_messages SET status = ?, error = ? WHERE id = ?'
  ).run(status, error, id);
}

function incrementAttemptCount(id) {
  getDb().prepare(
    'UPDATE scheduled_messages SET attempt_count = attempt_count + 1 WHERE id = ?'
  ).run(id);
}

function cancelScheduledMessage(id) {
  getDb().prepare(
    "UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(id);
}

// ── Contact helpers ───────────────────────────────────────────────────────

function getAllContacts() {
  return getDb().prepare(
    'SELECT id, name, phone FROM contacts ORDER BY name ASC'
  ).all();
}

function searchContacts(query) {
  const like = `%${query}%`;
  return getDb().prepare(
    'SELECT id, name, phone FROM contacts WHERE name LIKE ? OR phone LIKE ? ORDER BY name ASC LIMIT 20'
  ).all(like, like);
}

module.exports = {
  init, close,
  upsertContact, insertMessage, getStatus, setStatus,
  createScheduledMessage, getScheduledMessage, getDueScheduledMessages,
  getPendingScheduledMessages, updateScheduledMessageStatus,
  incrementAttemptCount, cancelScheduledMessage,
  getAllContacts, searchContacts,
};
