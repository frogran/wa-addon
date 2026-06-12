const db = require('../src/db');

describe('core helpers', () => {
  beforeEach(() => {
    db.init(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('upsertContact creates a new contact and returns its id', () => {
    const id = db.upsertContact('+972501234567', 'Test Fan');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('upsertContact returns the same id on duplicate phone', () => {
    const id1 = db.upsertContact('+972501234567', 'Test Fan');
    const id2 = db.upsertContact('+972501234567', 'Updated Name');
    expect(id1).toBe(id2);
  });

  test('insertMessage stores a message and returns its id', () => {
    const contactId = db.upsertContact('+972501234567', 'Test Fan');
    const msgId = db.insertMessage(contactId, 'in', 'Hello!', 1700000000, 'wa-id-001');
    expect(typeof msgId).toBe('number');
    expect(msgId).toBeGreaterThan(0);
  });

  test('insertMessage returns null on duplicate wa_id', () => {
    const contactId = db.upsertContact('+972501234567', 'Test Fan');
    db.insertMessage(contactId, 'in', 'Hello!', 1700000000, 'wa-id-001');
    const result = db.insertMessage(contactId, 'in', 'Hello!', 1700000000, 'wa-id-001');
    expect(result).toBeNull();
  });

  test('getStatus returns disconnected by default', () => {
    expect(db.getStatus()).toBe('disconnected');
  });

  test('setStatus and getStatus round-trip', () => {
    db.setStatus('connected');
    expect(db.getStatus()).toBe('connected');
    db.setStatus('qr_pending');
    expect(db.getStatus()).toBe('qr_pending');
  });

  test('calling a helper before init throws a clear error', () => {
    // db is closed by afterEach — simulate calling before init
    db.close(); // ensure closed (safe to call when already null)
    expect(() => db.getStatus()).toThrow('db not initialised');
  });
});

// ── Scheduled message helpers ──────────────────────────────────────────────

describe('scheduled messages', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Test Fan');
  });

  afterEach(() => db.close());

  test('createScheduledMessage returns an id', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('getScheduledMessage retrieves a row by id', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    const row = db.getScheduledMessage(id);
    expect(row.body).toBe('Hello!');
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
  });

  test('getDueScheduledMessages returns only past-due pending rows', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.createScheduledMessage(contactId, 'Due', past);
    db.createScheduledMessage(contactId, 'Not due', future);
    const due = db.getDueScheduledMessages();
    expect(due.length).toBe(1);
    expect(due[0].body).toBe('Due');
    expect(due[0].phone).toBe('+972501234567');
  });

  test('getDueScheduledMessages excludes rows with attempt_count >= 3', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const id = db.createScheduledMessage(contactId, 'Stuck', past);
    db.incrementAttemptCount(id);
    db.incrementAttemptCount(id);
    db.incrementAttemptCount(id);
    const due = db.getDueScheduledMessages();
    expect(due.find(m => m.id === id)).toBeUndefined();
  });

  test('getPendingScheduledMessages returns pending rows with contact name', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.createScheduledMessage(contactId, 'Later', future);
    const rows = db.getPendingScheduledMessages();
    expect(rows.length).toBe(1);
    expect(rows[0].contact_name).toBe('Test Fan');
  });

  test('updateScheduledMessageStatus changes status and stores error', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.updateScheduledMessageStatus(id, 'failed', 'timeout');
    const row = db.getScheduledMessage(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('timeout');
  });

  test('incrementAttemptCount increments by 1 each call', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.incrementAttemptCount(id);
    db.incrementAttemptCount(id);
    const row = db.getScheduledMessage(id);
    expect(row.attempt_count).toBe(2);
  });

  test('cancelScheduledMessage sets status to cancelled', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.cancelScheduledMessage(id);
    const row = db.getScheduledMessage(id);
    expect(row.status).toBe('cancelled');
  });

  test('cancelScheduledMessage is a no-op on non-pending rows', () => {
    const id = db.createScheduledMessage(contactId, 'Hello!', 1800000000);
    db.updateScheduledMessageStatus(id, 'sent');
    db.cancelScheduledMessage(id);
    const row = db.getScheduledMessage(id);
    expect(row.status).toBe('sent');
  });
});

// ── Contact search helpers ────────────────────────────────────────────────

describe('contact helpers', () => {
  beforeEach(() => {
    db.init(':memory:');
    db.upsertContact('+972501234567', 'Daniel Fan');
    db.upsertContact('+12125550001', 'Alice Press');
    db.upsertContact('+447700900001', 'Bob Colleague');
  });

  afterEach(() => db.close());

  test('getAllContacts returns all contacts ordered by name', () => {
    const contacts = db.getAllContacts();
    expect(contacts.length).toBe(3);
    expect(contacts[0].name).toBe('Alice Press');
  });

  test('searchContacts filters by name', () => {
    const results = db.searchContacts('Daniel');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Daniel Fan');
  });

  test('searchContacts filters by phone', () => {
    const results = db.searchContacts('+44');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Bob Colleague');
  });

  test('searchContacts returns empty array for no match', () => {
    expect(db.searchContacts('zzznomatch')).toHaveLength(0);
  });
});

