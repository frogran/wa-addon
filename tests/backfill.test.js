jest.mock('../src/llm', () => ({
  extractTasksBatch: jest.fn(),
}));

const db = require('../src/db');
const llm = require('../src/llm');
const { processBatches } = require('../src/backfill');

describe('processBatches', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Test Fan');
    jest.clearAllMocks();
  });

  afterEach(() => db.close());

  test('creates tasks from Claude response', async () => {
    const msgId = db.insertMessage(contactId, 'in', 'Please call me back', 1700000000, 'wa-b1');
    llm.extractTasksBatch.mockResolvedValue({ [msgId]: ['Call back'] });

    await processBatches();

    const tasks = db.getPendingTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].body).toBe('Call back');
  });

  test('updates backfill_last_processed_id checkpoint', async () => {
    const msgId = db.insertMessage(contactId, 'in', 'Hello', 1700000000, 'wa-b2');
    llm.extractTasksBatch.mockResolvedValue({ [msgId]: [] });

    await processBatches();

    expect(db.getSetting('backfill_last_processed_id')).toBe(String(msgId));
  });

  test('sets backfill_total and backfill_processed counts', async () => {
    db.insertMessage(contactId, 'in', 'Msg 1', 1700000001, 'wa-b3');
    db.insertMessage(contactId, 'in', 'Msg 2', 1700000002, 'wa-b4');
    llm.extractTasksBatch.mockResolvedValue({});

    await processBatches();

    expect(db.getSetting('backfill_total')).toBe('2');
    expect(db.getSetting('backfill_processed')).toBe('2');
  });

  test('does not re-process messages already past the checkpoint', async () => {
    const msgId = db.insertMessage(contactId, 'in', 'Hello', 1700000000, 'wa-b5');
    llm.extractTasksBatch.mockResolvedValue({ [msgId]: [] });

    await processBatches();
    expect(llm.extractTasksBatch).toHaveBeenCalledTimes(1);

    llm.extractTasksBatch.mockClear();
    await processBatches();
    expect(llm.extractTasksBatch).not.toHaveBeenCalled();
  });

  test('skips outbound messages', async () => {
    db.insertMessage(contactId, 'out', 'My reply', 1700000000, 'wa-b6');

    await processBatches();

    expect(llm.extractTasksBatch).not.toHaveBeenCalled();
    expect(db.getSetting('backfill_total')).toBe('0');
  });
});
