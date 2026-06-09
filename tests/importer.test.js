const db = require('../src/db');
const { parseTimestamp, parseFile, importFile } = require('../src/importer');

describe('parseTimestamp', () => {
  test('parses DD/MM/YYYY HH:MM:SS', () => {
    expect(parseTimestamp('15/01/2024, 14:22:13')).toBe(
      Math.floor(new Date('2024-01-15T14:22:13Z').getTime() / 1000)
    );
  });

  test('parses with 12-hour PM time', () => {
    expect(parseTimestamp('15/01/2024, 3:22:13 PM')).toBe(
      Math.floor(new Date('2024-01-15T15:22:13Z').getTime() / 1000)
    );
  });

  test('parses 12:xx AM as 00:xx', () => {
    expect(parseTimestamp('15/01/2024, 12:05:00 AM')).toBe(
      Math.floor(new Date('2024-01-15T00:05:00Z').getTime() / 1000)
    );
  });

  test('parses 12:xx PM as 12:xx', () => {
    expect(parseTimestamp('15/01/2024, 12:05:00 PM')).toBe(
      Math.floor(new Date('2024-01-15T12:05:00Z').getTime() / 1000)
    );
  });

  test('parses 2-digit year', () => {
    const ts = parseTimestamp('15/01/24, 14:22:13');
    expect(ts).toBe(Math.floor(new Date('2024-01-15T14:22:13Z').getTime() / 1000));
  });

  test('returns null for invalid input', () => {
    expect(parseTimestamp('not a date')).toBeNull();
  });
});

describe('parseFile', () => {
  test('parses two messages with correct senders and bodies', () => {
    const text = '[15/01/2024, 14:22:13] Alice: Hello!\n[15/01/2024, 14:23:00] Bob: How are you?';
    const msgs = parseFile(text);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ sender: 'Alice', body: 'Hello!' });
    expect(msgs[1]).toMatchObject({ sender: 'Bob', body: 'How are you?' });
  });

  test('joins continuation lines into one message body', () => {
    const text = '[15/01/2024, 14:22:13] Alice: Hello!\nLine 2\n[15/01/2024, 14:23:00] Bob: Reply';
    const msgs = parseFile(text);
    expect(msgs[0].body).toBe('Hello!\nLine 2');
    expect(msgs).toHaveLength(2);
  });

  test('skips media omitted messages', () => {
    const text = '[15/01/2024, 14:22:13] Alice: <Media omitted>\n[15/01/2024, 14:23:00] Alice: Real message';
    const msgs = parseFile(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('Real message');
  });

  test('handles Hebrew characters correctly', () => {
    const text = '[15/01/2024, 14:22:13] דנה: שלום, איך הולך?';
    const msgs = parseFile(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('שלום, איך הולך?');
    expect(msgs[0].sender).toBe('דנה');
  });

  test('returns empty array for blank input', () => {
    expect(parseFile('')).toEqual([]);
  });
});

describe('importFile', () => {
  beforeEach(() => db.init(':memory:'));
  afterEach(() => db.close());

  test('returns imported and skipped counts', async () => {
    const text = '[15/01/2024, 14:22:13] Alice: Hello!\n[15/01/2024, 14:23:00] Me: Hi!';
    const result = await importFile(text, 'Me', '+972501234567');
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
  });

  test('skips duplicate messages on re-import', async () => {
    const text = '[15/01/2024, 14:22:13] Alice: Hello!';
    await importFile(text, 'Me', '+972501234567');
    const result = await importFile(text, 'Me', '+972501234567');
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('returns imported: 0 for file with only media omitted messages', async () => {
    const text = '[15/01/2024, 14:22:13] Alice: <Media omitted>';
    const result = await importFile(text, 'Me', '+972501234567');
    expect(result.imported).toBe(0);
  });
});
