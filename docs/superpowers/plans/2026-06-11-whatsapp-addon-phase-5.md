# Phase 5: Smart Reply Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Inbox triage tab where Claude generates three reply suggestions per unanswered message, using contact profiles and per-contact reply settings, with direct send via WhatsApp.

**Architecture:** New `src/reply-engine.js` coordinates suggestion generation (mirrors `contact-intel.js`). `llm.js` gets `buildReplySuggestions`. DB schema adds 7 reply-settings columns to `contacts` via `ALTER TABLE` migration. Server adds 4 inbox routes. The Inbox tab (HTML/CSS/JS) replaces the placeholder. The Contacts panel gets a reply settings section and cross-navigation links.

**Tech Stack:** Node.js, Express, better-sqlite3 (sync), @anthropic-ai/sdk (`claude-opus-4-8`), vanilla JS dashboard.

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/llm.js` | Modify | Add `buildReplySuggestions` |
| `src/db.js` | Modify | ALTER TABLE migration + 9 new helpers + update `getContactDetail` + expand `patchContactProfile` whitelist |
| `src/reply-engine.js` | Create | `generateForMessage`, `generateBatch` |
| `src/server.js` | Modify | Add `replyEngine` require + 4 inbox routes + expand PATCH `/api/contacts/:id` whitelist |
| `public/index.html` | Modify | Inbox tab (HTML/CSS/JS) + Contacts panel reply settings section + cross-navigation |
| `tests/llm.test.js` | Modify | 4 new tests for `buildReplySuggestions` |
| `tests/db.test.js` | Modify | 6 new tests for inbox/suggestion helpers |
| `tests/reply-engine.test.js` | Create | 5 tests |
| `tests/server.test.js` | Modify | 5 new tests for inbox routes |

**Baseline:** 134 tests. Expected after: ~154 tests.

---

## Codebase Context

**Key patterns to follow:**
- `better-sqlite3` is synchronous — no `await` on DB calls, only LLM/bridge calls are async
- Fire-and-forget: `.catch(err => console.error(...))` attached, never awaited
- `patchContactProfile` builds a dynamic SQL UPDATE from a whitelist — expand that whitelist rather than add a new patch function
- `getContactDetail` returns the full contact row; must be updated to include the new columns
- `escHtml()` on all user-supplied values before `innerHTML`; `dir="auto"` on all text fields
- Test isolation: each `describe` block calls `db.init(':memory:')` in `beforeEach` and `db.close()` in `afterEach`
- `jest.mock('../src/bridge', ...)` and `jest.mock('../src/reply-engine', ...)` at top of `server.test.js` before require

---

## Task 1: `buildReplySuggestions` in `src/llm.js`

**Files:**
- Modify: `src/llm.js`
- Test: `tests/llm.test.js`

- [ ] **Step 1: Write failing tests**

Add to `tests/llm.test.js` (inside a new `describe('buildReplySuggestions', ...)` block after the existing ones):

```javascript
describe('buildReplySuggestions', () => {
  const { buildReplySuggestions } = require('../src/llm');
  const defaultSettings = { length: 'auto', tone: 'auto', language: 'auto', emoji: 'auto', greeting: 1 };

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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/llm.test.js --no-coverage
```

Expected: 4 new tests fail with `buildReplySuggestions is not a function`.

- [ ] **Step 3: Implement `buildReplySuggestions` in `src/llm.js`**

Add before `module.exports` in `src/llm.js`:

```javascript
async function buildReplySuggestions(messages, contactProfile, userProfile, settings) {
  if (!messages.length) return null;
  const client = getClient();

  const history = messages.map(m =>
    `[${m.direction === 'out' ? 'You' : 'Them'}] ${m.body}`
  ).join('\n');

  const profileSection = contactProfile && contactProfile.summary
    ? `\n\nContact profile:\nRelationship: ${contactProfile.summary}\nYour style with them: ${contactProfile.style}`
    : '';

  const userSection = userProfile
    ? `\n\nYour overall writing style:\n${userProfile}`
    : '';

  const lengthInstructions = {
    auto: "Choose an appropriate length based on the message. Match the contact's conversational pace.",
    short: 'Keep each reply to 1–2 sentences.',
    medium: 'Keep each reply to one paragraph.',
    long: 'Write a full, detailed paragraph response.',
  };

  const toneInstruction = settings.tone !== 'auto'
    ? `Tone: ${settings.tone}.`
    : 'Tone: match the established style from the profile.';

  const langInstruction = settings.language === 'he'
    ? 'Language: reply in Hebrew only.'
    : settings.language === 'en'
    ? 'Language: reply in English only.'
    : "Language: match the contact's language or your established pattern with them.";

  const emojiInstruction = settings.emoji === 'none'
    ? 'Do not use any emoji.'
    : settings.emoji === 'frequent'
    ? 'Use emoji freely.'
    : 'Use emoji naturally, matching the established style.';

  const greetingInstruction = settings.greeting
    ? 'Start with a natural greeting if appropriate.'
    : 'Do not start with a greeting — get straight to the reply.';

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `You are drafting WhatsApp reply suggestions on behalf of the user.

You will be given the recent message history with a contact, their relationship profile, and the user's writing style.

Write exactly 3 reply options. Each should be meaningfully different — not just paraphrases.
Vary the angle: one might confirm/agree, one might ask a follow-up, one might be warmer or more direct.

${toneInstruction}
${langInstruction}
Length: ${lengthInstructions[settings.length] || lengthInstructions.auto}
${emojiInstruction}
${greetingInstruction}

Never contradict explicit instructions above, but otherwise match the user's established style.

Respond in this exact format:
SUGGESTION_1:
<text>

SUGGESTION_2:
<text>

SUGGESTION_3:
<text>`,
      messages: [{ role: 'user', content: `Message history:${profileSection}${userSection}\n\n${history}` }],
    });
    const text = response.content[0].text;
    const s1 = (text.match(/SUGGESTION_1:\s*([\s\S]*?)(?=\n+SUGGESTION_2:|$)/) || [])[1]?.trim() || '';
    const s2 = (text.match(/SUGGESTION_2:\s*([\s\S]*?)(?=\n+SUGGESTION_3:|$)/) || [])[1]?.trim() || '';
    const s3 = (text.match(/SUGGESTION_3:\s*([\s\S]*?)(?=\n+$|$)/) || [])[1]?.trim() || '';
    if (!s1) return null;
    return [s1, s2, s3];
  } catch (err) {
    console.error('buildReplySuggestions error:', err.message);
    return null;
  }
}
```

Update `module.exports` at the bottom of `src/llm.js`:

```javascript
module.exports = { extractTasks, extractTasksBatch, buildContactProfile, buildUserProfile, buildReplySuggestions };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/llm.test.js --no-coverage
```

Expected: all 21 tests pass (17 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/llm.js tests/llm.test.js
git commit -m "feat: add buildReplySuggestions to llm.js"
```

