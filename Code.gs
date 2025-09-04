// After edits: Deploy → Manage deployments → select current Web app → Edit → Deploy
// Execute as: Me    |  Who has access: Anyone (or Anyone with the link)
/**
 * Planet Intake – Sheet Writer (polished + safe fallback)
 * - Creates a new spreadsheet when no spreadsheetId is provided.
 * - Writes two tabs:
 *   Summary:  Badge | Lead | Total Premium | Listed #’s | + #’s
 *   AllNumbers: Lead | Phone | Lead | Phone | Flag
 * - Normalizes "LAST, FIRST" -> "First Last"
 * - Adds currency formatting, auto-size, row banding
 * - Returns JSON with ok + url
 */

const VERSION_TAG = 'sheet-polish-v3';

/** ========== Web entry points ========== */

function doGet() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Accepts JSON body. Flexible keys supported for backward compatibility:
 * {
 *   spreadsheetId?: string, // optional. If omitted, a new Spreadsheet is created.
 *   summaryRows:   [ [badge, name, totalPremium, listedCount, plusCount], ... ] | [{...}, ...],
 *   goodNumbers:   [ [name, phone], ... ] | [{...}, ...],
 *   flaggedNumbers:[ [name, phone, flag], ... ] | [{...}, ...]
 * }
 */
function doPost(e) {
  try {
    console.log('POST bytes:', e?.postData?.contents?.length || 0);
    const payload = parseJson_(e);

    // Open target or create new spreadsheet safely
    const ss = openSpreadsheetOrCreate_(payload);

    // (Optional) Share the newly created sheet with a viewer, if requested.
    try {
      const shareEmail = coalesce_(payload, ['shareEmail', 'email'], null);
      if (shareEmail) {
        DriveApp.getFileById(ss.getId()).addViewer(shareEmail);
      }
    } catch (shareErr) {
      console.log('Share failed: ' + shareErr);
    }

    // Gather arrays with mild schema flexibility
    const summaryRows = coalesce_(payload, ['summaryRows','summary','summary_list'], []) || [];
    const goodList    = coalesce_(payload, ['goodNumbers','allNumbersGood','valid_numbers'], []) || [];
    const flaggedList = coalesce_(payload, ['flaggedNumbers','allNumbersFlagged','flagged_numbers'], []) || [];

    // Render both sheets
    const counts = {};
    counts.summary = renderSummary_(ss, summaryRows);
    counts.allGood = renderAllNumbers_(ss, goodList, flaggedList);

    // Respond with the spreadsheet URL for convenience
    return json_(200, {
      ok: true,
      url: ss.getUrl(),
      counts,
      versionTag: VERSION_TAG
    });

  } catch (err) {
    return json_(500, { ok:false, error:String(err), versionTag: VERSION_TAG });
  }
}

/** ========== Summary sheet ========== */

function renderSummary_(ss, rows) {
  const headers = ['Badge','Lead','Total Premium','Listed #’s','+ #’s'];
  const sh = prepareSheet_(ss, 'Summary', headers);

  const out = [];
  for (const r of (rows || [])) {
    // Accept array or object
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

    // Fallback badge logic if not provided by the server
    if (!badge) badge = computeBadge_(premium, allLapsed);

    out.push([badge, lead, premium, listed, extra]);
  }

  if (out.length) {
    sh.getRange(2, 1, out.length, headers.length).setValues(out);
    // Currency format for Total Premium (col C)
    sh.getRange(2, 3, out.length, 1).setNumberFormat('$#,##0.00;[Red]-$#,##0.00;$0.00');
  }

  finalizeSheetStyle_(sh, headers.length, 1 + out.length);
  return out.length;
}

/** ========== AllNumbers sheet ========== */

function renderAllNumbers_(ss, goodList, flaggedList) {
  const headers = ['Lead','Phone','Lead','Phone','Flag'];
  const sh = prepareSheet_(ss, 'AllNumbers', headers);

  // Good list (A:B)
  const goodRows = (goodList || []).map(item => {
    if (Array.isArray(item)) {
      return [ normalizeName_(String(item[0] || '')), String(item[1] || '') ];
    }
    return [
      normalizeName_(String(coalesce_(item, ['lead','primaryName','name'], ''))),
      String(coalesce_(item, ['phone','number'], ''))
    ];
  });

  // Flagged list (C:E)
  const flaggedRows = (flaggedList || []).map(item => {
    if (Array.isArray(item)) {
      return [ normalizeName_(String(item[0] || '')), String(item[1] || ''), String(item[2] || '') ];
    }
    return [
      normalizeName_(String(coalesce_(item, ['lead','primaryName','name'], ''))),
      String(coalesce_(item, ['phone','number'], '')),
      String(coalesce_(item, ['flag','reason','label'], ''))
    ];
  });

  let lastRow = 1;
  if (goodRows.length) {
    sh.getRange(2, 1, goodRows.length, 2).setValues(goodRows);
    lastRow = Math.max(lastRow, 1 + goodRows.length);
  }
  if (flaggedRows.length) {
    sh.getRange(2, 3, flaggedRows.length, 3).setValues(flaggedRows);
    lastRow = Math.max(lastRow, 1 + flaggedRows.length);
  }

  finalizeSheetStyle_(sh, headers.length, lastRow);
  return { good: goodRows.length, flagged: flaggedRows.length };
}

/** ========== Sheet helpers & styling ========== */

function prepareSheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  // Remove any prior banding so we can re-apply cleanly
  sh.getBandings().forEach(b => b.remove());
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function finalizeSheetStyle_(sh, colCount, lastRow) {
  // Auto-size & apply banding
  sh.autoResizeColumns(1, colCount);
  if (lastRow >= 2) {
    sh.getRange(1, 1, lastRow, colCount)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
  }
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

  // Fallback: create a new timestamped spreadsheet
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

