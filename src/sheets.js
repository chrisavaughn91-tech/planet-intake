import axios from "axios";

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
  // BODY ONLY (no header row) — Code.gs writes headers and formatting
  return (leads || []).map((L) => [
    L.star || "",                            // Badge emoji
    L.primaryName || "",                     // Lead
    Number(L.monthlySpecialTotal || 0),      // Total Premium
    (L.clickToCall || []).length,            // Listed #’s (ClickToCall count)
    (L.policyPhones || []).length,           // + Policy #’s (extras-only policy numbers)
  ]);
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

    const consider = (r) => {
      if (!r) return;
      const phone = r.phone || r.rawDigits || r.original || "";
      const raw = String(r.rawDigits || phone).replace(/\D/g, "");

      // If ALL policies lapsed for this lead, everything is flagged "Lapsed"
      if (L.allPoliciesLapsed) {
        flaggedNumbers.push([primary, String(phone), "Lapsed"]);
        return;
      }

      // Build flags WITHOUT "Extra" (policy extras treated like normal numbers)
      const flags = [];
      if (r.international) flags.push("International");
      if (raw.length === 7) flags.push("Needs area code");
      if (r.valid === false) flags.push("Invalid");
      if (Array.isArray(r.flags) && r.flags.some(f => /fax/i.test(String(f)))) flags.push("Fax");

      if (flags.length > 0) {
        flaggedNumbers.push([primary, String(phone), flags.join(", ")]);
      } else if (raw.length === 10) {
        goodNumbers.push([primary, String(phone)]);
      } else {
        flaggedNumbers.push([primary, String(phone), "Invalid"]);
      }
    };

    (L.clickToCall || []).forEach(consider);
    (L.policyPhones || []).forEach(consider); // extras-only — no "Extra" flag anymore
  }

  return { goodNumbers, flaggedNumbers };
}

/* ---------- lightweight counts for server toast/statistics ---------- */
function computeCounts(leads) {
  const out = {
    totals: {
      leads: 0,
      premiumSum: 0,
      listedNumbers: 0,
      policyNumbers: 0,
      lapsedLeads: 0,
    },
    badges: { star: 0, white: 0, purple: 0, orange: 0, red: 0 },
  };

  for (const L of (leads || [])) {
    out.totals.leads += 1;
    out.totals.premiumSum += Number(L.monthlySpecialTotal || 0);
    out.totals.listedNumbers += (L.clickToCall || []).length;
    out.totals.policyNumbers += (L.policyPhones || []).length;
    if (L.allPoliciesLapsed) out.totals.lapsedLeads += 1;

    const badge =
      L.star === "⭐" ? "star" :
      L.star === "🟣" ? "purple" :
      L.star === "🟠" ? "orange" :
      L.star === "🔴" ? "red" : "white";
    out.badges[badge] = (out.badges[badge] || 0) + 1;
  }

  // Round premiumSum to 2 decimals
  out.totals.premiumSum = Math.round(out.totals.premiumSum * 100) / 100;
  return out;
}

/* ---------- main entry ---------- */
async function createSheetAndShare({ email, result }) {
  const webappUrl = process.env.GSCRIPT_REAL_URL || process.env.GSCRIPT_WEBAPP_URL;
  const sharedKey = process.env.GSCRIPT_SHARED_SECRET || ""; // optional
  if (!webappUrl) throw new Error("Missing GSCRIPT_WEBAPP_URL (or GSCRIPT_REAL_URL) env var");

  // tiny helpers for retry
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTransient = (err) => {
    const code = err?.code || "";
    const status = err?.response?.status || 0;
    return status >= 500 || ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"].includes(code);
  };

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

  // Post without following redirects; if 30x, extract Location or parse the HTML and re-GET.
  const baseOpts = {
    timeout: 120000,
    headers: { "Content-Type": "application/json" },
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400, // accept 30x
  };

  async function singleAttempt() {
    const r1 = await axios.post(webappUrl, payload, baseOpts);

    if (r1.status >= 300 && r1.status < 400) {
      let loc = r1.headers?.location || "";
      if (!loc && r1.data) {
        const html = String(r1.data);
        const m = html.match(/https:\/\/script\.googleusercontent\.com\/macros\/echo\?[^"'<> ]+/);
        if (m) loc = m[0].replace(/&amp;/g, "&");
      }
      if (!loc) throw new Error("Apps Script redirected but no Location found");

      // The echo URL must be fetched with GET (POST would 405)
      const r2 = await axios.get(loc, { timeout: 120000 });
      return r2.data;
    }
    return r1.data;
  }

  let data;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await singleAttempt();
      break;
    } catch (err) {
      if (attempt === 0 && isTransient(err)) {
        await sleep(600); // brief backoff, then exactly one retry
        continue;
      }
      const status = err?.response?.status;
      const msg = err?.response?.statusText || err?.message || String(err);
      throw new Error(`Apps Script call failed${status ? ` (${status})` : ""}: ${msg}`);
    }
  }

  if (!data || !data.ok) {
    throw new Error(`Apps Script failed: ${data && data.error ? data.error : "unknown error"}`);
  }

  // Augment with local counts for server/UI toast
  const counts = computeCounts(result.leads);

  return { spreadsheetId: data.spreadsheetId, url: data.url, counts };
}

// Export in ESM style
export { pushToSheets, createSheetAndShare };
