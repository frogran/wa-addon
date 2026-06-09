const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-8';

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function extractTasks(messageBody) {
  if (!messageBody || !messageBody.trim()) return [];
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: 'You are a task extraction assistant. Given a WhatsApp message received by the user, identify any explicit action items or requests the sender expects the user to act on. Return ONLY a JSON array of strings — each string is one task written in the original language of the message. Return [] if there are no tasks. Output only the JSON array, no explanation, no markdown.',
    messages: [{ role: 'user', content: messageBody }],
  });
  const text = response.content[0].text.trim();
  try {
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
    .map((m, i) => `[${i + 1}] From ${m.contactName}:\n${m.body}`)
    .join('\n\n');
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
}

module.exports = { extractTasks, extractTasksBatch };
