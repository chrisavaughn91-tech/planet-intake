import { chromium } from "playwright";
import { emit } from "./events.js";

/* =========================
   Small helpers
   ========================= */
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const BASE_URL = "https://m.planetaltig.com";
const LOGIN_URL = `${BASE_URL}/Account/Login`;
const DASH_URL = `${BASE_URL}/`;
const PACK_URL = `${BASE_URL}/Lead/Inbox`;
const PACK_ANCHOR = "/Lead/InboxDetail?LeadId=";
const LEAD_TABLE = "#LeadTable";
const PACK_LINKS_SEL = `${LEAD_TABLE} a[href^="${PACK_ANCHOR}"]`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const toPretty = (d10) => (d10 ? `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}` : null);
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

const DEBUG = String(process.env.DEBUG_SCRAPER || "") === "1";
const dlog = (...args) => {
  if (DEBUG) console.log("[SCRAPER]", ...args);
};

/* EMIT HELPERS */
function info(msg) {
  emit("info", { msg });
}
function reportError(err, extra = {}) {
  emit("error", { msg: String((err && err.stack) || err), ...extra });
}

/* Validation */
function sameDigits(s) {
  return /^([0-9])\1{9}$/.test(s);
}
function validUS10(d10) {
  if (!d10 || d10.length !== 10) return false;
  if (sameDigits(d10)) return false;
  const npa = d10.slice(0, 3),
    nxx = d10.slice(3, 6),
    line = d10.slice(6);
  if (/[01]/.test(npa[0])) return false;
  if (/[01]/.test(nxx[0])) return false;
  if (npa === "555" && /^01\d\d$/.test(line)) return false;
  if (/^(211|311|411|511|611|711|811|911)$/.test(npa)) return false;
  return true;
}

const TOLL_FREE = new Set(["800", "888", "877", "866", "855", "844", "833", "822"]);

function normalizePhoneCandidate(raw, contextLabel) {
  if (/\b(dnc|do\s*not\s*call)\b/i.test(String(raw))) return null;

  let ext = null;
  const extMatch = String(raw).match(/\b(?:x|ext\.?|#)\s*([0-9]{2,6})\b/i);
  if (extMatch) ext = extMatch[1];

  let s = String(raw)
    .replace(/\b(?:x|ext\.?|#)\s*[0-9]{2,6}\b/gi, "")
    .replace(/[^\d+]/g, "");

  if (s.startsWith("+1")) s = s.slice(2);
  if (s.length === 11 && s.startsWith("1")) s = s.slice(1);

  let rawDigits = null,
    pretty = null,
    valid = false,
    flags = [];
  let tollFree = false,
    international = false;

  if (s.startsWith("+") && !s.startsWith("+1")) international = true;

  if (/^\d{10}$/.test(s)) {
    rawDigits = s;
    valid = validUS10(s);
    pretty = valid ? toPretty(s) : null;
    if (TOLL_FREE.has(s.slice(0, 3))) tollFree = true;
  } else if (/^\d{7}$/.test(s)) {
    rawDigits = s;
    flags.push("Needs Area Code");
    pretty = `${s.slice(0, 3)}-${s.slice(3)}`;
  } else {
    return null;
  }

  if (contextLabel && /fax/i.test(contextLabel)) flags.push("Fax");
  if (international) flags.push("International");
  if (ext) flags.push("Has Extension");
  if (tollFree) flags.push("Toll-free kept");

  return {
    original: String(raw),
    rawDigits,
    phone: pretty,
    extension: ext,
    valid,
    tollFree,
    international,
    flags,
  };
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

async function firstVisible(locator) {
  const n = await locator.count();
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible()) return el;
  }
  return null;
}

/* =========================
   Overlay handling
   ========================= */
async function isOverlayPresent(page) {
  return await page.evaluate(() => {
    const hasBackdrop = !!document.querySelector(".modal-backdrop");
    const modalOpen = document.body.classList.contains("modal-open");
    const visibleDialog = !!document.querySelector('[role="dialog"][aria-modal="true"], .modal.show, .modal-dialog');
    return hasBackdrop || modalOpen || visibleDialog;
  });
}

async function closeBlockingOverlays(page) {
  let closedAny = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const present = await isOverlayPresent(page);
    if (!present) break;

    let clicked = false;
    const closeSelectors = [
      '[data-dismiss="modal"]',
      '[aria-label="Close"]',
      '.modal-header .close',
      'button:has-text("Close")',
      'button:has-text("Dismiss")',
      'a:has-text("Close")',
      'button:has-text("Got it")',
      'button:has-text("I Understand")',
      'button:has-text("OK")',
    ];

    for (const sel of closeSelectors) {
      const btn = await firstVisible(page.locator(sel));
      if (btn) {
        try {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 1500 });
          clicked = true;
          break;
        } catch {}
      }
    }

    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => {});
    }

    await page.waitForTimeout(200);
    const cleared = !(await isOverlayPresent(page));
    if (cleared) {
      closedAny = true;
      emit("info", { msg: "overlay: closed" });
      break;
    }
  }
  return closedAny;
}

