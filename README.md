# WA Addon — WhatsApp Assistant for Mac

A local Node.js dashboard that connects to your WhatsApp account and adds AI-powered features on top: smart reply suggestions, contact intelligence, task extraction, scheduled messages, and contact info extraction from conversations.

All data stays on your machine. The only external service is the Anthropic API for AI features.

---

## Features

### Inbox
Surfaces contacts you haven't replied to yet. For each unanswered message, Claude generates three contextual reply suggestions based on the contact's profile, your communication style, and per-contact settings (tone, length, language, emoji, greeting). Click a suggestion to edit it, then send — or dismiss it. Replies sent from your phone are automatically detected and remove the contact from the inbox.

### Contact Intelligence
Every contact gets an AI-generated profile: relationship summary, communication style, language, and category. Profiles refresh automatically every 5 inbound messages. The Contacts tab lets you browse profiles, view message history, and configure per-contact reply settings.

### Tasks
Extracts action items from inbound messages using Claude. Tasks appear in the Tasks tab and can be marked done.

### Scheduled Messages
Compose a message and schedule it to send at a specific time. The scheduler runs every minute and sends due messages via the WhatsApp client.

### Shared & Extracted Contacts
Tracks contact info that surfaces in your conversations:
- **vCard** — when someone explicitly shares a contact card via WhatsApp
- **text** — phone numbers and email addresses mentioned in plain message text (extracted automatically from new inbound messages going forward)

Each entry shows who shared it and when, with a source badge (green = vCard, blue = text).

### Chat Import
Import a WhatsApp chat export (`.txt` format) to seed the database with conversation history for a contact.

### Message Backfill / Scan History
Fetches up to 500 recent messages per chat from your WhatsApp history and runs AI task extraction across all stored inbound messages.

---

## Requirements

- **macOS** (uses Google Chrome for the WhatsApp Web session)
- **Node.js** v18 or later (tested on v26)
- **Google Chrome** installed at `/Applications/Google Chrome.app`
- **Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com)
- A WhatsApp account linked to a phone

---

## Setup

```bash
git clone https://github.com/frogran/wa-addon.git
cd wa-addon
npm install
```

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

Start the server:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. On first run, a QR code will appear — scan it with WhatsApp on your phone (Settings → Linked Devices → Link a Device). The session is saved locally and persists across restarts.

---

## Configuration

All settings are per-contact and can be changed from the Contacts tab:

| Setting | Options | Default |
|---|---|---|
| Reply length | Auto / Short / Medium / Long | Auto |
| Reply tone | Auto / Formal / Casual / Friendly / Direct | Auto |
| Reply language | Auto / English / Hebrew / Spanish / French | Auto |
| Emoji | Auto / Always / Never | Auto |
| Greeting | On / Off | On |
| Messages to consider | 1–50 | 20 |
| Mute in inbox | — | Off |

**Auto** means Claude infers the appropriate value from the conversation context.

---

## Data

All data is stored in `data/wa.db` (SQLite). The WhatsApp session is stored in `data/.wwebjs_auth/`. Neither is committed to git.

Key tables:
- `contacts` — contact profiles and reply settings
- `messages` — full message history (inbound and outbound)
- `reply_suggestions` — generated suggestions with status tracking
- `tasks` — extracted action items
- `scheduled_messages` — pending and sent scheduled messages
- `shared_contacts` — vCard-shared contact info
- `extracted_contacts` — phone numbers and emails extracted from message text

---

## Tech Stack

| Layer | Technology |
|---|---|
| WhatsApp client | [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) + Puppeteer + Chrome |
| AI | [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-node) (claude-opus-4-8) |
| Backend | Node.js + Express |
| Database | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Frontend | Vanilla JS (single HTML file) |
| Tests | Jest + Supertest |

---

## Known Limitations

- **Mac only** — Chrome path is hardcoded to `/Applications/Google Chrome.app`
- **Shared & Extracted Contacts backfill** — text extraction only runs on new messages; existing chat history is not retroactively scanned for phone numbers and emails
- **Group chats** — group messages are stored under the group ID, not attributed to individual participants
- **WhatsApp session** — if the session disconnects, restart the server and re-scan the QR code
