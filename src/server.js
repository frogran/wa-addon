const express = require('express');
const path = require('path');
const qrcode = require('qrcode');
const db = require('./db');
const bridge = require('./bridge');
const backfill = require('./backfill');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/status', (req, res) => {
    res.json({
      bridge_status: db.getStatus(),
      has_qr: !!bridge.getQr()
    });
  });

  app.get('/api/qr', async (req, res) => {
    const raw = bridge.getQr();
    if (!raw) return res.json({ qr: null });
    const dataUrl = await qrcode.toDataURL(raw);
    res.json({ qr: dataUrl });
  });

  // ── Scheduled messages ────────────────────────────────────────────────
  app.get('/api/scheduled', (req, res) => {
    res.json(db.getPendingScheduledMessages());
  });

  app.post('/api/scheduled', (req, res) => {
    const { contact_id, body, send_at } = req.body;
    if (contact_id == null || !body || send_at == null) {
      return res.status(400).json({ error: 'contact_id, body, and send_at are required' });
    }
    if (Number(send_at) <= Math.floor(Date.now() / 1000)) {
      return res.status(400).json({ error: 'send_at must be a future Unix timestamp' });
    }
    try {
      const id = db.createScheduledMessage(Number(contact_id), body, Number(send_at));
      res.status(201).json({ id });
    } catch (err) {
      console.error('POST /api/scheduled error:', err.message);
      res.status(422).json({ error: 'Invalid contact_id or database error' });
    }
  });

  app.delete('/api/scheduled/:id', (req, res) => {
    const changed = db.cancelScheduledMessage(Number(req.params.id));
    if (!changed) return res.status(404).json({ error: 'Message not found or already finalized' });
    res.json({ ok: true });
  });

  // ── Contacts ──────────────────────────────────────────────────────────
  app.get('/api/contacts', (req, res) => {
    const { q } = req.query;
    const contacts = q ? db.searchContacts(q) : db.getAllContacts();
    res.json(contacts);
  });

  // ── Tasks ─────────────────────────────────────────────────────────────
  app.get('/api/tasks', (req, res) => {
    res.json(db.getPendingTasks());
  });

  app.patch('/api/tasks/:id', (req, res) => {
    const { status } = req.body;
    if (status !== 'done') {
      return res.status(400).json({ error: 'status must be "done"' });
    }
    const changed = db.markTaskDone(Number(req.params.id));
    if (!changed) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  });

  // ── Backfill ──────────────────────────────────────────────────────────
  app.get('/api/backfill/status', (req, res) => {
    res.json({
      status: db.getSetting('backfill_status') || 'idle',
      processed: parseInt(db.getSetting('backfill_processed') || '0', 10),
      total: parseInt(db.getSetting('backfill_total') || '0', 10),
    });
  });

  app.post('/api/backfill', (req, res) => {
    const status = db.getSetting('backfill_status');
    if (status === 'running') {
      return res.status(409).json({ error: 'Backfill already running' });
    }
    backfill.run(null).catch(err => console.error('Backfill failed:', err.message));
    res.json({ ok: true });
  });

  return app;
}

function init() {
  const app = createApp();
  app.listen(3000, () => console.log('Dashboard running at http://localhost:3000'));
  return app;
}

module.exports = { createApp, init };
