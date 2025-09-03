const axios = require("axios");

/* ---------- helpers ---------- */
function digitsOnly(s) { return String(s || "").replace(/\D/g, ""); }
function isTenDigitUS(r) {
  const d = digitsOnly(r.rawDigits || r.phone || r.original);
  return d.length === 10 && r.valid !== false;
}
function isSevenDigit(r) {
  const d = digitsOnly(r.rawDigits || r.phone || r.original);
  return d.length === 7;
}
function normKeyWithExt(r) {
  const d = digitsOnly(r.rawDigits || r.phone || r.original);
  const ext = r.extension ? String(r.extension) : "";
  return `${d}|${ext}`;
}

/* ---------- row builders ---------- */
function buildAllNumbersRows(leads) {
  const rows = [["Primary Name", "Phone"]];
  const seen = new Set();

  for (const L of (leads || [])) {
    const primary = (L.primaryName && String(L.primaryName).trim()) || "(Unknown Lead)";

    const push = (r) => {
      if (!r) return;
      if (!isTenDigitUS(r)) return; // drop invalids & 7-digit
      const key = normKeyWithExt(r);
      if (seen.has(key)) return;
      seen.add(key);

      const out = r.phone || r.rawDigits || r.original || "";
      if (!out) return;
      rows.push([primary, String(out)]);
    };

    (L.clickToCall || []).forEach(push);
    (L.policyPhones || []).forEach(push);
  }
  return rows;
}

function buildNeedsAreaRows(leads) {
  const rows = [["Primary Name", "Phone (7-digit)"]];
  const seen = new Set();

  for (const L of (leads || [])) {
    const primary = (L.primaryName && String(L.primaryName).trim()) || "(Unknown Lead)";
    const push = (r) => {
      if (!r) return;
      if (!isSevenDigit(r)) return;
      const key = normKeyWithExt(r);
      if (seen.has(key)) return;
      seen.add(key);
      const out = r.phone || r.rawDigits || r.original || "";
      if (!out) return;
      rows.push([primary, String(out)]);
    };
    (L.clickToCall || []).forEach(push);
    (L.policyPhones || []).forEach(push);
  }
  return rows;
}

function buildDetailsRows(leads) {
  const rows = [["Primary Name","Phone","Source","Extension","Flags","RawDigits","Original"]];
  const seen = new Set();

  for (const L of (leads || [])) {
    const primary = (L.primaryName && String(L.primaryName).trim()) || "(Unknown Lead)";
    const push = (r) => {
      if (!r) return;
      const key = normKeyWithExt(r) + "|" + (r.source || r.lineType || "");
      if (seen.has(key)) return;
      seen.add(key);
      const phoneOut = r.phone || r.rawDigits || r.original || "";
      rows.push([
        primary,
        String(phoneOut || ""),
        String(r.source || r.lineType || ""),
        r.extension ? String(r.extension) : "",
        Array.isArray(r.flags) ? r.flags.join(", ") : String(r.flag || ""),
        String(r.rawDigits || ""),
        String(r.original || "")
      ]);
    };

    (L.clickToCall || []).forEach(push);
    (L.policyPhones || []).forEach(push);
  }
  return rows;
}

/* ---------- main entry ---------- */
exports.createSheetAndShare = async function createSheetAndShare({ email, result }) {
  const webappUrl = process.env.GSCRIPT_REAL_URL || process.env.GSCRIPT_WEBAPP_URL;
  const sharedKey  = process.env.GSCRIPT_SHARED_SECRET || "";
  if (!webappUrl) throw new Error("Missing GSCRIPT_WEBAPP_URL (or GSCRIPT_REAL_URL)");

  const payload = {
    email,
    title: `Planet Scrape — ${email} — ${new Date().toISOString().replace("T"," ").slice(0,19)}`,
    summaryRows: (result && Array.isArray(result.leads)) ? [
      ["Primary Name","Monthly Special Total","Star","ClickToCall Count","PolicyPhones Count"],
      ...result.leads.map(L => [
        (L.primaryName && String(L.primaryName).trim()) || "(Unknown Lead)",
        Number(L.monthlySpecialTotal || 0),
        L.star || "",
        Array.isArray(L.clickToCall) ? L.clickToCall.length : 0,
        Array.isArray(L.policyPhones) ? L.policyPhones.length : 0,
      ])
    ] : [["Primary Name","Monthly Special Total","Star","ClickToCall Count","PolicyPhones Count"]],
    allRows: buildAllNumbersRows(result.leads),
    needsAreaRows: buildNeedsAreaRows(result.leads),
    detailsRows: buildDetailsRows(result.leads),
    ...(sharedKey ? { expectedKey: sharedKey, key: sharedKey } : {})
  };

  const baseOpts = {
    timeout: 120000,
    headers: { "Content-Type": "application/json" },
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400
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

  return { spreadsheetId: data.spreadsheetId, url: data.url, csvUrl: data.csvUrl || null };
};

module.exports = {
  ...module.exports,
  buildAllNumbersRows,
  buildNeedsAreaRows,
  buildDetailsRows
};

