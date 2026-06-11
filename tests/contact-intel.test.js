jest.mock('../src/llm');
let db = require('../src/db');

// Re-require after mocks to get fresh module state
let contactIntel;

beforeEach(() => {
  jest.resetModules();
  jest.mock('../src/llm');
  db = require('../src/db');
  db.init(':memory:');
  contactIntel = require('../src/contact-intel');
});

afterEach(() => {
  db.close();
  jest.clearAllMocks();
});

describe('refreshContact', () => {
  test('passes existing profile to buildContactProfile (accumulate semantics)', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn().mockResolvedValue({ summary: 'new', style: 's', language: 'en', category: 'fan' });
    const cid = db.upsertContact('+1', 'Alice');
    db.insertMessage(cid, 'in', 'hello', 1000, 'wa-1');
    db.updateContactProfile(cid, 'Old summary', 'Old style', 'en', 'other');

    await contactIntel.refreshContact(cid);

    const [, existingProfile] = llmFresh.buildContactProfile.mock.calls[0];
    expect(existingProfile).not.toBeNull();
    expect(existingProfile.summary).toBe('Old summary');
  });

  test('does not update DB if LLM returns null', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn().mockResolvedValue(null);
    const cid = db.upsertContact('+1', 'Alice');
    db.insertMessage(cid, 'in', 'hello', 1000, 'wa-1');
    db.updateContactProfile(cid, 'Original', 'S', 'en', 'other');

    await contactIntel.refreshContact(cid);

    expect(db.getContactProfile(cid).summary).toBe('Original');
  });

  test('does nothing if contact has no messages', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn();
    const cid = db.upsertContact('+1', 'Empty');

    await contactIntel.refreshContact(cid);

    expect(llmFresh.buildContactProfile).not.toHaveBeenCalled();
  });
});

describe('seedAll', () => {
  test('creates profiles for all contacts with messages', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn().mockResolvedValue({ summary: 'x', style: 'y', language: 'en', category: 'fan' });
    llmFresh.buildUserProfile = jest.fn().mockResolvedValue('global style');
    const id1 = db.upsertContact('+1', 'A');
    const id2 = db.upsertContact('+2', 'B');
    db.insertMessage(id1, 'in', 'hi', 1000, 'wa-1');
    db.insertMessage(id2, 'in', 'hi', 1001, 'wa-2');

    await contactIntel.seedAll();

    expect(llmFresh.buildContactProfile).toHaveBeenCalledTimes(2);
    expect(db.getContactProfile(id1).summary).toBe('x');
    expect(db.getContactProfile(id2).summary).toBe('x');
    expect(db.getSetting('intel_status')).toBe('done');
  });

  test('skips contacts with no messages', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn().mockResolvedValue({ summary: 'x', style: 'y', language: 'en', category: 'fan' });
    llmFresh.buildUserProfile = jest.fn().mockResolvedValue('style');
    db.upsertContact('+1', 'NoMsg');
    const id2 = db.upsertContact('+2', 'HasMsg');
    db.insertMessage(id2, 'in', 'hi', 1000, 'wa-1');

    await contactIntel.seedAll();

    expect(llmFresh.buildContactProfile).toHaveBeenCalledTimes(1);
  });

  test('calls buildUserProfile at the end', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn().mockResolvedValue({ summary: 'x', style: 'y', language: 'en', category: 'fan' });
    llmFresh.buildUserProfile = jest.fn().mockResolvedValue('my style');
    const cid = db.upsertContact('+1', 'A');
    db.insertMessage(cid, 'in', 'hi', 1000, 'wa-1');

    await contactIntel.seedAll();

    expect(llmFresh.buildUserProfile).toHaveBeenCalledTimes(1);
    expect(db.getProfile().global_style).toBe('my style');
  });

  test('resumes from checkpoint on error-status restart', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn().mockResolvedValue({ summary: 'x', style: 'y', language: 'en', category: 'fan' });
    llmFresh.buildUserProfile = jest.fn().mockResolvedValue('style');
    const id1 = db.upsertContact('+1', 'A');
    const id2 = db.upsertContact('+2', 'B');
    db.insertMessage(id1, 'in', 'msg from A', 1000, 'wa-1');
    db.insertMessage(id2, 'in', 'msg from B', 1001, 'wa-2');

    // Simulate: id1 was already seeded in a prior errored run
    db.setSetting('intel_last_seeded_contact_id', String(id1));
    db.setSetting('intel_processed', '1');
    db.setSetting('intel_status', 'error');

    await contactIntel.seedAll();

    // Should only process id2
    expect(llmFresh.buildContactProfile).toHaveBeenCalledTimes(1);
    const [calledMessages] = llmFresh.buildContactProfile.mock.calls[0];
    expect(calledMessages[0].body).toBe('msg from B');
  });

  test('sets intel_status to error and unblocks on exception', async () => {
    const llmFresh = require('../src/llm');
    llmFresh.buildContactProfile = jest.fn().mockRejectedValue(new Error('API exploded'));
    llmFresh.buildUserProfile = jest.fn().mockResolvedValue('style');
    const cid = db.upsertContact('+1', 'A');
    db.insertMessage(cid, 'in', 'hi', 1000, 'wa-1');

    await contactIntel.seedAll();

    expect(db.getSetting('intel_status')).toBe('error');
    // Verify isRunning was reset — a second call should proceed (not be a no-op)
    llmFresh.buildContactProfile = jest.fn().mockResolvedValue({ summary: 'x', style: 'y', language: 'en', category: 'fan' });
    llmFresh.buildUserProfile = jest.fn().mockResolvedValue('style');
    db.setSetting('intel_status', 'error'); // ensure resume mode
    await contactIntel.seedAll();
    expect(db.getSetting('intel_status')).toBe('done');
  });
});
