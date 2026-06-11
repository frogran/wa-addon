jest.mock('@anthropic-ai/sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { extractTasks, extractTasksBatch, buildContactProfile, buildUserProfile } = require('../src/llm');

describe('extractTasks', () => {
  let mockCreate;

  beforeEach(() => {
    mockCreate = jest.fn();
    Anthropic.mockImplementation(() => ({ messages: { create: mockCreate } }));
  });

  afterEach(() => jest.clearAllMocks());

  test('returns empty array for blank message without calling API', async () => {
    const tasks = await extractTasks('');
    expect(tasks).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('returns tasks array from Claude response', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '["Call back by 5pm","Send the contract"]' }] });
    const tasks = await extractTasks('Please call me and send the contract');
    expect(tasks).toEqual(['Call back by 5pm', 'Send the contract']);
  });

  test('returns empty array when Claude returns []', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '[]' }] });
    const tasks = await extractTasks('How are you today?');
    expect(tasks).toEqual([]);
  });

  test('returns empty array when Claude returns non-array JSON', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '{"error":"bad"}' }] });
    const tasks = await extractTasks('Some message');
    expect(tasks).toEqual([]);
  });

  test('prompt includes message body, uses claude-opus-4-8', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '[]' }] });
    await extractTasks('Please review this document');
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toBe('Please review this document');
    expect(call.model).toBe('claude-opus-4-8');
    expect(call.system).toMatch(/task extraction/i);
  });

  test('returns empty array when API call throws', async () => {
    mockCreate.mockRejectedValue(new Error('rate limit'));
    const tasks = await extractTasks('Call me back');
    expect(tasks).toEqual([]);
  });
});

describe('extractTasksBatch', () => {
  let mockCreate;

  beforeEach(() => {
    mockCreate = jest.fn();
    Anthropic.mockImplementation(() => ({ messages: { create: mockCreate } }));
  });

  afterEach(() => jest.clearAllMocks());

  test('returns empty object for empty input without calling API', async () => {
    const result = await extractTasksBatch([]);
    expect(result).toEqual({});
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('maps task arrays back to message ids', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '{"1":["Call back"],"2":[]}' }] });
    const msgs = [
      { id: 42, contactName: 'Alice', body: 'Call me back' },
      { id: 43, contactName: 'Bob', body: 'How are you?' },
    ];
    const result = await extractTasksBatch(msgs);
    expect(result[42]).toEqual(['Call back']);
    expect(result[43]).toEqual([]);
  });

  test('returns empty arrays for all ids on JSON parse failure', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'not json' }] });
    const msgs = [{ id: 99, contactName: 'Alice', body: 'Hello' }];
    const result = await extractTasksBatch(msgs);
    expect(result[99]).toEqual([]);
  });

  test('returns empty arrays for all ids when API call throws', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));
    const msgs = [
      { id: 10, contactName: 'Alice', body: 'Hello' },
      { id: 11, contactName: 'Bob', body: 'Hi' },
    ];
    const result = await extractTasksBatch(msgs);
    expect(result[10]).toEqual([]);
    expect(result[11]).toEqual([]);
  });
});

describe('buildContactProfile', () => {
  let mockCreate;

  beforeEach(() => {
    mockCreate = jest.fn();
    Anthropic.mockImplementation(() => ({ messages: { create: mockCreate } }));
  });

  afterEach(() => jest.clearAllMocks());

  test('includes message history in prompt', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'RELATIONSHIP_SUMMARY:\nA fan\n\nSTYLE_TO_CONTACT:\nCasual\n\nLANGUAGE: en\n\nCATEGORY: fan' }] });
    const msgs = [{ direction: 'in', body: 'Hello!', timestamp: 1000 }];
    await buildContactProfile(msgs, null);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('[Them] Hello!');
  });

  test('includes existing profile in prompt when provided', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'RELATIONSHIP_SUMMARY:\nA fan\n\nSTYLE_TO_CONTACT:\nCasual\n\nLANGUAGE: en\n\nCATEGORY: fan' }] });
    await buildContactProfile([], { summary: 'Old summary', style: 'Old style' });
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Old summary');
    expect(call.messages[0].content).toContain('Old style');
  });

  test('parses all four sections from response', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'RELATIONSHIP_SUMMARY:\nBig fan from Tel Aviv\n\nSTYLE_TO_CONTACT:\nCasual, Hebrew/English mix\n\nLANGUAGE: mixed\n\nCATEGORY: fan' }] });
    const result = await buildContactProfile([{ direction: 'in', body: 'hi', timestamp: 1 }], null);
    expect(result.summary).toBe('Big fan from Tel Aviv');
    expect(result.style).toBe('Casual, Hebrew/English mix');
    expect(result.language).toBe('mixed');
    expect(result.category).toBe('fan');
  });

  test('returns null on API error', async () => {
    mockCreate.mockRejectedValue(new Error('API down'));
    const result = await buildContactProfile([{ direction: 'in', body: 'hi', timestamp: 1 }], null);
    expect(result).toBeNull();
  });
});

