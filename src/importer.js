const crypto = require('crypto');
const db = require('./db');

const MSG_REGEX = /^\[([^\]]+)\]\s+([^:]+):\s(.*)/;
const OMITTED_BODY = /^<.+omitted>$/i;

function parseTimestamp(raw) {
  const m = raw.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?/i
  );
  if (!m) return null;
  let [, day, month, year, hour, min, sec = '0', ampm] = m;
  if (year.length === 2) year = '20' + year;
  hour = parseInt(hour, 10);
  if (ampm) {
    if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  }
  const date = new Date(
    Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), hour, parseInt(min, 10), parseInt(sec, 10))
  );
  return isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

function syntheticWaId(timestamp, sender, body) {
  return (
    'import_' +
    crypto
      .createHash('md5')
      .update(`${timestamp}:${sender}:${body}`)
      .digest('hex')
      .slice(0, 16)
  );
}

function parseFile(text) {
  const lines = text.split('\n');
  const messages = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(MSG_REGEX);
    if (m) {
      if (current) messages.push(current);
      const [, rawTs, sender, body] = m;
      const ts = parseTimestamp(rawTs.trim());
      if (!ts) continue;
      if (OMITTED_BODY.test(body.trim())) continue;
      current = { timestamp: ts, sender: sender.trim(), body: body.trim() };
    } else if (current && line.trim()) {
      current.body += '\n' + line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

async function importFile(text, userName, contactPhone) {
  const messages = parseFile(text);
  if (!messages.length) return { imported: 0, skipped: 0 };

  const contactName =
    messages.find(m => m.sender !== userName)?.sender || contactPhone;
  const contactId = db.upsertContact(contactPhone, contactName);

  let imported = 0;
  let skipped = 0;

  for (const msg of messages) {
    const direction = userName && msg.sender === userName ? 'out' : 'in';
    const waId = syntheticWaId(msg.timestamp, msg.sender, msg.body);
    const msgId = db.insertMessage(contactId, direction, msg.body, msg.timestamp, waId);
    if (msgId === null) { skipped++; } else { imported++; }
  }

  return { imported, skipped };
}

module.exports = { parseTimestamp, parseFile, importFile };
