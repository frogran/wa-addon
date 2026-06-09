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

  return app;
}

function init() {
  const app = createApp();
  app.listen(3000, () => console.log('Dashboard running at http://localhost:3000'));
  return app;
}

module.exports = { createApp, init };