/* =========================
   Inbox helpers
   ========================= */
async function ensureInboxStable(page) {
  const backdrop = page.locator(".modal-backdrop");
  if (await backdrop.count()) {
    await backdrop.first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  }
  const processing = page.locator("div.dataTables_processing");
  if (await processing.count()) {
    try {
      await processing.first().waitFor({ state: "hidden", timeout: 10000 });
    } catch {
      await processing.first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    }
  }
  await page.waitForTimeout(50);
}

async function getInboxInfoText(page) {
  const t = await page.locator("#LeadTable_info").innerText().catch(() => "");
  return (t || "").replace(/\s+/g, " ").trim();
}

function parseInfoCounts(txt) {
  const m = txt.match(/Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+entries/i);
  if (!m) return null;
  const from = parseInt(m[1], 10);
  const to = parseInt(m[2], 10);
  const total = parseInt(m[3], 10);
  return { from, to, total };
}

async function waitInboxInfoChange(page, prev, timeout = 10000) {
  await page.waitForFunction(
    (oldText) => {
      const el = document.querySelector("#LeadTable_info");
      const txt = (el?.textContent || "").replace(/\s+/g, " ").trim();
      return !!txt && txt !== oldText;
    },
    prev,
    { timeout }
  );
}

async function launch() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
  dlog("Browser/context/page launched");
  return { browser, context, page };
}

/* =========================
   Login + Nav
   ========================= */
async function login(page, creds) {
  dlog("Login: navigating to login page");
  await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 60000 });

  let userInput =
    (await firstVisible(page.locator('input[type="text"]'))) ||
    (await firstVisible(page.locator('input[type="email"]'))) ||
    (await firstVisible(page.locator("form input").first()));

  let passInput = await firstVisible(page.locator('input[type="password"]'));

  if (!userInput || !passInput) {
    const form = (await firstVisible(page.locator("form"))) || page.locator("body");
    if (!userInput) userInput = await firstVisible(form.locator("input").nth(0));
    if (!passInput)
      passInput = await firstVisible(form.locator('input[type="password"], input').nth(1));
  }
  if (!userInput || !passInput) {
    reportError("LOGIN: inputs not found");
    throw new Error("LOGIN: inputs not found");
  }

  await userInput.fill(creds.username || "");
  await passInput.fill(creds.password || "");

  const submit =
    (await firstVisible(page.getByRole("button", { name: /^login$/i }))) ||
    (await firstVisible(page.locator('button[type="submit"]'))) ||
    (await firstVisible(page.locator('input[type="submit"]'))) ||
    (await firstVisible(page.locator("button")));

  if (!submit) {
    reportError("LOGIN: submit button not found");
    throw new Error("LOGIN: submit button not found");
  }

  await Promise.allSettled([
    page.waitForLoadState("networkidle", { timeout: 45000 }),
    page.waitForURL(/\/(Lead\/Inbox|Dashboard|Home)\b/i, { timeout: 45000 }).catch(() => {}),
    submit.click(),
  ]);

  const url = page.url();
  if (/Account\/Login/i.test(url)) {
    reportError("LOGIN: still on login page — check PLANET_USER/PLANET_PASS");
    throw new Error("LOGIN: credentials rejected or flow changed");
  }

  await page.goto(DASH_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  dlog("Login: completed; on dashboard/home");
}

async function goToAllLeads(page) {
  dlog("Nav: going to All Leads");
  const myLeads =
    (await firstVisible(page.getByRole("link", { name: /my leads/i }))) ||
    (await firstVisible(page.getByRole("button", { name: /my leads/i }))) ||
    (await firstVisible(page.locator('a:has-text("My Leads"), button:has-text("My Leads")')));

  if (myLeads) {
    await myLeads.click().catch(() => {});
    await sleep(300);
  }

  const allLeads =
    (await firstVisible(page.getByRole("link", { name: /all leads/i }))) ||
    (await firstVisible(page.getByRole("button", { name: /all leads/i }))) ||
    (await firstVisible(page.locator('a:has-text("All Leads"), button:has-text("All Leads")')));

  if (allLeads) {
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
      allLeads.click(),
    ]);
  }

  await page.goto(PACK_URL, { waitUntil: "domcontentloaded" });

  await page.waitForSelector(`a[href*="${PACK_ANCHOR}"]`, { timeout: 30000 });
  info("➡️Go to All Leads");
}