// ── Task helpers ──────────────────────────────────────────────────────────

describe('task helpers', () => {
  let contactId, messageId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Test Fan');
    messageId = db.insertMessage(contactId, 'in', 'Please call me back', 1700000000, 'wa-t1');
  });

  afterEach(() => db.close());

  test('createTask returns a numeric id', () => {
    const id = db.createTask(contactId, messageId, 'Call back');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('getPendingTasks returns pending tasks with contact name and message snippet', () => {
    db.createTask(contactId, messageId, 'Call back');
    const tasks = db.getPendingTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].body).toBe('Call back');
    expect(tasks[0].contact_name).toBe('Test Fan');
    expect(tasks[0].message_snippet).toBe('Please call me back');
    expect(tasks[0].status).toBe('pending');
  });

  test('markTaskDone sets status to done and returns 1', () => {
    const id = db.createTask(contactId, messageId, 'Call back');
    const changed = db.markTaskDone(id);
    expect(changed).toBe(1);
    const tasks = db.getPendingTasks();
    expect(tasks).toHaveLength(0);
  });

  test('markTaskDone returns 0 for non-existent id', () => {
    expect(db.markTaskDone(9999)).toBe(0);
  });

  test('createTask with duplicate message_id+body is silently ignored', () => {
    db.createTask(contactId, messageId, 'Call back');
    const id2 = db.createTask(contactId, messageId, 'Call back');
    expect(id2).toBeNull();
    expect(db.getPendingTasks()).toHaveLength(1);
  });
});

// ── shared_contacts helpers ───────────────────────────────────────────────

describe('shared_contacts helpers', () => {
  let sharedByContactId;

  beforeEach(() => {
    db.init(':memory:');
    sharedByContactId = db.upsertContact('+972501234567', 'Test Fan');
  });

  afterEach(() => db.close());

  test('createSharedContact returns a numeric id', () => {
    const id = db.createSharedContact('+972509999999', 'New Person', sharedByContactId);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('getAllSharedContacts returns rows with shared_by_name', () => {
    db.createSharedContact('+972509999999', 'New Person', sharedByContactId);
    const rows = db.getAllSharedContacts();
    expect(rows.length).toBe(1);
    expect(rows[0].phone).toBe('+972509999999');
    expect(rows[0].name).toBe('New Person');
    expect(rows[0].shared_by_name).toBe('Test Fan');
  });

  test('createSharedContact stores preceding message context as JSON', () => {
    db.createSharedContact('+972509999999', 'New Person', sharedByContactId, null, ['Can you share her number?', 'She was at the event']);
    const rows = db.getAllSharedContacts();
    const ctx = JSON.parse(rows[0].context_before);
    expect(ctx).toEqual(['Can you share her number?', 'She was at the event']);
  });

  test('getAllSharedContacts includes context_before field', () => {
    db.createSharedContact('+972509999999', 'New Person', sharedByContactId);
    const rows = db.getAllSharedContacts();
    // context_before is null or a JSON string — field must exist
    expect('context_before' in rows[0]).toBe(true);
  });

  test('createSharedContact with duplicate phone is ignored', () => {
    db.createSharedContact('+972509999999', 'New Person', sharedByContactId);
    const id2 = db.createSharedContact('+972509999999', 'New Person', sharedByContactId);
    expect(id2).toBeNull();
    expect(db.getAllSharedContacts()).toHaveLength(1);
  });
});

// ── settings helpers ──────────────────────────────────────────────────────

describe('settings helpers', () => {
  beforeEach(() => db.init(':memory:'));
  afterEach(() => db.close());

  test('getSetting returns null for unknown key', () => {
    expect(db.getSetting('unknown_key')).toBeNull();
  });

  test('setSetting and getSetting round-trip', () => {
    db.setSetting('my_key', 'my_value');
    expect(db.getSetting('my_key')).toBe('my_value');
  });

  test('setSetting overwrites existing value', () => {
    db.setSetting('my_key', 'first');
    db.setSetting('my_key', 'second');
    expect(db.getSetting('my_key')).toBe('second');
  });
});

// ── Backfill helpers ──────────────────────────────────────────────────────

describe('backfill helpers', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Test Fan');
  });

  afterEach(() => db.close());

  test('countInboundMessages counts only direction=in messages', () => {
    db.insertMessage(contactId, 'in', 'Hello', 1700000001, 'wa-bf1');
    db.insertMessage(contactId, 'in', 'Hi again', 1700000002, 'wa-bf2');
    db.insertMessage(contactId, 'out', 'My reply', 1700000003, 'wa-bf3');
    expect(db.countInboundMessages()).toBe(2);
  });

  test('getInboundMessagesAfter returns messages with id > afterId, joined with contact_name', () => {
    const id1 = db.insertMessage(contactId, 'in', 'First', 1700000001, 'wa-bf4');
    const id2 = db.insertMessage(contactId, 'in', 'Second', 1700000002, 'wa-bf5');
    db.insertMessage(contactId, 'in', 'Third', 1700000003, 'wa-bf6');
    const rows = db.getInboundMessagesAfter(id2, 10);
    expect(rows.length).toBe(1);
    expect(rows[0].body).toBe('Third');
    expect(rows[0].contact_name).toBe('Test Fan');
  });

  test('getInboundMessagesAfter skips outbound messages', () => {
    db.insertMessage(contactId, 'out', 'My reply', 1700000001, 'wa-bf7');
    db.insertMessage(contactId, 'in', 'Inbound', 1700000002, 'wa-bf8');
    const rows = db.getInboundMessagesAfter(0, 10);
    expect(rows.length).toBe(1);
    expect(rows[0].body).toBe('Inbound');
  });

  test('getLastMessagesFromContact returns bodies in chronological order', () => {
    db.insertMessage(contactId, 'in', 'First msg', 1700000001, 'wa-bf9');
    db.insertMessage(contactId, 'in', 'Second msg', 1700000002, 'wa-bf10');
    db.insertMessage(contactId, 'in', 'Third msg', 1700000003, 'wa-bf11');
    const bodies = db.getLastMessagesFromContact(contactId, 2);
    expect(bodies).toEqual(['Second msg', 'Third msg']);
  });
});

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

  test('markSuggestionFailed sets status to failed', () => {
    db.ensureSuggestionRow(messageId, contactId);
    db.markSuggestionFailed(messageId);
    expect(db.getSuggestions(messageId).status).toBe('failed');
  });

  test('getUnansweredCount returns 1 for contact with unanswered message', () => {
    expect(db.getUnansweredCount(contactId)).toBe(1);
  });
});

