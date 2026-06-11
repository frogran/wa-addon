# WhatsApp Add-on — Phase 5: Smart Reply Suggestions

**Date:** 2026-06-11
**Status:** Approved, ready for implementation

---

## Overview

Phase 5 adds an Inbox triage view to the dashboard. For each unanswered WhatsApp message, Claude generates three reply suggestions using the contact's relationship profile, the user's writing-style profile, and per-contact reply settings. The user edits a suggestion (or writes their own), then sends directly from the dashboard via the existing WhatsApp bridge.

---

## Scope

**In:**
- Inbox tab: two-panel triage view (message queue + detail panel)
- Batch suggestion generation triggered when Inbox tab opens
- Per-contact reply settings (context window, length, tone, language, emoji, greeting)
- Per-contact inbox mute (opt-out from suggestions permanently until re-enabled)
- Send reply from dashboard via WhatsApp bridge
- Navigation: Inbox ↔ Contacts tab cross-links
- Dismiss a message (resets on next inbound from that contact)

**Out (deferred):**
- Push/desktop notifications for new inbound messages
- Suggestion quality feedback / thumbs up-down loop
- Scheduled reply (defer to Phase 6 / scheduler integration)

---

## Architecture

### New file

**`src/reply-engine.js`** — coordinator for suggestion generation. Mirrors `src/contact-intel.js` in structure. Keeps `llm.js` as a pure SDK wrapper and `server.js` thin.

Exports: `{ generateForMessage, generateBatch }`

### Modified files

| File | Change |
|---|---|
| `src/llm.js` | Add `buildReplySuggestions(messages, contactProfile, userProfile, settings)` |
| `src/db.js` | Add inbox query helpers, suggestion helpers, reply settings helpers |
| `src/server.js` | Add inbox API routes |
| `public/index.html` | Implement Inbox tab UI; add reply settings section to Contacts panel; add navigation links |

### No new dependencies

All required packages (`@anthropic-ai/sdk`, `better-sqlite3`, `express`) already installed.

---

## Data Model

### `contacts` — new columns (added via `ALTER TABLE` in `db.init`)

| Column | Type | Default | Notes |
|---|---|---|---|
| `inbox_muted` | INTEGER | `0` | 1 = never show in Inbox |
| `reply_context_messages` | INTEGER | `20` | How many messages to pass to LLM |
| `reply_length` | TEXT | `'auto'` | `auto` / `short` / `medium` / `long` |
| `reply_tone` | TEXT | `'auto'` | `auto` / `casual` / `professional` / `warm` / `direct` |
| `reply_language` | TEXT | `'auto'` | `auto` / `en` / `he` |
| `reply_emoji` | TEXT | `'auto'` | `none` / `auto` / `frequent` |
| `reply_greeting` | INTEGER | `1` | 1 = include greeting, 0 = skip |

### `reply_suggestions` — already in schema

```sql
CREATE TABLE IF NOT EXISTS reply_suggestions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES messages(id),
  contact_id   INTEGER NOT NULL REFERENCES contacts(id),
  suggestion_1 TEXT,
  suggestion_2 TEXT,
  suggestion_3 TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending','ready','used','dismissed','failed')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
```

**Status lifecycle:** `pending` → `ready` (suggestions stored) → `used` (reply sent) or `dismissed` (skipped by user). `failed` = LLM error.

### What "unanswered" means

A contact appears in the Inbox when:
1. Their most recent message has `direction = 'in'`
2. `inbox_muted = 0`
3. That message has no `reply_suggestions` row with `status IN ('used', 'dismissed')`

---

## LLM Function (`src/llm.js`)

### `buildReplySuggestions(messages, contactProfile, userProfile, settings)`

**Input:**
- `messages` — array of `{ direction, body, timestamp, contact_name }`, last N messages in chronological order (N = `reply_context_messages`)
- `contactProfile` — `{ summary, style, language, category }` from `contacts` table (may be null if not yet generated)
- `userProfile` — `global_style` string from `user_profile` (may be null)
- `settings` — `{ length, tone, language, emoji, greeting }` per-contact overrides

**System prompt:**

```
You are drafting WhatsApp reply suggestions on behalf of the user.

You will be given:
- The recent message history with this contact
- A profile of the contact and the relationship (if available)
- A profile of the user's writing style (if available)
- Per-contact settings that override defaults

Write exactly 3 reply options. Each should be meaningfully different — not just paraphrases.
Vary the angle: one might confirm/agree, one might ask a follow-up, one might be warmer or more direct.

Match the user's established style with this contact unless overridden by settings:
- Language: {language instruction}
- Length: {length instruction}
- Tone: {tone instruction}
- Emoji: {emoji instruction}
- Greeting: {greeting instruction}

Never remove or override instructions from the user's style profile — settings only add constraints.

Respond in this exact format:
SUGGESTION_1:
<text>

SUGGESTION_2:
<text>

SUGGESTION_3:
<text>
```