/* =========================
   Name extraction (placed BEFORE uses)
   ========================= */
async function getPrimaryNameFromHeader(page) {
  const name = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const back = Array.from(document.querySelectorAll("a,button")).find((el) =>
      /(^|\b)back\b/i.test(clean(el.textContent))
    );
    const backBottom = back ? back.getBoundingClientRect().bottom : 0;
    const zoneTop = backBottom;
    const zoneBottom = backBottom + 220;
    const zoneRight = window.innerWidth * 0.55;
    const bad = /^(BACK|DETAIL|CALL|APPT\.?|COMMENTS|RESOLVE|VIEWING\s+\d+\s*\/\s*\d+)$/i;

    const cands = [];
    document.querySelectorAll("body *").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < zoneTop || rect.top > zoneBottom) return;
      if (rect.left > zoneRight) return;
      const txt = clean(el.textContent);
      if (!txt) return;
      if (bad.test(txt)) return;
      if (/\d{3,}/.test(txt)) return;
      if (/[a-z]/.test(txt)) return;
      if (!/[A-Z]/.test(txt)) return;
      cands.push({ t: txt, y: rect.top, x: rect.left });
    });
    cands.sort((a, b) => a.y - b.y || a.x - b.x);
    return cands.length ? cands[0].t : null;
  });
  return name || null;
}

/* =========================
   Tokenization (scoped) + parsing
   ========================= */
const TOKEN_RE =
  /(?:\+?1[\s-]?)?(?:\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}|\b\d{7}\b)(?:\s*(?:x|ext\.?|#)\s*\d{2,6})?/gi;

/* Gather visible number-ish tokens from the WHOLE page */
async function gatherVisibleNumberTokens(page) {
  return await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, "gi");
    const toks = new Set();
    const walk = (root) => {
      const els = root.querySelectorAll("*");
      for (const el of els) {
        if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
        const t = (el.textContent || "").trim();
        let m;
        while ((m = re.exec(t))) toks.add(m[0]);

        const href = el.getAttribute && el.getAttribute("href");
        if (href && /tel:/i.test(href)) toks.add(href);

        const oc = el.getAttribute && el.getAttribute("onclick");
        if (oc && /\d{7,}/.test(oc)) toks.add(oc);

        const dp = el.getAttribute && el.getAttribute("data-phone");
        if (dp && /\d{7,}/.test(dp)) toks.add(dp);
      }
    };
    walk(document.body);
    return Array.from(toks);
  }, TOKEN_RE.source);
}

/* =============== New: “Listed #” header fallback =============== */
async function harvestHeaderListedNumbers(page) {
  const tokens = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, "gi");
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const back = Array.from(document.querySelectorAll("a,button")).find((el) =>
      /(^|\b)back\b/i.test(clean(el.textContent))
    );
    const backBottom = back ? back.getBoundingClientRect().bottom : 0;
    const zoneTop = backBottom;
    const zoneBottom = backBottom + 260;
    const zoneRight = window.innerWidth * 0.55;

    const found = new Set();
    document.querySelectorAll("body *").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < zoneTop || rect.top > zoneBottom) return;
      if (rect.left > zoneRight) return;

      const txt = clean(el.textContent || "");
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(txt))) found.add(m[0]);

      const href = el.getAttribute && el.getAttribute("href");
      if (href && /^tel:/i.test(href)) found.add(href);
    });

    return Array.from(found);
  }, TOKEN_RE.source);

  const rows = [];
  const seen = new Set();
  for (const token of tokens) {
    const norm = normalizePhoneCandidate(token, "HeaderListed");
    if (!norm) continue;
    const key = `${norm.rawDigits || norm.original}-${norm.extension || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      primaryName: null,
      source: "header",
      lineType: "ListedHeader",
      original: norm.original,
      rawDigits: norm.rawDigits,
      phone: norm.phone,
      extension: norm.extension || null,
      tollFree: !!norm.tollFree,
      international: !!norm.international,
      valid: !!norm.valid,
      flag: norm.flags.join(", "),
    });
  }
  return uniqBy(rows, (r) => `${r.rawDigits || r.original}-${r.extension || ""}`);
}

/* Restore robust click-to-call harvesting using page-wide diff */
async function harvestClickToCall(page) {
  const rows = [];

  await closeBlockingOverlays(page).catch(() => {});

  const callBtn =
    (await firstVisible(page.locator('div:has(button:has-text("Appt.")) >> button:has-text("Call")'))) ||
    (await firstVisible(page.getByRole("button", { name: /^Call$/ }))) ||
    (await firstVisible(page.locator('button:has-text("Call")'))) ||
    (await firstVisible(page.locator('a:has-text("Call")')));

  if (!callBtn) return rows;

  const before = new Set(await gatherVisibleNumberTokens(page));

  await callBtn.scrollIntoViewIfNeeded().catch(() => {});
  await callBtn.click().catch(() => {});

  let after = new Set();
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(300);
    after = new Set(await gatherVisibleNumberTokens(page));
    if (after.size > before.size) break;
  }

  if (after.size <= before.size && (await isOverlayPresent(page))) {
    await closeBlockingOverlays(page).catch(() => {});
    await callBtn.click().catch(() => {});
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(300);
      after = new Set(await gatherVisibleNumberTokens(page));
      if (after.size > before.size) break;
    }
  }

  const diff = Array.from(after).filter((s) => !before.has(s));
  const seen = new Set();
  for (const token of diff) {
    const norm = normalizePhoneCandidate(token, "ClickToCall");
    if (!norm) continue;
    const key = `${norm.rawDigits || norm.original}-${norm.extension || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      primaryName: null,
      source: "click2call",
      lineType: "ClickToCall",
      original: norm.original,
      rawDigits: norm.rawDigits,
      phone: norm.phone,
      extension: norm.extension || null,
      tollFree: !!norm.tollFree,
      international: !!norm.international,
      valid: !!norm.valid,
      flag: norm.flags.join(", "),
    });
  }

  return uniqBy(rows, (r) => `${r.rawDigits || r.original}-${r.extension || ""}`);
}

