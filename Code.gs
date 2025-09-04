// ---- name normalization helpers ----
function toTitleCase_(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function normalizeLeadName_(name) {
  if (!name) return '';
  const str = String(name).trim();
  const m = str.match(/^([^,]+),\s*(.+)$/); // LAST, FIRST
  if (m) {
    const last = toTitleCase_(m[1]);
    const first = toTitleCase_(m[2]);
    return `${first} ${last}`;
  }
  return toTitleCase_(str);
}
// ------------------------------------

/** Webhook to build + share the Planet sheet */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || "{}");

    // optional shared secret
    var EXPECTED_KEY = data.expectedKey || ""; // leave blank if you don't want to check

    if (EXPECTED_KEY && data.key !== EXPECTED_KEY) {
      return _json({ ok: false, error: "bad key" }, 401);
    }

    var email = data.email || "";
    var title = data.title || ("Planet Scrape — " + email + " — " +
                 new Date().toISOString().replace("T"," ").slice(0,19));

    var summaryRows    = data.summaryRows    || [];
    var goodNumbers    = data.goodNumbers    || [];
    var flaggedNumbers = data.flaggedNumbers || [];

    // Create spreadsheet with Summary + AllNumbers
    var ss = SpreadsheetApp.create(title);
    var url = ss.getUrl();
    var id  = ss.getId();

    // Rename default sheet to Summary
    var firstSheet = ss.getSheets()[0];
    firstSheet.setName("Summary");

    // Build sheets
    renderSummarySheet_(ss, summaryRows);
    renderAllNumbersSheet_(ss, goodNumbers, flaggedNumbers);

    // Share with the user and notify
    DriveApp.getFileById(id).addViewer(email);
    try { MailApp.sendEmail(email, "Your Planet sheet is ready", url); } catch (err) {}

    return _json({ ok: true, spreadsheetId: id, url: url });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

function renderSummarySheet_(ss, summaryRows) {
  // summaryRows is an array of objects: { name, badge, monthlySpecial, clickToCallCount, extraPolicyPhonesCount }
  const sheet = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  sheet.clearContents();

  const headers = ["Badge","Lead","Total Premium","Listed #s","Added #s"];
  sheet.getRange(1,1,1,headers.length).setValues([headers]);

  // Normalize name + map to the new column order
  const values = (summaryRows || []).map(r => ([
    r.badge || "",
    normalizeLeadName_(r.name || ""),
    Number(r.monthlySpecial || 0),
    Number(r.clickToCallCount || 0),
    Number(r.extraPolicyPhonesCount || 0)
  ]));

  if (values.length) {
    sheet.getRange(2,1,values.length,headers.length).setValues(values);
  }

  // Currency format for Total Premium (column C)
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2,3, sheet.getLastRow()-1, 1).setNumberFormat("$#,##0.00");
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

function renderAllNumbersSheet_(ss, goodNumbers, flaggedNumbers) {
  // goodNumbers: [{name, phone}]
  // flaggedNumbers: [{name, phone, flag}]
  const sheet = ss.getSheetByName('AllNumbers') || ss.insertSheet('AllNumbers');
  sheet.clearContents();

  const headers = ["Lead","Phone","Lead","Number","Flag"];
  sheet.getRange(1,1,1,headers.length).setValues([headers]);

  const good = (goodNumbers || [])
    .filter(g => g && g.phone)
    .map(g => [ normalizeLeadName_(g.name || ""), g.phone || "" ]);

  const flagged = (flaggedNumbers || [])
    .filter(f => f && f.phone)
    .map(f => [ normalizeLeadName_(f.name || ""), f.phone || "", f.flag || "" ]);

  if (good.length) {
    sheet.getRange(2, 1, good.length, 2).setValues(good); // A:B
  }
  if (flagged.length) {
    sheet.getRange(2, 3, flagged.length, 3).setValues(flagged); // C:D:E
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

function _json(obj, code) {
  var out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  if (code) out.setHeader("X-Status-Code", String(code));
  return out;
}

function doGet() {
  return ContentService.createTextOutput('Webhook is up. Use POST only.');
}
