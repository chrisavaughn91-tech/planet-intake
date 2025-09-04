"use strict";

const axios = require("axios");

/**
 * Low-level helper: POST a payload directly to the Apps Script Web App.
 * Used by the smoke test (scripts/test-push.js).
 * @param {string} execUrl Full /exec URL
 * @param {object} payload JSON body
 * @returns {Promise<any>} parsed JSON or raw body
 */
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
  return [
    ["Primary Name", "Monthly Special Total", "Star", "ClickToCall Count", "PolicyPhones Count"],
    ...((leads || []).map((L) => [
      L.primaryName || "",
      Number(L.monthlySpecialTotal || 0),
      L.star || "",
      (L.clickToCall || []).length,
      (L.policyPhones || []).length, // already extras-only
    ])),
  ];
}

/* ---------- main entry ---------- */
async function createSheetAndShare({ email, result }) {
  // Prefer a pre-resolved echo URL if you set one; else use the /exec URL
  const webappUrl = process.env.GSCRIPT_REAL_URL || process.env.GSCRIPT_WEBAPP_URL;
  const sharedKey = process.env.GSCRIPT_SHARED_SECRET || ""; // optional

  if (!webappUrl) {
    throw new Error("Missing GSCRIPT_WEBAPP_URL (or GSCRIPT_REAL_URL) env var");
  }

  const payload = {
    email,
    title: `Planet Scrape — ${email} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
    summaryRows: buildSummaryRows(result.leads),
    allRows: buildAllNumbersRows(result.leads),
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

module.exports = { pushToSheets, createSheetAndShare };

