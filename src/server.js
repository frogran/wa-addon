const express = require('express');
const path = require('path');
const qrcode = require('qrcode');
const db = require('./db');
const bridge = require('./bridge');

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

  return app;
}

function init() {
  const app = createApp();
  app.listen(3000, () => console.log('Dashboard running at http://localhost:3000'));
  return app;
}

module.exports = { createApp, init };
