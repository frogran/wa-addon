const db = require('./db');
const llm = require('./llm');

let isRunning = false;

async function refreshContact(contactId) {
  const messages = db.getContactMessages(contactId);
  if (!messages.length) return;
  const existing = db.getContactProfile(contactId);
  const existingArg = existing && existing.summary ? existing : null;
  const profile = await llm.buildContactProfile(messages, existingArg);
  if (!profile) return;
  db.updateContactProfile(contactId, profile.summary, profile.style, profile.language, profile.category);
}

async function refreshUserProfile() {
  const messages = db.getOutgoingMessagesSample(50);
  const profile = db.getProfile();
  const globalStyle = await llm.buildUserProfile(messages, profile ? profile.global_style : null);
  if (!globalStyle) return;
  db.updateProfile(globalStyle);
}

async function seedAll() {
  if (isRunning) return;
  isRunning = true;
  const prevStatus = db.getSetting('intel_status');
  if (prevStatus !== 'error') {
    db.setSetting('intel_last_seeded_contact_id', '0');
    db.setSetting('intel_processed', '0');
  }
  db.setSetting('intel_status', 'running');
  try {
    const contacts = db.getContactsToSeed(0, 9999);
    db.setSetting('intel_total', String(contacts.length));
    let lastId = parseInt(db.getSetting('intel_last_seeded_contact_id') || '0', 10);
    let processed = parseInt(db.getSetting('intel_processed') || '0', 10);
    for (const contact of contacts) {
      if (contact.id <= lastId) continue;
      await refreshContact(contact.id);
      lastId = contact.id;
      processed++;
      db.setSetting('intel_last_seeded_contact_id', String(lastId));
      db.setSetting('intel_processed', String(processed));
    }
    await refreshUserProfile();
    db.setSetting('intel_status', 'done');
  } catch (err) {
    console.error('seedAll error:', err.message);
    db.setSetting('intel_status', 'error');
  } finally {
    isRunning = false;
  }
}

module.exports = { seedAll, refreshContact, refreshUserProfile };
