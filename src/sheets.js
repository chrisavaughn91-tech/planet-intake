const axios = require("axios");

function buildAllNumbersSheet(allRows) {
  const header = [
    "⭐", "Primary Name", "Favorite",
    "ClickToCall Count", "PolicyPhone Count",
    "Phone", "Pretty", "RawDigits", "Extension",
    "Flags", "Source", "Label", "LeadId",
    "City", "State", "Zip"
  ];

  const rows = (allRows || []).map(r => ([
    "",
    r.primaryName || "",
    "",
    r.clickCount ?? 0,
    r.policyExtraCount ?? 0,
    r.phone || r.pretty || r.rawDigits || "",
    r.pretty || "",
    r.rawDigits || "",
    r.extension || "",
    r.flags || "",
    r.source || "",
    r.label || "",
    String(r.leadId || ""),
    r.city || "",
    r.state || "",
    r.zip || ""
  ]));

  return [header, ...rows];
}

exports.createSheetAndShare = async function createSheetAndShare({ email, result, csvData }) {
  const webappUrl = process.env.GSCRIPT_REAL_URL || process.env.GSCRIPT_WEBAPP_URL;
  const sharedKey  = process.env.GSCRIPT_SHARED_SECRET || "";
  if (!webappUrl) throw new Error("Missing GSCRIPT_WEBAPP_URL (or GSCRIPT_REAL_URL)");

  const payload = {
    email,
    title: `Planet Scrape — ${email} — ${new Date().toISOString().replace("T"," ").slice(0,19)}`,
    allRows: buildAllNumbersSheet(result.allRows || []),
    csvData,
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
