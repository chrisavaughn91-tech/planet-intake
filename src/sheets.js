"use strict";

// src/sheets.js (CommonJS; Node 18+)

/**
 * Post payload to an Apps Script Web App while preserving POST across redirects.
 * Handles Google's /echo -> /exec hop automatically.
 * @param {string} execUrl - The Apps Script Web App "exec" URL.
 * @param {object} payload - JSON serializable body.
 * @returns {Promise<object|string>} Parsed JSON or raw text.
 */
async function pushToSheets(execUrl, payload) {
  if (!execUrl) throw new Error("Missing execUrl");

  async function post(url, hops = 0) {
    if (hops > 6) throw new Error("Too many redirects");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",          // we will follow ourselves
    });

    // Follow Google’s bounce while keeping POST
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      let next = res.headers.get("location");
      if (!next) throw new Error("Redirect without Location header");
      // Apps Script’s first hop is often /echo; normalize to /exec
      next = next.replace("/echo?", "/exec?");
      return post(next, hops + 1);
    }

    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  return post(execUrl, 0);
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

