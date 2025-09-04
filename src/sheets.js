"use strict";
const axios = require("axios");

// Low-level helper used by scripts/test-push.js
async function pushToSheets(execUrl, payload) {
  if (!execUrl) throw new Error("Missing execUrl");
  const res = await axios.post(execUrl, payload, {
    headers: { "Content-Type": "application/json" },
    // follow the script.google.com -> script.googleusercontent.com redirect
    maxRedirects: 5,
    validateStatus: s => s < 500,
    timeout: 120000,
  });
  let data = res.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (_) {}
  }
  return data;
}

/* ---------- row builders ---------- */
function buildAllNumbersRows(leads) {
  // A/B: valid unique numbers; C/D/E: flagged numbers
  const rows = [["Primary Name","Phone","Primary Name","Number","Flag"]];
  for (const L of (leads || [])) {
    const primary = L.primaryName || "";

    // If all policies are lapsed, put ALL numbers into flagged with "Lapsed"
    if (L.allPoliciesLapsed) {
      const seen = new Set();
      const pushLapsed = (r) => {
        if (!r) return;
        const key = `${r.rawDigits || r.original || r.phone || ""}|${r.extension || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        const raw = String(r.rawDigits || "");
        const isSeven = raw.length === 7;
        const sevenPretty = isSeven ? `${raw.slice(0,3)}-${raw.slice(3)}` : null;
        const phoneText = isSeven ? sevenPretty : (r.phone || r.rawDigits || r.original || "");
        rows.push(["","", primary, String(phoneText), "Lapsed"]);
      };
      (L.clickToCall || []).forEach(pushLapsed);
      (L.policyPhones || []).forEach(pushLapsed); // extras-only still fine here
      continue;
    }

    // Normal path: split into valid vs flagged
    const seenValid = new Set();
    const valid = [];
    const flagged = [];

    const consider = (r) => {
      if (!r) return;
      const raw = String(r.rawDigits || "");
      const isSeven = raw.length === 7;
      // Pretty for 7-digit in flagged view
      const sevenPretty = isSeven ? `${raw.slice(0,3)}-${raw.slice(3)}` : null;
      const phoneText = isSeven ? sevenPretty : (r.phone || r.rawDigits || r.original || "");

      const flagBits = [];
      if (r.international) flagBits.push("International");
      if (isSeven) flagBits.push("Needs area code");
      if (r.valid === false) flagBits.push("Invalid");
      if (flagBits.length > 0) {
        flagged.push([primary, String(phoneText), flagBits.join(", ")]);
        return;
      }
      // valid 10-digit; dedupe within this lead
      const key = `${raw}|${r.extension || ""}`;
      if (raw.length === 10 && !seenValid.has(key)) {
        seenValid.add(key);
        valid.push([primary, String(r.phone || r.rawDigits)]);
      }
    };

    (L.clickToCall || []).forEach(consider);
    (L.policyPhones || []).forEach(consider); // extras-only

    const n = Math.max(valid.length, flagged.length);
    for (let i = 0; i < n; i++) {
      const v = valid[i] || ["",""];
      const f = flagged[i] || ["","",""];
      rows.push([v[0], v[1], f[0], f[1], f[2]]);
    }
  }
  return rows;
}

function buildSummaryRows(leads) {
  // Expected layout (matches your sheet): Badge | Lead | Total Premium | Listed #s | + #s
  const header = ["Badge", "Lead", "Total Premium", "Listed #s", "+ #s"];
  const body = (leads || []).map((L) => [
    L.star || "",                            // Badge emoji
    L.primaryName || "",                     // Lead
    Number(L.monthlySpecialTotal || 0),      // Total Premium (number; Apps Script formats to currency)
    (L.clickToCall || []).length,            // Listed #s (ClickToCall count)
    (L.policyPhones || []).length,           // + #s (extras-only policy numbers)
  ]);
  return [header, ...body];
}

/**
 * Build arrays that match Code.gs expectations:
 *  - goodNumbers: [ [lead, phone], ... ]
 *  - flaggedNumbers: [ [lead, phone, flag], ... ]
 */
function buildGoodAndFlagged(leads) {
  const goodNumbers = [];
  const flaggedNumbers = [];

  for (const L of (leads || [])) {
    const primary = L.primaryName || "";

    const makeFlag = (r, base) => {
      const flags = [];
      if (base) flags.push(base);
      if (r?.international) flags.push("International");
      const raw = String(r?.rawDigits || r?.phone || "").replace(/\D/g, "");
      if (raw.length === 7) flags.push("Needs area code");
      if (r?.valid === false) flags.push("Invalid");
      return flags.join(", ");
    };

    const consider = (r, baseFlag = "") => {
      if (!r) return;
      const phone = r.phone || r.rawDigits || r.original || "";
      const raw10 = String(r.rawDigits || phone).replace(/\D/g, "");

      if (L.allPoliciesLapsed) {
        flaggedNumbers.push([primary, String(phone), "Lapsed"]);
        return;
      }

      const flag = makeFlag(r, baseFlag);
      if (flag) {
        flaggedNumbers.push([primary, String(phone), flag]);
      } else if (raw10.length === 10) {
        goodNumbers.push([primary, String(phone)]);
      } else {
        flaggedNumbers.push([primary, String(phone), "Invalid"]);
      }
    };

    // clickToCall set
    (L.clickToCall || []).forEach(r => consider(r, ""));
    // policyPhones are the extras-only; preserve any explicit flags from the scrape
    (L.policyPhones || []).forEach(r => {
      const base =
        Array.isArray(r?.flags) && r.flags.length ? r.flags.join(", ")
        : (r?.flag || "Extra");
      consider(r, base);
    });
  }

  return { goodNumbers, flaggedNumbers };
}

/* ---------- main entry ---------- */
async function createSheetAndShare({ email, result }) {
  // Prefer a pre-resolved echo URL if you set one; else use the /exec URL
  const webappUrl = process.env.GSCRIPT_REAL_URL || process.env.GSCRIPT_WEBAPP_URL;
  const sharedKey = process.env.GSCRIPT_SHARED_SECRET || ""; // optional

  if (!webappUrl) {
    throw new Error("Missing GSCRIPT_WEBAPP_URL (or GSCRIPT_REAL_URL) env var");
  }

  const { goodNumbers, flaggedNumbers } = buildGoodAndFlagged(result.leads);

  const payload = {
    email,
    title: `Planet Scrape — ${email} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
    summaryRows: buildSummaryRows(result.leads),
    allRows: buildAllNumbersRows(result.leads),  // optional; Apps Script ignores unknown keys
    goodNumbers,
    flaggedNumbers,
    ...(sharedKey ? { expectedKey: sharedKey, key: sharedKey } : {}),
  };

  // Post without following redirects; if 30x, extract Location or parse the HTML and re-post.
  const baseOpts = {
    timeout: 120000,
    headers: { "Content-Type": "application/json" },
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400, // accept 30x
  };

  let data;
  try {
    const r1 = await axios.post(webappUrl, payload, baseOpts);

    if (r1.status >= 300 && r1.status < 400) {
      let loc = r1.headers?.location || "";
      if (!loc && r1.data) {
        const html = String(r1.data);
        const m = html.match(/https:\/\/script\.googleusercontent\.com\/macros\/echo\?[^"'<> ]+/);
        if (m) loc = m[0].replace(/&amp;/g, "&");
      }
      if (!loc) throw new Error("Apps Script redirected but no Location found");

      // The echo URL must be fetched with GET (POST will 405)
      const r2 = await axios.get(loc, { timeout: 120000 });
      data = r2.data;
    } else {
      data = r1.data;
    }
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.statusText || err?.message || String(err);
    throw new Error(`Apps Script call failed${status ? ` (${status})` : ""}: ${msg}`);
  }

  if (!data || !data.ok) {
    throw new Error(`Apps Script failed: ${data && data.error ? data.error : "unknown error"}`);
  }

  return { spreadsheetId: data.spreadsheetId, url: data.url };
}

// Export BOTH helpers in a single CommonJS export.
// (Avoid mixing `exports.foo = ...` and `module.exports = ...`.)
module.exports = {
  pushToSheets,
  createSheetAndShare,
};

