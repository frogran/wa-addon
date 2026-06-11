# WhatsApp Add-on — Phase 4: Contact Intelligence

**Date:** 2026-06-11
**Status:** Approved, ready for implementation

---

## Overview

Phase 4 adds contact intelligence to the WhatsApp assistant: for each contact, Claude builds an accumulating profile describing the relationship and how the user specifically writes to that person. It also builds and maintains an accumulating profile of the user's own writing style across all conversations. Both profiles grow richer over time — new observations are added, never erased.

These profiles are the foundation for Phase 5 smart reply suggestions. They are also directly editable by the user from the Contacts tab.

---

## Scope

**In:**
- Per-contact accumulating profiles (`relationship_summary`, `style_to_contact`, `language`, `category`)
- User writing style profile (`user_profile.global_style`)
- Batch seeding job: generate initial profiles for all contacts from existing messages
- Ongoing refresh: re-enrich a contact's profile every 5 new inbound messages; re-enrich user profile every 20 new outbound messages
- Contacts tab: searchable contact list + editable side panel
- Settings tab: "Generate profiles" button with progress bar

**Out (deferred):**
- Clustering (`clusters` table exists in schema but is unused)
- Cluster view in Contacts tab
- Any external sync (Obsidian, Notion, etc.)

---

## Architecture

### New file

**`src/contact-intel.js`** — all profile refresh logic. Keeps `llm.js` as a pure SDK wrapper and `backfill.js` focused on message ingestion.

### Modified files

| File | Change |
|---|---|
| `src/llm.js` | Add `buildContactProfile(messages, existingProfile)` and `buildUserProfile(outgoingMessages, existingProfile)` |
| `src/db.js` | Add contact profile helpers and user profile helpers |
| `src/bridge.js` | Wire per-contact refresh trigger (every 5th inbound) and user profile trigger (every 20th outbound) |
| `src/server.js` | Add contact detail, patch, profile, and intel seed routes |
| `public/index.html` | Replace Contacts tab with searchable list + editable side panel |

### No new dependencies

All required packages (`@anthropic-ai/sdk`, `better-sqlite3`, `express`) are already installed.

---

## Data Model

All tables and columns already exist in the schema. No migrations needed.

### `contacts` columns used in Phase 4

| column | type | notes |
|---|---|---|
| `relationship_summary` | TEXT | Narrative description of the relationship — who they are, tone, recurring topics, history |
| `style_to_contact` | TEXT | How the user specifically writes to this person — formality, language mix, emoji use, example phrases |
| `language` | TEXT | `en`, `he`, or `mixed` — detected from their inbound messages |
| `category` | TEXT | User-assignable or LLM-suggested: `fan`, `colleague`, `press`, `family`, etc. |

### `user_profile` (single row, id=1)

| column | type | notes |
|---|---|---|
| `global_style` | TEXT | Accumulating description of the user's overall writing style: tone, Hebrew/English switching, emoji habits, typical reply length, recurring phrases |
| `updated_at` | INTEGER | Unix timestamp of last update |

### `settings` keys added in Phase 4

| key | value |
|---|---|
| `intel_status` | `idle`, `running`, `done`, `error` |
| `intel_last_seeded_contact_id` | Checkpoint for restart-safety |
| `intel_total` | Total contacts to seed |
| `intel_processed` | Contacts seeded so far |
| `intel_outbound_count` | Running count of outbound messages since last user profile refresh |

---

## LLM Functions (`src/llm.js`)

### `buildContactProfile(messages, existingProfile)`

**Input:**
- `messages` — array of `{ direction, body, timestamp }` for this contact, in chronological order
- `existingProfile` — `{ summary, style }` object, or `null` on first run

**System prompt:**
```
You are building a relationship and communication profile for a WhatsApp contact.
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

CATEGORY: <fan|colleague|press|family|other>
```

**Returns:** `{ summary: string, style: string, language: string, category: string }`

**Error handling:** Returns `null` on API error (caller skips the update).

---

### `buildUserProfile(outgoingMessages, existingProfile)`

**Input:**
- `outgoingMessages` — array of `{ body, contact_name, timestamp }`, sampled across contacts
- `existingProfile` — existing `global_style` string, or `null` on first run

**System prompt:**
```
You are building a profile of a WhatsApp user's communication style.
You will be given their existing style profile (if any) and a sample of messages they have sent.

Enrich the profile — add new patterns, confirm existing ones.
Note code-switching between Hebrew and English, emoji habits, typical reply lengths,
tone variation across different types of contacts, recurring phrases.
Never delete prior observations — only add and refine.

Respond with a single prose profile (2-4 paragraphs). Be specific and concrete.
```

**Returns:** `string` (updated global_style)

**Error handling:** Returns `null` on API error.

---

## `src/contact-intel.js`

Exports: `{ seedAll, refreshContact, refreshUserProfile }`

### `seedAll()`

Batch seeds all contacts that have at least 1 message and have not yet been seeded (or forces re-seed if called explicitly).

