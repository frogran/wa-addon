# WhatsApp Add-on Phase 4: Contact Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-contact and global user writing-style profiles that accumulate over time, with a searchable editable Contacts tab and a Settings batch-seed job.

**Architecture:** Three new backend pieces — LLM functions in `llm.js`, DB helpers in `db.js`, and a coordinator module `contact-intel.js` — wired into `bridge.js` for real-time refresh and `server.js` for API access. The Contacts tab is rebuilt as a two-column search + side-panel layout. No schema migrations required; all columns exist.

**Tech Stack:** better-sqlite3 (sync), @anthropic-ai/sdk (claude-opus-4-8), Express, vanilla JS frontend. Jest + supertest for tests.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/llm.js` | Modify | Add `buildContactProfile`, `buildUserProfile` |
| `src/db.js` | Modify | Add 10 new helpers; update `getAllContacts`, `searchContacts` |
| `src/contact-intel.js` | Create | `seedAll`, `refreshContact`, `refreshUserProfile` orchestration |
| `src/server.js` | Modify | 8 new routes for contacts, profile, intel |
| `src/bridge.js` | Modify | Wire refresh triggers on inbound messages |
| `public/index.html` | Modify | Rebuild Contacts tab; add intel card to Settings |
| `tests/llm.test.js` | Modify | 6 new tests |
| `tests/db.test.js` | Modify | 9 new tests |
| `tests/contact-intel.test.js` | Create | 7 tests |
| `tests/server.test.js` | Modify | 10 new tests |

**Expected test count after Phase 4:** 128 (96 current + 32 new)

---

## Task 1: LLM Functions

**Files:**
- Modify: `src/llm.js`
- Modify: `tests/llm.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/llm.test.js`:

```javascript
const { buildContactProfile, buildUserProfile } = require('../src/llm');

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
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest tests/llm.test.js --no-coverage 2>&1 | tail -15
```
Expected: FAIL — `buildContactProfile is not a function`, `buildUserProfile is not a function`

- [ ] **Step 3: Implement the two functions**

In `src/llm.js`, add after `extractTasksBatch`, before `module.exports`:

```javascript
async function buildContactProfile(messages, existingProfile) {
  const client = getClient();
  const existing = existingProfile && existingProfile.summary
    ? `\n\nExisting profile:\nRELATIONSHIP_SUMMARY:\n${existingProfile.summary}\n\nSTYLE_TO_CONTACT:\n${existingProfile.style}`
    : '';
  const history = messages.map(m =>
    `[${m.direction === 'out' ? 'You' : 'Them'}] ${m.body}`
  ).join('\n');
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `You are building a relationship and communication profile for a WhatsApp contact.
You will be given the existing profile (if any) and the full message history with this contact.

Update and enrich the profile — never remove existing observations unless you have clear evidence they are wrong.
Only add, refine, or strengthen. The profile has two parts:

RELATIONSHIP SUMMARY: Who is this person? What is the relationship? What do they typically want?
What topics come up? What is their tone? Be concrete and specific — avoid generic labels.
Include memorable details if any emerge.

STYLE TO CONTACT: How does the user specifically write to this person?
Note: formality level, language (Hebrew / English / mixed), emoji use, typical reply length,
recurring phrases or expressions lifted from the sent messages.

Respond in this exact format:
RELATIONSHIP_SUMMARY:
<text>

STYLE_TO_CONTACT:
<text>

LANGUAGE: <en|he|mixed>

CATEGORY: <fan|colleague|press|family|other>`,
      messages: [{ role: 'user', content: `Message history:${existing}\n\n${history}` }],
    });
    const text = response.content[0].text;
    const summary = (text.match(/RELATIONSHIP_SUMMARY:\s*([\s\S]*?)(?=\nSTYLE_TO_CONTACT:|$)/) || [])[1]?.trim() || '';
    const style = (text.match(/STYLE_TO_CONTACT:\s*([\s\S]*?)(?=\nLANGUAGE:|$)/) || [])[1]?.trim() || '';
    const language = (text.match(/LANGUAGE:\s*(\S+)/) || [])[1]?.toLowerCase() || 'en';
    const category = (text.match(/CATEGORY:\s*(\S+)/) || [])[1]?.toLowerCase() || 'other';
    if (!summary) return null;
    return { summary, style, language, category };
  } catch (err) {
    console.error('buildContactProfile error:', err.message);
    return null;
  }
}

