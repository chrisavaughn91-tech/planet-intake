// scripts/test-push.js
// Tiny smoke test that posts sample data to your Apps Script Web App
// Reads GSCRIPT_WEBAPP_URL from .env (and supports shell export too).
try { require('dotenv').config(); } catch {}

const { pushToSheets } = require("../src/sheets");

const EXEC_URL = process.env.GSCRIPT_WEBAPP_URL; // must end with /exec
if (!EXEC_URL) {
  console.error("Missing GSCRIPT_WEBAPP_URL (set it in .env or export it in your shell)");
  process.exit(1);
}

const payload = {
  summaryRows: [
    ["⭐", "DOE, JOHN", 120.25, 2, 1],
    { lead: "SMITH, JANE", totalPremium: "$48.00", listedCount: 1, extraPolicyCount: 0 }
  ],
  goodNumbers: [
    ["John Doe", "555-0101"],
    { name: "Jane Smith", phone: "555-0202" }
  ],
  flaggedNumbers: [
    ["John Doe", "555-0303", "DNC"],
    { lead: "Smith, Jane", number: "555-0404", flag: "Bad/Disconnected" }
  ]
};

pushToSheets(EXEC_URL, payload)
  .then((out) => {
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  })
  .catch((err) => {
    console.error("FAILED:", err?.message || err);
    process.exit(1);
  });