// ── extracted_contacts helpers ────────────────────────────────────────────

describe('extracted_contacts helpers', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    contactId = db.upsertContact('+972501234567', 'Tester');
  });

  afterEach(() => db.close());

  test('createExtractedPhone returns a numeric id', () => {
    const id = db.createExtractedPhone('+972509999999', contactId);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('createExtractedPhone returns null on duplicate phone', () => {
    db.createExtractedPhone('+972509999999', contactId);
    const id2 = db.createExtractedPhone('+972509999999', contactId);
    expect(id2).toBeNull();
  });

  test('createExtractedEmail returns a numeric id', () => {
    const id = db.createExtractedEmail('hello@example.com', contactId);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('createExtractedEmail returns null on duplicate email', () => {
    db.createExtractedEmail('hello@example.com', contactId);
    const id2 = db.createExtractedEmail('hello@example.com', contactId);
    expect(id2).toBeNull();
  });

  test('getAllSharedContacts includes extracted phone with source=text', () => {
    db.createExtractedPhone('+972509999999', contactId);
    const rows = db.getAllSharedContacts();
    const row = rows.find(r => r.source === 'text' && r.phone === '+972509999999');
    expect(row).toBeDefined();
    expect(row.shared_by_name).toBe('Tester');
  });

  test('getAllSharedContacts includes extracted email with source=text', () => {
    db.createExtractedEmail('hello@example.com', contactId);
    const rows = db.getAllSharedContacts();
    const row = rows.find(r => r.source === 'text' && r.email === 'hello@example.com');
    expect(row).toBeDefined();
  });
});

// ── getInboxMessages outbound filter ──────────────────────────────────────

describe('getInboxMessages outbound filter', () => {
  beforeEach(() => db.init(':memory:'));
  afterEach(() => db.close());

  test('excludes contact when outbound message follows latest inbound', () => {
    const cId = db.upsertContact('+10000000099', 'Reply Test');
    db.insertMessage(cId, 'in', 'hello', 1000, 'wa_in_reply_test');
    db.insertMessage(cId, 'out', 'hi back', 2000, 'wa_out_reply_test');
    const rows = db.getInboxMessages();
    expect(rows.find(r => r.contact_id === cId)).toBeUndefined();
  });

  test('keeps contact when outbound message precedes latest inbound (contact replied after us)', () => {
    const cId = db.upsertContact('+10000000098', 'Reply Before');
    db.insertMessage(cId, 'out', 'hey there', 1000, 'wa_out_first');
    db.insertMessage(cId, 'in', 'hey back!', 2000, 'wa_in_after_out');
    const rows = db.getInboxMessages();
    expect(rows.find(r => r.contact_id === cId)).toBeDefined();
  });

  test('contact reappears after new inbound following a prior outbound', () => {
    const cId = db.upsertContact('+10000000097', 'Reappear Test');
    db.insertMessage(cId, 'in', 'first message', 1000, 'wa_in_first_2');
    db.insertMessage(cId, 'out', 'my reply', 2000, 'wa_out_second');
    db.insertMessage(cId, 'in', 'their follow-up', 3000, 'wa_in_third');
    const rows = db.getInboxMessages();
    expect(rows.find(r => r.contact_id === cId)).toBeDefined();
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
    db.updateProfile('Writes concisely.');
    const p = db.getProfile();
    expect(p.global_style).toBe('Writes concisely.');
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
