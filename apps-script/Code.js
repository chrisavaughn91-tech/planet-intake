// After edits: Deploy → Manage deployments → select current Web app → Edit → Deploy
// Execute as: Me    |  Who has access: Anyone (or Anyone with the link)

/**
 * Planet Intake – Sheet Writer (polish v4)
 * - Creates a new spreadsheet when no spreadsheetId is provided.
 * - Writes two tabs with formatting:
 *   Summary:  Badge | Lead | Total Premium | Listed #’s | + Policy #’s
 *   AllNumbers: two-section layout with merged headers:
 *     Row1:  A1:B1 "Valid Numbers", C1:E1 "Flagged Numbers"
 *     Row2:  A2 "Lead", B2 "Phone", C2 "Lead", D2 "Phone", E2 "Flag"
 */

const VERSION_TAG = 'sheet-polish-v4';

const COLORS = {
  header: '#D9EAF7',   // light blue
  star:   '#FFF4CC',   // pale gold
  red:    '#FDEAEA',   // very light red
  purple: '#F3E8FD',   // very light purple
  orange: '#FFF1E6',   // very light orange
  green:  '#E8F5E9',   // very light green (supersedes badges)
  divider:'#CCCCCC'
};

/** ========== Web entry points ========== */

function doGet() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Accepts JSON body:
 * {
 *   spreadsheetId?: string
 *   summaryRows:   [ [badge, name, totalPremium, listedCount, plusCount], ... ] | [{...}, ...],
 *   goodNumbers:   [ [name, phone], ... ] | [{...}, ...],
 *   flaggedNumbers:[ [name, phone, flag], ... ] | [{...}, ...]
 * }
 */
function doPost(e) {
  try {
    const payload = parseJson_(e);

    const ss = openSpreadsheetOrCreate_(payload);

    // Optional sharing
    try {
      const shareEmail = coalesce_(payload, ['shareEmail', 'email'], null);
      if (shareEmail) DriveApp.getFileById(ss.getId()).addViewer(shareEmail);
    } catch (shareErr) {
      console.log('Share failed: ' + shareErr);
    }

    // Gather arrays
    const summaryRows = coalesce_(payload, ['summaryRows','summary','summary_list'], []) || [];
    const goodList    = coalesce_(payload, ['goodNumbers','allNumbersGood','valid_numbers'], []) || [];
    const flaggedList = coalesce_(payload, ['flaggedNumbers','allNumbersFlagged','flagged_numbers'], []) || [];

    // Render
    const counts = {};
    counts.summary = renderSummary_(ss, summaryRows);
    counts.allGood = renderAllNumbers_(ss, goodList, flaggedList);

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
  const sh = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  sh.clearContents();
  sh.getBandings().forEach(b => b.remove());

  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);

  const out = [];
  for (const r of (rows || [])) {
    let badge, nameRaw, premiumRaw, listedRaw, extraRaw, allLapsed;
    if (Array.isArray(r)) {
      [badge, nameRaw, premiumRaw, listedRaw, extraRaw] = r;
      allLapsed = false;
    } else {
      badge       = coalesce_(r, ['badge','star'], null);
      nameRaw     = coalesce_(r, ['lead','primaryName','name'], '');
      premiumRaw  = coalesce_(r, ['totalPremium','monthlySpecial'], 0);
      listedRaw   = coalesce_(r, ['listedCount','clickToCallCount'], 0);
      extraRaw    = coalesce_(r, ['extraPolicyCount','policyPhoneCount'], 0);
      allLapsed   = coalesce_(r, ['allPoliciesLapsed'], false);
    }
    const lead    = normalizeName_(String(nameRaw || ''));
    const premium = toNumber_(premiumRaw);
    const listed  = toInt_(listedRaw);
    const extra   = toInt_(extraRaw);
    if (!badge) badge = computeBadge_(premium, allLapsed);
    out.push([badge, lead, premium, listed, extra]);
  }

  let lastRow = 1;
  if (out.length) {
    sh.getRange(2, 1, out.length, headers.length).setValues(out);
    sh.getRange(2, 3, out.length, 1).setNumberFormat('$#,##0.00;[Red]-$#,##0.00;$0.00'); // currency C
    lastRow = 1 + out.length;
  }

  // Header styling
  styleHeaderRow_(sh, 1, headers.length);

  // Center D:E (rows 2..)
  if (lastRow >= 2) {
    sh.getRange(2, 4, lastRow - 1, 2).setHorizontalAlignment('center');
  }

  // Conditional formatting (order matters; first rule wins)
  applySummaryConditionalFormats_(sh, lastRow);

  // Auto-size + light banding
  sh.autoResizeColumns(1, headers.length);
  if (lastRow >= 2) {
    sh.getRange(1, 1, lastRow, headers.length).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
  }

  return out.length;
}

