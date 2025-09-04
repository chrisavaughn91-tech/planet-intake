"use strict";

// src/sheets.js (CommonJS; Node 18+)
const axios = require("axios");

/**
 * Post the payload to a Google Apps Script Web App.
 * @param {string} execUrl - Full /exec URL, e.g.
 *   https://script.google.com/macros/s/AKfycbxvt86xnMFTqA--bwiRlp33TTAodKnPMXTsAYd1Pf-canbXfBpBz0i6cS0OJ3mbDoaZ/exec
 * @param {object} payload - JSON body the GAS doPost() expects
 * @returns {Promise<any>} parsed JSON or raw body
 */
async function pushToSheets(execUrl, payload) {
  if (!execUrl) throw new Error("Missing execUrl");
  const res = await axios.post(execUrl, payload, {
    headers: { "Content-Type": "application/json" },
    // axios will follow the script.google.com -> script.googleusercontent.com redirect
    maxRedirects: 5,
    validateStatus: s => s < 500
  });

  let data = res.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (_) {}
  }
  return data;
}

/**
 * Build the Apps Script payload from the scraper result and
 * call the Web App. Returns { url, ok }.
 * @param {{email:string, result:object}} opts
 */
async function createSheetAndShare({ email, result }) {
  const execUrl = process.env.GSCRIPT_WEBAPP_URL;
  if (!execUrl) throw new Error("GSCRIPT_WEBAPP_URL is not set (check your .env)");
  if (!result?.ok) throw new Error("Invalid scrape result");

  // ---- Summary rows (one per lead)
  const summaryRows = (result.leads || []).map((l) => ({
    badge: l.star || "",
    primaryName: l.primaryName || "",
    totalPremium: Number(l.monthlySpecialTotal || 0),
    listedCount: (l.clickToCall || []).length,
    extraPolicyCount: (l.policyPhones || []).length,
    allPoliciesLapsed: !!l.allPoliciesLapsed,
  }));

  // ---- Good numbers (flattened click-to-call)
  const goodNumbers = (result.clickToCall || []).map((r) => ({
    lead: r.primaryName || "",
    phone: r.phone || r.original || "",
  }));

  // ---- Flagged numbers (from both sources where a flag exists)
  const flaggedNumbers = [
    ...(result.clickToCall || []),
    ...(result.policyPhones || []),
  ]
    .filter((r) => (Array.isArray(r.flags) && r.flags.length) || r.flag)
    .map((r) => ({
      lead: r.primaryName || "",
      phone: r.phone || r.original || "",
      flag: Array.isArray(r.flags) ? r.flags.join(", ") : (r.flag || ""),
    }));

  // Optional: pass email along so Apps Script could share, if you enable it there
  const payload = {
    summaryRows,
    goodNumbers,
    flaggedNumbers,
    // shareEmail: email,   // enable this if you add sharing in Apps Script (see PATCH B)
  };

  const out = await pushToSheets(execUrl, payload);

  if (typeof out === "object" && out && "url" in out) {
    return { ok: out.ok !== false, url: out.url };
  }

  // Fallback if the script returned raw text
  try {
    const parsed = JSON.parse(String(out || "{}"));
    return { ok: parsed.ok !== false, url: parsed.url };
  } catch {
    return { ok: false, url: undefined };
  }
}

module.exports = { pushToSheets, createSheetAndShare };

