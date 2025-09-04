const axios = require("axios");

/* ---------- row builders ---------- */
function buildAllNumbersRows(leads) {
  // Two parallel lists: valid NANP (10-digit) vs 7-digit "Needs Area Code"
  const header = [
    "Primary Name", "Phone",
    "Primary Name (Needs Area Code)", "Phone (Needs Area Code)"
  ];
  const rows = [header];

  for (const L of (leads || [])) {
    const primary = L.primaryName || "";
    const seenValid = new Set();
    const seenShort = new Set();
    const valid = [];
    const short = [];

    const visit = (r) => {
      const key = `${r.rawDigits || r.original || r.phone || ""}|${r.extension || ""}`;
      const is10 = /^\d{10}$/.test(String(r.rawDigits || ""));
      const is7  = /^\d{7}$/.test(String(r.rawDigits || ""));
      if (is10) {
        if (seenValid.has(key)) return;
        seenValid.add(key);
        valid.push(String(r.phone || "")); // pretty only
      } else if (is7) {
        if (seenShort.has(key)) return;
        seenShort.add(key);
        // pretty for 7-digit already set as xxx-xxxx in scraper
        short.push(String(r.phone || ""));
      }
    };

    (L.clickToCall || []).forEach(visit);
    (L.policyPhones || []).forEach(visit);

    const maxLen = Math.max(valid.length, short.length, 1);
    for (let i = 0; i < maxLen; i++) {
      rows.push([
        i < valid.length ? primary : "",
        i < valid.length ? valid[i] : "",
        i < short.length ? primary : "",
        i < short.length ? short[i] : ""
      ]);
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
      (L.policyPhones || []).length,
    ])),
  ];
}

/* ---------- main entry ---------- */
exports.createSheetAndShare = async function createSheetAndShare({ email, result }) {
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
};