function applySummaryConditionalFormats_(sh, lastRow) {
  const rules = [];
  const region = sh.getRange(2, 1, Math.max(0, lastRow - 1), 5);

  // 1) Green row if + Policy #’s > 0  (supersedes others -> placed FIRST)
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$E2>0')
      .setBackground(COLORS.green)
      .setRanges([region])
      .build()
  );

  // 2) Badge-based row tints (based on column A)
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$A2="⭐"')
      .setBackground(COLORS.star)
      .setRanges([region])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$A2="🔴"')
      .setBackground(COLORS.red)
      .setRanges([region])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$A2="🟣"')
      .setBackground(COLORS.purple)
      .setRanges([region])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$A2="🟠"')
      .setBackground(COLORS.orange)
      .setRanges([region])
      .build()
  );

  sh.setConditionalFormatRules(rules);
}

/** ========== AllNumbers sheet ========== */

function renderAllNumbers_(ss, goodList, flaggedList) {
  const sh = ss.getSheetByName('AllNumbers') || ss.insertSheet('AllNumbers');
  sh.clearContents();
  sh.getBandings().forEach(b => b.remove());

  // Row 1: section titles (merged)
  sh.getRange('A1').setValue('Valid Numbers');
  sh.getRange('C1').setValue('Flagged Numbers');
  sh.getRange('A1:B1').merge();
  sh.getRange('C1:E1').merge();

  // Row 2: subheaders
  sh.getRange(2, 1, 1, 5).setValues([['Lead','Phone','Lead','Phone','Flag']]);

  // Header styling (rows 1-2)
  sh.getRange('A1:E2')
    .setBackground(COLORS.header)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);
  sh.setFrozenRows(2);

  // Build rows
  const goodRows = (goodList || []).map(item => (
    Array.isArray(item)
      ? [ normalizeName_(String(item[0] || '')), String(item[1] || '') ]
      : [ normalizeName_(String(coalesce_(item, ['lead','primaryName','name'], ''))),
          String(coalesce_(item, ['phone','number'], '')) ]
  ));

  const flaggedRows = (flaggedList || []).map(item => (
    Array.isArray(item)
      ? [ normalizeName_(String(item[0] || '')), String(item[1] || ''), String(item[2] || '') ]
      : [ normalizeName_(String(coalesce_(item, ['lead','primaryName','name'], ''))),
          String(coalesce_(item, ['phone','number'], '')),
          String(coalesce_(item, ['flag','reason','label'], '')) ]
  ));

  let lastDataRow = 2;
  if (goodRows.length) {
    sh.getRange(3, 1, goodRows.length, 2).setValues(goodRows);
    lastDataRow = Math.max(lastDataRow, 2 + goodRows.length);
  }
  if (flaggedRows.length) {
    sh.getRange(3, 3, flaggedRows.length, 3).setValues(flaggedRows);
    lastDataRow = Math.max(lastDataRow, 2 + flaggedRows.length);
  }

  // Vertical divider between B and C (apply along used rows)
  const dividerRows = Math.max(2, lastDataRow);
  sh.getRange(1, 3, dividerRows, 1)
    .setBorder(null, true, null, null, null, null, COLORS.divider, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // Auto-size
  sh.autoResizeColumns(1, 5);

  return { good: goodRows.length, flagged: flaggedRows.length };
}

/** ========== Shared styling helper ========== */

function styleHeaderRow_(sh, headerRow, colCount) {
  sh.getRange(headerRow, 1, 1, colCount)
    .setBackground(COLORS.header)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);
}

/** ========== Parsing & spreadsheet selection ========== */

function parseJson_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('Missing POST body');
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
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
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
  return String(str).toLowerCase().replace(/[\p{L}’']+/gu, w => w.charAt(0).toUpperCase() + w.slice(1));
}

// Badge fallback
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
