const db = require('../src/db');

describe('core helpers', () => {
  beforeEach(() => {
    db.init(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('upsertContact creates a new contact and returns its id', () => {
    const id = db.upsertContact('+972501234567', 'Test Fan');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('upsertContact returns the same id on duplicate phone', () => {
    const id1 = db.upsertContact('+972501234567', 'Test Fan');
    const id2 = db.upsertContact('+972501234567', 'Updated Name');
    expect(id1).toBe(id2);
  });

  test('insertMessage stores a message and returns its id', () => {
    const contactId = db.upsertContact('+972501234567', 'Test Fan');
    const msgId = db.insertMessage(contactId, 'in', 'Hello!', 1700000000, 'wa-id-001');
    expect(typeof msgId).toBe('number');
    expect(msgId).toBeGreaterThan(0);
  });

  test('insertMessage returns null on duplicate wa_id', () => {
    const contactId = db.upsertContact('+972501234567', 'Test Fan');
    db.insertMessage(contactId, 'in', 'Hello!', 1700000000, 'wa-id-001');
    const result = db.insertMessage(contactId, 'in', 'Hello!', 1700000000, 'wa-id-001');
    expect(result).toBeNull();
  });

  test('getStatus returns disconnected by default', () => {
    expect(db.getStatus()).toBe('disconnected');
  });

  test('setStatus and getStatus round-trip', () => {
    db.setStatus('connected');
    expect(db.getStatus()).toBe('connected');
    db.setStatus('qr_pending');
    expect(db.getStatus()).toBe('qr_pending');
  });

  test('calling a helper before init throws a clear error', () => {
    // db is closed by afterEach — simulate calling before init
    db.close(); // ensure closed (safe to call when already null)
    expect(() => db.getStatus()).toThrow('db not initialised');
  });
});

// ── Scheduled message helpers ──────────────────────────────────────────────

describe('scheduled messages', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Test Fan');
  });

  afterEach(() => db.close());

  test('createScheduledMessage returns an id', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('getScheduledMessage retrieves a row by id', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    const row = db.getScheduledMessage(id);
    expect(row.body).toBe('Hello!');
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
  });

  test('getDueScheduledMessages returns only past-due pending rows', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.createScheduledMessage(contactId, 'Due', past);
    db.createScheduledMessage(contactId, 'Not due', future);
    const due = db.getDueScheduledMessages();
    expect(due.length).toBe(1);
    expect(due[0].body).toBe('Due');
    expect(due[0].phone).toBe('+972501234567');
  });

  test('getDueScheduledMessages excludes rows with attempt_count >= 3', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const id = db.createScheduledMessage(contactId, 'Stuck', past);
    db.incrementAttemptCount(id);
    db.incrementAttemptCount(id);
    db.incrementAttemptCount(id);
    const due = db.getDueScheduledMessages();
    expect(due.find(m => m.id === id)).toBeUndefined();
  });

  test('getPendingScheduledMessages returns pending rows with contact name', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.createScheduledMessage(contactId, 'Later', future);
    const rows = db.getPendingScheduledMessages();
    expect(rows.length).toBe(1);
    expect(rows[0].contact_name).toBe('Test Fan');
  });

  test('updateScheduledMessageStatus changes status and stores error', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.updateScheduledMessageStatus(id, 'failed', 'timeout');
    const row = db.getScheduledMessage(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('timeout');
  });

  test('incrementAttemptCount increments by 1 each call', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.incrementAttemptCount(id);
    db.incrementAttemptCount(id);
    const row = db.getScheduledMessage(id);
    expect(row.attempt_count).toBe(2);
  });

  test('cancelScheduledMessage sets status to cancelled', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.cancelScheduledMessage(id);
    const row = db.getScheduledMessage(id);
    expect(row.status).toBe('cancelled');
  });

  test('cancelScheduledMessage is a no-op on non-pending rows', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.updateScheduledMessageStatus(id, 'sent');
    db.cancelScheduledMessage(id);
    const row = db.getScheduledMessage(id);
    expect(row.status).toBe('sent');
  });
});

// ── Contact search helpers ────────────────────────────────────────────────

describe('contact helpers', () => {
  beforeEach(() => {
    db.init(':memory:');
    db.upsertContact('+972501234567', 'Daniel Fan');
    db.upsertContact('+12125550001', 'Alice Press');
    db.upsertContact('+447700900001', 'Bob Colleague');
  });

  afterEach(() => db.close());

  test('getAllContacts returns all contacts ordered by name', () => {
    const contacts = db.getAllContacts();
    expect(contacts.length).toBe(3);
    expect(contacts[0].name).toBe('Alice Press');
  });

  test('searchContacts filters by name', () => {
    const results = db.searchContacts('Daniel');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Daniel Fan');
  });

  test('searchContacts filters by phone', () => {
    const results = db.searchContacts('+44');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Bob Colleague');
  });

  test('searchContacts returns empty array for no match', () => {
    expect(db.searchContacts('zzznomatch')).toHaveLength(0);
  });
});

