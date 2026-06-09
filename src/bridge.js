const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const db = require('./db');

let client = null;
let currentQr = null;

function init() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './data/.wwebjs_auth' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  client.on('qr', (qr) => {
    currentQr = qr;
    db.setStatus('qr_pending');
    console.log('\nScan this QR code with WhatsApp on your phone:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    currentQr = null;
    db.setStatus('connected');
    console.log('WhatsApp client ready.');
  });

  client.on('disconnected', (reason) => {
    currentQr = null;
    db.setStatus('disconnected');
    console.log('WhatsApp disconnected:', reason);
  });

  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    try {
      const contact = await msg.getContact();
      const contactId = db.upsertContact(msg.from, contact.pushname || contact.name || msg.from);
      db.insertMessage(contactId, 'in', msg.body, Math.floor(msg.timestamp), msg.id.id);
    } catch (err) {
      console.error('Error handling incoming message:', err.message);
    }
  });

  client.initialize();
}

async function sendMessage(phone, body) {
  if (!client) throw new Error('WhatsApp client not initialized');
  await client.sendMessage(phone, body);
}

function getQr() {
  return currentQr;
}

module.exports = { init, sendMessage, getQr };
