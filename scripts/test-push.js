// scripts/test-push.js — Apps Script smoke test using the *production* path
try { require('dotenv').config(); } catch {}
const { createSheetAndShare } = require("../src/sheets");

const EXEC_URL = process.env.GSCRIPT_WEBAPP_URL; // required by createSheetAndShare internally
const EMAIL    = process.env.REPORT_EMAIL || process.env.TEST_EMAIL;

if (!EXEC_URL) {
  console.error("GSCRIPT_WEBAPP_URL is missing from .env");
  process.exit(1);
}
if (!EMAIL) {
  console.error("REPORT_EMAIL (or TEST_EMAIL) is missing from .env");
  process.exit(1);
}

// Build a realistic `result` (same shape returned by scrapePlanet)
const result = {
  ok: true,
  leads: [
    {
      primaryName: "DOE, JOHN",
      monthlySpecialTotal: 120.25,
      star: "⭐",
      clickToCall: [
        { original: "(614) 555-1212", rawDigits: "6145551212", phone: "(614) 555-1212", valid: true,  flags: [] },
        { original: "555-0181",       rawDigits: "5550181",    phone: "555-0181",       valid: false, flags: ["Needs Area Code"] }
      ],
      policyPhones: [
        { original: "(614) 555-4000", rawDigits: "6145554000", phone: "(614) 555-4000", valid: true,  flags: ["Home"] }
      ],
      allPoliciesLapsed: false
    },
    {
      primaryName: "SMITH, JANE",
      monthlySpecialTotal: 48.00,
      star: "🟣",
      clickToCall: [
        { original: "555-0202", rawDigits: "5550202", phone: "555-0202", valid: false, flags: ["Needs Area Code"] }
      ],
      policyPhones: [],
      allPoliciesLapsed: false
    }
  ],
  clickToCall: [],
  policyPhones: [],
  meta: {
    ts: new Date().toISOString(),
    leadCount: 2,
    sumMonthlyAcrossLeads: 168.25
  }
};

// Call the same function the server uses
createSheetAndShare({ email: EMAIL, result })
  .then(({ url, spreadsheetId, counts }) => {
    console.log("OK:", { url, spreadsheetId, counts });
    process.exit(0);
  })
  .catch(err => {
    console.error("FAILED:", err?.stack || err);
    process.exit(1);
  });

