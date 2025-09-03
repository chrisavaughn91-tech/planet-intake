function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function _toCsv(rows) {
  return (rows || []).map(r =>
    (r || []).map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")
  ).join("\r\n");
}

function doGet(e) {
  return _json({ ok: true, error: "POST only" });
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    if (data.expectedKey && data.key !== data.expectedKey) {
      return _json({ ok: false, error: 'bad key' });
    }

    var email = data.email;
    var title = data.title || 'Planet Scrape';
    var summaryRows = Array.isArray(data.summaryRows) ? data.summaryRows : [];
    var allRows = Array.isArray(data.allRows) ? data.allRows : [];

    var ss = SpreadsheetApp.create(title);
    var id = ss.getId();
    var url = ss.getUrl();

    var summary = ss.getActiveSheet();
    summary.setName('Summary');
    if (summaryRows.length) summary.getRange(1,1,summaryRows.length,summaryRows[0].length).setValues(summaryRows);

    var all = ss.insertSheet('AllNumbers');
    if (allRows.length) all.getRange(1,1,allRows.length,allRows[0].length).setValues(allRows);

    // Freeze header + bold only actual header width
    summary.setFrozenRows(1);
    all.setFrozenRows(1);
    if (summaryRows.length) summary.getRange(1,1,1,summaryRows[0].length).setFontWeight('bold');
    if (allRows.length)     all.getRange(1,1,1,allRows[0].length).setFontWeight('bold');

    // Keep first two columns of AllNumbers as text (names + phone)
    all.getRange(1,1,all.getMaxRows(),2).setNumberFormat('@');

    // Optional: NeedsAreaCode
    var csvUrl = "";
    if (Array.isArray(data.needsAreaRows) && data.needsAreaRows.length) {
      var needs = ss.insertSheet('NeedsAreaCode');
      needs.getRange(1,1,data.needsAreaRows.length,data.needsAreaRows[0].length).setValues(data.needsAreaRows);
      needs.setFrozenRows(1);
      needs.getRange(1,1,1,data.needsAreaRows[0].length).setFontWeight('bold');
      needs.getRange(1,1,needs.getMaxRows(),2).setNumberFormat('@');
    }

    // Optional: AllNumbers_Details (audit)
    if (Array.isArray(data.detailsRows) && data.detailsRows.length) {
      var det = ss.insertSheet('AllNumbers_Details');
      det.getRange(1,1,data.detailsRows.length,data.detailsRows[0].length).setValues(data.detailsRows);
      det.setFrozenRows(1);
      det.getRange(1,1,1,data.detailsRows[0].length).setFontWeight('bold');
      // text format first two columns (Name + Phone)
      det.getRange(1,1,det.getMaxRows(),2).setNumberFormat('@');
    }

    // ALSO create a CSV for AllNumbers
    var csvName = title + ' - AllNumbers.csv';
    var csvBlob = Utilities.newBlob(_toCsv(allRows), 'text/csv', csvName);
    var csvFile = DriveApp.createFile(csvBlob);
    csvFile.addViewer(email);
    csvUrl = csvFile.getUrl();

    // Share sheet with the user and notify
    DriveApp.getFileById(id).addViewer(email);
    try {
      MailApp.sendEmail({
        to: email,
        subject: 'Your Planet files are ready',
        body: url,
        attachments: [csvBlob]
      });
    } catch (err) {}

    return _json({ ok: true, sheetUrl: url, csvUrl: csvUrl, spreadsheetId: id, url: url });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