**Length instructions by setting:**
- `auto` — "Choose an appropriate length based on the message. Match the contact's conversational pace."
- `short` — "Keep each reply to 1–2 sentences."
- `medium` — "Keep each reply to one paragraph."
- `long` — "Write a full, detailed paragraph response."

**Returns:** `[suggestion1, suggestion2, suggestion3]` (array of strings) or `null` on API error.

**Parsing:** Extract via regex on `SUGGESTION_1:`, `SUGGESTION_2:`, `SUGGESTION_3:` with `\n+` lookaheads (same pattern as `buildContactProfile`).

---

## `src/reply-engine.js`

```javascript
const db = require('./db');
const llm = require('./llm');

async function generateForMessage(contactId, messageId) {
  const contact = db.getContactDetail(contactId);
  if (!contact) return;
  const messages = db.getContactMessages(contactId).slice(-contact.reply_context_messages);
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
  // Only generate for messages with no suggestion row yet (or failed — allow retry)
  const messages = db.getInboxMessages().filter(
    m => m.suggestion_status === null || m.suggestion_status === 'failed'
  );
  const toGenerate = messages.slice(0, limit);
  for (const msg of toGenerate) {
    db.ensureSuggestionRow(msg.message_id, msg.contact_id); // insert 'pending' row
    generateForMessage(msg.contact_id, msg.message_id)
      .catch(err => console.error('generateForMessage error:', err.message));
  }
}

module.exports = { generateForMessage, generateBatch };
```

`generateBatch` is fire-and-forget per message — inserts `pending` row immediately (so client sees "Generating…"), then generates asynchronously.

---

## DB Helpers (`src/db.js`)

```javascript
// Inbox query
function getInboxMessages()
// For each non-muted contact, find their most recent inbound message.
// Include it if there is NO suggestion row for that message with status IN ('used','dismissed').
// i.e. show rows with no suggestion row yet, OR status IN ('pending','ready','failed').
// LEFT JOIN reply_suggestions on message_id; filter inbox_muted=0.
// Returns: [{ message_id, contact_id, contact_name, body, timestamp,
//             suggestion_status (null if no row), suggestion_1, suggestion_2, suggestion_3 }]
// Ordered by timestamp DESC

// Suggestion helpers
function ensureSuggestionRow(messageId, contactId)
// INSERT OR IGNORE INTO reply_suggestions (message_id, contact_id, status)
// VALUES (?, ?, 'pending')

function storeSuggestions(messageId, contactId, s1, s2, s3)
// INSERT OR REPLACE ... with status='ready'

function getSuggestions(messageId)
// → { suggestion_1, suggestion_2, suggestion_3, status } or null

function markSuggestionUsed(messageId)
// UPDATE reply_suggestions SET status='used' WHERE message_id=?

function markSuggestionDismissed(messageId)
// UPDATE reply_suggestions SET status='dismissed' WHERE message_id=?

function markSuggestionFailed(messageId)
// UPDATE reply_suggestions SET status='failed' WHERE message_id=?

// Reply settings helpers
function updateReplySettings(contactId, settings)
// UPDATE contacts SET inbox_muted=?, reply_context_messages=?, reply_length=?,
//   reply_tone=?, reply_language=?, reply_emoji=?, reply_greeting=?
// Only updates fields present in settings object (whitelist)

function setInboxMuted(contactId, muted)
// UPDATE contacts SET inbox_muted=? WHERE id=?

// Unanswered count for a contact (used in Contacts panel badge)
function getUnansweredCount(contactId)
// COUNT of messages where direction='in' and no used/dismissed suggestion
// for this contact — returns integer (0 or 1 in practice)
```

`getAllContacts()` and `getContactDetail()` already return all columns; new columns will be included automatically once added via `ALTER TABLE`.

---

## API Routes (`src/server.js`)

```
GET  /api/inbox
  → db.getInboxMessages() joined with reply_suggestions status
  → returns [{ message_id, contact_id, contact_name, body, timestamp,
               suggestion_status, suggestion_1, suggestion_2, suggestion_3 }]

POST /api/inbox/generate
  body: { limit: 20 }
  → replyEngine.generateBatch(limit) — fire-and-forget
  → 200 { ok: true }

POST /api/inbox/:messageId/dismiss
  → db.markSuggestionDismissed(messageId)
  → 200 { ok: true }

POST /api/inbox/:messageId/send
  body: { body: string }
  → bridge.sendMessage(contactPhone, body)
  → db.insertMessage(contactId, 'out', body, unixepoch(), null)
  → db.markSuggestionUsed(messageId)
  → 200 { ok: true }
```

All `:messageId` routes validate `Number.isInteger(id) && id > 0`.

`POST /api/inbox/:messageId/send` fetches the contact phone from `db.getContactDetail` to pass to `bridge.sendMessage`.

---

## Contacts Tab Changes (`public/index.html`)

### Reply settings section

Added below "How you write to them" in the contact side panel:

