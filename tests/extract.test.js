const { extractPhones, extractEmails } = require('../src/extract');

describe('extractPhones', () => {
  test('extracts international format', () => {
    expect(extractPhones('Call me at +972501234567')).toEqual(['+972501234567']);
  });

  test('extracts local number with dashes', () => {
    expect(extractPhones('My number: 050-123-4567')).toEqual(['0501234567']);
  });

  test('extracts multiple numbers', () => {
    const result = extractPhones('Call +972501234567 or 0521234567');
    expect(result).toHaveLength(2);
    expect(result).toContain('+972501234567');
    expect(result).toContain('0521234567');
  });

  test('deduplicates same number', () => {
    expect(extractPhones('+972501234567 and +972501234567')).toHaveLength(1);
  });

  test('ignores short sequences (less than 7 digits)', () => {
    expect(extractPhones('Room 101 or price 50')).toEqual([]);
  });

  test('ignores standalone year or date', () => {
    const result = extractPhones('See you in 2026 on the 12th');
    expect(result).toEqual([]);
  });
});

describe('extractEmails', () => {
  test('extracts a single email', () => {
    expect(extractEmails('Send to user@example.com')).toEqual(['user@example.com']);
  });

  test('extracts multiple emails', () => {
    const result = extractEmails('a@b.com and c@d.org');
    expect(result).toHaveLength(2);
  });

  test('lowercases extracted emails', () => {
    expect(extractEmails('User@EXAMPLE.COM')).toEqual(['user@example.com']);
  });

  test('deduplicates emails', () => {
    expect(extractEmails('a@b.com and a@b.com')).toHaveLength(1);
  });
});
