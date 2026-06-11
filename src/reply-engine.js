const db = require('./db');
const llm = require('./llm');

async function generateForMessage(contactId, messageId) {
  const contact = db.getContactDetail(contactId);
  if (!contact) return;
  const allMessages = db.getContactMessages(contactId);
  const messages = allMessages.slice(-contact.reply_context_messages);
  const contactProfile = db.getContactProfile(contactId);
  const userProfile = db.getProfile();
  const settings = {
    length: contact.reply_length,
    tone: contact.reply_tone,
    language: contact.reply_language,
    emoji: contact.reply_emoji,
    greeting: contact.reply_greeting,
  };
  const suggestions = await llm.buildReplySuggestions(
    messages,
    contactProfile,
    userProfile ? userProfile.global_style : null,
    settings
  );
  if (!suggestions) {
    db.markSuggestionFailed(messageId);
    return;
  }
  db.storeSuggestions(messageId, contactId, suggestions[0], suggestions[1], suggestions[2]);
}

async function generateBatch(limit = 20) {
  const messages = db.getInboxMessages().filter(
    m => m.suggestion_status === null || m.suggestion_status === 'failed'
  );
  const toGenerate = messages.slice(0, limit);
  for (const msg of toGenerate) {
    db.ensureSuggestionRow(msg.message_id, msg.contact_id);
    generateForMessage(msg.contact_id, msg.message_id)
      .catch(err => console.error('generateForMessage error:', err.message));
  }
}

module.exports = { generateForMessage, generateBatch };
