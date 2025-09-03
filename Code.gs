function json(o){ return ContentService.createTextOutput(JSON.stringify(o))
  .setMimeType(ContentService.MimeType.JSON); }

function toCsv(rows){
  rows = rows || [];
  return rows.map(r => (Array.isArray(r) ? r : Object.values(r))
    .map(v => {
      let s = String(v == null ? '' : v);
      if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g,'""') + '"';
      return s;
    }).join(',')).join('\n');
}

function writeSheet_(ss, name, rows){
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  if (!rows || !rows.length) { sh.getRange(1,1).setValue('No data'); return; }
  const isObj = !Array.isArray(rows[0]);
  const data = isObj ? [Object.keys(rows[0])].concat(rows.map(o => Object.keys(rows[0]).map(k => o[k]))) : rows;
  sh.getRange(1,1,data.length,data[0].length).setValues(data);
}

function doPost(e){
  try {
    const body = e && e.postData && e.postData.contents || '{}';
    const data = JSON.parse(body);
    const email = (data.email || '').trim();

    const title = data.title || ('Planet Scrape ' + new Date().toISOString().slice(0,19).replace('T',' '));
    const summaryRows = data.summaryRows || [];
    const allRows = data.allRows || [];

    // 1) Create spreadsheet
    const ss = SpreadsheetApp.create(title);
    const ssUrl = ss.getUrl();

    // 2) Write sheets (adapt names if needed)
    if (summaryRows.length) writeSheet_(ss, 'Summary', summaryRows);
    if (allRows.length) writeSheet_(ss, 'AllNumbers', allRows);

    // 3) Build CSV (use Summary if present, else AllNumbers)
    const forCsv = summaryRows.length ? summaryRows : allRows;
    const csv = toCsv(forCsv);
    const csvFile = DriveApp.createFile(title + '.csv', csv, MimeType.CSV);

    // 4) Make the CSV link-viewable and email it (if email provided)
    csvFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const csvUrl = csvFile.getUrl();

    if (email) {
      const subject = 'Your Planet Intake results';
      const bodyText = 'Hi,\n\nYour scrape has finished.\n\nSheet: ' + ssUrl + '\nCSV: ' + csvUrl + '\n\nRegards,\nPlanet Intake Bot';
      MailApp.sendEmail({
        to: email,
        subject: subject,
        htmlBody: bodyText.replace(/\n/g,'<br>'),
        attachments: [csvFile.getAs(MimeType.CSV)],
        name: 'Planet Intake Bot'
      });
    }

    return json({ ok:true, sheetUrl: ssUrl, csvUrl });
  } catch (err) {
    return json({ ok:false, error: String(err && err.message || err) });
  }
}