---

## Task 2: DB schema migration and helpers

**Files:**
- Modify: `src/db.js`
- Test: `tests/db.test.js`

- [ ] **Step 1: Write failing tests**

Add a new `describe` block to `tests/db.test.js`:

```javascript
describe('inbox and reply suggestion helpers', () => {
  let contactId, messageId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Alice');
    messageId = db.insertMessage(contactId, 'in', 'Hey there!', 1000, 'wa-inbox-1');
  });

  afterEach(() => db.close());

  test('getInboxMessages returns unanswered non-muted contacts', () => {
    const rows = db.getInboxMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].contact_name).toBe('Alice');
    expect(rows[0].message_id).toBe(messageId);
    expect(rows[0].suggestion_status).toBeNull();
  });

  test('getInboxMessages excludes muted contacts', () => {
    db.patchContactProfile(contactId, { inbox_muted: 1 });
    expect(db.getInboxMessages()).toHaveLength(0);
  });

  test('getInboxMessages excludes contacts whose last inbound has used suggestion', () => {
    db.ensureSuggestionRow(messageId, contactId);
    db.markSuggestionUsed(messageId);
    expect(db.getInboxMessages()).toHaveLength(0);
  });

  test('storeSuggestions and getSuggestions round-trip', () => {
    db.storeSuggestions(messageId, contactId, 'S1', 'S2', 'S3');
    const row = db.getSuggestions(messageId);
    expect(row.suggestion_1).toBe('S1');
    expect(row.suggestion_2).toBe('S2');
    expect(row.suggestion_3).toBe('S3');
    expect(row.status).toBe('ready');
  });

  test('markSuggestionDismissed sets status to dismissed', () => {
    db.ensureSuggestionRow(messageId, contactId);
    db.markSuggestionDismissed(messageId);
    expect(db.getSuggestions(messageId).status).toBe('dismissed');
  });

  test('getUnansweredCount returns 1 for contact with unanswered message', () => {
    expect(db.getUnansweredCount(contactId)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/db.test.js --no-coverage
```

Expected: 6 new tests fail with errors about missing functions.

- [ ] **Step 3: Add migration to `db.init()` in `src/db.js`**

After the `db.prepare('INSERT OR IGNORE INTO user_profile ...').run()` line (around line 110), add:

```javascript
  // ── Phase 5 migration: add reply settings columns to contacts ─────────
  const existingCols = new Set(
    db.prepare('PRAGMA table_info(contacts)').all().map(r => r.name)
  );
  const colsToAdd = [
    ['inbox_muted',            'INTEGER NOT NULL DEFAULT 0'],
    ['reply_context_messages', 'INTEGER NOT NULL DEFAULT 20'],
    ['reply_length',           "TEXT NOT NULL DEFAULT 'auto'"],
    ['reply_tone',             "TEXT NOT NULL DEFAULT 'auto'"],
    ['reply_language',         "TEXT NOT NULL DEFAULT 'auto'"],
    ['reply_emoji',            "TEXT NOT NULL DEFAULT 'auto'"],
    ['reply_greeting',         'INTEGER NOT NULL DEFAULT 1'],
  ];
  for (const [col, def] of colsToAdd) {
    if (!existingCols.has(col)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${def}`);
    }
  }

  // ── Phase 5 migration: unique index on reply_suggestions(message_id) ──
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_suggestions_message ON reply_suggestions(message_id)`);
```

- [ ] **Step 4: Add the new DB helpers**

Add the following functions to `src/db.js` before `module.exports`. Place them after the existing user profile helpers:

```javascript
// ── Inbox helpers ─────────────────────────────────────────────────────────

function getInboxMessages() {
  return getDb().prepare(`
    SELECT
      m.id           AS message_id,
      c.id           AS contact_id,
      c.name         AS contact_name,
      c.phone,
      m.body,
      m.timestamp,
      rs.status      AS suggestion_status,
      rs.suggestion_1,
      rs.suggestion_2,
      rs.suggestion_3
    FROM contacts c
    JOIN messages m ON m.contact_id = c.id
    LEFT JOIN reply_suggestions rs ON rs.message_id = m.id
    WHERE c.inbox_muted = 0
      AND m.direction = 'in'
      AND m.id = (
        SELECT MAX(m2.id) FROM messages m2
        WHERE m2.contact_id = c.id AND m2.direction = 'in'
      )
      AND (rs.status IS NULL OR rs.status NOT IN ('used', 'dismissed'))
    ORDER BY m.timestamp DESC
  `).all();
}

function ensureSuggestionRow(messageId, contactId) {
  getDb().prepare(
    `INSERT OR IGNORE INTO reply_suggestions (message_id, contact_id, status) VALUES (?, ?, 'pending')`
  ).run(messageId, contactId);
}

function storeSuggestions(messageId, contactId, s1, s2, s3) {
  getDb().prepare(`
    INSERT INTO reply_suggestions (message_id, contact_id, suggestion_1, suggestion_2, suggestion_3, status)
    VALUES (?, ?, ?, ?, ?, 'ready')
    ON CONFLICT(message_id) DO UPDATE SET
      suggestion_1 = excluded.suggestion_1,
      suggestion_2 = excluded.suggestion_2,
      suggestion_3 = excluded.suggestion_3,
      status = 'ready'
  `).run(messageId, contactId, s1, s2, s3);
}

function getSuggestions(messageId) {
  return getDb().prepare(
    'SELECT suggestion_1, suggestion_2, suggestion_3, status FROM reply_suggestions WHERE message_id = ?'
  ).get(messageId) || null;
}

function markSuggestionUsed(messageId) {
  getDb().prepare("UPDATE reply_suggestions SET status = 'used' WHERE message_id = ?").run(messageId);
}

function markSuggestionDismissed(messageId) {
  getDb().prepare("UPDATE reply_suggestions SET status = 'dismissed' WHERE message_id = ?").run(messageId);
}

function markSuggestionFailed(messageId) {
  getDb().prepare("UPDATE reply_suggestions SET status = 'failed' WHERE message_id = ?").run(messageId);
}

function getUnansweredCount(contactId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM messages m
    LEFT JOIN reply_suggestions rs ON rs.message_id = m.id
    WHERE m.contact_id = ?
      AND m.direction = 'in'
      AND m.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.contact_id = ? AND m2.direction = 'in')
      AND (rs.status IS NULL OR rs.status NOT IN ('used', 'dismissed'))
  `).get(contactId, contactId);
  return row ? row.n : 0;
}

