import { createInvite, getParticipantByCode } from '../server/db.js';

function randomizeReadingOrderForControl() {
  return Math.random() < 0.5 ? 'withdrawal_first' : 'confrontation_first';
}

async function run() {
  for (let i = 0; i < 10; i++) {
    const groupAssignment = 'control';
    const readingOrder = randomizeReadingOrderForControl();
    try {
      const invite = await createInvite({ groupAssignment, readingOrder });
      const participant = await getParticipantByCode(invite.participantCode);
      console.log(`Invite ${i + 1}: code=${invite.participantCode} readingOrder=${participant.readingOrder}`);
    } catch (err) {
      console.error('Error', err);
    }
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
