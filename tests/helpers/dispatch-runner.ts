import { sendOutreachEmail } from '../../src/lib/gmail/send-email';
import { initializeDatabase } from '../../src/db/migrate';

async function run() {
  const contactId = process.argv[2];
  initializeDatabase();
  const res = await sendOutreachEmail(contactId);
  console.log('DISPATCH_RESULT:' + JSON.stringify(res));
}

run().catch((err) => {
  console.error('DISPATCH_ERROR:' + (err?.message || err));
  process.exit(1);
});