```
1. Count contacts with messages → setSetting('intel_total', n)
2. Read checkpoint: intel_last_seeded_contact_id (default 0)
3. Loop: getContactsToSeed(afterId, batchSize=1)
   a. getContactMessages(contact.id) — all messages
   b. llm.buildContactProfile(messages, existingProfile)
   c. db.updateContactProfile(id, summary, style, language, category)
   d. Advance checkpoint, increment intel_processed
4. After all contacts: seedUserProfile()
5. setSetting('intel_status', 'done')
```

Language detection: inferred by Claude from the inbound messages in the profile call — no separate detection step.

Category: Claude suggests one in the profile call (see system prompt note below); user can override via the edit panel.

### `refreshContact(contactId)`

Called from `bridge.js` on every 5th inbound message from a contact.

```
1. getContactMessages(contactId) — all messages
2. getContactProfile(contactId) — existing summary + style
3. llm.buildContactProfile(messages, existingProfile)
4. db.updateContactProfile(...)
```

Non-blocking: called with `.then().catch()` from bridge.js, never awaited.

### `refreshUserProfile()`

Called from `bridge.js` every 20th outbound message overall.

```
1. getOutgoingMessagesSample(50) — 50 recent sent messages, sampled across contacts
2. getProfile() — existing global_style
3. llm.buildUserProfile(messages, existingProfile)
4. db.updateProfile(globalStyle)
```

Non-blocking: same fire-and-forget pattern.

### `seedUserProfile()`

Called at end of `seedAll()`. Same as `refreshUserProfile()` but awaited (part of the batch job).

---

## DB Helpers (`src/db.js`)

New functions to add:

```javascript
// Contact profile
function getContactProfile(contactId)
  // → { summary, style, language, category } or null

function updateContactProfile(contactId, summary, style, language, category)
  // UPDATE contacts SET relationship_summary=?, style_to_contact=?, language=?, category=?

function getContactMessages(contactId)
  // SELECT direction, body, timestamp FROM messages WHERE contact_id=? ORDER BY timestamp

function getContactsToSeed(afterId, limit)
  // contacts that have messages, id > afterId, LIMIT limit
  // JOIN with a COUNT of messages to filter ≥ 1

function getContactDetail(contactId)
  // Full contact row + last 5 messages

function getOutgoingMessagesSample(limit)
  // SELECT m.body, c.name AS contact_name, m.timestamp
  // FROM messages m JOIN contacts c ON c.id = m.contact_id
  // WHERE m.direction = 'out' ORDER BY m.id DESC LIMIT ?

// User profile
function getProfile()
  // SELECT * FROM user_profile WHERE id = 1

function updateProfile(globalStyle)
  // UPDATE user_profile SET global_style=?, updated_at=unixepoch() WHERE id=1

// Outbound message counter (for auto-refresh trigger)
function getOutboundCount()
  // SELECT COUNT(*) FROM messages WHERE direction='out'

function getContactInboundCount(contactId)
  // SELECT COUNT(*) FROM messages WHERE contact_id=? AND direction='in'
```

---

## `bridge.js` changes

Two new triggers in the `message` handler (both fire-and-forget):

```javascript
// After inserting inbound message:
const inboundCount = db.getContactInboundCount(contactId);
if (inboundCount % 5 === 0) {
  contactIntel.refreshContact(contactId)
    .catch(err => console.error('Contact refresh error:', err.message));
}

// After inserting any message (inbound or outbound):
const outboundCount = db.getOutboundCount();
if (outboundCount > 0 && outboundCount % 20 === 0) {
  contactIntel.refreshUserProfile()
    .catch(err => console.error('User profile refresh error:', err.message));
}
```

Also need: `db.getContactInboundCount(contactId)` — count of inbound messages for this contact.

---

## API Routes (`src/server.js`)

```
GET  /api/contacts              existing — returns all contacts (add language, category fields)
GET  /api/contacts/:id          NEW — full profile + last 5 messages
PATCH /api/contacts/:id         NEW — update summary, style, category, language
POST /api/contacts/:id/refresh  NEW — trigger LLM profile refresh (fire-and-forget)

GET  /api/profile               NEW — user_profile row
PATCH /api/profile              NEW — update global_style manually
POST /api/profile/refresh       NEW — trigger user profile refresh (fire-and-forget)

POST /api/intel/seed            NEW — trigger batch seed job
GET  /api/intel/status          NEW — { status, processed, total }
```

All PATCH routes accept only the fields they own (no mass-assignment). `POST /api/intel/seed` returns 409 if already running.

---

## Contacts Tab UI

Replaces the current Contacts tab (which shows shared contacts only — those move to a collapsible section at the bottom of the same tab).

### Layout: two-column

**Left column (1/3 width):**
- Search input at top (filters by name, filters as you type)
- Scrollable list of contacts, sorted by most recent message
- Each row: name, language badge (`EN` / `HE` / `MIX`), message count
- Clicking a row opens the side panel

