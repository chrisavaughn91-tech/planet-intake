// scripts/test-push.js
// Smoke test: POST a sample payload to your Apps Script Web App.
try { require('dotenv').config(); } catch {}

const { pushToSheets } = require('../src/sheets');

const EXEC_URL = process.env.GSCRIPT_WEBAPP_URL;
if (!EXEC_URL) {
  console.error('Missing GSCRIPT_WEBAPP_URL (set it in .env or export it in your shell).');
  process.exit(1);
}

const payload = {
  // optional: ask Apps Script to share the new sheet with this email
  shareEmail: process.env.REPORT_EMAIL || null,

  summaryRows: [
    ['⭐', 'Doe, John', 120.25, 2, 1],
    { lead: 'Smith, Jane', totalPremium: '$48.00', listedCount: 1, extraPolicyCount: 0 }
  ],
  goodNumbers: [
    ['John Doe', '555-0101'],
    { name: 'Jane Smith', phone: '555-0202' }
  ],
  flaggedNumbers: [
    ['John Doe', '555-0303', 'DNC'],
    { lead: 'Smith, Jane', number: '555-0404', flag: 'Bad/Disconnected' }
  ]
};

pushToSheets(EXEC_URL, payload)
  .then((out) => {
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  })
  .catch((err) => {
    console.error('FAILED:', err?.message || err);
    process.exit(1);
  });