function getMessageWithContact(messageId) {
  return getDb().prepare(`
    SELECT m.id, m.contact_id, m.body, c.phone, c.name
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    WHERE m.id = ?
  `).get(messageId) || null;
}
```

- [ ] **Step 5: Update `getContactDetail` to include new columns**

Replace the existing `getContactDetail` function:

```javascript
function getContactDetail(contactId) {
  const contact = getDb().prepare(`
    SELECT id, name, phone, category, language, relationship_summary, style_to_contact,
           inbox_muted, reply_context_messages, reply_length, reply_tone,
           reply_language, reply_emoji, reply_greeting
    FROM contacts WHERE id = ?
  `).get(contactId);
  if (!contact) return null;
  contact.recent_messages = getDb().prepare(
    'SELECT direction, body, timestamp FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 5'
  ).all(contactId);
  return contact;
}
```

- [ ] **Step 6: Expand `patchContactProfile` whitelist**

Replace the `allowed` array in `patchContactProfile`:

```javascript
function patchContactProfile(contactId, updates) {
  const allowed = [
    'relationship_summary', 'style_to_contact', 'language', 'category',
    'inbox_muted', 'reply_context_messages', 'reply_length', 'reply_tone',
    'reply_language', 'reply_emoji', 'reply_greeting',
  ];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) {
    console.warn('patchContactProfile: no valid fields in updates', Object.keys(updates));
    return;
  }
  const sql = `UPDATE contacts SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
  getDb().prepare(sql).run(...fields.map(f => updates[f]), contactId);
}
```

- [ ] **Step 7: Update `module.exports`**

Replace the existing `module.exports`:

```javascript
module.exports = {
  init, close,
  upsertContact, insertMessage, getStatus, setStatus,
  createScheduledMessage, getScheduledMessage, getDueScheduledMessages,
  getPendingScheduledMessages, updateScheduledMessageStatus,
  incrementAttemptCount, cancelScheduledMessage, failScheduledMessage,
  getAllContacts, searchContacts,
  createTask, getPendingTasks, markTaskDone,
  createSharedContact, getLastMessagesFromContact, getAllSharedContacts,
  getSetting, setSetting,
  countInboundMessages, getInboundMessagesAfter,
  getContactProfile, updateContactProfile, patchContactProfile,
  getContactMessages, getContactsToSeed, getContactDetail, getContactInboundCount,
  getProfile, updateProfile, getOutgoingMessagesSample, getOutboundCount,
  getInboxMessages, ensureSuggestionRow, storeSuggestions, getSuggestions,
  markSuggestionUsed, markSuggestionDismissed, markSuggestionFailed,
  getUnansweredCount, getMessageWithContact,
};
```

- [ ] **Step 8: Run tests to confirm they pass**

```bash
npm test -- tests/db.test.js --no-coverage
```

Expected: all 54 tests pass (48 existing + 6 new).

- [ ] **Step 9: Commit**

```bash
git add src/db.js tests/db.test.js
git commit -m "feat: add inbox DB helpers and reply settings migration"
```

---

## Task 3: `src/reply-engine.js`

**Files:**
- Create: `src/reply-engine.js`
- Create: `tests/reply-engine.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/reply-engine.test.js`:

```javascript
const db = require('../src/db');

jest.mock('../src/llm', () => ({
  buildReplySuggestions: jest.fn(),
}));

let replyEngine;
let llm;

beforeEach(() => {
  jest.resetModules();
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/reply-engine.test.js --no-coverage
```

Expected: 5 tests fail with `Cannot find module '../src/reply-engine'`.

- [ ] **Step 3: Create `src/reply-engine.js`**

```javascript
const db = require('./db');
const llm = require('./llm');

async function generateForMessage(contactId, messageId) {
  const contact = db.getContactDetail(contactId);
  if (!contact) return;
  const allMessages = db.getContactMessages(contactId);
  const messages = allMessages.slice(-contact.reply_context_messages);
  const contactProfile = db.getContactProfile(contactId);
  const userProfile = db.getProfile();
  const settings = {
    length: contact.reply_length,
    tone: contact.reply_tone,
    language: contact.reply_language,
    emoji: contact.reply_emoji,
    greeting: contact.reply_greeting,
  };
  const suggestions = await llm.buildReplySuggestions(
    messages,
    contactProfile,
    userProfile ? userProfile.global_style : null,
    settings
  );
  if (!suggestions) {
    db.markSuggestionFailed(messageId);
    return;
  }
  db.storeSuggestions(messageId, contactId, suggestions[0], suggestions[1], suggestions[2]);
}

async function generateBatch(limit = 20) {
  const messages = db.getInboxMessages().filter(
    m => m.suggestion_status === null || m.suggestion_status === 'failed'
  );
  const toGenerate = messages.slice(0, limit);
  for (const msg of toGenerate) {
    db.ensureSuggestionRow(msg.message_id, msg.contact_id);
    generateForMessage(msg.contact_id, msg.message_id)
      .catch(err => console.error('generateForMessage error:', err.message));
  }
}

module.exports = { generateForMessage, generateBatch };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/reply-engine.test.js --no-coverage
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reply-engine.js tests/reply-engine.test.js
git commit -m "feat: add reply-engine.js with generateForMessage and generateBatch"
```