/* Ensure all policy blocks are visible */
async function expandAllPolicies(page) {
  for (let i = 0; i < 12; i++) {
    const more = await firstVisible(page.locator('button:has-text("More"), a:has-text("More")'));
    if (!more) break;
    await more.scrollIntoViewIfNeeded().catch(() => {});
    await more.click().catch(() => {});
    await sleep(350);
    const anotherMore = await firstVisible(
      page.locator('button:has-text("More"), a:has-text("More")')
    );
    if (!anotherMore) break;
  }
  await page
    .evaluate(async () => {
      let y = 0;
      for (let i = 0; i < 6; i++) {
        y += Math.round(window.innerHeight * 0.8);
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
    })
    .catch(() => {});
}

/* Strict policy extractor: only "Ph:" and "Sec Ph:" */
async function extractPolicyPhonesStrict(page) {
  return await page.evaluate((reSrc) => {
    const DIGIT_RE = new RegExp(reSrc, "gi");
    const isDNC = (s) => /\b(dnc|do\s*not\s*call)\b/i.test(String(s || ""));
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const labelNodes = Array.from(document.querySelectorAll("body *")).filter((el) => {
      const t = clean(el.textContent);
      return /^ph:$/i.test(t) || /^sec\s*ph:$/i.test(t);
    });

    const pullNeighborStrings = (labelEl) => {
      const out = [];

      const harvestFrom = (node) => {
        const txt = clean(node.textContent || "");
        if (txt) out.push(txt);

        node.querySelectorAll("a, span, button").forEach((el) => {
          const href = el.getAttribute("href") || "";
          if (/^tel:/i.test(href)) out.push(href);
          const oc = el.getAttribute("onclick") || "";
          if (/\d{7,}/.test(oc)) out.push(oc);
          const dp = el.getAttribute("data-phone") || "";
          if (/\d{7,}/.test(dp)) out.push(dp);
          const tx = clean(el.textContent || "");
          if (/\d{7,}/.test(tx)) out.push(tx);
        });
      };

      const tr = labelEl.closest("tr");
      if (tr) {
        const cells = Array.from(tr.children);
        const idx = cells.findIndex((c) => c.contains(labelEl));
        if (idx >= 0 && idx + 1 < cells.length) harvestFrom(cells[idx + 1]);
      } else {
        if (labelEl.nextElementSibling) harvestFrom(labelEl.nextElementSibling);
        let sib = labelEl.parentElement;
        if (sib) {
          let n = sib.nextElementSibling;
          if (n) harvestFrom(n);
        }
      }

      const inline = labelEl.parentElement || labelEl;
      inline.querySelectorAll('a[href^="tel:"]').forEach((a) => out.push(a.getAttribute("href")));

      const uniq = [];
      const seen = new Set();
      for (const s of out.map(clean)) {
        if (!s || isDNC(s)) continue;
        let m;
        DIGIT_RE.lastIndex = 0;
        while ((m = DIGIT_RE.exec(s))) {
          if (!seen.has(m[0])) {
            seen.add(m[0]);
            uniq.push(m[0]);
          }
        }
      }
      return uniq;
    };

    const results = [];
    for (const labelEl of labelNodes) {
      const labelTxt = clean(labelEl.textContent);
      const strings = pullNeighborStrings(labelEl);
      results.push({ label: labelTxt, strings });
    }
    return results;
  }, TOKEN_RE.source);
}

/* =========================
   Lapsed & detail parsing
   ========================= */
function daysBetween(a, b) {
  return Math.floor((a - b) / 86400000);
}

function cushionForMode(modeLc) {
  if (!modeLc) return 60;
  if (modeLc.startsWith("annual")) return 366;
  if (modeLc.startsWith("quarter")) return 92;
  if (modeLc.startsWith("month")) return 31;
  return 60;
}

/**
 * Normalize a "Due Day" token.
 * - Accepts raw tokens like "00", "7", 7, etc.
 * - Returns a day-of-month (1..last) integer.
 * - "00" / invalid / out-of-range -> last day of the current month.
 */
function normalizeDueDay(dueDayRaw, today) {
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const d = Number(dueDayRaw);
  if (!Number.isFinite(d) || d <= 0 || d > 31) return last;
  return Math.min(Math.max(d, 1), last);
}

async function parseLeadDetail(page) {
  await closeBlockingOverlays(page).catch(() => {});
  await expandAllPolicies(page);

  const pageText = await page.evaluate(() => document.body.innerText || "");
  const blocks = pageText.split(/\bStage:\s*/i).slice(1);
  let monthlyTotalActive = 0;
  let policyBlockCount = 0;
  let activeBlockCount = 0;

  for (const rawBlock of blocks) {
    policyBlockCount++;
    const block = rawBlock.slice(0, 2500);

    const isLapsedByText =
      /\bLAPSED\s+POLICY\b/i.test(block) ||
      /^\s*Lapsed\b/i.test(block) ||
      /\bStat:\s*99\b/i.test(block);

    const sp = block.match(/\bSpecial\s+([$\d][\d,]*(?:\.\d{1,2})?)/i);
    let specialMonthly = 0;
    if (sp) {
      const n = Number(String(sp[1]).replace(/[$,]/g, ""));
      if (!Number.isNaN(n)) specialMonthly = n;
    }

    const modeM = block.match(/\bMode\s+([A-Za-z]+)/i);
    const dueM  = block.match(/\bDue\s*(?:Date|Day)\s+([0-9]{1,2}|00)\b/i);
    const paidM = block.match(
      /\bPolicy\s+Paid\s+To\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2})\b/i
    );

    const mode = modeM ? modeM[1].toLowerCase() : null;
    const today = new Date();

    // parse paid-to date if present
    let paidTo = null;
    if (paidM) {
      const s = paidM[1];
      const parts = s.includes("-") ? s.split("-).map(Number) : s.split("/").map(Number);
      if (s.includes("-")) {
        paidTo = new Date(parts[0], parts[1] - 1, parts[2]);
      } else {
        const Y = parts[2] < 100 ? 2000 + parts[2] : parts[2];
        paidTo = new Date(Y, parts[0] - 1, parts[1]);
      }
    }

    // compute cushion and normalized due-day (even if paidTo missing)
    const cushion       = cushionForMode(mode || "");
    const dueDayRaw     = dueM ? dueM[1] : null;
    const normalizedDue = normalizeDueDay(dueDayRaw, today);

    // start active state from textual signal
    let active = !isLapsedByText;

    // refine with grace window if we have a paid-to date
    if (paidTo) {
      const diff = daysBetween(today, paidTo);
      active = diff <= cushion && active;
    }

    // ALWAYS emit a lapse line with status + normalized day
    emit("info", {
      msg: `lapse: mode=${mode || "unknown"} cushion=${cushion}d dueDay=${dueDayRaw ?? "N/A"} -> norm=${normalizedDue} status=${active ? "active" : "lapsed"}`,
      isLapsed: !active
    });

    if (active && specialMonthly > 0) monthlyTotalActive += specialMonthly;
    if (active) activeBlockCount++;
  }

  const primaryNameHeader = await getPrimaryNameFromHeader(page);

  const policyPairs = await extractPolicyPhonesStrict(page);
  const policyRows = [];
  const seen = new Set();
  const pushPolicy = (rawToken, label, primaryName) => {
    const norm = normalizePhoneCandidate(rawToken, /sec/i.test(label) ? "Secondary" : "Policy");
    if (!norm) return;

    if (!norm.rawDigits) return;
    if (!(norm.rawDigits.length === 10 || norm.rawDigits.length === 7)) return;

    const key = `${norm.rawDigits}-${norm.extension || ""}-policy`;
    if (seen.has(key)) return;
    seen.add(key);

    policyRows.push({
      primaryName,
      source: "policy",
      lineType: /sec/i.test(label) ? "Secondary" : "Policy",
      original: norm.original,
      rawDigits: norm.rawDigits,
      phone: norm.phone,
      extension: norm.extension || null,
      tollFree: !!norm.tollFree,
      international: !!norm.international,
      valid: !!norm.valid,
      flag: norm.flags.join(", "),
    });
  };

  for (const { label, strings } of policyPairs) {
    for (const s of strings) pushPolicy(s, label, primaryNameHeader || null);
  }

  return {
    primaryNameHeader,
    policyRows,
    monthlyTotalActive,
    policyBlockCount,
    activeBlockCount,
  };
}

