// scripts/test-push.js
const { pushToSheets } = require("../src/sheets");
const EXEC_URL = process.env.GSCRIPT_WEBAPP_URL; // set in .env

const payload = {
  summaryRows: [
    ["⭐","Doe, John",120.25,2,1],
    { lead: "Smith, Jane", totalPremium: "$48.00", listedCount: 1, extraPolicyCount: 0 }
  ],
  goodNumbers: [
    ["John Doe","555-0101"],
    { name: "Jane Smith", phone: "555-0202" }
  ],
  flaggedNumbers: [
    ["John Doe","555-0303","DNC"],
    { lead: "Smith, Jane", number: "555-0404", flag: "Bad/Disconnected" }
  ]
};

pushToSheets(EXEC_URL, payload)
  .then(out => { console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2)); })
  .catch(err => { console.error("FAILED:", err.message); process.exit(1); });