---

## Task 4: Server routes

**Files:**
- Modify: `src/server.js`
- Modify: `tests/server.test.js`

- [ ] **Step 1: Write failing tests**

At the top of `tests/server.test.js`, add `reply-engine` to the mocks (add after the existing `jest.mock('../src/contact-intel', ...)` block):

```javascript
jest.mock('../src/reply-engine', () => ({
  generateBatch: jest.fn().mockResolvedValue(undefined),
  generateForMessage: jest.fn().mockResolvedValue(undefined),
}));
```

Add a new `describe` block at the bottom of `tests/server.test.js`:

```javascript
describe('inbox routes', () => {
  let contactId, messageId;

  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
    contactId = db.upsertContact('+972501234567', 'Alice');
    messageId = db.insertMessage(contactId, 'in', 'Hey!', 1000, 'wa-inbox-1');
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
  });

  test('GET /api/inbox returns unanswered messages', async () => {
    const res = await request(app).get('/api/inbox');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].contact_name).toBe('Alice');
    expect(res.body[0].message_id).toBe(messageId);
  });

  test('POST /api/inbox/generate returns 200 and calls generateBatch', async () => {
    const replyEngine = require('../src/reply-engine');
    const res = await request(app)
      .post('/api/inbox/generate')
      .send({ limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(replyEngine.generateBatch).toHaveBeenCalledWith(10);
  });

  test('POST /api/inbox/:messageId/dismiss marks suggestion dismissed', async () => {
    db.ensureSuggestionRow(messageId, contactId);
    const res = await request(app).post(`/api/inbox/${messageId}/dismiss`);
    expect(res.status).toBe(200);
    expect(db.getSuggestions(messageId).status).toBe('dismissed');
  });

  test('POST /api/inbox/:messageId/send returns 400 when body is missing', async () => {
    const res = await request(app)
      .post(`/api/inbox/${messageId}/send`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/inbox/:messageId/send returns 404 for unknown message', async () => {
    const res = await request(app)
      .post('/api/inbox/9999/send')
      .send({ body: 'hello' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/server.test.js --no-coverage
```

Expected: 5 new tests fail (routes not yet added).

- [ ] **Step 3: Expand the PATCH `/api/contacts/:id` whitelist in `src/server.js`**

The existing route filters incoming fields before calling `patchContactProfile`. Add the new reply settings fields:

```javascript
// Find this line in the PATCH /api/contacts/:id handler:
const allowed = ['relationship_summary', 'style_to_contact', 'language', 'category'];

// Replace with:
const allowed = [
  'relationship_summary', 'style_to_contact', 'language', 'category',
  'inbox_muted', 'reply_context_messages', 'reply_length', 'reply_tone',
  'reply_language', 'reply_emoji', 'reply_greeting',
];
```

- [ ] **Step 4: Add routes to `src/server.js`**

Add at the top of `createApp`, after the existing `const contactIntel = require('./contact-intel');` require in `server.js`:

```javascript
const replyEngine = require('./reply-engine');
```

Add the following routes after the `// ── Contact intelligence seed` section and before the `// ── Tasks` section:

```javascript
  // ── Inbox ──────────────────────────────────────────────────────────────
  app.get('/api/inbox', (req, res) => {
    res.json(db.getInboxMessages());
  });

  app.post('/api/inbox/generate', (req, res) => {
    const limit = Number(req.body.limit) || 20;
    replyEngine.generateBatch(limit)
      .catch(err => console.error('generateBatch error:', err.message));
    res.json({ ok: true });
  });

  app.post('/api/inbox/:messageId/dismiss', (req, res) => {
    const id = Number(req.params.messageId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
    db.markSuggestionDismissed(id);
    res.json({ ok: true });
  });

  app.post('/api/inbox/:messageId/send', async (req, res) => {
    const id = Number(req.params.messageId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
    const { body } = req.body;
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body is required' });
    const msg = db.getMessageWithContact(id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    try {
      await bridge.sendMessage(msg.phone, body);
      db.insertMessage(msg.contact_id, 'out', body, Math.floor(Date.now() / 1000), `manual-${Date.now()}`);
      db.markSuggestionUsed(id);
      res.json({ ok: true });
    } catch (err) {
      console.error('Send message error:', err.message);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm test -- tests/server.test.js --no-coverage
```