async function buildUserProfile(outgoingMessages, existingProfile) {
  const client = getClient();
  const existing = existingProfile ? `\n\nExisting style profile:\n${existingProfile}` : '';
  const sample = outgoingMessages.map(m => `To ${m.contact_name}: ${m.body}`).join('\n');
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `You are building a profile of a WhatsApp user's communication style.
You will be given their existing style profile (if any) and a sample of messages they have sent.

Enrich the profile — add new patterns, confirm existing ones.
Note code-switching between Hebrew and English, emoji habits, typical reply lengths,
tone variation across different types of contacts, recurring phrases.
Never delete prior observations — only add and refine.

Respond with a single prose profile (2-4 paragraphs). Be specific and concrete.`,
      messages: [{ role: 'user', content: `Sent messages:${existing}\n\n${sample}` }],
    });
    return response.content[0].text.trim() || null;
  } catch (err) {
    console.error('buildUserProfile error:', err.message);
    return null;
  }
}
```

Update `module.exports` at the bottom of `src/llm.js`:

```javascript
module.exports = { extractTasks, extractTasksBatch, buildContactProfile, buildUserProfile };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest tests/llm.test.js --no-coverage 2>&1 | tail -10
```
Expected: PASS — 6 new tests + all prior llm tests pass

- [ ] **Step 5: Commit**

```bash
git add src/llm.js tests/llm.test.js
git commit -m "feat: add buildContactProfile and buildUserProfile to llm.js"
```

---

## Task 2: DB Helpers

**Files:**
- Modify: `src/db.js`
- Modify: `tests/db.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/db.test.js`:

```javascript
describe('contact profile helpers', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Test Fan');
  });

  afterEach(() => db.close());

  test('updateContactProfile / getContactProfile round-trip', () => {
    db.updateContactProfile(contactId, 'Big fan', 'Casual', 'he', 'fan');
    const p = db.getContactProfile(contactId);
    expect(p.summary).toBe('Big fan');
    expect(p.style).toBe('Casual');
    expect(p.language).toBe('he');
    expect(p.category).toBe('fan');
  });

  test('getContactProfile returns null for contact with no profile', () => {
    const p = db.getContactProfile(contactId);
    expect(p.summary).toBeNull();
    expect(p.style).toBeNull();
  });

  test('patchContactProfile updates only specified fields', () => {
    db.updateContactProfile(contactId, 'Original summary', 'Original style', 'en', 'other');
    db.patchContactProfile(contactId, { relationship_summary: 'Updated summary' });
    const p = db.getContactProfile(contactId);
    expect(p.summary).toBe('Updated summary');
    expect(p.style).toBe('Original style');
  });

  test('getContactMessages returns messages in chronological order', () => {
    db.insertMessage(contactId, 'in', 'First', 1000, 'wa-1');
    db.insertMessage(contactId, 'out', 'Second', 2000, 'wa-2');
    db.insertMessage(contactId, 'in', 'Third', 3000, 'wa-3');
    const msgs = db.getContactMessages(contactId);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].body).toBe('First');
    expect(msgs[1].direction).toBe('out');
    expect(msgs[2].body).toBe('Third');
  });

  test('getContactsToSeed returns only contacts with at least one message', () => {
    db.upsertContact('+972509999999', 'No Messages');
    db.insertMessage(contactId, 'in', 'hi', 1000, 'wa-1');
    const contacts = db.getContactsToSeed(0, 99);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe(contactId);
  });

  test('getContactsToSeed respects afterId filter', () => {
    const id2 = db.upsertContact('+972502222222', 'Second');
    db.insertMessage(contactId, 'in', 'hi', 1000, 'wa-1');
    db.insertMessage(id2, 'in', 'hi', 1001, 'wa-2');
    const contacts = db.getContactsToSeed(contactId, 99);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe(id2);
  });

  test('getContactDetail returns full row with recent messages', () => {
    db.updateContactProfile(contactId, 'Big fan', 'Casual', 'he', 'fan');
    db.insertMessage(contactId, 'in', 'Hello', 1000, 'wa-1');
    const detail = db.getContactDetail(contactId);
    expect(detail.name).toBe('Test Fan');
    expect(detail.relationship_summary).toBe('Big fan');
    expect(detail.recent_messages).toHaveLength(1);
    expect(detail.recent_messages[0].body).toBe('Hello');
  });

  test('getContactInboundCount counts only inbound', () => {
    db.insertMessage(contactId, 'in', 'hi', 1000, 'wa-1');
    db.insertMessage(contactId, 'in', 'bye', 2000, 'wa-2');
    db.insertMessage(contactId, 'out', 'ok', 3000, 'wa-3');
    expect(db.getContactInboundCount(contactId)).toBe(2);
  });
});

