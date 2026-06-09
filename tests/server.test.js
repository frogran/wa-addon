const request = require('supertest');
const db = require('../src/db');

jest.mock('../src/bridge', () => ({
  init: jest.fn(),
  sendMessage: jest.fn(),
  getQr: jest.fn().mockReturnValue(null)
}));

const { createApp } = require('../src/server');

let app;

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
