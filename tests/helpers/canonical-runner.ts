import fs from 'fs';
import { reconstructCanonicalContacts, isBlankOrContinuationCompany } from '../../src/lib/pipeline/canonical-ingestion';

const action = process.argv[2];
const inputJson = fs.readFileSync(0, 'utf-8');

if (action === 'isBlank') {
  const parsed = JSON.parse(inputJson);
  const result = isBlankOrContinuationCompany(parsed);
  console.log('OUTPUT:' + JSON.stringify(result));
} else if (action === 'reconstruct') {
  const records = JSON.parse(inputJson);
  const result = reconstructCanonicalContacts(records);
  console.log('OUTPUT:' + JSON.stringify(result));
} else {
  console.error('Unknown action');
  process.exit(1);
}