- **Inbox suggestions** toggle — calls `PATCH /api/contacts/:id` with `{ inbox_muted }` (added to whitelist)
- **Messages to consider** — number input (5–50), saves on blur
- **Reply length** — button group: Auto / Short / Medium / Long
- **Tone** — pill group: Auto / Casual / Professional / Warm / Direct
- **Language** — button group: Auto / English / עברית
- **Emoji use** — button group: None / Auto / Frequent
- **Include greeting** — toggle
- **Save reply settings** button — `PATCH /api/contacts/:id` with all reply settings fields

### Unanswered badge

In the contact panel header, when `getUnansweredCount > 0`:
```html
<div id="contact-inbox-badge" onclick="showTab('inbox'); openInboxContact(id)">
  ● 1 unanswered message → Go to Inbox
</div>
```
Badge hidden when count is 0.

---

## Inbox Tab UI (`public/index.html`)

### Layout: two-column (matches Contacts tab pattern)

**Left panel (240px):** scrollable list of unanswered contacts, sorted by recency. Each row: contact name, category badge, timestamp, suggestion status indicator (spinner if generating, green dot if ready).

**Right panel (flex):** opens when contact selected. Shows:
1. **Header:** clickable contact name (→ Contacts tab), category badge, "Mute inbox" button
2. **Recent chat** (last N messages, scrollable, `dir="auto"`)
3. **Suggestions** (3 clickable full-text blocks, hover highlight)
4. **Edit + send bar** (sticky bottom): textarea pre-filled on suggestion click, Send / Dismiss / Regenerate buttons

### JS functions

- `refreshInboxList()` — fetches `/api/inbox`, renders left panel
- `openInboxContact(contactId)` — renders right panel for selected contact; sets `activeInboxContactId` race guard
- `triggerInboxGenerate()` — POSTs `/api/inbox/generate`, starts polling
- `startInboxPolling()` — polls `/api/inbox` every 3s while any contact has `pending` status; stops when all ready
- `sendInboxReply(messageId, contactId)` — POSTs send, removes contact from left panel on success
- `dismissInboxMessage(messageId)` — POSTs dismiss, removes from left panel
- `openContactFromInbox(contactId)` — calls `showTab('contacts')` then `openContactPanel(contactId)`

`showTab('inbox')` triggers `refreshInboxList()` and `triggerInboxGenerate()`.

---

## Navigation

**Inbox → Contacts:** clicking the contact name in the right panel header calls `showTab('contacts'); openContactPanel(contactId)`.

**Contacts → Inbox:** the unanswered badge calls `showTab('inbox'); openInboxContact(contactId)`.

Both panels track their active selection independently (`activeContactId` and `activeInboxContactId`).

---

## Error Handling

- LLM error in `generateForMessage`: marks suggestion `failed`; client shows "Failed — Regenerate" instead of suggestions.
- `bridge.sendMessage` error: returns 500; client shows error state on Send button, does not mark suggestion used.
- Contact with no profile: `buildReplySuggestions` receives `null` for contactProfile and userProfile — prompt omits those sections gracefully.
- Inbox opened with no unanswered messages: shows placeholder "No unanswered messages."

---

## Testing

### `tests/llm.test.js` (extend)

- `buildReplySuggestions` parses all three SUGGESTION sections
- `buildReplySuggestions` returns null on API error
- `buildReplySuggestions` includes length/tone/language/emoji/greeting instructions in prompt
- `buildReplySuggestions` handles null contactProfile and null userProfile gracefully

### `tests/db.test.js` (extend)

- `getInboxMessages` returns only unanswered, non-muted contacts
- `getInboxMessages` excludes contacts with used/dismissed suggestions
- `storeSuggestions` / `getSuggestions` round-trip
- `markSuggestionUsed` / `markSuggestionDismissed` update status correctly
- `updateReplySettings` updates only whitelisted fields
- `setInboxMuted` toggles inbox_muted

### `tests/reply-engine.test.js` (new)

LLM mocked via `jest.mock('../src/llm')`.

- `generateForMessage` stores suggestions when LLM returns results
- `generateForMessage` marks failed when LLM returns null
- `generateBatch` inserts pending rows immediately for each message
- `generateBatch` respects the limit parameter
- `generateBatch` skips messages that already have a pending/ready row (only generates for null or failed status)

### `tests/server.test.js` (extend)

- `GET /api/inbox` returns correct shape
- `POST /api/inbox/generate` returns 200 and calls generateBatch
- `POST /api/inbox/:messageId/dismiss` marks dismissed
- `POST /api/inbox/:messageId/send` calls bridge.sendMessage and marks used
- `POST /api/inbox/:messageId/send` returns 400 for missing body

---

## Bilingual Notes

- All message bodies in the Inbox panel rendered with `dir="auto"`
- Language override setting includes עברית as a labeled option
- `buildReplySuggestions` prompt explicitly handles Hebrew/English/mixed per the `reply_language` setting
- Contact names in the left panel use `dir="auto"`
