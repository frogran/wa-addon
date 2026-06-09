jest.mock('@anthropic-ai/sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { extractTasks, extractTasksBatch } = require('../src/llm');

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
