const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-8';

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function extractTasks(messageBody) {
  if (!messageBody || !messageBody.trim()) return [];
  const client = getClient();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: 'You are a task extraction assistant. Given a WhatsApp message received by the user, identify any explicit action items or requests the sender expects the user to act on. Return ONLY a JSON array of strings — each string is one task written in the original language of the message. Return [] if there are no tasks. Output only the JSON array, no explanation, no markdown.',
      messages: [{ role: 'user', content: messageBody }],
    });
    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function extractTasksBatch(messages) {
  if (!messages.length) return {};
  const client = getClient();
  const numbered = messages
    .map((m, i) => `[${i + 1}] From ${m.contactName.replace(/[\r\n]/g, ' ')}:\n${m.body}`)
    .join('\n\n');
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: 'You are a task extraction assistant. Given a numbered list of WhatsApp messages received by the user, identify any explicit action items or requests the sender expects the user to act on. Return ONLY a JSON object mapping each message number (as a string key) to an array of task strings in the original language of that message. Use empty arrays for messages with no tasks. Output only the JSON object, no explanation, no markdown.',
      messages: [{ role: 'user', content: numbered }],
    });
    const text = response.content[0].text.trim();
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error('extractTasksBatch: Claude returned non-JSON:', text.slice(0, 100));
    }
    const result = {};
    messages.forEach((m, i) => {
      const key = String(i + 1);
      result[m.id] = Array.isArray(parsed[key]) ? parsed[key] : [];
    });
    return result;
  } catch (err) {
    console.error('extractTasksBatch API error:', err.message);
    const result = {};
    messages.forEach(m => { result[m.id] = []; });
    return result;
  }
}

async function buildContactProfile(messages, existingProfile) {
  if (!messages.length && !existingProfile) return null;
  const client = getClient();
  const existing = existingProfile && existingProfile.summary
    ? `\n\nExisting profile:\nRELATIONSHIP_SUMMARY:\n${existingProfile.summary}\n\nSTYLE_TO_CONTACT:\n${existingProfile.style}`
    : '';
  const history = messages.map(m =>
    `[${m.direction === 'out' ? 'You' : 'Them'}] ${m.body}`
  ).join('\n');
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `You are building a relationship and communication profile for a WhatsApp contact.
You will be given the existing profile (if any) and the full message history with this contact.

Update and enrich the profile — never remove existing observations unless you have clear evidence they are wrong.
Only add, refine, or strengthen. The profile has two parts:

RELATIONSHIP SUMMARY: Who is this person? What is the relationship? What do they typically want?
What topics come up? What is their tone? Be concrete and specific — avoid generic labels.
Include memorable details if any emerge.

STYLE TO CONTACT: How does the user specifically write to this person?
Note: formality level, language (Hebrew / English / mixed), emoji use, typical reply length,
recurring phrases or expressions lifted from the sent messages.

Respond in this exact format:
RELATIONSHIP_SUMMARY:
<text>

STYLE_TO_CONTACT:
<text>

LANGUAGE: <en|he|mixed>

CATEGORY: <fan|colleague|press|family|other>`,
      messages: [{ role: 'user', content: `Message history:${existing}\n\n${history}` }],
    });
    const text = response.content[0].text;
    const summary = (text.match(/RELATIONSHIP_SUMMARY:\s*([\s\S]*?)(?=\n+STYLE_TO_CONTACT:|$)/) || [])[1]?.trim() || '';
    const style = (text.match(/STYLE_TO_CONTACT:\s*([\s\S]*?)(?=\n+LANGUAGE:|$)/) || [])[1]?.trim() || '';
    const language = (text.match(/LANGUAGE:\s*([a-zA-Z]+)/) || [])[1]?.toLowerCase() || 'en';
    const category = (text.match(/CATEGORY:\s*([a-zA-Z]+)/) || [])[1]?.toLowerCase() || 'other';
    if (!summary) return null;
    return { summary, style, language, category };
  } catch (err) {
    console.error('buildContactProfile error:', err.message);
    return null;
  }
}

async function buildUserProfile(outgoingMessages, existingProfile) {
  if (!outgoingMessages.length) return null;
  const client = getClient();
  const existing = existingProfile ? `\n\nExisting style profile:\n${existingProfile}` : '';
  const sample = outgoingMessages.map(m => `To ${m.contact_name}: ${m.body}`).join('\n');
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `You are building a profile of a WhatsApp user's communication style.
You will be given their existing style profile (if any) and a sample of messages they have sent.

Enrich the profile — add new patterns, confirm existing ones.
Note code-switching between Hebrew and English, emoji habits, typical reply lengths,
tone variation across different types of contacts, recurring phrases.
Never delete prior observations — only add and refine.

Respond with a single prose profile (2-4 paragraphs). Be specific and concrete.`,
      messages: [{ role: 'user', content: `Sent messages:${existing}\n\n${sample}` }],
    });
    return response.content[0].text.trim() || null;
  } catch (err) {
    console.error('buildUserProfile error:', err.message);
    return null;
  }
}

module.exports = { extractTasks, extractTasksBatch, buildContactProfile, buildUserProfile };
