import { createInvite, getParticipantByCode } from '../server/db.js';

async function run() {
  for (let i = 0; i < 10; i++) {
    try {
      const invite = await createInvite({ groupAssignment: 'control' });
      const code = invite.participantCode;
      const participant = await getParticipantByCode(code);
      console.log(`Invite ${i + 1}: code=${code} readingOrder=${participant.readingOrder}`);
    } catch (err) {
      console.error('Error creating invite', err);
    }
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