**Right panel (2/3 width), opens on contact click:**
- **Name** + phone (read-only header)
- **Language** — dropdown (`en` / `he` / `mixed`), inline save on change
- **Category** — text input (`fan`, `colleague`, `press`, `family`, etc.), Save button
- **Relationship summary** — `<textarea>`, 6 rows, Save button
- **Style notes** — `<textarea>`, 4 rows, Save button (label: "How you write to them")
- **"Refresh profile"** button — calls `POST /api/contacts/:id/refresh`, shows spinner, re-fetches after 3s
- **Last 5 messages** — read-only, `dir="auto"`, newest first, dimmed styling
- Separator line
- **Shared Contacts** section (existing Phase 3 feature) — contacts this person has sent you via vCard

**No panel shown** when no contact is selected — placeholder text: "Select a contact to view their profile."

### Settings tab addition

In the Settings tab (after Import card), add a new card:

**"Contact Intelligence"**
- "Generate profiles" button → `POST /api/intel/seed`
- Progress bar (same pattern as backfill: polls `GET /api/intel/status`)
- Status text: idle / running / done / error

---

## Data Flow Summary

### A. First-time setup (user clicks "Generate profiles")

```
POST /api/intel/seed
→ contact-intel.seedAll()
  → for each contact with messages:
    → getContactMessages(contactId)
    → llm.buildContactProfile(messages, null)  // null = no prior profile
    → db.updateContactProfile(...)
    → advance checkpoint
  → seedUserProfile()
    → getOutgoingMessagesSample(50)
    → llm.buildUserProfile(messages, null)
    → db.updateProfile(globalStyle)
→ setSetting('intel_status', 'done')
```

### B. New inbound message (ongoing)

```
bridge.js receives message
→ upsert contact, insert message
→ task extraction (existing Phase 3)
→ if inboundCount % 5 === 0:
  → contactIntel.refreshContact(contactId)  // fire and forget
→ if outboundCount % 20 === 0:
  → contactIntel.refreshUserProfile()       // fire and forget
```

### C. User edits a profile field

```
User types in textarea, clicks Save
→ PATCH /api/contacts/:id { relationship_summary: "..." }
→ db.updateContactProfile(...)
→ 200 { ok: true }
```

### D. User manually refreshes one contact

```
User clicks "Refresh profile" in side panel
→ POST /api/contacts/:id/refresh
→ contactIntel.refreshContact(contactId)  // fire and forget
→ 200 { ok: true }
→ Client polls or re-fetches after 3s
```

---

## Error Handling

- LLM errors in `buildContactProfile` / `buildUserProfile`: return `null`, caller skips the DB write and logs the error. Profile is not corrupted.
- Batch seed interrupted: checkpoint in settings table; next `POST /api/intel/seed` resumes from `intel_last_seeded_contact_id`.
- `PATCH /api/contacts/:id` with unknown fields: server ignores unknown keys (only whitelisted fields updated).
- `POST /api/contacts/:id/refresh` while seed is running: allowed — per-contact refresh is independent of the batch job.

---

## Testing

### `tests/contact-intel.test.js` (new)

LLM mocked via `jest.mock('../src/llm')`.

- `seedAll()` creates profiles for all contacts with messages
- `seedAll()` skips contacts with no messages
- `seedAll()` advances checkpoint after each contact
- `seedAll()` resumes from checkpoint on second call (does not re-process contacts before checkpoint)
- `seedAll()` calls `buildUserProfile` at the end
- `refreshContact()` passes existing profile to `buildContactProfile` (accumulate semantics)
- `refreshContact()` does not update DB if LLM returns null

### `tests/llm.test.js` (extend)

- `buildContactProfile()` includes messages and existing profile in the prompt
- `buildContactProfile()` returns `null` on API error
- `buildContactProfile()` parses all four sections: `RELATIONSHIP_SUMMARY:`, `STYLE_TO_CONTACT:`, `LANGUAGE:`, `CATEGORY:`
- `buildUserProfile()` includes outgoing messages and existing profile in the prompt
- `buildUserProfile()` returns `null` on API error

### `tests/db.test.js` (extend)

- `updateContactProfile()` / `getContactProfile()` round-trip
- `getContactMessages()` returns messages in chronological order
- `getContactsToSeed()` only returns contacts with ≥ 1 message
- `getOutgoingMessagesSample()` returns only outbound messages
- `updateProfile()` / `getProfile()` round-trip

### `tests/server.test.js` (extend)

- `GET /api/contacts/:id` returns profile + last 5 messages
- `PATCH /api/contacts/:id` updates profile fields
- `POST /api/contacts/:id/refresh` returns 200
- `GET /api/profile` returns global_style
- `PATCH /api/profile` updates global_style
- `POST /api/intel/seed` returns 200 / 409 if running
- `GET /api/intel/status` returns correct shape

---

## Bilingual Notes

- `buildContactProfile` system prompt does not specify a language — Claude mirrors the dominant language of the messages.
- `language` field is set based on Claude's inferred language during the profile call (added as a third parsed field in the response format).
- All textarea fields in the Contacts panel use `dir="auto"` for correct Hebrew RTL rendering.
- `buildUserProfile` explicitly mentions code-switching between Hebrew and English as a dimension to capture.
