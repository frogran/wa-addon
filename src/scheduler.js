const cron = require('node-cron');
const db = require('./db');

const MAX_ATTEMPTS = 3;

let isRunning = false;

async function tick(sendFn) {
  if (isRunning) return;
  isRunning = true;
  try {
    const due = db.getDueScheduledMessages();
    for (const msg of due) {
      try {
        await sendFn(msg.phone, msg.body);
        db.updateScheduledMessageStatus(msg.id, 'sent');
      } catch (err) {
        db.failScheduledMessage(msg.id, err.message, MAX_ATTEMPTS);
      }
    }
  } finally {
    isRunning = false;
  }
}

function init(sendFn) {
  cron.schedule('* * * * *', () => tick(sendFn).catch(err => {
    console.error('Scheduler tick error:', err.message);
  }));
  console.log('Scheduler started — checking every minute.');
}

module.exports = { init, tick };
