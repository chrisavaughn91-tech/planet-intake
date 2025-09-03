const SERVICE_NPA = new Set(["211","311","411","511","611","711","811","911"]);
const TOLL_FREE_NPA = new Set(["800","888","877","866","855","844","833","822"]);
const PLACEHOLDER_SET = new Set(["0000000000", "1111111111", "1234567890", "9999999999"]);

function titleCaseWord(w) {
  if (!w) return w;
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
}

function normalizePersonName(name) {
  if (!name) return "";
  let n = name.trim();

  // Common "LAST, FIRST [MIDDLE]" in all caps → "First [Middle] Last"
  if (n.includes(",")) {
    const [last, rest] = n.split(",", 2);
    const parts = rest.trim().split(/\s+/).filter(Boolean).map(titleCaseWord);
    return [...parts, titleCaseWord(last.trim())].join(" ").trim();
  }

  // Otherwise title-case tokens
  return n.split(/\s+/).map(titleCaseWord).join(" ").trim();
}

function onlyDigitsPlus(s) {
  return String(s || "").replace(/[^\d+]/g, "");
}

function splitExtension(s) {
  const m = String(s || "").match(/\b(?:ext\.?|x|#)\s*([0-9]{1,6})\b/i);
  return m ? m[1] : "";
}

function cleanToDigitsWithPossiblePlus(s) {
  return onlyDigitsPlus(s);
}

function stripToCanonical(raw) {
  // Remove everything except digits; keep possible leading '+'
  let cleaned = cleanToDigitsWithPossiblePlus(raw);
  // Pull out extension separately first (we’ll pass extension back up)
  const ext = splitExtension(raw);

  // Normalize country code:
  // +1XXXXXXXXXX → 10 digits
  // 1XXXXXXXXXX  → drop leading 1
  // else keep digits
  let digits = cleaned.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.startsWith("+1") && digits.length === 12) digits = digits.slice(2);
  return { digits, extension: ext };
}

function isAllSameDigits(d) {
  return /^(\d)\1{9}$/.test(d);
}

function isValidNANP10(d) {
  if (!/^\d{10}$/.test(d)) return false;
  const npa = d.slice(0,3);
  const nxx = d.slice(3,6);

  // Area code 2–9 and not service NPA
  if (!/^[2-9]/.test(npa)) return false;
  if (SERVICE_NPA.has(npa)) return false;

  // Central office 2–9
  if (!/^[2-9]/.test(nxx)) return false;

  // No reserved fake block 555-01xx
  if (npa === "555" && /^01/.test(nxx)) return false;

  if (PLACEHOLDER_SET.has(d)) return false;
  if (isAllSameDigits(d)) return false;

  return true;
}

function isTollFree(d) {
  if (!/^\d{10}$/.test(d)) return false;
  return TOLL_FREE_NPA.has(d.slice(0,3));
}

function pretty10(d) {
  if (!/^\d{10}$/.test(d)) return d;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

/**
 * Label-aware candidate acceptance for PDFs. Only accept when near a phone label.
 * Provide a "windowText" that includes the labeled context (same line or neighbor lines).
 */
function labelWindowAccepts(windowText) {
  const t = (windowText || "").toLowerCase();
  const labels = [
    "ph", "phone", "cell", "home", "work", "secondary", "sec ph", "tel", "telephone"
  ];
  return labels.some(k => t.includes(k));
}

/**
 * Main normalization + flags
 * Returns { rawText, digits, pretty, extension, flags[], status }
 *  status ∈ { 'ok', 'review', 'discard' }
 */
function normalizeAndFlag(rawText, { from = "unknown", inPdfLabelWindow = false } = {}) {
  const flags = new Set();
  const { digits, extension } = stripToCanonical(rawText);

  // DO NOT CALL / DNC early
  if (/\b(do[\s-]?not[\s-]?call|dnc)\b/i.test(rawText)) {
    flags.add("DNC label");
  }

  // Too short/long after cleaning
  if (digits.length < 7 || digits.length > 11) {
    flags.add("Invalid length");
    return { rawText, digits, pretty: digits, extension, flags: [...flags], status: "discard" };
  }

  // 7-digits → keep for review
  if (digits.length === 7) {
    flags.add("Needs Area Code");
    return { rawText, digits, pretty: digits, extension, flags: [...flags], status: "review" };
  }

  // Now expect 10 digits
  if (digits.length === 10) {
    // Filter junk-like patterns in PDF context
    if (from === "pdf" && !inPdfLabelWindow) {
      flags.add("Unlabeled number");
      // keep for review (or flip to discard if you prefer)
      return { rawText, digits, pretty: pretty10(digits), extension, flags: [...flags], status: "review" };
    }

    // Obvious fakes / NANP checks
    if (!isValidNANP10(digits)) {
      flags.add("NANP invalid");
      return { rawText, digits, pretty: pretty10(digits), extension, flags: [...flags], status: "discard" };
    }

    // Toll-free as optional keep
    if (isTollFree(digits)) {
      flags.add("Toll-free");
    }

    if (extension) flags.add("Has Extension");

    return { rawText, digits, pretty: pretty10(digits), extension, flags: [...flags], status: flags.has("Unlabeled number") ? "review" : "ok" };
  }

  // 11 (already handled "1" trimming above); if we get here, treat as discard.
  flags.add("Invalid length");
  return { rawText, digits, pretty: digits, extension, flags: [...flags], status: "discard" };
}

/**
 * Dedupe by digits+extension
 */
function dedupePhones(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.digits || ""}#${it.extension || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

module.exports = {
  normalizePersonName,
  normalizeAndFlag,
  dedupePhones,
  pretty10,
  labelWindowAccepts,
  isValidNANP10,
};
