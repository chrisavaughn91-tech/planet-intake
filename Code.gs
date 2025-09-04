/** Utilities **/

function toTitleCaseName(name) {
  // Expected "LAST, FIRST" -> "First Last"
  if (!name) return '';
  const parts = String(name).split(',');
  if (parts.length === 2) {
    const last = parts[0].trim().toLowerCase();
    const first = parts[1].trim().toLowerCase();
    return first.charAt(0).toUpperCase() + first.slice(1) + ' ' +
           last.charAt(0).toUpperCase() + last.slice(1);
  }
  // Fallback: title-case each token
  return String(name).split(/\s+/).map(t => t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : '').join(' ');
}

function ensureSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  // Install headers
  sh.clear();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setFrozenRows(1);
  return sh;
}

function dollarFormat(range) {
  range.setNumberFormat('$#,##0.00;[Red]-$#,##0.00;$0.00');
}

function compactOutBlanks(sh) {
  // Remove completely blank rows beneath header (row 1), keeping order.
  const last = sh.getLastRow();
  if (last <= 1) return;
  const values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  const nonBlank = values.filter(r => r.join('').trim() !== '');
  sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getMaxColumns()).clearContent();
  if (nonBlank.length) {
    sh.getRange(2, 1, nonBlank.length, sh.getLastColumn()).setValues(nonBlank);
  }
}

/** Web entry points **/

function doGet() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Expected POST payload from node:
 * {
 *   summaryRows: [ [badge, leadRAW, totalPremium, listedCount, plusCount], ... ],
 *   goodNumbers: [ [leadRAW, phone], ...],
 *   flaggedNumbers: [ [leadRAW, phone, flag], ...]
 * }
 */
function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(body);

    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    const ss = SpreadsheetApp.create(`Planet Scrape — ${ts}`);

    // Sheets & headers
    const summary = ensureSheet(ss, 'Summary', ['Badge','Lead','Total Premium','Listed #’s','+ #’s']);
    const allnums = ensureSheet(ss, 'AllNumbers', ['Lead','Phone','Lead','Phone','Flag']);

    // Normalize names to "First Last"
    const normSummary = (data.summaryRows || []).map(r => {
      return [r[0], toTitleCaseName(r[1]), r[2], r[3], r[4]];
    });
    const normGood = (data.goodNumbers || []).map(r => [toTitleCaseName(r[0]), r[1]]);
    const normFlag = (data.flaggedNumbers || []).map(r => [toTitleCaseName(r[0]), r[1], r[2]]);

    // Write Summary
    if (normSummary.length) {
      summary.getRange(2, 1, normSummary.length, 5).setValues(normSummary);
      // Money format for "Total Premium"
      dollarFormat(summary.getRange(2, 3, normSummary.length, 1));
      // Autosize
      for (let c = 1; c <= 5; c++) summary.autoResizeColumn(c);
    }

    // Write AllNumbers
    let row = 2;
    if (normGood.length) {
      allnums.getRange(row, 1, normGood.length, 2).setValues(normGood);
      row += normGood.length;
    }
    if (normFlag.length) {
      allnums.getRange(2, 3, normFlag.length, 3).setValues(normFlag);
    }
    // Compact out any blanks so the two blocks read like two tight lists
    compactOutBlanks(allnums);
    for (let c = 1; c <= 5; c++) allnums.autoResizeColumn(c);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, url: ss.getUrl() }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
