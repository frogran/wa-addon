const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const db = require('./db');
const llm = require('./llm');
const contactIntel = require('./contact-intel');

let client = null;
let currentQr = null;

function parseVCardPhone(vcard) {
  const waid = vcard.match(/waid=(\d+)/);
  if (waid) return '+' + waid[1];
  const tel = vcard.match(/TEL[^:]*:([+\d\s().-]+)/);
  return tel ? tel[1].replace(/\s/g, '').trim() : null;
}

function parseVCardName(vcard) {
  const m = vcard.match(/^FN:(.+)$/m);
  return m ? m[1].trim() : null;
}

function init() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './data/.wwebjs_auth' }),
    puppeteer: {
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
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
      const contactId = db.upsertContact(
        msg.from,
        contact.pushname || contact.name || msg.from
      );

      // Capture shared contacts (vCard messages)
      if (msg.type === 'contact_card' || msg.type === 'vcard') {
        const vcards = msg.vCards || [];
        if (vcards.length) {
          // Fetch the 2 most recent messages from this contact for context
          const context = db.getLastMessagesFromContact(contactId, 2);
          vcards.forEach((vcard) => {
            const phone = parseVCardPhone(vcard);
            const name = parseVCardName(vcard);
            if (phone) db.createSharedContact(phone, name, contactId, null, context);
          });
        }
        return;
      }

      if (!msg.body) return;

      const msgId = db.insertMessage(
        contactId,
        'in',
        msg.body,
        Math.floor(msg.timestamp),
        msg.id.id
      );

      if (msgId) {
        llm.extractTasks(msg.body)
          .then((tasks) => tasks.forEach((body) => db.createTask(contactId, msgId, body)))
          .catch((err) => console.error('Task extraction error:', err.message));
      }

      // Refresh contact profile every 5th inbound message from this contact
      const inboundCount = db.getContactInboundCount(contactId);
      if (inboundCount > 0 && inboundCount % 5 === 0) {
        contactIntel.refreshContact(contactId)
          .catch(err => console.error('Contact refresh error:', err.message));
      }

      // Refresh user writing style profile every 20th outbound message overall
      const outboundCount = db.getOutboundCount();
      if (outboundCount > 0 && outboundCount % 20 === 0) {
        contactIntel.refreshUserProfile()
          .catch(err => console.error('User profile refresh error:', err.message));
      }
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

function getChats() {
  if (!client) throw new Error('WhatsApp client not initialized');
  return client.getChats();
}

module.exports = { init, sendMessage, getQr, getChats };
