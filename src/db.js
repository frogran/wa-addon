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

    CREATE TABLE IF NOT EXISTS shared_contacts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      phone          TEXT NOT NULL,
      name           TEXT,
      shared_by      INTEGER NOT NULL REFERENCES contacts(id),
      message_id     INTEGER REFERENCES messages(id),
      context_before TEXT,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_contacts_phone ON shared_contacts(phone);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_message_body ON tasks(message_id, body);

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
  const result = getDb().prepare(
    "UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(id);
  return result.changes;
}

function failScheduledMessage(id, error, maxAttempts) {
  getDb().prepare(`
    UPDATE scheduled_messages
    SET attempt_count = attempt_count + 1,
        status = CASE WHEN attempt_count + 1 >= ? THEN 'failed' ELSE status END,
        error = ?
    WHERE id = ?
  `).run(maxAttempts, error, id);
}

// ── Task helpers ──────────────────────────────────────────────────────────

function createTask(contactId, messageId, body) {
  const result = getDb().prepare(
    'INSERT OR IGNORE INTO tasks (contact_id, message_id, body) VALUES (?, ?, ?)'
  ).run(contactId, messageId, body);
  return result.changes === 0 ? null : result.lastInsertRowid;
}

function getPendingTasks() {
  return getDb().prepare(`
    SELECT t.id, t.body, t.status, t.created_at,
           c.name AS contact_name,
           m.body AS message_snippet
    FROM tasks t
    JOIN contacts c ON c.id = t.contact_id
    JOIN messages m ON m.id = t.message_id
    WHERE t.status = 'pending'
    ORDER BY t.created_at DESC
  `).all();
}

function markTaskDone(id) {
  const result = getDb().prepare(
    "UPDATE tasks SET status = 'done' WHERE id = ? AND status = 'pending'"
  ).run(id);
  return result.changes;
}

// ── shared_contacts helpers ───────────────────────────────────────────────

function createSharedContact(phone, name, sharedBy, messageId = null, contextBefore = []) {
  const result = getDb().prepare(
    'INSERT OR IGNORE INTO shared_contacts (phone, name, shared_by, message_id, context_before) VALUES (?, ?, ?, ?, ?)'
  ).run(phone, name, sharedBy, messageId, (contextBefore && contextBefore.length) ? JSON.stringify(contextBefore) : null);
  return result.changes === 0 ? null : result.lastInsertRowid;
}

function getLastMessagesFromContact(contactId, limit) {
  return getDb().prepare(
    "SELECT body FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY id DESC LIMIT ?"
  ).all(contactId, limit).map(r => r.body).reverse();
}

function getAllSharedContacts() {
  return getDb().prepare(`
    SELECT sc.id, sc.phone, sc.name, sc.context_before, sc.created_at,
           c.name AS shared_by_name, c.phone AS shared_by_phone
    FROM shared_contacts sc
    JOIN contacts c ON c.id = sc.shared_by
    ORDER BY sc.created_at DESC
  `).all();
}

// ── Generic settings helpers ──────────────────────────────────────────────

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).run(key, value);
}

// ── Backfill helpers ──────────────────────────────────────────────────────

function countInboundMessages() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'").get().n;
}

function getInboundMessagesAfter(afterId, limit) {
  return getDb().prepare(`
    SELECT m.id, m.contact_id, m.body,
           c.name AS contact_name
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    WHERE m.direction = 'in' AND m.id > ?
    ORDER BY m.id
    LIMIT ?
  `).all(afterId, limit);
}

// ── Contact helpers ───────────────────────────────────────────────────────

function getAllContacts() {
  return getDb().prepare(
    'SELECT id, name, phone, language, category FROM contacts ORDER BY name ASC'
  ).all();
}

function searchContacts(query) {
  const like = `%${query}%`;
  return getDb().prepare(
    'SELECT id, name, phone, language, category FROM contacts WHERE name LIKE ? OR phone LIKE ? ORDER BY name ASC LIMIT 20'
  ).all(like, like);
}

// ── Contact profile helpers ───────────────────────────────────────────────

function getContactProfile(contactId) {
  return getDb().prepare(
    'SELECT relationship_summary AS summary, style_to_contact AS style, language, category FROM contacts WHERE id = ?'
  ).get(contactId) || null;
}

function updateContactProfile(contactId, summary, style, language, category) {
  getDb().prepare(
    'UPDATE contacts SET relationship_summary = ?, style_to_contact = ?, language = ?, category = ? WHERE id = ?'
  ).run(summary, style, language, category, contactId);
}

function patchContactProfile(contactId, updates) {
  const allowed = ['relationship_summary', 'style_to_contact', 'language', 'category'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) return;
  const sql = `UPDATE contacts SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
  getDb().prepare(sql).run(...fields.map(f => updates[f]), contactId);
}

function getContactMessages(contactId) {
  return getDb().prepare(
    'SELECT direction, body, timestamp FROM messages WHERE contact_id = ? ORDER BY timestamp ASC'
  ).all(contactId);
}

function getContactsToSeed(afterId, limit) {
  return getDb().prepare(`
    SELECT DISTINCT c.id, c.name, c.phone
    FROM contacts c
    INNER JOIN messages m ON m.contact_id = c.id
    WHERE c.id > ?
    ORDER BY c.id ASC
    LIMIT ?
  `).all(afterId, limit);
}

function getContactDetail(contactId) {
  const contact = getDb().prepare(
    'SELECT id, name, phone, category, language, relationship_summary, style_to_contact FROM contacts WHERE id = ?'
  ).get(contactId);
  if (!contact) return null;
  contact.recent_messages = getDb().prepare(
    'SELECT direction, body, timestamp FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 5'
  ).all(contactId);
  return contact;
}

function getContactInboundCount(contactId) {
  return getDb().prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'in'"
  ).get(contactId).n;
}

// ── User profile helpers ──────────────────────────────────────────────────

function getProfile() {
  return getDb().prepare('SELECT * FROM user_profile WHERE id = 1').get();
}

function updateProfile(globalStyle) {
  getDb().prepare(
    'UPDATE user_profile SET global_style = ?, updated_at = unixepoch() WHERE id = 1'
  ).run(globalStyle);
}

function getOutgoingMessagesSample(limit) {
  return getDb().prepare(`
    SELECT m.body, c.name AS contact_name, m.timestamp
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    WHERE m.direction = 'out'
    ORDER BY m.id DESC
    LIMIT ?
  `).all(limit);
}

function getOutboundCount() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'").get().n;
}

module.exports = {
  init, close,
  upsertContact, insertMessage, getStatus, setStatus,
  createScheduledMessage, getScheduledMessage, getDueScheduledMessages,
  getPendingScheduledMessages, updateScheduledMessageStatus,
  incrementAttemptCount, cancelScheduledMessage, failScheduledMessage,
  getAllContacts, searchContacts,
  createTask, getPendingTasks, markTaskDone,
  createSharedContact, getLastMessagesFromContact, getAllSharedContacts,
  getSetting, setSetting,
  countInboundMessages, getInboundMessagesAfter,
  getContactProfile, updateContactProfile, patchContactProfile,
  getContactMessages, getContactsToSeed, getContactDetail, getContactInboundCount,
  getProfile, updateProfile, getOutgoingMessagesSample, getOutboundCount,
};
