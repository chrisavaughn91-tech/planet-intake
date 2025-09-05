// After edits: Deploy → Manage deployments → select current Web app → Edit → Deploy
// Execute as: Me    |  Who has access: Anyone (or Anyone with the link)
/**
 * Planet Intake – Sheet Writer (polished + formatting rules)
 * - Creates a new spreadsheet when no spreadsheetId is provided.
 * - Writes two tabs:
 *   Summary:  Badge | Lead | Total Premium | Listed #’s | + Policy #’s
 *   AllNumbers: Valid Numbers (Lead | Phone)  |  Flagged Numbers (Lead | Phone | Flag)
 * - Normalizes "LAST, FIRST" -> "First Last"
 * - Adds currency formatting, header styling, conditional formatting, banding
 * - Returns JSON with ok + url (+ spreadsheetId)
 */

const VERSION_TAG = 'sheet-polish-v4';

/** ========== Web entry points ========== */
function doGet() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Accepts JSON body. Flexible keys supported for backward compatibility:
 * {
 *   spreadsheetId?: string,
 *   summaryRows:   [ [badge, name, totalPremium, listedCount, extraCount], ... ] | [{...}, ...],
 *   goodNumbers:   [ [name, phone], ... ] | [{...}, ...],
 *   flaggedNumbers:[ [name, phone, flag], ... ] | [{...}, ...],
 *   email?: string // optional share
 * }
 */
function doPost(e) {
  try {
    console.log('POST bytes:', e?.postData?.contents?.length || 0);
    const payload = parseJson_(e);

    const ss = openSpreadsheetOrCreate_(payload);

    // Optional share
    try {
      const shareEmail = coalesce_(payload, ['shareEmail', 'email'], null);
      if (shareEmail) {
        DriveApp.getFileById(ss.getId()).addViewer(shareEmail);
      }
    } catch (shareErr) {
      console.log('Share failed: ' + shareErr);
    }

    const summaryRows = coalesce_(payload, ['summaryRows','summary','summary_list'], []) || [];
    const goodList    = coalesce_(payload, ['goodNumbers','allNumbersGood','valid_numbers'], []) || [];
    const flaggedList = coalesce_(payload, ['flaggedNumbers','allNumbersFlagged','flagged_numbers'], []) || [];

    const counts = {};
    counts.summary  = renderSummary_(ss, summaryRows);
    counts.allNums  = renderAllNumbers_(ss, goodList, flaggedList);

    return json_(200, {
      ok: true,
      url: ss.getUrl(),
      spreadsheetId: ss.getId(),
      counts,
      versionTag: VERSION_TAG
    });

  } catch (err) {
    return json_(500, { ok:false, error:String(err), versionTag: VERSION_TAG });
  }
}

/** ========== Summary sheet ========== */

function renderSummary_(ss, rows) {
  const headers = ['Badge','Lead','Total Premium','Listed #’s','+ Policy #’s'];
  const sh = prepareSheet_(ss, 'Summary');

  // Build data (and be robust to someone passing a header row)
  let out = [];
  for (const r of (rows || [])) {
    let badge, nameRaw, premiumRaw, listedRaw, extraRaw, allLapsed;

    if (Array.isArray(r)) {
      [badge, nameRaw, premiumRaw, listedRaw, extraRaw] = r;
      allLapsed = false;
    } else {
      badge       = coalesce_(r, ['badge','star'], null);
      nameRaw     = coalesce_(r, ['lead','primaryName','name'], '');
      premiumRaw  = coalesce_(r, ['totalPremium','monthlySpecial','monthlySpecialTotal'], 0);
      listedRaw   = coalesce_(r, ['listedCount','clickToCallCount'], 0);
      extraRaw    = coalesce_(r, ['extraPolicyCount','policyPhoneCount','plusCount'], 0);
      allLapsed   = coalesce_(r, ['allPoliciesLapsed'], false);
    }

    const lead    = normalizeName_(String(nameRaw || ''));
    const premium = toNumber_(premiumRaw);
    const listed  = toInt_(listedRaw);
    const extra   = toInt_(extraRaw);

    if (!badge) badge = computeBadge_(premium, allLapsed);

    out.push([badge, lead, premium, listed, extra]);
  }

  // Drop duplicate header if someone passed it through as data
  if (out.length && String(out[0][0]).toLowerCase() === 'badge' && String(out[0][1]).toLowerCase() === 'lead') {
    out.shift();
  }

  // Write headers + body
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (out.length) {
    sh.getRange(2, 1, out.length, headers.length).setValues(out);
    // Currency format for Total Premium (col C)
    sh.getRange(2, 3, out.length, 1).setNumberFormat('$#,##0.00;[Red]-$#,##0.00;$0.00');
  }

  const lastRow = 1 + out.length;

  // Header style: light blue, centered, wrapped
  const header = sh.getRange(1, 1, 1, headers.length);
  header.setBackground('#E7F1FB').setHorizontalAlignment('center').setWrap(true);

  // Center D:E (including header)
  sh.getRange(1, 4, Math.max(1, lastRow), 2).setHorizontalAlignment('center');

  // Conditional formatting: row highlight for + Policy #'s > 0 (takes precedence)
  // Then very light fills based on Badge (⭐, 🔴, 🟣, 🟠)
  const dataRange = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, headers.length) : null;
  if (dataRange) {
    const rules = [];

    // 1) + Policy #'s > 0 -> very light green (supersedes badge color)
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$E2>0')
        .setBackground('#E8F5E9') // very light green
        .setRanges([dataRange])
        .build()
    );

    // 2) Badge-based light fills
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$A2="⭐"')
        .setBackground('#FFF8E1') // very light gold
        .setRanges([dataRange])
        .build()
    );
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$A2="🔴"')
        .setBackground('#FDECEA') // very light red
        .setRanges([dataRange])
        .build()
    );
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$A2="🟣"')
        .setBackground('#F4E8FF') // very light purple
        .setRanges([dataRange])
        .build()
    );
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$A2="🟠"')
        .setBackground('#FFF4E5') // very light orange
        .setRanges([dataRange])
        .build()
    );

    sh.setConditionalFormatRules(rules);
  }

  // Banding + autosize
  if (lastRow >= 2) {
    sh.getRange(1, 1, lastRow, headers.length).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
  }
  sh.autoResizeColumns(1, headers.length);
  sh.setFrozenRows(1);

  return out.length;
}

