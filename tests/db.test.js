const db = require('../src/db');

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
