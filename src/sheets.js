"use strict";

const axios = require("axios");

/* ---------- low-level poster (used by tests and by createSheetAndShare) ---------- */
async function pushToSheets(execUrl, payload) {
  if (!execUrl) throw new Error("Missing execUrl");

  // Post without following redirects; if 30x, extract Location or parse HTML and then GET the echo URL
  const baseOpts = {
    timeout: 120000,
    headers: { "Content-Type": "application/json" },
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400, // accept 30x
  };

  let data;
  const r1 = await axios.post(execUrl, payload, baseOpts);
  if (r1.status >= 300 && r1.status < 400) {
    let loc = r1.headers?.location || "";
    if (!loc && r1.data) {
      const html = String(r1.data);
      const m = html.match(/https:\/\/script\.googleusercontent\.com\/macros\/echo\?[^"'<> ]+/);
      if (m) loc = m[0].replace(/&amp;/g, "&");
    }
    if (!loc) throw new Error("Apps Script redirected but no Location found");
    const r2 = await axios.get(loc, { timeout: 120000 });
    data = r2.data;
  } else {
    data = r1.data;
  }

  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch {}
  }
  return data;
}

/**
 * Build the Apps Script payload from the scraper result and call the Web App.
 * Returns { ok, url } on success.
 * @param {{email?:string, result:object}} opts
 */
async function createSheetAndShare({ email, result }) {
  // Prefer a pre-resolved echo URL if you set one; else use the /exec URL
  const webappUrl = process.env.GSCRIPT_REAL_URL || process.env.GSCRIPT_WEBAPP_URL;
  const sharedKey = process.env.GSCRIPT_SHARED_SECRET || ""; // optional
  if (!webappUrl) throw new Error("GSCRIPT_WEBAPP_URL is not set (check your .env)");
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
    sharedKey,
    // shareEmail: email, // enable if you've added sharing logic in Apps Script
  };

  let data;
  try {
    data = await pushToSheets(webappUrl, payload);
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

// Export the low-level poster for tests and tools
module.exports = { pushToSheets, createSheetAndShare };