/** ========== AllNumbers sheet ========== */

function renderAllNumbers_(ss, goodList, flaggedList) {
  // We’ll create two header rows:
  // Row 1: "Valid Numbers" (A:B merged) | "Flagged Numbers" (C:E merged)
  // Row 2: "Lead | Phone"                | "Lead | Phone | Flag"
  const sh = prepareSheet_(ss, 'AllNumbers');

  const subheaders = ['Lead','Phone','Lead','Phone','Flag'];

  // Build rows
  const goodRows = (goodList || []).map(item => {
    if (Array.isArray(item))      return [ normalizeName_(String(item[0] || '')), String(item[1] || '') ];
    else                          return [ normalizeName_(String(coalesce_(item, ['lead','primaryName','name'], ''))),
                                           String(coalesce_(item, ['phone','number'], '')) ];
  });

  const flaggedRows = (flaggedList || []).map(item => {
    if (Array.isArray(item))      return [ normalizeName_(String(item[0] || '')), String(item[1] || ''), String(item[2] || '') ];
    else                          return [ normalizeName_(String(coalesce_(item, ['lead','primaryName','name'], ''))),
                                           String(coalesce_(item, ['phone','number'], '')),
                                           String(coalesce_(item, ['flag','reason','label'], '')) ];
  });

  // Header row 1 (merged group headers)
  sh.getRange(1,1).setValue('Valid Numbers');
  sh.getRange(1,1,1,2).merge();
  sh.getRange(1,3).setValue('Flagged Numbers');
  sh.getRange(1,3,1,3).merge();

  // Header row 2 (subheaders)
  sh.getRange(2,1,1,5).setValues([subheaders]);

  // Write data starting row 3
  let lastRow = 2;
  if (goodRows.length) {
    sh.getRange(3, 1, goodRows.length, 2).setValues(goodRows);
    lastRow = Math.max(lastRow, 2 + goodRows.length);
  }
  if (flaggedRows.length) {
    sh.getRange(3, 3, flaggedRows.length, 3).setValues(flaggedRows);
    lastRow = Math.max(lastRow, 2 + flaggedRows.length);
  }

  // Styling
  const header1 = sh.getRange(1,1,1,5);
  const header2 = sh.getRange(2,1,1,5);
  header1.setFontWeight('bold').setBackground('#E7F1FB').setHorizontalAlignment('center').setWrap(true);
  header2.setFontWeight('bold').setBackground('#E7F1FB').setHorizontalAlignment('center').setWrap(true);

  // Make the two lists feel more separated: thick vertical divider between columns B and C
  const divider = sh.getRange(1,2,Math.max(2, lastRow),1);
  divider.setBorder(null,null,null,true,null,null,'#999999',SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // Banding + autosize
  if (lastRow >= 2) {
    sh.getRange(1, 1, lastRow, 5).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
  }
  sh.autoResizeColumns(1, 5);

  // Freeze both header rows
  sh.setFrozenRows(2);

  return { good: goodRows.length, flagged: flaggedRows.length };
}

/** ========== Sheet helpers & boilerplate ========== */

function prepareSheet_(ss, name) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  // Remove banding & CF so we can re-apply cleanly
  sh.getBandings().forEach(b => b.remove());
  sh.setConditionalFormatRules([]);
  return sh;
}

/** ========== Parsing & spreadsheet selection ========== */

function parseJson_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Missing POST body');
  }
  try {
    return JSON.parse(e.postData.contents) || {};
  } catch (err) {
    throw new Error('Invalid JSON: ' + err);
  }
}

function openSpreadsheetOrCreate_(payload) {
  const id = coalesce_(payload, ['spreadsheetId','sheetId'], null);
  if (id) return SpreadsheetApp.openById(id);
  const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  return SpreadsheetApp.create(`Planet Scrape — ${ts}`);
}

/** ========== Small utilities ========== */

function coalesce_(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return fallback;
}

function toNumber_(x) {
  const n = typeof x === 'string' ? Number(x.replace(/[^0-9.\-]/g, '')) : Number(x);
  return Number.isFinite(n) ? n : 0;
}
function toInt_(x) {
  const n = toNumber_(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function normalizeName_(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^\s*([^,]+)\s*,\s*(.+)$/); // "LAST, FIRST"
  if (m) return toTitleCase_(m[2]) + ' ' + toTitleCase_(m[1]);
  return toTitleCase_(s);
}

function toTitleCase_(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\p{L}’']+/gu, w => w.charAt(0).toUpperCase() + w.slice(1));
}

// Badge fallback:
// - 🔴 if all policies lapsed
// - ⭐ if premium >= 100
// - 🟣 if 0 <= premium < 50
// - 🟠 otherwise (50–99.99)
function computeBadge_(premium, allLapsed) {
  if (allLapsed === true) return '🔴';
  if (premium >= 100)    return '⭐';
  if (premium >= 0 && premium < 50) return '🟣';
  return '🟠';
}

/** ========== JSON response helper ========== */
function json_(status, obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

