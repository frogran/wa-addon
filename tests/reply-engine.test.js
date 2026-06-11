jest.mock('../src/llm', () => ({
  buildReplySuggestions: jest.fn(),
}));

let db;
let replyEngine;
let llm;

beforeEach(() => {
  jest.resetModules();
  jest.mock('../src/llm', () => ({
    buildReplySuggestions: jest.fn(),
  }));
  db = require('../src/db');
  db.init(':memory:');
  llm = require('../src/llm');
  replyEngine = require('../src/reply-engine');
});

afterEach(() => {
  db.close();
});

test('generateForMessage stores suggestions when LLM returns results', async () => {
  llm.buildReplySuggestions.mockResolvedValue(['A', 'B', 'C']);
  const contactId = db.upsertContact('+1', 'Bob');
  const msgId = db.insertMessage(contactId, 'in', 'Hi', 1000, 'wa-1');
  db.ensureSuggestionRow(msgId, contactId);

  await replyEngine.generateForMessage(contactId, msgId);

  const s = db.getSuggestions(msgId);
  expect(s.status).toBe('ready');
  expect(s.suggestion_1).toBe('A');
  expect(s.suggestion_2).toBe('B');
  expect(s.suggestion_3).toBe('C');
});

test('generateForMessage marks failed when LLM returns null', async () => {
  llm.buildReplySuggestions.mockResolvedValue(null);
  const contactId = db.upsertContact('+1', 'Bob');
  const msgId = db.insertMessage(contactId, 'in', 'Hi', 1000, 'wa-2');
  db.ensureSuggestionRow(msgId, contactId);

  await replyEngine.generateForMessage(contactId, msgId);

  expect(db.getSuggestions(msgId).status).toBe('failed');
});

test('generateForMessage does nothing for unknown contactId', async () => {
  llm.buildReplySuggestions.mockResolvedValue(['A', 'B', 'C']);
  await replyEngine.generateForMessage(9999, 1);
  expect(llm.buildReplySuggestions).not.toHaveBeenCalled();
});

test('generateBatch inserts pending rows immediately for eligible messages', async () => {
  llm.buildReplySuggestions.mockResolvedValue(['A', 'B', 'C']);
  const contactId = db.upsertContact('+1', 'Bob');
  const msgId = db.insertMessage(contactId, 'in', 'Hi', 1000, 'wa-3');

  replyEngine.generateBatch(5);

  // pending row inserted synchronously before async generation
  const s = db.getSuggestions(msgId);
  expect(s).not.toBeNull();
  expect(s.status).toBe('pending');
});

test('generateBatch skips messages that already have pending or ready suggestions', async () => {
  llm.buildReplySuggestions.mockResolvedValue(['A', 'B', 'C']);
  const contactId = db.upsertContact('+1', 'Bob');
  const msgId = db.insertMessage(contactId, 'in', 'Hi', 1000, 'wa-4');
  db.ensureSuggestionRow(msgId, contactId); // already pending

  replyEngine.generateBatch(5);

  // LLM should not be called since it was already pending
  expect(llm.buildReplySuggestions).not.toHaveBeenCalled();
});

test('generateBatch respects the limit parameter', async () => {
  llm.buildReplySuggestions.mockResolvedValue(['A', 'B', 'C']);
  const contactId1 = db.upsertContact('+1', 'Bob');
  const contactId2 = db.upsertContact('+2', 'Carol');
  const contactId3 = db.upsertContact('+3', 'Dave');
  db.insertMessage(contactId1, 'in', 'Hi', 1000, 'wa-5');
  db.insertMessage(contactId2, 'in', 'Hey', 1001, 'wa-6');
  db.insertMessage(contactId3, 'in', 'Hello', 1002, 'wa-7');

  replyEngine.generateBatch(2); // only 2 of 3 should get pending rows

  const inbox = db.getInboxMessages();
  const pendingCount = inbox.filter(m => m.suggestion_status === 'pending').length;
  expect(pendingCount).toBe(2);
});
