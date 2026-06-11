const request = require('supertest');
const db = require('../src/db');

jest.mock('../src/bridge', () => ({
  init: jest.fn(),
  sendMessage: jest.fn(),
  getQr: jest.fn().mockReturnValue(null)
}));

jest.mock('../src/contact-intel', () => ({
  seedAll: jest.fn().mockResolvedValue(undefined),
  refreshContact: jest.fn().mockResolvedValue(undefined),
  refreshUserProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/reply-engine', () => ({
  generateBatch: jest.fn().mockResolvedValue(undefined),
  generateForMessage: jest.fn().mockResolvedValue(undefined),
}));

const { createApp } = require('../src/server');

let app;

describe('status and QR routes', () => {
  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
  });

  afterEach(() => {
    db.close();
  });

  test('GET /api/status returns disconnected by default', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bridge_status: 'disconnected', has_qr: false });
  });

  test('GET /api/status reflects updated bridge status', async () => {
    db.setStatus('connected');
    const res = await request(app).get('/api/status');
    expect(res.body.bridge_status).toBe('connected');
  });

  test('GET /api/status has_qr is true when QR is available', async () => {
    const bridge = require('../src/bridge');
    bridge.getQr.mockReturnValueOnce('mock-qr-string');
    const res = await request(app).get('/api/status');
    expect(res.body.has_qr).toBe(true);
  });

  test('GET /api/qr returns null when no QR pending', async () => {
    const res = await request(app).get('/api/qr');
    expect(res.status).toBe(200);
    expect(res.body.qr).toBeNull();
  });
});