/* =========================
   Inbox pagination + collection
   ========================= */
async function setInboxPageSize(page) {
  await ensureInboxStable(page);
  const lengthSelect = page.locator("#LeadTable_length select");

  let options = [];
  if (await lengthSelect.count()) {
    options = await lengthSelect.evaluate((sel) =>
      Array.from(sel.options || []).map((o) => o.value)
    );
    const current = await lengthSelect.inputValue().catch(() => null);
    if (current !== "100") {
      await lengthSelect.selectOption("100");
    }
  }

  await ensureInboxStable(page);
  try {
    await page.waitForFunction(
      () => /to\s+100\b/i.test(document.querySelector("#LeadTable_info")?.textContent || ""),
      null,
      { timeout: 10000 }
    );
  } catch {
    await page.waitForTimeout(250);
  }

  info(`📬setPageSize(100) options=[${options.join(",") || "unknown"}]`);
}

async function getPackLinksFromPage(page) {
  await page.waitForSelector(`${LEAD_TABLE} tbody tr`, { state: "visible" });
  const hrefs = await page.$$eval(PACK_LINKS_SEL, (els) =>
    els.map((a) => a.getAttribute("href")).filter(Boolean)
  );
  return hrefs;
}

async function clickNextInboxPage(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await ensureInboxStable(page);

  const nextLi = page.locator("#LeadTable_next");
  if (await nextLi.count()) {
    const cls = (await nextLi.getAttribute("class")) || "";
    if (/\bdisabled\b/i.test(cls)) {
      info("📬next disabled (last page)");
      return { advanced: false, changed: false };
    }
  }

  const prevInfo = await getInboxInfoText(page);
  const nextA = page.locator("#LeadTable_next a");
  await nextA.click({ timeout: 5000 }).catch(() => {});
  await ensureInboxStable(page);

  let changed = true;
  try {
    await waitInboxInfoChange(page, prevInfo);
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    try {
      await waitInboxInfoChange(page, prevInfo);
    } catch {
      changed = false;
    }
  }

  if (changed) info("➡️Go to next page");
  return { advanced: changed, changed };
}

