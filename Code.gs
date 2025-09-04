/** @OnlyCurrentDoc */

// -----------------------------
// Version tag (for diagnostics)
// -----------------------------
const VERSION_TAG = 'sheet-polish-v2';

// -----------------------------
// Entry point
// -----------------------------
function doPost(e) {
  try {
    const payload = parsePayload_(e);
    const ss = openTargetSpreadsheet_(payload);

    const summaryRows = coalesce_(payload, ['summaryRows','summary','summary_list'], []);
    const goodList    = coalesce_(payload, ['allNumbersGood','goodNumbers','valid_numbers'], []);
    const flaggedList = coalesce_(payload, ['allNumbersFlagged','flaggedNumbers','flagged_numbers'], []);

    renderSummarySheet_(ss, summaryRows);
    renderAllNumbersSheet_(ss, goodList, flaggedList);

    return json_(200, {
      ok: true,
      meta: {
        versionTag: VERSION_TAG,
        summaryCount: Array.isArray(summaryRows) ? summaryRows.length : 0,
        goodCount: Array.isArray(goodList) ? goodList.length : 0,
        flaggedCount: Array.isArray(flaggedList) ? flaggedList.length : 0
      }
    });
  } catch (err) {
    return json_(500, { ok:false, error: String(err), versionTag: VERSION_TAG });
  }
}

// -----------------------------
// Summary sheet rendering
// -----------------------------
function renderSummarySheet_(ss, rows) {
  const sheet = getOrCreateSheet_(ss, 'Summary');

  // Header order & labels
  const headers = ['Badge','Lead','Total Premium','Listed #’s','+ #’s'];
  prepareSheetWithHeaders_(sheet, headers);

  const out = [];
  (rows || []).forEach((r) => {
    const nameRaw = coalesce_(r, ['lead','primaryName','name'], '');
    const premiumRaw = coalesce_(r, ['totalPremium','monthlySpecial'], 0);
    const listedRaw  = coalesce_(r, ['listedCount','clickToCallCount'], 0);
    const extraRaw   = coalesce_(r, ['extraPolicyCount','policyPhoneCount'], 0);
    const allLapsed  = coalesce_(r, ['allPoliciesLapsed'], false);

    const lead = normalizeName_(String(nameRaw));
    const premium = toNumber_(premiumRaw);
    const listed  = toInt_(listedRaw);
    const extra   = toInt_(extraRaw);

    let badge = coalesce_(r, ['badge','star'], null);
    if (!badge) badge = computeBadge_(premium, allLapsed);

    out.push([badge, lead, premium, listed, extra]);
  });

  // Write table
  if (out.length) {
    sheet.getRange(2, 1, out.length, headers.length).setValues(out);
  }

  // Formats
  const last = 1 + out.length;
  if (out.length) {
    sheet.getRange(2, 3, out.length, 1).setNumberFormat('$#,##0.00'); // Total Premium
  }

  // Styling
  finalizeSheetStyling_(sheet, headers.length, last);
}

// -----------------------------
// AllNumbers sheet rendering
// -----------------------------
function renderAllNumbersSheet_(ss, goodList, flaggedList) {
  const sheet = getOrCreateSheet_(ss, 'AllNumbers');

  const headers = ['Lead','Phone','Lead','Phone','Flag'];
  prepareSheetWithHeaders_(sheet, headers);

  // Coerce to arrays of arrays, normalize names
  const goodRows = (goodList || []).map((x) => {
    const arr = toRow_(x, ['primaryName','lead','name'], ['phone','number']);
    return [ normalizeName_(arr[0] || ''), String(arr[1] || '') ];
  });

  const flaggedRows = (flaggedList || []).map((x) => {
    const arr = toRow_(x, ['primaryName','lead','name'], ['phone','number'], ['flag','reason','label']);
    return [ normalizeName_(arr[0] || ''), String(arr[1] || ''), String(arr[2] || '') ];
  });

  // Write compact block A–B
  if (goodRows.length) {
    sheet.getRange(2, 1, goodRows.length, 2).setValues(goodRows);
  }

  // Write compact block C–E
  if (flaggedRows.length) {
    sheet.getRange(2, 3, flaggedRows.length, 3).setValues(flaggedRows);
  }

  const lastRow = 1 + Math.max(goodRows.length, flaggedRows.length);
  finalizeSheetStyling_(sheet, headers.length, lastRow);
}

// -----------------------------
// Helpers: sheet setup & polish
// -----------------------------
function getOrCreateSheet_(ss, name) {
  const found = ss.getSheetByName(name);
  return found || ss.insertSheet(name);
}

function prepareSheetWithHeaders_(sheet, headers) {
  sheet.clearContents();
  // preserve existing banding by removing and re-applying in finalize
  const existingBands = sheet.getBandings();
  existingBands.forEach(b => b.remove());
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
       .setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function finalizeSheetStyling_(sheet, headerCount, lastRow) {
  // Column sizing
  sheet.autoResizeColumns(1, headerCount);

  // Banded rows
  if (lastRow >= 2) {
    sheet.getRange(1, 1, lastRow, headerCount)
         .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
  }
}

// -----------------------------
// Helpers: parsing & coercion
// -----------------------------
function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Missing POST body');
  }
  let data;
  try { data = JSON.parse(e.postData.contents); }
  catch (err) { throw new Error('Invalid JSON: ' + err); }
  return data || {};
}

// If client passes a specific spreadsheetId, open that; else use active
function openTargetSpreadsheet_(payload) {
  const id = coalesce_(payload, ['spreadsheetId','sheetId'], null);
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function coalesce_(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return fallback;
}

function toNumber_(x) {
  const n = typeof x === 'string' ? Number(x.replace(/[^0-9.\-]/g,'')) : Number(x);
  return Number.isFinite(n) ? n : 0;
}
function toInt_(x) {
  const n = toNumber_(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toRow_(item, nameKeys, phoneKeys, flagKeys) {
  // Accept object or array
  if (Array.isArray(item)) {
    // For arrays, trust positional
    return [
      String(item[0] ?? ''),
      String(item[1] ?? ''),
      String(item[2] ?? '')
    ];
  }
  // Object: map via keys
  const name  = coalesce_(item, nameKeys, '');
  const phone = coalesce_(item, phoneKeys, '');
  const flag  = flagKeys ? coalesce_(item, flagKeys, '') : '';
  return [String(name || ''), String(phone || ''), String(flag || '')];
}

// -----------------------------
// Helpers: names & badges
// -----------------------------
function normalizeName_(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^\s*([^,]+)\s*,\s*(.+)$/); // "LAST, FIRST"
  if (m) {
    return toTitleCase_(m[2]) + ' ' + toTitleCase_(m[1]);
  }
  return toTitleCase_(s);
}
function toTitleCase_(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\p{L}’']+/gu, w => w.charAt(0).toUpperCase() + w.slice(1));
}

// Badge logic:
// - 🔴 if allPoliciesLapsed
// - ⭐ if premium >= 100
// - 🟣 if 0 <= premium < 50
// - 🟠 otherwise (50–99.99)
function computeBadge_(premium, allLapsed) {
  if (allLapsed === true) return '🔴';
  if (premium >= 100)    return '⭐';
  if (premium >= 0 && premium < 50) return '🟣';
  return '🟠';
}

// -----------------------------
// Response helper
// -----------------------------
function json_(status, obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
