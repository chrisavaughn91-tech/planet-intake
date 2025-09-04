// scripts/test-push.js — small smoke test to POST a sample payload to Apps Script
try { require("dotenv").config(); } catch {}
const mod = require("../src/sheets");
// Quick sanity check: should show ["pushToSheets","createSheetAndShare"]
// (Leave this log while debugging; remove later if you want.)
console.log("exports:", Object.keys(mod));
const { pushToSheets } = mod;

const EXEC_URL = process.env.GSCRIPT_WEBAPP_URL; // must end with /exec
if (!EXEC_URL) {
  console.error("GSCRIPT_WEBAPP_URL is missing. Put it in .env or export it in your shell.");
  process.exit(1);
}

const payload = {
  summaryRows: [
    ["⭐", "Doe, John", 120.25, 2, 1],
    { lead: "Smith, Jane", totalPremium: "$48.00", listedCount: 1, extraPolicyCount: 0 }
  ],
  goodNumbers: [
    ["John Doe", "555-0181"],
    { name: "Jane Smith", phone: "555-0202" }
  ],
  flaggedNumbers: [
    ["John Doe", "555-0830", "DNC"],
    { lead: "Smith, Jane", number: "555-0404", flag: "Bad/Disconnected" }
  ]
};

pushToSheets(EXEC_URL, payload)
  .then(out => {
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  })
  .catch(err => {
    console.error("FAILED:", err?.stack || err);
    process.exit(1);
  });