async function collectPaginated(page, max) {
  await setInboxPageSize(page);

  const allSet = new Set();
  let pageNum = 1;

  for (;;) {
    const infoTxt = await getInboxInfoText(page);
    const counts = parseInfoCounts(infoTxt);
    const totalEntries = counts?.total || undefined;

    info(`📬page ${pageNum}${totalEntries ? ` of ~${Math.ceil(totalEntries / 100)}` : ""}`);

    const hrefs = await getPackLinksFromPage(page);
    hrefs.forEach((h) => allSet.add(h));
    info(`📬collected ${hrefs.length} links on page ${pageNum}, total ${allSet.size}`);

    if (max && allSet.size >= max) break;
    if (counts && counts.to >= counts.total) break;

    const { advanced, changed } = await clickNextInboxPage(page);
    if (!advanced || !changed) break;
    pageNum += 1;
  }

  const all = Array.from(allSet);
  return max ? all.slice(0, max) : all;
}

/* =========================
   Badge config + resolution (NEW)
   ========================= */

const BADGE_ORDER = ["star", "white", "purple", "orange", "red"];
const BADGE_EMOJI = { star: "⭐", white: "⚪", purple: "🟣", orange: "🟠", red: "🔴" };

function numOrUndef(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function lc(v) { return String(v || "").toLowerCase(); }

/**
 * Normalize the badge config coming from opts.badgeConfig.
 * Supports either an array of {name,on,mode,floor,ceil} or an object keyed by name.
 */
function normalizeBadgeConfig(input) {
  if (!input) return null;

  const out = {};
  const arr = Array.isArray(input) ? input : BADGE_ORDER.map(k => ({ name: k, ...(input[k] || {}) }));

  for (const raw of arr) {
    const name = lc(raw?.name);
    if (!BADGE_ORDER.includes(name)) continue;
    const mode = ["number","lapsed","no_numbers"].includes(lc(raw?.mode)) ? lc(raw.mode) :
                 (raw?.bool === "lapsed" ? "lapsed" : raw?.bool === "no_numbers" ? "no_numbers" : "number");

    out[name] = {
      on: raw?.on === true || raw?.on === "true" || raw?.on === 1,
      mode,
      floor: numOrUndef(raw?.floor),
      ceil:  numOrUndef(raw?.ceil),
    };
  }
  return out;
}

/**
 * Given normalized config, compute effective numeric bands.
 * - Missing ceil is filled to next higher floor - 0.01 (if any), else +Infinity
 * - Missing floor stays undefined (interpreted as 0 later)
 * - Badges with neither floor nor ceil stay "open"; they’ll match only if nothing else caught them.
 */
function computeNumericBands(cfg) {
  if (!cfg) return null;
  const floors = BADGE_ORDER
    .map(k => ({ k, f: cfg[k]?.mode === "number" ? numOrUndef(cfg[k].floor) : undefined }))
    .filter(x => x.f != null)
    .sort((a,b) => a.f - b.f);

  const nextFloor = (f) => {
    const idx = floors.findIndex(x => x.f === f);
    // find the next *greater* distinct floor
    for (const row of floors) { if (row.f > f) return row.f; }
    return undefined;
  };

  const bands = {};
  for (const k of BADGE_ORDER) {
    const b = cfg[k];
    if (!b || !b.on || b.mode !== "number") continue;
    const f = numOrUndef(b.floor);
    const c = numOrUndef(b.ceil);
    let lo = f != null ? f : undefined;
    let hi = c != null ? c : undefined;

    if (hi == null && f != null) {
      const nf = nextFloor(f);
      hi = nf != null ? Math.max(f, Math.fround(nf - 0.01)) : Number.POSITIVE_INFINITY;
    }

    bands[k] = { floor: lo, ceil: hi };
  }
  return bands;
}

function pickBadgeByRules(total, hasValidNumbers, allPoliciesLapsed, cfg) {
  // 1) If no config: keep your legacy behavior (exactly as before)
  if (!cfg) {
    if (total >= 100) return "star";
    if (total > 0 && total < 50) return "purple";
    if (total > 0 && !hasValidNumbers) return "orange";
    if (total === 0 || allPoliciesLapsed) return "red";
    return "white";
  }

  // Fill numeric bands from cfg
  const bands = computeNumericBands(cfg);
  const inBand = (name) => {
    const band = bands?.[name];
    if (!band) return false;
    const lo = band.floor != null ? band.floor : 0;
    const hi = band.ceil != null ? band.ceil : Number.POSITIVE_INFINITY;
    return total >= lo && total <= hi;
  };

  // 2) Priority A1: any Lapsed badge (top→bottom order)
  for (const k of BADGE_ORDER) {
    const b = cfg[k];
    if (b?.on && b.mode === "lapsed" && allPoliciesLapsed) return k;
  }

  // 3) Priority A2: any No Numbers badge (top→bottom order)
  for (const k of BADGE_ORDER) {
    const b = cfg[k];
    if (b?.on && b.mode === "no_numbers" && !hasValidNumbers) return k;
  }

  // 4) Numeric bands (top→bottom order)
  for (const k of BADGE_ORDER) {
    const b = cfg[k];
    if (b?.on && b.mode === "number" && inBand(k)) return k;
  }

  // 5) Fallback to white
  return "white";
}

/* =========================
   Main scraper
   ========================= */
export async function scrapePlanet(opts = {}) {
  const { username, password, jobId } = opts;
  const max = opts?.max ?? Number(process.env.MAX_LEADS_DEFAULT ?? 200);
  const badgeConfigNorm = normalizeBadgeConfig(opts?.badgeConfig || null); // NEW (optional)
  const startTime = Date.now();

  emit("start", { username, maxLeads: max, jobId: jobId || null });
  let browser, context, page;
  let leadCount = 0;
  let sumAllLeadsMonthly = 0;

  try {
    ({ browser, context, page } = await launch());
    info("browser: ready");

    info("login: starting");
    await login(page, { username, password }).catch((e) => {
      reportError(e);
      throw e;
    });
    info("login: ok");

    await goToAllLeads(page);
    info("📬inbox loaded");

    const packlinks = await collectPaginated(page, max);
    const toVisit = max ? packlinks.slice(0, max) : packlinks;
    if (!toVisit.length) {
      info("No leads found in inbox.");
      return {
        ok: true,
        leads: [],
        clickToCall: [],
        policyPhones: [],
        meta: { ts: nowIso(), leadCount: 0 },
      };
    }

    const clickToCallRows = [];
    const policyPhoneRows = [];
    const leads = [];
    const total = toVisit.length;

    for (let i = 0; i < total; i++) {
      const href = toVisit[i];
      const absUrl = new URL(href, page.url()).toString();

      emit("info", { msg: "lead: opening", href: absUrl, jobId: jobId || null });
      await page.goto(absUrl, { waitUntil: "domcontentloaded" });
      await sleep(350);

      await closeBlockingOverlays(page).catch(() => {});

      let primaryName = await getPrimaryNameFromHeader(page);
      emit("lead", { index: i + 1, total, leadName: primaryName, jobId: jobId || null });

      await closeBlockingOverlays(page).catch(() => {});

      // 1) Try normal click-to-call
      let c2c = await harvestClickToCall(page);

      // 2) Fallback: if nothing came back, go harvest from header (without clicking Call again)
      if ((c2c || []).length === 0) {
        const onDetail = /Lead\/InboxDetail/i.test(page.url());
        if (!onDetail) {
          await page.goto(absUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          await sleep(250);
        }
        await closeBlockingOverlays(page).catch(() => {});
        const headerFallback = await harvestHeaderListedNumbers(page);
        if (headerFallback.length) {
          headerFallback.forEach((r) => (r.primaryName = primaryName || r.primaryName));
          c2c = headerFallback;
          emit("info", { msg: "listed#: header fallback used" });
        }
      }

      c2c.forEach((r) => (r.primaryName = primaryName || r.primaryName));
      clickToCallRows.push(...c2c);

      // Policy phones
      const detail = await parseLeadDetail(page);
      if (!primaryName && detail.primaryNameHeader) primaryName = detail.primaryNameHeader || primaryName;

      const c2cDigits = new Set(
        (c2c || []).map((r) => r.rawDigits || onlyDigits(r.phone || r.original || ""))
      );
      const policyPhonesExtra = (detail.policyRows || []).filter((r) => {
        const k = r.rawDigits || onlyDigits(r.phone || r.original || "");
        return k && !c2cDigits.has(k);
      });

      emit("numbers", {
        leadName: primaryName,
        listedCount: c2c.length,
        extraCount: policyPhonesExtra.length,
        flaggedCount: [...c2c, ...policyPhonesExtra].filter((r) => (r.flags || []).length).length,
        jobId: jobId || null,
      });

      const leadMonthly = Number(detail.monthlyTotalActive.toFixed(2));
      const hasAnyPolicy = detail.policyBlockCount > 0;
      const allPoliciesLapsed = hasAnyPolicy && detail.activeBlockCount === 0;

      // Valid numbers for "No Numbers" rule: valid + 10-digit
      const validDigits = new Set();
      const accValid = (r) => {
        if (r && r.valid && (r.rawDigits || "").length === 10) validDigits.add(r.rawDigits);
      };
      (c2c || []).forEach(accValid);
      (policyPhonesExtra || []).forEach(accValid);

      const hasValidNumbers = validDigits.size > 0;

      // ==== NEW: resolve badge using config (or legacy if none) ====
      const chosen = pickBadgeByRules(leadMonthly, hasValidNumbers, allPoliciesLapsed, badgeConfigNorm);
      const badgeEmoji = BADGE_EMOJI[chosen] || "⚪";

      emit("badge", { leadName: primaryName, badge: badgeEmoji, totalPremium: leadMonthly, jobId: jobId || null });

      leads.push({
        primaryName: primaryName || null,
        monthlySpecialTotal: leadMonthly,
        star: badgeEmoji,
        clickToCall: c2c,
        policyPhones: policyPhonesExtra,
        allPoliciesLapsed,
      });

      sumAllLeadsMonthly += leadMonthly;
      leadCount++;
      if (leadCount >= max) break;
    }

    emit("done", { processed: leadCount, ms: Date.now() - startTime, jobId: jobId || null });

    return {
      ok: true,
      leads,
      clickToCall: clickToCallRows,
      policyPhones: policyPhoneRows,
      meta: { ts: nowIso(), leadCount },
    };
  } catch (err) {
    reportError(err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    try {
      emit("done", { processed: 0, ms: Date.now() - startTime, jobId: jobId || null });
    } catch {}
  }
}
