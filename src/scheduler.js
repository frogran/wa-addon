const cron = require('node-cron');
const db = require('./db');

const MAX_ATTEMPTS = 3;

async function tick(sendFn) {
  const due = db.getDueScheduledMessages();
  for (const msg of due) {
    try {
      await sendFn(msg.phone, msg.body);
      db.updateScheduledMessageStatus(msg.id, 'sent');
    } catch (err) {
      const newCount = msg.attempt_count + 1;
      db.incrementAttemptCount(msg.id);
      if (newCount >= MAX_ATTEMPTS) {
        db.updateScheduledMessageStatus(msg.id, 'failed', err.message);
      }
    }
  }
}

function init(sendFn) {
  cron.schedule('* * * * *', () => tick(sendFn).catch(err => {
    console.error('Scheduler tick error:', err.message);
  }));
  console.log('Scheduler started — checking every minute.');
}

module.exports = { init, tick };
