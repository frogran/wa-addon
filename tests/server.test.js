const request = require('supertest');
const db = require('../src/db');

jest.mock('../src/bridge', () => ({
  init: jest.fn(),
  sendMessage: jest.fn(),
  getQr: jest.fn().mockReturnValue(null)
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