Expected: all 41 tests pass (36 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/server.js tests/server.test.js
git commit -m "feat: add inbox API routes to server.js"
```

---

## Task 5: Inbox tab UI

**Files:**
- Modify: `public/index.html`

No automated tests for the UI. Verify manually by starting the server: `node src/index.js` (or `node -e "require('./src/db').init(); require('./src/server').init()"`).

- [ ] **Step 1: Add Inbox CSS**

Inside the `<style>` block in `public/index.html`, add after the `.panel-divider` rule (around line 291):

```css
    /* Inbox tab */
    .inbox-layout {
      display: flex;
      gap: 0;
      height: calc(100vh - 160px);
      min-height: 400px;
    }
    .inbox-sidebar {
      width: 240px;
      flex-shrink: 0;
      border-right: 1px solid #21262d;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .inbox-sidebar-header {
      padding: 10px 14px;
      font-size: 0.8em;
      color: #8b949e;
      border-bottom: 1px solid #21262d;
      flex-shrink: 0;
    }
    #inbox-list { flex: 1; overflow-y: auto; }
    .inbox-list-item {
      padding: 10px 14px;
      cursor: pointer;
      border-bottom: 1px solid #21262d;
    }
    .inbox-list-item:hover { background: #161b22; }
    .inbox-list-item.active { background: #1c2128; }
    .inbox-list-item .ili-name { font-size: 0.85em; font-weight: 600; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .inbox-list-item .ili-snippet { font-size: 0.78em; color: #8b949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .inbox-list-item .ili-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .inbox-list-item .ili-time { font-size: 0.72em; color: #8b949e; margin-left: auto; }
    .inbox-status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .inbox-status-dot.ready    { background: #3fb950; }
    .inbox-status-dot.pending  { background: #d29922; }
    .inbox-status-dot.failed   { background: #f85149; }
    .inbox-status-dot.none     { background: #30363d; }
    .inbox-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .inbox-panel-placeholder {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #8b949e;
      font-size: 0.9em;
    }
    .inbox-panel-header {
      padding: 10px 16px;
      border-bottom: 1px solid #21262d;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .inbox-panel-header .iph-name {
      font-weight: 600;
      font-size: 1em;
      color: #58a6ff;
      cursor: pointer;
      text-decoration: none;
    }
    .inbox-panel-header .iph-name:hover { text-decoration: underline; }
    .inbox-panel-header .iph-meta { font-size: 0.8em; color: #8b949e; flex: 1; }
    .inbox-mute-btn {
      background: none;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 0.78em;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
    }
    .inbox-mute-btn:hover { border-color: #f85149; color: #f85149; }
    .inbox-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .inbox-section-label {
      font-size: 0.72em;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 2px;
      margin-top: 8px;
    }
    .msg-bubble {
      max-width: 75%;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 0.875em;
      line-height: 1.5;
    }
    .msg-bubble.in  { background: #161b22; color: #c9d1d9; align-self: flex-start; }
    .msg-bubble.out { background: #1a3a2a; color: #c9d1d9; align-self: flex-end; }
    .msg-bubble.in.latest { border: 1px solid #3fb950; }
    .inbox-divider { border: none; border-top: 1px solid #21262d; margin: 6px 0; }
    .suggestion-block {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 0.875em;
      line-height: 1.5;
      color: #c9d1d9;
      cursor: pointer;
      transition: border-color 0.1s;
    }
    .suggestion-block:hover { border-color: #58a6ff; }
    .suggestion-block.selected { border-color: #3fb950; background: #1a3a2a; }
    .suggestion-num { font-size: 0.72em; color: #8b949e; margin-bottom: 3px; }
    .inbox-compose {
      border-top: 1px solid #21262d;
      padding: 10px 16px;
      flex-shrink: 0;
      background: #0d1117;
    }
    .inbox-compose textarea {
      width: 100%;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      padding: 8px 10px;
      font-size: 0.875em;
      font-family: inherit;
      resize: none;
      height: 64px;
      line-height: 1.5;
    }
    .inbox-compose textarea:focus { outline: none; border-color: #3fb950; }
    .inbox-compose-actions { display: flex; gap: 6px; margin-top: 6px; }
    .inbox-send-btn {
      flex: 1;
      background: #238636;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 7px 14px;
      font-size: 0.875em;
      cursor: pointer;
      font-family: inherit;
    }
    .inbox-send-btn:hover { background: #2ea043; }
    .inbox-send-btn:disabled { background: #21262d; color: #8b949e; cursor: not-allowed; }
    .inbox-dismiss-btn, .inbox-regen-btn {
      background: none;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 0.875em;
      cursor: pointer;
      font-family: inherit;
    }
    .inbox-dismiss-btn:hover { border-color: #f85149; color: #f85149; }
    .inbox-regen-btn:hover { border-color: #58a6ff; color: #58a6ff; }
```

- [ ] **Step 2: Replace the Inbox tab placeholder HTML**

Replace the existing `<!-- Inbox tab (placeholder) -->` block:

```html
  <!-- Inbox tab -->
  <div id="tab-inbox" class="tab active">
    <div class="inbox-layout">
      <div class="inbox-sidebar">
        <div class="inbox-sidebar-header" id="inbox-sidebar-header">Unanswered (0)</div>
        <div id="inbox-list">
          <p class="empty-state" style="padding:12px 14px">No unanswered messages.</p>
        </div>
      </div>
      <div class="inbox-panel" id="inbox-panel">
        <div class="inbox-panel-placeholder">Select a message to draft a reply.</div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add Inbox JS — list rendering and panel opening**

Inside the `<script>` tag, add after the `// ── Contacts tab` section (before `// ── Shared contacts`):

```javascript
    // ── Inbox tab ────────────────────────────────────────────────────────
    let inboxPoller = null;
    let activeInboxMessageId = null;
    let inboxData = [];

    async function refreshInboxList() {
      try {
        const res = await fetch('/api/inbox');
        if (!res.ok) return;
        inboxData = await res.json();
      } catch {
        return;
      }
      const list = document.getElementById('inbox-list');
      const header = document.getElementById('inbox-sidebar-header');
      header.textContent = `Unanswered (${inboxData.length})`;
      if (!inboxData.length) {
        list.innerHTML = '<p class="empty-state" style="padding:12px 14px">No unanswered messages.</p>';
        return;
      }
      list.innerHTML = inboxData.map(m => {
        const statusClass = m.suggestion_status === 'ready' ? 'ready'
          : m.suggestion_status === 'pending' ? 'pending'
          : m.suggestion_status === 'failed' ? 'failed' : 'none';
        return `
          <div class="inbox-list-item${activeInboxMessageId === m.message_id ? ' active' : ''}"
               data-message-id="${escHtml(String(m.message_id))}"
               onclick="openInboxPanel(${m.message_id})">
            <div class="ili-meta">
              <span class="inbox-status-dot ${statusClass}"></span>
              <span class="ili-name" dir="auto">${escHtml(m.contact_name || m.phone)}</span>
              <span class="ili-time">${formatTime(m.timestamp)}</span>
            </div>
            <div class="ili-snippet" dir="auto">${escHtml(m.body)}</div>
          </div>`;
      }).join('');
    }

    async function openInboxPanel(messageId) {
      activeInboxMessageId = messageId;
      document.querySelectorAll('.inbox-list-item').forEach(el => {
        el.classList.toggle('active', el.dataset.messageId === String(messageId));
      });

      const panel = document.getElementById('inbox-panel');
      const msg = inboxData.find(m => m.message_id === messageId);
      if (!msg) return;

      panel.innerHTML = `
        <div class="inbox-panel-header">
          <span class="iph-name" onclick="openContactFromInbox(${msg.contact_id})" dir="auto">${escHtml(msg.contact_name || msg.phone)} ↗</span>
          <span class="iph-meta"></span>
          <button class="inbox-mute-btn" onclick="muteInboxContact(${msg.contact_id})">Mute inbox</button>
        </div>
        <div class="inbox-scroll" id="inbox-scroll-${messageId}">
          <div class="inbox-section-label">Recent conversation</div>
          <div id="inbox-chat-${messageId}"><p style="color:#8b949e;font-size:0.85em">Loading…</p></div>
          <hr class="inbox-divider">
          <div class="inbox-section-label">Suggestions — click to edit</div>
          <div id="inbox-suggestions-${messageId}">${renderSuggestions(msg, messageId)}</div>
        </div>
        <div class="inbox-compose" id="inbox-compose-${messageId}">
          <textarea id="inbox-reply-${messageId}" dir="auto" placeholder="Click a suggestion above, or type your reply…"></textarea>
          <div class="inbox-compose-actions">
            <button class="inbox-send-btn" onclick="sendInboxReply(${messageId}, ${msg.contact_id})">Send via WhatsApp</button>
            <button class="inbox-dismiss-btn" onclick="dismissInboxMessage(${messageId})">Dismiss</button>
            <button class="inbox-regen-btn" onclick="regenInboxSuggestions(${messageId}, ${msg.contact_id})">↻</button>
          </div>
        </div>`;

      loadInboxChat(msg.contact_id, messageId);
    }

    function renderSuggestions(msg, messageId) {
      if (msg.suggestion_status === 'pending') {
        return '<p style="color:#8b949e;font-size:0.85em">⟳ Generating suggestions…</p>';
      }
      if (msg.suggestion_status === 'failed' || !msg.suggestion_1) {
        return '<p style="color:#f85149;font-size:0.85em">Failed to generate — click ↻ to retry.</p>';
      }
      return [msg.suggestion_1, msg.suggestion_2, msg.suggestion_3]
        .filter(Boolean)
        .map((s, i) => `
          <div class="suggestion-block" onclick="selectSuggestion(${messageId}, this, ${escHtml(JSON.stringify(s))})">
            <div class="suggestion-num">${i + 1}</div>
            ${escHtml(s)}
          </div>`).join('');
    }

    function selectSuggestion(messageId, el, text) {
      document.querySelectorAll(`#inbox-suggestions-${messageId} .suggestion-block`).forEach(b => b.classList.remove('selected'));
      el.classList.add('selected');
      document.getElementById(`inbox-reply-${messageId}`).value = text;
    }

    async function loadInboxChat(contactId, messageId) {
      try {
        const res = await fetch(`/api/contacts/${contactId}`);
        if (!res.ok) return;
        const c = await res.json();
        const chatEl = document.getElementById(`inbox-chat-${messageId}`);
        if (!chatEl) return;
        const msgs = (c.recent_messages || []).slice().reverse(); // oldest first
        chatEl.innerHTML = msgs.map(m => `
          <div class="msg-bubble ${m.direction}${m.direction === 'in' && msgs.indexOf(m) === msgs.length - 1 ? ' latest' : ''}" dir="auto">
            ${escHtml(m.body)}
          </div>`).join('');
      } catch {}
    }

    function openContactFromInbox(contactId) {
      showTab('contacts');
      openContactPanel(contactId);
    }
```

- [ ] **Step 4: Add Inbox JS — actions and polling**

Immediately after the above block (still inside `<script>`):

```javascript
    async function sendInboxReply(messageId, contactId) {
      const textarea = document.getElementById(`inbox-reply-${messageId}`);
      const body = textarea ? textarea.value.trim() : '';
      if (!body) { textarea && (textarea.style.borderColor = '#f85149'); return; }
      const btn = document.querySelector(`#inbox-compose-${messageId} .inbox-send-btn`);
      if (btn) btn.disabled = true;
      try {
        const res = await fetch(`/api/inbox/${messageId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (btn) { btn.disabled = false; btn.textContent = data.error || 'Error'; setTimeout(() => { btn.textContent = 'Send via WhatsApp'; }, 2000); }
          return;
        }
        // Remove from list and clear panel
        inboxData = inboxData.filter(m => m.message_id !== messageId);
        activeInboxMessageId = null;
        await refreshInboxList();
        document.getElementById('inbox-panel').innerHTML = '<div class="inbox-panel-placeholder">Reply sent.</div>';
      } catch (e) {
        if (btn) { btn.disabled = false; }
      }
    }

    async function dismissInboxMessage(messageId) {
      try {
        await fetch(`/api/inbox/${messageId}/dismiss`, { method: 'POST' });
      } catch {}
      inboxData = inboxData.filter(m => m.message_id !== messageId);
      activeInboxMessageId = null;
      await refreshInboxList();
      document.getElementById('inbox-panel').innerHTML = '<div class="inbox-panel-placeholder">Select a message to draft a reply.</div>';
    }

    async function muteInboxContact(contactId) {
      try {
        await fetch(`/api/contacts/${contactId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inbox_muted: 1 }),
        });
      } catch {}
      inboxData = inboxData.filter(m => m.contact_id !== contactId);
      activeInboxMessageId = null;
      await refreshInboxList();
      document.getElementById('inbox-panel').innerHTML = '<div class="inbox-panel-placeholder">Contact muted from Inbox.</div>';
    }

    async function regenInboxSuggestions(messageId, contactId) {
      try {
        await fetch('/api/inbox/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 1 }),
        });
      } catch {}
      // Update local state to pending so spinner shows
      const entry = inboxData.find(m => m.message_id === messageId);
      if (entry) { entry.suggestion_status = 'pending'; entry.suggestion_1 = null; }
      openInboxPanel(messageId);
      startInboxPolling();
    }

    async function triggerInboxGenerate() {
      try {
        await fetch('/api/inbox/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20 }),
        });
      } catch {}
    }

    function startInboxPolling() {
      if (inboxPoller) clearInterval(inboxPoller);
      inboxPoller = setInterval(async () => {
        await refreshInboxList();
        // Re-render open panel if suggestions arrived
        if (activeInboxMessageId !== null) {
          const msg = inboxData.find(m => m.message_id === activeInboxMessageId);
          if (msg && msg.suggestion_status === 'ready') {
            const sugEl = document.getElementById(`inbox-suggestions-${activeInboxMessageId}`);
            if (sugEl) sugEl.innerHTML = renderSuggestions(msg, activeInboxMessageId);
          }
        }
        const anyPending = inboxData.some(m => m.suggestion_status === 'pending');
        if (!anyPending) {
          clearInterval(inboxPoller);
          inboxPoller = null;
        }
      }, 3000);
    }
```

- [ ] **Step 5: Wire `showTab('inbox')` to trigger generate + poll**

In the `showTab` function, update the inbox case. The current `showTab` body ends with:

```javascript
      if (name === 'contacts') { refreshContactList(''); refreshSharedContacts(); }
```

Add immediately after that line:

```javascript
      if (name === 'inbox') { refreshInboxList().then(() => { triggerInboxGenerate(); startInboxPolling(); }); }
```

- [ ] **Step 6: Verify manually**

Start the server and open the dashboard:

```bash
node -e "
  require('./src/db').init();
  const app = require('./src/server').createApp();
  app.listen(3000, () => console.log('http://localhost:3000'));
"
```

Open http://localhost:3000 and click the Inbox tab. Confirm: sidebar shows "Unanswered (0)" with empty state (no real WhatsApp needed). No JS errors in the console.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: implement Inbox tab UI with two-panel layout and suggestion rendering"
```

---

## Task 6: Contacts panel reply settings + navigation

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add reply settings CSS**

Inside the `<style>` block, add after the `.inbox-regen-btn` rules:

```css
    /* Reply settings section in Contacts panel */
    .reply-settings-section { margin-top: 20px; }
    .reply-settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .reply-settings-header h4 { font-size: 0.85em; font-weight: 600; color: #e6edf3; }
    .reply-settings-header .rsh-sub { font-size: 0.75em; color: #8b949e; }
    .rs-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
      margin-bottom: 12px;
    }
    .rs-toggle-label { font-size: 0.82em; color: #c9d1d9; }
    .rs-toggle-sub { font-size: 0.75em; color: #8b949e; }
    .toggle-switch {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .toggle-track {
      width: 32px; height: 18px;
      border-radius: 9px;
      background: #21262d;
      position: relative;
      transition: background 0.2s;
    }
    .toggle-track.on { background: #238636; }
    .toggle-thumb {
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #fff;
      position: absolute;
      top: 2px; left: 2px;
      transition: left 0.2s;
    }
    .toggle-track.on .toggle-thumb { left: 16px; }
    .rs-field { margin-bottom: 12px; }
    .rs-field label { display: block; font-size: 0.75em; color: #8b949e; margin-bottom: 4px; }
    .rs-field input[type="number"] {
      width: 80px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      padding: 5px 8px;
      font-size: 0.875em;
      font-family: inherit;
    }
    .rs-field input[type="number"]:focus { outline: none; border-color: #58a6ff; }
    .rs-btn-group { display: flex; gap: 4px; flex-wrap: wrap; }
    .rs-btn {
      background: #161b22;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 0.8em;
      cursor: pointer;
      font-family: inherit;
    }
    .rs-btn.active { background: #1a3a2a; border-color: #3fb950; color: #3fb950; }
    .rs-btn:hover:not(.active) { border-color: #8b949e; color: #c9d1d9; }
    .rs-pill-group { display: flex; gap: 4px; flex-wrap: wrap; }
    .rs-pill {
      background: #161b22;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 12px;
      padding: 3px 10px;
      font-size: 0.78em;
      cursor: pointer;
      font-family: inherit;
    }
    .rs-pill.active { background: #1a3a2a; border-color: #3fb950; color: #3fb950; }
    .rs-pill:hover:not(.active) { border-color: #8b949e; color: #c9d1d9; }
    .inbox-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 0.8em;
      color: #c9d1d9;
      margin-bottom: 14px;
    }
    .inbox-badge:hover { border-color: #58a6ff; }
    .inbox-badge .ib-dot { color: #f0883e; }
    .inbox-badge .ib-link { color: #58a6ff; }
```

- [ ] **Step 2: Update `openContactPanel` to add reply settings and inbox badge**

Replace the `openContactPanel` function. Find the line:

```javascript
      panel.innerHTML = `
        <div class="panel-header">
```

and replace the entire template string through the closing backtick with:

```javascript
      const unanswered = c.inbox_muted ? 0 : (await fetch(`/api/inbox`).then(r=>r.json()).catch(()=>[])).filter(m => m.contact_id === id).length;

      panel.innerHTML = `
        <div class="panel-header">
          <div class="panel-name" dir="auto">${escHtml(c.name || c.phone)}</div>
          <div class="panel-phone">${escHtml(c.phone || '')}</div>
        </div>
        ${unanswered > 0 ? `
        <div class="inbox-badge" onclick="openInboxFromContact(${id})">
          <span class="ib-dot">●</span>
          <span>${unanswered} unanswered message${unanswered > 1 ? 's' : ''}</span>
          <span class="ib-link">→ Go to Inbox</span>
        </div>` : ''}
        <button class="refresh-profile-btn" onclick="triggerContactRefresh(${id})">↻ Refresh profile</button>
        <div class="panel-field">
          <label>Language</label>
          <select onchange="saveContactField(${id}, 'language', this.value)">${langOptions}</select>
        </div>
        <div class="panel-field">
          <label>Category</label>
          <input type="text" id="panel-category-${id}" value="${escHtml(c.category || '')}" placeholder="fan, colleague, press…" dir="auto">
          <button class="save-btn" onclick="saveContactField(${id}, 'category', document.getElementById('panel-category-${id}').value)">Save</button>
        </div>
        <div class="panel-field">
          <label>Relationship summary</label>
          <textarea id="panel-summary-${id}" rows="6" dir="auto">${escHtml(c.relationship_summary || '')}</textarea>
          <button class="save-btn" onclick="saveContactField(${id}, 'relationship_summary', document.getElementById('panel-summary-${id}').value)">Save</button>
        </div>
        <div class="panel-field">
          <label>How you write to them</label>
          <textarea id="panel-style-${id}" rows="4" dir="auto">${escHtml(c.style_to_contact || '')}</textarea>
          <button class="save-btn" onclick="saveContactField(${id}, 'style_to_contact', document.getElementById('panel-style-${id}').value)">Save</button>
        </div>
        ${msgHtml ? `<div class="panel-messages"><h4>Recent messages</h4>${msgHtml}</div>` : ''}
        <div class="reply-settings-section">
          <div class="reply-settings-header">
            <h4>Reply settings</h4>
            <span class="rsh-sub">Overrides defaults for AI suggestions</span>
          </div>
          <div class="rs-toggle-row">
            <div>
              <div class="rs-toggle-label">Inbox suggestions</div>
              <div class="rs-toggle-sub">Show this contact in Inbox</div>
            </div>
            <div class="toggle-switch" onclick="toggleInboxMuted(${id}, this)">
              <div class="toggle-track${c.inbox_muted ? '' : ' on'}" id="rs-mute-track-${id}">
                <div class="toggle-thumb"></div>
              </div>
              <span style="font-size:0.8em;color:#8b949e" id="rs-mute-label-${id}">${c.inbox_muted ? 'Off' : 'On'}</span>
            </div>
          </div>
          <div class="rs-field">
            <label>Messages to consider</label>
            <input type="number" id="rs-ctx-${id}" value="${c.reply_context_messages || 20}" min="5" max="50"
              onchange="saveContactField(${id}, 'reply_context_messages', parseInt(this.value) || 20)">
          </div>
          <div class="rs-field">
            <label>Reply length</label>
            <div class="rs-btn-group">
              ${['auto','short','medium','long'].map(v => `
                <button class="rs-btn${(c.reply_length||'auto')===v?' active':''}"
                  onclick="setRsSingle(${id},'reply_length','${v}',this.parentElement)">${v.charAt(0).toUpperCase()+v.slice(1)}</button>`).join('')}
            </div>
          </div>
          <div class="rs-field">
            <label>Tone</label>
            <div class="rs-pill-group">
              ${['auto','casual','professional','warm','direct'].map(v => `
                <button class="rs-pill${(c.reply_tone||'auto')===v?' active':''}"
                  onclick="setRsSingle(${id},'reply_tone','${v}',this.parentElement)">${v.charAt(0).toUpperCase()+v.slice(1)}</button>`).join('')}
            </div>
          </div>
          <div class="rs-field">
            <label>Language</label>
            <div class="rs-btn-group">
              ${[['auto','Auto'],['en','English'],['he','עברית']].map(([v,l]) => `
                <button class="rs-btn${(c.reply_language||'auto')===v?' active':''}"
                  onclick="setRsSingle(${id},'reply_language','${v}',this.parentElement)">${l}</button>`).join('')}
            </div>
          </div>
          <div class="rs-field">
            <label>Emoji use</label>
            <div class="rs-btn-group">
              ${['none','auto','frequent'].map(v => `
                <button class="rs-btn${(c.reply_emoji||'auto')===v?' active':''}"
                  onclick="setRsSingle(${id},'reply_emoji','${v}',this.parentElement)">${v.charAt(0).toUpperCase()+v.slice(1)}</button>`).join('')}
            </div>
          </div>
          <div class="rs-toggle-row" style="border-top:1px solid #21262d;border-bottom:none;margin-top:4px">
            <div class="rs-toggle-label">Include greeting</div>
            <div class="toggle-switch" onclick="toggleGreeting(${id}, this)">
              <div class="toggle-track${c.reply_greeting ? ' on' : ''}" id="rs-greeting-track-${id}">
                <div class="toggle-thumb"></div>
              </div>
              <span style="font-size:0.8em;color:#8b949e" id="rs-greeting-label-${id}">${c.reply_greeting ? 'On' : 'Off'}</span>
            </div>
          </div>
        </div>
      `;
```

Note: `openContactPanel` must be changed to `async` since it now uses `await`:

Replace `async function openContactPanel(id) {` — it's already `async` based on the fetch call inside. Confirm the `async` keyword is there.

- [ ] **Step 3: Add reply settings helper JS functions**

Add after `triggerContactRefresh`:

```javascript
    function setRsSingle(contactId, field, value, container) {
      container.querySelectorAll('.rs-btn, .rs-pill').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      saveContactField(contactId, field, value);
    }

    async function toggleInboxMuted(contactId, toggleEl) {
      const track = document.getElementById(`rs-mute-track-${contactId}`);
      const label = document.getElementById(`rs-mute-label-${contactId}`);
      const isOn = track.classList.contains('on');
      const newMuted = isOn ? 1 : 0;
      track.classList.toggle('on', !isOn);
      label.textContent = isOn ? 'Off' : 'On';
      await saveContactField(contactId, 'inbox_muted', newMuted);
    }

    async function toggleGreeting(contactId, toggleEl) {
      const track = document.getElementById(`rs-greeting-track-${contactId}`);
      const label = document.getElementById(`rs-greeting-label-${contactId}`);
      const isOn = track.classList.contains('on');
      const newVal = isOn ? 0 : 1;
      track.classList.toggle('on', !isOn);
      label.textContent = isOn ? 'Off' : 'On';
      await saveContactField(contactId, 'reply_greeting', newVal);
    }

    function openInboxFromContact(contactId) {
      showTab('inbox');
      const msg = inboxData.find(m => m.contact_id === contactId);
      if (msg) openInboxPanel(msg.message_id);
    }
```

- [ ] **Step 4: Verify manually**

Open http://localhost:3000 → Contacts tab → click a contact. Confirm:
- Reply settings section appears below "How you write to them"
- If the contact has an unanswered message in the Inbox, the badge "N unanswered message → Go to Inbox" appears
- Toggle switches work visually and save on click
- "Auto/Short/Medium/Long" buttons highlight correctly
- Clicking "Go to Inbox" badge switches to Inbox tab and selects the contact's message

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: add reply settings section and navigation to Contacts panel"
```

---

## Final check

- [ ] **Run all tests**

```bash
npm test
```

Expected: ~154 tests, all passing.

- [ ] **Push to remote**

```bash
git push
```
