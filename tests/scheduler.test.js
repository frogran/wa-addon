const db = require('../src/db');
const { tick } = require('../src/scheduler');

beforeEach(() => db.init(':memory:'));
afterEach(() => db.close());

test('tick sends due messages and marks them sent', async () => {
  const contactId = db.upsertContact('+972501234567', 'Test Fan');
  const past = Math.floor(Date.now() / 1000) - 60;
  const id = db.createScheduledMessage(contactId, 'Hello!', past);

  const sendFn = jest.fn().mockResolvedValue();
  await tick(sendFn);

  expect(sendFn).toHaveBeenCalledWith('+972501234567', 'Hello!');
  expect(db.getScheduledMessage(id).status).toBe('sent');
});

test('tick does not send future messages', async () => {
  const contactId = db.upsertContact('+972501234567', 'Test Fan');
  const future = Math.floor(Date.now() / 1000) + 3600;
  db.createScheduledMessage(contactId, 'Later', future);

  const sendFn = jest.fn();
  await tick(sendFn);

  expect(sendFn).not.toHaveBeenCalled();
});

test('tick leaves message pending after first failure', async () => {
  const contactId = db.upsertContact('+972501234567', 'Test Fan');
  const past = Math.floor(Date.now() / 1000) - 60;
  const id = db.createScheduledMessage(contactId, 'Hello!', past);

  const sendFn = jest.fn().mockRejectedValue(new Error('WA error'));
  await tick(sendFn);

  const row = db.getScheduledMessage(id);
  expect(row.status).toBe('pending');
  expect(row.attempt_count).toBe(1);
});

test('tick marks failed after third failure', async () => {
  const contactId = db.upsertContact('+972501234567', 'Test Fan');
  const past = Math.floor(Date.now() / 1000) - 60;
  const id = db.createScheduledMessage(contactId, 'Hello!', past);

  const sendFn = jest.fn().mockRejectedValue(new Error('WA error'));
  await tick(sendFn); // attempt 1
  await tick(sendFn); // attempt 2
  await tick(sendFn); // attempt 3

  const row = db.getScheduledMessage(id);
  expect(row.status).toBe('failed');
  expect(row.error).toBe('WA error');
  expect(row.attempt_count).toBe(3);
});

test('tick stores error message on failure', async () => {
  const contactId = db.upsertContact('+972501234567', 'Test Fan');
  const past = Math.floor(Date.now() / 1000) - 60;
  const id = db.createScheduledMessage(contactId, 'Hello!', past);

  const sendFn = jest.fn()
    .mockRejectedValueOnce(new Error('first error'))
    .mockRejectedValueOnce(new Error('second error'))
    .mockRejectedValueOnce(new Error('final error'));

  await tick(sendFn);
  await tick(sendFn);
  await tick(sendFn);

  expect(db.getScheduledMessage(id).error).toBe('final error');
});

test('tick sends multiple due messages in one pass', async () => {
  const c1 = db.upsertContact('+111', 'Alice');
  const c2 = db.upsertContact('+222', 'Bob');
  const past = Math.floor(Date.now() / 1000) - 60;
  db.createScheduledMessage(c1, 'Msg A', past);
  db.createScheduledMessage(c2, 'Msg B', past);

  const sendFn = jest.fn().mockResolvedValue();
  await tick(sendFn);

  expect(sendFn).toHaveBeenCalledTimes(2);
});
