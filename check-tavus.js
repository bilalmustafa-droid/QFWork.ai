// ============================================================
// Tavus configuration check — run:  node check-tavus.js
// ------------------------------------------------------------
// Reads the same .env the server uses and verifies that the API
// key is valid and that the configured personas belong to it.
//
// Personas are bound to the account that created them, so after
// changing TAVUS_API_KEY the persona ids must be regenerated with
// `node setup-tavus.js`.
// ============================================================

require('dotenv').config();
const fetch = require('node-fetch');

const key = process.env.TAVUS_API_KEY;
const configured = [
  { label: 'TAVUS_PERSONA_ID             ', id: process.env.TAVUS_PERSONA_ID },
  { label: 'TAVUS_PRESENTATION_PERSONA_ID', id: process.env.TAVUS_PRESENTATION_PERSONA_ID }
];

(async () => {
  if (!key) {
    console.log('TAVUS_API_KEY is not set in .env');
    process.exit(1);
  }

  console.log(`\nAPI key ending in ...${key.slice(-6)}`);
  console.log(`TAVUS_REPLICA_ID: ${process.env.TAVUS_REPLICA_ID || '(blank)'}\n`);

  const r = await fetch('https://tavusapi.com/v2/personas?persona_type=user&limit=100', { headers: { 'x-api-key': key } });
  if (!r.ok) {
    console.log(`Could not list personas (${r.status}): ${await r.text()}`);
    console.log('The API key itself is invalid or inactive for this account.');
    process.exit(1);
  }

  const data = await r.json();
  const personas = data.data || [];
  const ids = personas.map(p => p.persona_id);

  console.log(`This account owns ${personas.length} persona(s):`);
  personas.forEach(p => console.log(`  ${p.persona_id}  ${p.persona_name || ''}`));
  console.log('');

  let problems = 0;
  for (const c of configured) {
    if (!c.id) {
      console.log(`${c.label}  not set`);
      problems++;
    } else if (ids.includes(c.id)) {
      console.log(`${c.label}  ${c.id}  OK`);
    } else {
      console.log(`${c.label}  ${c.id}  NOT owned by this key`);
      problems++;
    }
  }

  if (problems) {
    console.log('\nRun "node setup-tavus.js" to create the personas for this account,');
    console.log('then copy the printed ids into .env and your host\'s environment variables.');
  }
  process.exit(problems ? 1 : 0);
})().catch(e => { console.log('Error:', e.message); process.exit(1); });
