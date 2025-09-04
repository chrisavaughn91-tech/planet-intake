"use strict";

const axios = require("axios");

/**
 * POST payload to a Google Apps Script Web App endpoint.
 * Handles the initial 302 redirect by re-POSTing to the Location.
 * @param {string} execUrl - Full /exec URL
 * @param {object} payload - JSON body the GAS doPost() expects
 * @returns {Promise<any>} Parsed JSON (or raw text) from Apps Script
 */
async function pushToSheets(execUrl, payload) {
  if (!execUrl) throw new Error("Missing execUrl");

  // 1) Try the direct /exec POST WITHOUT following redirects
  const first = await axios.post(execUrl, payload, {
    headers: { "Content-Type": "application/json" },
    maxRedirects: 0,
    // accept 302 so we can manually follow it
    validateStatus: (s) => (s >= 200 && s < 300) || s === 302,
  });

  // 2) If Apps Script responded with a 302, manually POST to the Location
  if (first.status === 302 && first.headers?.location) {
    const second = await axios.post(first.headers.location, payload, {
      headers: { "Content-Type": "application/json" },
      // allow normal redirects after this point
    });
    return normalize(second.data);
  }

  // 3) Normal 2xx response
  return normalize(first.data);
}

function normalize(data) {
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

/**
 * Build the Apps Script payload from the scraper result and call the Web App.
 * Returns { ok, url } on success.
 * @param {{email?:string, result:object}} opts
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

  const payload = {
    summaryRows,
    goodNumbers,
    flaggedNumbers,
    // shareEmail: email, // enable if you've added sharing logic in Apps Script
  };

  const out = await pushToSheets(execUrl, payload);

  if (out && typeof out === "object" && "url" in out) {
    return { ok: out.ok !== false, url: out.url };
  }
  try {
    const parsed = JSON.parse(String(out || ""));
    return { ok: parsed.ok !== false, url: parsed.url };
  } catch {
    return { ok: false, url: undefined };
  }
}

module.exports = { pushToSheets, createSheetAndShare };