describe('buildUserProfile', () => {
  let mockCreate;

  beforeEach(() => {
    mockCreate = jest.fn();
    Anthropic.mockImplementation(() => ({ messages: { create: mockCreate } }));
  });

  afterEach(() => jest.clearAllMocks());

  test('includes outgoing messages in prompt', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'Concise writer who code-switches.' }] });
    const msgs = [{ body: 'Noted', contact_name: 'Alice', timestamp: 1000 }];
    await buildUserProfile(msgs, null);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('To Alice: Noted');
  });

  test('returns null on API error', async () => {
    mockCreate.mockRejectedValue(new Error('rate limit'));
    const result = await buildUserProfile([{ body: 'Hi', contact_name: 'Bob', timestamp: 1 }], null);
    expect(result).toBeNull();
  });

  test('includes existing profile in prompt when provided', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'Updated style.' }] });
    await buildUserProfile([{ body: 'Noted', contact_name: 'Alice', timestamp: 1 }], 'Old style notes');
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Old style notes');
  });
});

describe('buildReplySuggestions', () => {
  const { buildReplySuggestions } = require('../src/llm');
  const defaultSettings = { length: 'auto', tone: 'auto', language: 'auto', emoji: 'auto', greeting: 1 };

  beforeEach(() => Anthropic.mockReset());

  test('returns null when messages array is empty', async () => {
    const result = await buildReplySuggestions([], null, null, defaultSettings);
    expect(result).toBeNull();
  });

  test('parses all three suggestions from Claude response', async () => {
    Anthropic.prototype.messages = {
      create: jest.fn().mockResolvedValue({
        content: [{ text: 'SUGGESTION_1:\nSure thing!\n\nSUGGESTION_2:\nSounds good.\n\nSUGGESTION_3:\nAbsolutely!' }]
      })
    };
    const messages = [{ direction: 'in', body: 'Hey!', timestamp: 1000 }];
    const result = await buildReplySuggestions(messages, null, null, defaultSettings);
    expect(result).toEqual(['Sure thing!', 'Sounds good.', 'Absolutely!']);
  });

  test('returns null on API error', async () => {
    Anthropic.prototype.messages = {
      create: jest.fn().mockRejectedValue(new Error('rate limit'))
    };
    const messages = [{ direction: 'in', body: 'Hey', timestamp: 1000 }];
    const result = await buildReplySuggestions(messages, null, null, defaultSettings);
    expect(result).toBeNull();
  });

  test('includes contact profile and user profile in prompt when provided', async () => {
    let capturedSystem = '';
    Anthropic.prototype.messages = {
      create: jest.fn().mockImplementation(({ system }) => {
        capturedSystem = system;
        return Promise.resolve({ content: [{ text: 'SUGGESTION_1:\nA\n\nSUGGESTION_2:\nB\n\nSUGGESTION_3:\nC' }] });
      })
    };
    const messages = [{ direction: 'in', body: 'Hi', timestamp: 1000 }];
    const profile = { summary: 'Close friend', style: 'Very casual' };
    const userProfile = 'Writes briefly, uses Hebrew often';
    await buildReplySuggestions(messages, profile, userProfile, defaultSettings);
    expect(capturedSystem).toContain('Close friend');
    expect(capturedSystem).toContain('Writes briefly');
  });
});