describe('scheduled message routes', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
    contactId = db.upsertContact('+972501234567', 'Test Fan');
  });

  afterEach(() => db.close());

  test('GET /api/scheduled returns empty array initially', async () => {
    const res = await request(app).get('/api/scheduled');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/scheduled creates a message and returns its id', async () => {
    const sendAt = Math.floor(Date.now() / 1000) + 3600;
    const res = await request(app)
      .post('/api/scheduled')
      .send({ contact_id: contactId, body: 'Hello!', send_at: sendAt });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('number');
  });

  test('POST /api/scheduled returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .send({ contact_id: contactId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  test('POST /api/scheduled returns 400 for past send_at', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .send({ contact_id: contactId, body: 'Hello!', send_at: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  test('GET /api/scheduled returns the created message with contact name', async () => {
    const sendAt = Math.floor(Date.now() / 1000) + 3600;
    await request(app)
      .post('/api/scheduled')
      .send({ contact_id: contactId, body: 'Hello!', send_at: sendAt });
    const res = await request(app).get('/api/scheduled');
    expect(res.body.length).toBe(1);
    expect(res.body[0].body).toBe('Hello!');
    expect(res.body[0].contact_name).toBe('Test Fan');
  });

  test('DELETE /api/scheduled/:id cancels the message', async () => {
    const sendAt = Math.floor(Date.now() / 1000) + 3600;
    const createRes = await request(app)
      .post('/api/scheduled')
      .send({ contact_id: contactId, body: 'Hello!', send_at: sendAt });
    const id = createRes.body.id;

    const delRes = await request(app).delete(`/api/scheduled/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const listRes = await request(app).get('/api/scheduled');
    expect(listRes.body).toHaveLength(0);
  });

  test('DELETE /api/scheduled/:id returns 404 for non-existent id', async () => {
    const res = await request(app).delete('/api/scheduled/9999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('contact routes', () => {
  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
    db.upsertContact('+972501234567', 'Daniel Fan');
    db.upsertContact('+12125550001', 'Alice Press');
  });

  afterEach(() => db.close());

  test('GET /api/contacts returns all contacts when no query', async () => {
    const res = await request(app).get('/api/contacts');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  test('GET /api/contacts?q= filters by name', async () => {
    const res = await request(app).get('/api/contacts?q=Alice');
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Alice Press');
  });
});

describe('task routes', () => {
  let contactId, messageId;

  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
    contactId = db.upsertContact('+972501234567', 'Test Fan');
    messageId = db.insertMessage(contactId, 'in', 'Please call me back', 1700000000, 'wa-task1');
  });

  afterEach(() => db.close());

  test('GET /api/tasks returns empty array initially', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/tasks returns pending tasks with contact name', async () => {
    db.createTask(contactId, messageId, 'Call back');
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].body).toBe('Call back');
    expect(res.body[0].contact_name).toBe('Test Fan');
    expect(res.body[0].message_snippet).toBe('Please call me back');
  });

  test('PATCH /api/tasks/:id marks task done', async () => {
    const id = db.createTask(contactId, messageId, 'Call back');
    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.getPendingTasks()).toHaveLength(0);
  });

  test('PATCH /api/tasks/:id returns 400 for invalid status', async () => {
    const id = db.createTask(contactId, messageId, 'Call back');
    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: 'invalid' });
    expect(res.status).toBe(400);
  });

  test('PATCH /api/tasks/:id returns 404 for non-existent id', async () => {
    const res = await request(app)
      .patch('/api/tasks/9999')
      .send({ status: 'done' });
    expect(res.status).toBe(404);
  });
});

describe('backfill routes', () => {
  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
  });

  afterEach(() => db.close());

  test('GET /api/backfill/status returns idle by default', async () => {
    const res = await request(app).get('/api/backfill/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
    expect(res.body.processed).toBe(0);
    expect(res.body.total).toBe(0);
  });

  test('POST /api/backfill returns ok', async () => {
    const res = await request(app).post('/api/backfill');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('import route', () => {
  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
  });

  afterEach(() => db.close());

  test('POST /api/import returns 400 when no file is sent', async () => {
    const res = await request(app)
      .post('/api/import')
      .field('contact_phone', '+972501234567');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('POST /api/import imports messages and returns counts', async () => {
    const fileContent = '[15/01/2024, 14:22:13] Alice: Hello!\n[15/01/2024, 14:23:00] Me: Hi!';
    const res = await request(app)
      .post('/api/import')
      .field('user_name', 'Me')
      .field('contact_phone', '+972501234567')
      .attach('file', Buffer.from(fileContent, 'utf8'), 'chat.txt');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped).toBe(0);
  });
});

describe('shared contacts routes', () => {
  let contactId;

  beforeEach(() => {
    db.init(':memory:');
    app = createApp();
    contactId = db.upsertContact('+972501234567', 'Test Fan');
  });

  afterEach(() => db.close());

  test('GET /api/shared-contacts returns empty array initially', async () => {
    const res = await request(app).get('/api/shared-contacts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/shared-contacts returns shared contacts with shared_by_name', async () => {
    db.createSharedContact('+972509999999', 'New Person', contactId);
    const res = await request(app).get('/api/shared-contacts');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].phone).toBe('+972509999999');
    expect(res.body[0].name).toBe('New Person');
    expect(res.body[0].shared_by_name).toBe('Test Fan');
  });
});

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

  test('PATCH /api/contacts/:id returns 404 for unknown contact', async () => {
    const res = await request(app)
      .patch('/api/contacts/9999')
      .send({ relationship_summary: 'x' });
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

  test('POST /api/contacts/:id/refresh returns 200 and calls refreshContact', async () => {
    const contactIntel = require('../src/contact-intel');
    const res = await request(app).post(`/api/contacts/${contactId}/refresh`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(contactIntel.refreshContact).toHaveBeenCalledWith(contactId);
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

  test('POST /api/profile/refresh returns 200 and calls refreshUserProfile', async () => {
    const contactIntel = require('../src/contact-intel');
    const res = await request(app).post('/api/profile/refresh');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(contactIntel.refreshUserProfile).toHaveBeenCalledTimes(1);
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

  test('POST /api/inbox/:messageId/dismiss works for message with no prior suggestion row', async () => {
    // messageId has no suggestion row at all — should still dismiss successfully
    const res = await request(app).post(`/api/inbox/${messageId}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
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

  test('POST /api/inbox/:messageId/send sends message and marks used', async () => {
    db.ensureSuggestionRow(messageId, contactId);
    const res = await request(app)
      .post(`/api/inbox/${messageId}/send`)
      .send({ body: 'Hello there' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.getSuggestions(messageId).status).toBe('used');
  });
});