describe('user profile and outbound helpers', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Alice');
  });

  afterEach(() => db.close());

  test('updateProfile / getProfile round-trip', () => {
    db.updateProfile('Writes concisely in Hebrew.');
    const p = db.getProfile();
    expect(p.global_style).toBe('Writes concisely in Hebrew.');
    expect(p.updated_at).toBeGreaterThan(0);
  });

  test('getOutgoingMessagesSample returns only outbound messages with contact name', () => {
    db.insertMessage(contactId, 'in', 'inbound msg', 1000, 'wa-1');
    db.insertMessage(contactId, 'out', 'outbound msg', 2000, 'wa-2');
    const msgs = db.getOutgoingMessagesSample(10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('outbound msg');
    expect(msgs[0].contact_name).toBe('Alice');
  });

  test('getOutboundCount counts all outbound messages', () => {
    const id2 = db.upsertContact('+972502222222', 'Bob');
    db.insertMessage(contactId, 'out', 'a', 1000, 'wa-1');
    db.insertMessage(id2, 'out', 'b', 2000, 'wa-2');
    db.insertMessage(contactId, 'in', 'c', 3000, 'wa-3');
    expect(db.getOutboundCount()).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest tests/db.test.js --no-coverage 2>&1 | tail -20
```
Expected: FAIL — multiple functions not found

- [ ] **Step 3: Implement DB helpers**

In `src/db.js`, add after the `searchContacts` function and before `module.exports`:

```javascript
// ── Contact profile helpers ───────────────────────────────────────────────

function getContactProfile(contactId) {
  return getDb().prepare(
    'SELECT relationship_summary AS summary, style_to_contact AS style, language, category FROM contacts WHERE id = ?'
  ).get(contactId) || null;
}

function updateContactProfile(contactId, summary, style, language, category) {
  getDb().prepare(
    'UPDATE contacts SET relationship_summary = ?, style_to_contact = ?, language = ?, category = ? WHERE id = ?'
  ).run(summary, style, language, category, contactId);
}

function patchContactProfile(contactId, updates) {
  const allowed = ['relationship_summary', 'style_to_contact', 'language', 'category'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) return;
  const sql = `UPDATE contacts SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
  getDb().prepare(sql).run(...fields.map(f => updates[f]), contactId);
}

function getContactMessages(contactId) {
  return getDb().prepare(
    'SELECT direction, body, timestamp FROM messages WHERE contact_id = ? ORDER BY timestamp ASC'
  ).all(contactId);
}

function getContactsToSeed(afterId, limit) {
  return getDb().prepare(`
    SELECT DISTINCT c.id, c.name, c.phone
    FROM contacts c
    INNER JOIN messages m ON m.contact_id = c.id
    WHERE c.id > ?
    ORDER BY c.id ASC
    LIMIT ?
  `).all(afterId, limit);
}

function getContactDetail(contactId) {
  const contact = getDb().prepare(
    'SELECT id, name, phone, category, language, relationship_summary, style_to_contact FROM contacts WHERE id = ?'
  ).get(contactId);
  if (!contact) return null;
  contact.recent_messages = getDb().prepare(
    'SELECT direction, body, timestamp FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 5'
  ).all(contactId);
  return contact;
}

function getContactInboundCount(contactId) {
  return getDb().prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'in'"
  ).get(contactId).n;
}

// ── User profile helpers ──────────────────────────────────────────────────

function getProfile() {
  return getDb().prepare('SELECT * FROM user_profile WHERE id = 1').get();
}

function updateProfile(globalStyle) {
  getDb().prepare(
    'UPDATE user_profile SET global_style = ?, updated_at = unixepoch() WHERE id = 1'
  ).run(globalStyle);
}

function getOutgoingMessagesSample(limit) {
  return getDb().prepare(`
    SELECT m.body, c.name AS contact_name, m.timestamp
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    WHERE m.direction = 'out'
    ORDER BY m.id DESC
    LIMIT ?
  `).all(limit);
}

function getOutboundCount() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'").get().n;
}
```

Also update `getAllContacts` (contacts tab needs `language` and `category`):

```javascript
function getAllContacts() {
  return getDb().prepare(
    'SELECT id, name, phone, language, category FROM contacts ORDER BY name ASC'
  ).all();
}
```

And `searchContacts`:

```javascript
function searchContacts(query) {
  const like = `%${query}%`;
  return getDb().prepare(
    'SELECT id, name, phone, language, category FROM contacts WHERE name LIKE ? OR phone LIKE ? ORDER BY name ASC LIMIT 20'
  ).all(like, like);
}
```

Update `module.exports` at the bottom of `src/db.js`:

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
};
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest tests/db.test.js --no-coverage 2>&1 | tail -10
```
Expected: PASS — 9 new tests + all prior db tests pass

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/db.js tests/db.test.js
git commit -m "feat: add contact profile and user profile DB helpers"
```

---

## Task 3: contact-intel.js

**Files:**
- Create: `src/contact-intel.js`
- Create: `tests/contact-intel.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/contact-intel.test.js`:

```javascript
jest.mock('../src/llm');
const llm = require('../src/llm');
const db = require('../src/db');

// Re-require after mocks to get fresh module state
let contactIntel;

beforeEach(() => {
  db.init(':memory:');
  jest.resetModules();
  jest.mock('../src/llm');
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
    db.insertMessage(id1, 'in', 'hi', 1000, 'wa-1');
    db.insertMessage(id2, 'in', 'hi', 1001, 'wa-2');

    // Simulate: id1 was already seeded in a prior errored run
    db.setSetting('intel_last_seeded_contact_id', String(id1));
    db.setSetting('intel_processed', '1');
    db.setSetting('intel_status', 'error');

    await contactIntel.seedAll();

    // Should only process id2
    expect(llmFresh.buildContactProfile).toHaveBeenCalledTimes(1);
    const [calledMessages] = llmFresh.buildContactProfile.mock.calls[0];
    expect(calledMessages[0].body).toBe('hi'); // id2's message
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest tests/contact-intel.test.js --no-coverage 2>&1 | tail -15
```
Expected: FAIL — `Cannot find module '../src/contact-intel'`

- [ ] **Step 3: Implement contact-intel.js**

Create `src/contact-intel.js`:

```javascript
const db = require('./db');
const llm = require('./llm');

let isRunning = false;

async function refreshContact(contactId) {
  const messages = db.getContactMessages(contactId);
  if (!messages.length) return;
  const existing = db.getContactProfile(contactId);
  const existingArg = existing && existing.summary ? existing : null;
  const profile = await llm.buildContactProfile(messages, existingArg);
  if (!profile) return;
  db.updateContactProfile(contactId, profile.summary, profile.style, profile.language, profile.category);
}

async function refreshUserProfile() {
  const messages = db.getOutgoingMessagesSample(50);
  if (!messages.length) return;
  const profile = db.getProfile();
  const globalStyle = await llm.buildUserProfile(messages, profile ? profile.global_style : null);
  if (!globalStyle) return;
  db.updateProfile(globalStyle);
}

async function seedAll() {
  if (isRunning) return;
  isRunning = true;
  const prevStatus = db.getSetting('intel_status');
  if (prevStatus !== 'error') {
    db.setSetting('intel_last_seeded_contact_id', '0');
    db.setSetting('intel_processed', '0');
  }
  db.setSetting('intel_status', 'running');
  try {
    const contacts = db.getContactsToSeed(0, 9999);
    db.setSetting('intel_total', String(contacts.length));
    let lastId = parseInt(db.getSetting('intel_last_seeded_contact_id') || '0', 10);
    let processed = parseInt(db.getSetting('intel_processed') || '0', 10);
    for (const contact of contacts) {
      if (contact.id <= lastId) { processed++; continue; }
      await refreshContact(contact.id);
      lastId = contact.id;
      processed++;
      db.setSetting('intel_last_seeded_contact_id', String(lastId));
      db.setSetting('intel_processed', String(processed));
    }
    await refreshUserProfile();
    db.setSetting('intel_status', 'done');
  } catch (err) {
    console.error('seedAll error:', err.message);
    db.setSetting('intel_status', 'error');
  } finally {
    isRunning = false;
  }
}

module.exports = { seedAll, refreshContact, refreshUserProfile };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest tests/contact-intel.test.js --no-coverage 2>&1 | tail -10
```
Expected: PASS — 7 tests

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: all 103 tests pass (96 + 7)

- [ ] **Step 6: Commit**

```bash
git add src/contact-intel.js tests/contact-intel.test.js
git commit -m "feat: add contact-intel.js with seedAll, refreshContact, refreshUserProfile"
```

---

## Task 4: Server Routes

**Files:**
- Modify: `src/server.js`
- Modify: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

At the top of `tests/server.test.js`, add the contact-intel mock. Place it with the other `jest.mock` calls (before requiring `createApp`):

```javascript
jest.mock('../src/contact-intel', () => ({
  seedAll: jest.fn().mockResolvedValue(undefined),
  refreshContact: jest.fn().mockResolvedValue(undefined),
  refreshUserProfile: jest.fn().mockResolvedValue(undefined),
}));
```

Then append these test suites to `tests/server.test.js`:

```javascript
describe('contact detail routes', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
    contactId = db.upsertContact('+972501234567', 'Alice');
  });

  afterEach(() => db.close());

  test('GET /api/contacts/:id returns contact detail with profile', async () => {
    db.updateContactProfile(contactId, 'Big fan', 'Casual', 'he', 'fan');
    db.insertMessage(contactId, 'in', 'Hi!', 1000, 'wa-1');
    const res = await request(app).get(`/api/contacts/${contactId}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice');
    expect(res.body.relationship_summary).toBe('Big fan');
    expect(res.body.recent_messages).toHaveLength(1);
  });

  test('GET /api/contacts/:id returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/contacts/9999');
    expect(res.status).toBe(404);
  });

  test('PATCH /api/contacts/:id updates profile fields', async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactId}`)
      .send({ relationship_summary: 'Updated', category: 'colleague' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const profile = db.getContactProfile(contactId);
    expect(profile.summary).toBe('Updated');
    expect(profile.category).toBe('colleague');
  });

  test('PATCH /api/contacts/:id ignores unknown fields', async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactId}`)
      .send({ relationship_summary: 'Safe', evil_field: 'dropped' });
    expect(res.status).toBe(200);
    expect(db.getContactProfile(contactId).summary).toBe('Safe');
  });

  test('POST /api/contacts/:id/refresh returns 200', async () => {
    const res = await request(app).post(`/api/contacts/${contactId}/refresh`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('user profile routes', () => {
  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
  });

  afterEach(() => db.close());

  test('GET /api/profile returns global_style', async () => {
    db.updateProfile('Writes concisely.');
    const res = await request(app).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.global_style).toBe('Writes concisely.');
  });

  test('PATCH /api/profile updates global_style', async () => {
    const res = await request(app)
      .patch('/api/profile')
      .send({ global_style: 'New style' });
    expect(res.status).toBe(200);
    expect(db.getProfile().global_style).toBe('New style');
  });

  test('POST /api/profile/refresh returns 200', async () => {
    const res = await request(app).post('/api/profile/refresh');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('intel routes', () => {
  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
  });

  test('POST /api/intel/seed returns 200 and triggers seedAll', async () => {
    const contactIntel = require('../src/contact-intel');
    const res = await request(app).post('/api/intel/seed');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(contactIntel.seedAll).toHaveBeenCalledTimes(1);
  });

  test('POST /api/intel/seed returns 409 when already running', async () => {
    db.setSetting('intel_status', 'running');
    const res = await request(app).post('/api/intel/seed');
    expect(res.status).toBe(409);
  });

  test('GET /api/intel/status returns correct shape', async () => {
    db.setSetting('intel_status', 'done');
    db.setSetting('intel_processed', '5');
    db.setSetting('intel_total', '10');
    const res = await request(app).get('/api/intel/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', processed: 5, total: 10 });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest tests/server.test.js --no-coverage 2>&1 | tail -20
```
Expected: FAIL — routes not found (404s)

- [ ] **Step 3: Implement the routes**

In `src/server.js`, add `const contactIntel = require('./contact-intel');` at the top with the other requires:

```javascript
const contactIntel = require('./contact-intel');
```

Then add these routes in `createApp()`, after the `GET /api/contacts` route:

```javascript
  // ── Contact detail ────────────────────────────────────────────────────
  app.get('/api/contacts/:id', (req, res) => {
    const contact = db.getContactDetail(Number(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(contact);
  });

  app.patch('/api/contacts/:id', (req, res) => {
    const allowed = ['relationship_summary', 'style_to_contact', 'language', 'category'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    db.patchContactProfile(Number(req.params.id), updates);
    res.json({ ok: true });
  });

  app.post('/api/contacts/:id/refresh', (req, res) => {
    contactIntel.refreshContact(Number(req.params.id))
      .catch(err => console.error('Contact refresh error:', err.message));
    res.json({ ok: true });
  });

  // ── User profile ──────────────────────────────────────────────────────
  app.get('/api/profile', (req, res) => {
    res.json(db.getProfile());
  });

  app.patch('/api/profile', (req, res) => {
    const { global_style } = req.body;
    if (global_style !== undefined) db.updateProfile(global_style);
    res.json({ ok: true });
  });

  app.post('/api/profile/refresh', (req, res) => {
    contactIntel.refreshUserProfile()
      .catch(err => console.error('Profile refresh error:', err.message));
    res.json({ ok: true });
  });

  // ── Contact intelligence seed ─────────────────────────────────────────
  app.post('/api/intel/seed', (req, res) => {
    const status = db.getSetting('intel_status');
    if (status === 'running') return res.status(409).json({ error: 'Intel seed already running' });
    contactIntel.seedAll().catch(err => console.error('Intel seed failed:', err.message));
    res.json({ ok: true });
  });

  app.get('/api/intel/status', (req, res) => {
    res.json({
      status: db.getSetting('intel_status') || 'idle',
      processed: parseInt(db.getSetting('intel_processed') || '0', 10),
      total: parseInt(db.getSetting('intel_total') || '0', 10),
    });
  });
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest tests/server.test.js --no-coverage 2>&1 | tail -10
```
Expected: PASS — 10 new tests + all prior server tests pass

- [ ] **Step 5: Run full suite**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: all 113 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/server.js tests/server.test.js
git commit -m "feat: add contact detail, profile, and intel seed routes"
```

---

## Task 5: Bridge.js Wiring

**Files:**
- Modify: `src/bridge.js`

No new tests — the fire-and-forget triggers are covered by the contact-intel unit tests. Bridge already has no test file.

- [ ] **Step 1: Add the require**

In `src/bridge.js`, add after the existing requires at the top:

```javascript
const contactIntel = require('./contact-intel');
```

- [ ] **Step 2: Add triggers in the message handler**

In `src/bridge.js`, find the inbound message handler block:

```javascript
      if (msgId) {
        // Fire task extraction async — non-blocking, failure is logged only
        llm.extractTasks(msg.body)
          .then((tasks) => tasks.forEach((body) => db.createTask(contactId, msgId, body)))
          .catch((err) => console.error('Task extraction error:', err.message));
      }
```

Replace with:

```javascript
      if (msgId) {
        llm.extractTasks(msg.body)
          .then((tasks) => tasks.forEach((body) => db.createTask(contactId, msgId, body)))
          .catch((err) => console.error('Task extraction error:', err.message));
      }

      // Refresh contact profile every 5th inbound message from this contact
      const inboundCount = db.getContactInboundCount(contactId);
      if (inboundCount > 0 && inboundCount % 5 === 0) {
        contactIntel.refreshContact(contactId)
          .catch(err => console.error('Contact refresh error:', err.message));
      }

      // Refresh user writing style profile every 20th outbound message overall
      const outboundCount = db.getOutboundCount();
      if (outboundCount > 0 && outboundCount % 20 === 0) {
        contactIntel.refreshUserProfile()
          .catch(err => console.error('User profile refresh error:', err.message));
      }
```

- [ ] **Step 3: Run full suite to confirm no regressions**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: all 113 tests still pass

- [ ] **Step 4: Commit**

```bash
git add src/bridge.js
git commit -m "feat: wire contact intel refresh triggers in bridge.js"
```

---

## Task 6: Contacts Tab UI

**Files:**
- Modify: `public/index.html`

No automated tests — visual feature. Verify manually by opening http://localhost:3000.

- [ ] **Step 1: Add CSS for the two-column contacts layout**

In `public/index.html`, find the closing `</style>` tag (line ~185). Insert before it:

```css
    /* Contacts tab */
    .contacts-layout {
      display: flex;
      gap: 0;
      height: calc(100vh - 160px);
      min-height: 400px;
    }
    .contacts-sidebar {
      width: 240px;
      flex-shrink: 0;
      border-right: 1px solid #21262d;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .contacts-sidebar input {
      margin: 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      padding: 6px 10px;
      font-size: 0.85em;
      font-family: inherit;
      width: calc(100% - 24px);
    }
    .contacts-sidebar input:focus { outline: none; border-color: #58a6ff; }
    #contact-list { flex: 1; overflow-y: auto; }
    .contact-list-item {
      padding: 10px 14px;
      cursor: pointer;
      border-bottom: 1px solid #21262d;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .contact-list-item:hover { background: #161b22; }
    .contact-list-item.active { background: #1c2128; }
    .contact-list-item .cli-name { font-size: 0.85em; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lang-badge {
      font-size: 0.65em;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 4px;
      background: #21262d;
      color: #8b949e;
      flex-shrink: 0;
    }
    .contacts-panel {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px;
    }
    .contacts-panel .panel-placeholder { color: #8b949e; font-size: 0.9em; }
    .panel-header { margin-bottom: 20px; }
    .panel-header .panel-name { font-size: 1.05em; font-weight: 700; }
    .panel-header .panel-phone { font-size: 0.8em; color: #8b949e; margin-top: 2px; }
    .panel-field { margin-bottom: 16px; }
    .panel-field label { display: block; font-size: 0.78em; color: #8b949e; margin-bottom: 4px; }
    .panel-field textarea, .panel-field input, .panel-field select {
      width: 100%;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      padding: 7px 10px;
      font-size: 0.875em;
      font-family: inherit;
    }
    .panel-field textarea { resize: vertical; }
    .panel-field textarea:focus, .panel-field input:focus, .panel-field select:focus { outline: none; border-color: #58a6ff; }
    .save-btn {
      background: none;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 4px;
      padding: 4px 12px;
      font-size: 0.78em;
      cursor: pointer;
      font-family: inherit;
      margin-top: 4px;
    }
    .save-btn:hover { border-color: #58a6ff; color: #58a6ff; }
    .refresh-profile-btn {
      background: none;
      border: 1px solid #388bfd;
      color: #58a6ff;
      border-radius: 4px;
      padding: 5px 14px;
      font-size: 0.82em;
      cursor: pointer;
      font-family: inherit;
      margin-bottom: 16px;
    }
    .refresh-profile-btn:hover { background: #1c2a3a; }
    .panel-messages { margin-top: 20px; }
    .panel-messages h4 { font-size: 0.78em; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    .panel-msg {
      font-size: 0.82em;
      color: #8b949e;
      padding: 6px 8px;
      border-left: 2px solid #21262d;
      margin-bottom: 6px;
    }
    .panel-msg.out { border-left-color: #388bfd; color: #c9d1d9; }
    .panel-divider { border: none; border-top: 1px solid #21262d; margin: 20px 0; }
```

- [ ] **Step 2: Replace the Contacts tab HTML**

Find the current Contacts tab in `public/index.html`:

```html
  <!-- Contacts tab -->
  <div id="tab-contacts" class="tab">
    <div class="card">
      <h3>Shared Contacts</h3>
      <div class="msg-list" id="shared-contacts-list">
        <p class="empty-state">No contacts have been shared yet.</p>
      </div>
    </div>
    <p class="placeholder-tab" style="margin-top:12px">
      Full contact intelligence (clusters, relationship summaries) coming in Phase 4.
    </p>
  </div>
```

Replace with:

```html
  <!-- Contacts tab -->
  <div id="tab-contacts" class="tab">
    <div class="contacts-layout">
      <div class="contacts-sidebar">
        <input type="text" id="contacts-search" placeholder="Search contacts…" autocomplete="off" oninput="refreshContactList(this.value)">
        <div id="contact-list">
          <p class="empty-state" style="padding:12px 14px">No contacts.</p>
        </div>
      </div>
      <div class="contacts-panel" id="contacts-panel">
        <p class="panel-placeholder">Select a contact to view their profile.</p>
      </div>
    </div>
    <hr class="panel-divider">
    <div class="card" style="margin-top:0">
      <h3>Shared Contacts</h3>
      <div class="msg-list" id="shared-contacts-list">
        <p class="empty-state">No contacts have been shared yet.</p>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add Contacts tab JavaScript**

In `public/index.html`, find the `// ── Shared contacts` JS section and insert before it:

```javascript
    // ── Contacts tab ─────────────────────────────────────────────────────
    let contactListTimer = null;

    async function refreshContactList(query) {
      clearTimeout(contactListTimer);
      contactListTimer = setTimeout(async () => {
        const list = document.getElementById('contact-list');
        try {
          const url = query ? `/api/contacts?q=${encodeURIComponent(query)}` : '/api/contacts';
          const contacts = await fetch(url).then(r => r.json());
          if (!contacts.length) {
            list.innerHTML = '<p class="empty-state" style="padding:12px 14px">No contacts.</p>';
            return;
          }
          const langLabel = { en: 'EN', he: 'HE', mixed: 'MIX' };
          list.innerHTML = contacts.map(c => `
            <div class="contact-list-item" data-contact-id="${escHtml(String(c.id))}" onclick="openContactPanel(${c.id})">
              <span class="cli-name">${escHtml(c.name || c.phone)}</span>
              ${c.language ? `<span class="lang-badge">${escHtml(langLabel[c.language] || c.language.toUpperCase())}</span>` : ''}
            </div>`).join('');
        } catch {
          list.innerHTML = '<p class="empty-state" style="padding:12px 14px">Error loading.</p>';
        }
      }, 150);
    }

    async function openContactPanel(id) {
      // Mark active
      document.querySelectorAll('.contact-list-item').forEach(el => {
        el.classList.toggle('active', el.dataset.contactId === String(id));
      });

      const panel = document.getElementById('contacts-panel');
      panel.innerHTML = '<p style="color:#8b949e;font-size:0.85em">Loading…</p>';

      let c;
      try {
        c = await fetch(`/api/contacts/${id}`).then(r => r.json());
      } catch {
        panel.innerHTML = '<p style="color:#f85149;font-size:0.85em">Failed to load contact.</p>';
        return;
      }

      const langOptions = ['en', 'he', 'mixed'].map(l =>
        `<option value="${l}"${c.language === l ? ' selected' : ''}>${l}</option>`
      ).join('');

      const msgHtml = (c.recent_messages || []).map(m =>
        `<div class="panel-msg ${m.direction === 'out' ? 'out' : ''}" dir="auto">${escHtml(m.body)}</div>`
      ).join('');

      panel.innerHTML = `
        <div class="panel-header">
          <div class="panel-name">${escHtml(c.name || c.phone)}</div>
          <div class="panel-phone">${escHtml(c.phone || '')}</div>
        </div>
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
      `;
    }

    async function saveContactField(id, field, value) {
      try {
        await fetch(`/api/contacts/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
      } catch (e) {
        console.warn('Save failed:', e.message);
      }
    }

    async function triggerContactRefresh(id) {
      try {
        await fetch(`/api/contacts/${id}/refresh`, { method: 'POST' });
        setTimeout(() => openContactPanel(id), 3000);
      } catch (e) {
        console.warn('Refresh failed:', e.message);
      }
    }

```

- [ ] **Step 4: Update `showTab` to load contacts**

Find the `showTab` function in `public/index.html`:

```javascript
      if (name === 'contacts') refreshSharedContacts();
```

Replace with:

```javascript
      if (name === 'contacts') { refreshContactList(''); refreshSharedContacts(); }
```

- [ ] **Step 5: Start the server and verify the Contacts tab**

```bash
node src/index.js
```

Open http://localhost:3000, go to the Contacts tab. Verify:
- Left sidebar shows a searchable list of contacts (with language badges if set)
- Clicking a contact opens the right panel with name, phone, editable fields
- Search box filters the list as you type
- "Refresh profile" button shows (clicking triggers the API call)
- Shared Contacts section still appears below

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: rebuild Contacts tab with searchable list and editable profile panel"
```

---

## Task 7: Settings Intel Card

**Files:**
- Modify: `public/index.html`

No automated tests — visual feature. Verify manually.

- [ ] **Step 1: Add the Contact Intelligence card to Settings tab**

In `public/index.html`, find the closing `</div>` of the Settings tab:

```html
  </div>

  <script>
```

The Settings tab closes just before `<script>`. Find the Import Chat Export card's closing `</div>` which is followed by `</div>` (Settings tab) and then `</div>` is for the settings section. The actual end of the Settings tab section is:

```html
    </div>

  </div>

  <script>
```

Insert the new card before the Settings tab closing `</div>`:

```html
    <div class="card">
      <h3>Contact Intelligence</h3>
      <p style="font-size:0.85em;color:#8b949e;margin-bottom:14px">
        Build relationship and writing-style profiles for all contacts from their message history.
      </p>
      <button type="button" class="primary" id="intel-btn" onclick="triggerIntelSeed()">Generate profiles</button>
      <div id="intel-status-text" style="margin-top:10px;font-size:0.85em;color:#8b949e"></div>
      <div id="intel-progress-wrap" style="display:none;margin-top:8px">
        <div style="background:#21262d;border-radius:4px;height:6px">
          <div id="intel-bar" style="background:#3fb950;border-radius:4px;height:6px;width:0%;transition:width 0.3s"></div>
        </div>
        <div id="intel-counts" style="margin-top:4px;font-size:0.8em;color:#8b949e"></div>
      </div>
    </div>
```

- [ ] **Step 2: Add the intel JS functions**

In `public/index.html`, in the `<script>` block, find the `// ── Backfill` section and add these functions after the backfill block (after `updateBackfillUI`):

```javascript
    // ── Contact intelligence ─────────────────────────────────────────────
    let intelPoller = null;

    async function pollIntelStatus() {
      try {
        const data = await fetch('/api/intel/status').then(r => r.json());
        updateIntelUI(data);
        if (data.status === 'running') startIntelPolling();
      } catch {}
    }

    async function triggerIntelSeed() {
      const btn = document.getElementById('intel-btn');
      btn.disabled = true;
      try {
        const res = await fetch('/api/intel/seed', { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          document.getElementById('intel-status-text').textContent = data.error || 'Error';
          btn.disabled = false;
          return;
        }
        startIntelPolling();
      } catch {
        btn.disabled = false;
      }
    }

    function startIntelPolling() {
      if (intelPoller) clearInterval(intelPoller);
      intelPoller = setInterval(async () => {
        try {
          const data = await fetch('/api/intel/status').then(r => r.json());
          updateIntelUI(data);
          if (data.status !== 'running') {
            clearInterval(intelPoller);
            intelPoller = null;
            document.getElementById('intel-btn').disabled = false;
          }
        } catch {}
      }, 2000);
    }

    function updateIntelUI(data) {
      const labels = { idle: '', running: 'Building profiles…', done: 'Done!', error: 'Error — check server logs.' };
      document.getElementById('intel-status-text').textContent = labels[data.status] || data.status;
      const wrap = document.getElementById('intel-progress-wrap');
      if (data.status === 'running' || data.status === 'done') {
        wrap.style.display = 'block';
        const pct = data.total > 0 ? Math.round(data.processed / data.total * 100) : 0;
        document.getElementById('intel-bar').style.width = pct + '%';
        document.getElementById('intel-counts').textContent = `${data.processed} / ${data.total} contacts`;
      }
    }

```

- [ ] **Step 3: Update `showTab` to poll intel status**

Find in the `showTab` function:

```javascript
      if (name === 'settings') pollBackfillStatus();
```

Replace with:

```javascript
      if (name === 'settings') { pollBackfillStatus(); pollIntelStatus(); }
```

- [ ] **Step 4: Verify in the browser**

Open http://localhost:3000, go to Settings tab. Verify:
- "Contact Intelligence" card appears below Import
- "Generate profiles" button is clickable
- Clicking it calls `POST /api/intel/seed` and starts polling
- Progress bar fills as contacts are processed
- Status changes to "Done!" on completion

- [ ] **Step 5: Run full test suite one last time**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: all 113 tests pass (Tasks 6 & 7 are UI-only, no new tests)

- [ ] **Step 6: Final commit**

```bash
git add public/index.html
git commit -m "feat: add Contact Intelligence card to Settings tab"
```

---

## Done

Phase 4 is complete. All 7 tasks implemented, 113 tests passing (32 new tests across llm, db, contact-intel, server). Phase 5 (Smart Reply Suggestions) is the next phase.
