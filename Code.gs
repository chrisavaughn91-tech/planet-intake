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

    var summaryRows = data.summaryRows || [["Primary Name","Monthly Special Total","Star","ClickToCall Count","PolicyPhones Count"]];
    var allRows     = data.allRows     || [["Primary Name","Phone","Primary Name","Number","Flag"]];

    // Create spreadsheet with Summary + AllNumbers
    var ss = SpreadsheetApp.create(title);
    var url = ss.getUrl();
    var id  = ss.getId();

    // Build sheets
    var summary = ss.getSheets()[0]; // default Sheet1
    summary.setName("Summary");
    var all = ss.insertSheet("AllNumbers");

    // Write data
    if (summaryRows.length) {
      summary.getRange(1,1,summaryRows.length,summaryRows[0].length).setValues(summaryRows);
    }
    if (allRows.length) {
      all.getRange(1,1,allRows.length,allRows[0].length).setValues(allRows);
    }

    // Freeze header + bold
    summary.setFrozenRows(1);
    all.setFrozenRows(1);
    summary.getRange(1,1,1,summary.getMaxColumns()).setFontWeight("bold");
    all.getRange(1,1,1,all.getMaxColumns()).setFontWeight("bold");

    // Text format for all five columns on AllNumbers
    all.getRange(1,1,all.getMaxRows(),5).setNumberFormat("@");

    // Share with the user and notify
    DriveApp.getFileById(id).addViewer(email);
    try { MailApp.sendEmail(email, "Your Planet sheet is ready", url); } catch (err) {}

    return _json({ ok: true, spreadsheetId: id, url: url });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) }, 500);
  }
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
