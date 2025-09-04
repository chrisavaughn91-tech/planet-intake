const axios = require("axios");

/* ---------- row builders ---------- */
function buildAllNumbersRows(leads) {
  // A–B: valid NANP (10-digit) pretty; C–E: flagged numbers (primary | number | flag)
  const header = [
    "Primary Name", "Phone",
    "Primary Name (Flagged)", "Phone (Flagged)", "Flag Reason"
  ];
  const rows = [header];

  for (const L of (leads || [])) {
    const primary = L.primaryName || "";
    const seenValid = new Set();
    const seenFlag  = new Set();
    const valid = [];
    const flagged = []; // { phone, flag }

    const visit = (r) => {
      const key = `${r.rawDigits || r.original || r.phone || ""}|${r.extension || ""}`;
      const rd  = String(r.rawDigits || "");
      const is10 = /^\d{10}$/.test(rd);
      const is7  = /^\d{7}$/.test(rd);
      const numberStr = String(r.phone || r.rawDigits || r.original || "");

      if (is10 && r.valid) {
        if (seenValid.has(key)) return;
        seenValid.add(key);
        valid.push(numberStr); // pretty only
      } else {
        if (seenFlag.has(key)) return;
        seenFlag.add(key);
        // Choose flag reason
        let reason = "Invalid";
        if (is7) reason = "Needs Area Code";
        else if (r.international) reason = "International";
        else if (r.flags && r.flags.length) reason = r.flags[0];
        flagged.push({ phone: numberStr, flag: String(reason) });
      }
    };

    (L.clickToCall || []).forEach(visit);
    (L.policyPhones || []).forEach(visit);

    const maxLen = Math.max(valid.length, flagged.length, 1);
    for (let i = 0; i < maxLen; i++) {
      rows.push([
        i < valid.length   ? primary : "",
        i < valid.length   ? valid[i] : "",
        i < flagged.length ? primary : "",
        i < flagged.length ? flagged[i].phone : "",
        i < flagged.length ? flagged[i].flag  : ""
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
