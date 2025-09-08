import { chromium } from "playwright";
import { emit } from './events.js';

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// ---- URLs ----
const BASE_URL = 'https://m.planetaltig.com';
const LOGIN_URL = `${BASE_URL}/Account/Login`;
const DASH_URL  = `${BASE_URL}/`;
const PACK_URL  = `${BASE_URL}/Lead/Inbox`; // "All Leads" ends here
const PACK_ANCHOR = '/Lead/InboxDetail?LeadId=';
const LEAD_TABLE = '#LeadTable';
const PACK_LINKS_SEL = `${LEAD_TABLE} a[href^="/Lead/InboxDetail?LeadId="]`;

// ---------- small utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const toPretty = (d10) => d10 ? `(${d10.slice(0,3)}) ${d10.slice(3,6)}-${d10.slice(6)}` : null;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// ---------- debug + filters ----------
const DEBUG = String(process.env.DEBUG_SCRAPER || '') === '1';
const dlog  = (...args) => { if (DEBUG) console.log('[SCRAPER]', ...args); };

/* START:EMIT_INFO */
function info(msg) { emit('info', { msg }); }
/* END:EMIT_INFO */

/* START:EMIT_ERROR */
function reportError(err) { emit('error', { msg: String(err && err.stack || err) }); }
/* END:EMIT_ERROR */

function sameDigits(s){ return /^([0-9])\1{9}$/.test(s); }

// NANP validation (10 digits)
function validUS10(d10){
  if(!d10 || d10.length !== 10) return false;
  if(sameDigits(d10)) return false;
  const npa = d10.slice(0,3), nxx = d10.slice(3,6), line = d10.slice(6);
  if(/[01]/.test(npa[0])) return false; // NPA can’t start 0/1
  if(/[01]/.test(nxx[0])) return false; // NXX can’t start 0/1
  // 555-01xx fake block
  if(npa === '555' && /^01\d\d$/.test(line)) return false;
  // service codes (211/311/…911) as NPAs: reject
  if(/^(211|311|411|511|611|711|811|911)$/.test(npa)) return false;
  return true;
}

const TOLL_FREE = new Set(["800","888","877","866","855","844","833","822"]);

function normalizePhoneCandidate(raw, contextLabel){
  // Omit explicit do-not-call markers entirely
  if (/\b(dnc|do\s*not\s*call)\b/i.test(String(raw))) return null;

  // grab extension if present
  let ext = null;
  const extMatch = String(raw).match(/\b(?:x|ext\.?|#)\s*([0-9]{2,6})\b/i);
  if(extMatch) ext = extMatch[1];

  let s = String(raw)
    .replace(/\b(?:x|ext\.?|#)\s*[0-9]{2,6}\b/ig,'') // remove ext bit
    .replace(/[^\d+]/g, '');

  // handle +1 or leading 1
  if(s.startsWith('+1')) s = s.slice(2);
  if(s.length === 11 && s.startsWith('1')) s = s.slice(1);

  // classify
  let rawDigits = null, pretty = null, valid = false, flags = [];
  let tollFree = false, international = false;

  if(s.startsWith('+') && !s.startsWith('+1')){
    international = true;
  }

  if(/^\d{10}$/.test(s)){
    rawDigits = s;
    valid = validUS10(s);
    pretty = valid ? toPretty(s) : null;
    if(TOLL_FREE.has(s.slice(0,3))) { tollFree = true; }
  }else if(/^\d{7}$/.test(s)){
    rawDigits = s;
    flags.push("Needs Area Code");
    // pretty for 7-digit local style
    pretty = `${s.slice(0,3)}-${s.slice(3)}`;
  }else{
    // reject weird lengths
    return null;
  }

  // context flags (label/source)
  if(contextLabel && /fax/i.test(contextLabel)) flags.push("Fax");
  if(international) flags.push("International");
  if(ext) flags.push("Has Extension");
  if(tollFree) flags.push("Toll-free kept");

  return {
    original: String(raw),
    rawDigits,
    phone: pretty,
    extension: ext,
    valid,
    tollFree,
    international,
    flags
  };
}

function uniqBy(arr, keyFn){
  const seen = new Set();
  const out = [];
  for(const x of arr){
    const k = keyFn(x);
    if(!seen.has(k)){
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

async function firstVisible(locator){
  const n = await locator.count();
  for(let i=0;i<n;i++){
    const el = locator.nth(i);
    if(await el.isVisible()) return el;
  }
  return null;
}

// --- Inbox stability helpers ---
async function ensureInboxStable(page) {
  // Wait for any bootstrap modal/backdrop to be gone
  const backdrop = page.locator('.modal-backdrop');
  if (await backdrop.count()) {
    await backdrop.first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  }

  // DataTables sometimes shows a processing overlay
  const processing = page.locator('div.dataTables_processing');
  if (await processing.count()) {
    // Hidden or detached both OK
    try {
      await processing.first().waitFor({ state: 'hidden', timeout: 10000 });
    } catch {
      await processing.first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    }
  }

  // tiny settle
  await page.waitForTimeout(50);
}

async function getInboxInfoText(page) {
  const t = await page.locator('#LeadTable_info').innerText().catch(() => '');
  return (t || '').replace(/\s+/g, ' ').trim();
}

async function waitInboxInfoChange(page, prev, timeout = 10000) {
  await page.waitForFunction(
    (oldText) => {
      const el = document.querySelector('#LeadTable_info');
      const txt = (el?.textContent || '').replace(/\s+/g, ' ').trim();
      return !!txt && txt !== oldText;
    },
    prev,
    { timeout }
  );
}

// ---------- browser helpers ----------
async function launch(){
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US"
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
  dlog('Browser/context/page launched');
  return { browser, context, page };
}

// ---------- login ----------
async function login(page, creds){
  dlog('Login: navigating to login page');
  await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 60000 });

  // Prefer the first visible text/email input and the first password input.
  let userInput =
    (await firstVisible(page.locator('input[type="text"]'))) ||
    (await firstVisible(page.locator('input[type="email"]'))) ||
    (await firstVisible(page.locator('form input').first()));

  let passInput = await firstVisible(page.locator('input[type="password"]'));

  if(!userInput || !passInput){
    // Fallback: first two inputs in the first form
    const form = (await firstVisible(page.locator("form"))) || page.locator("body");
    if(!userInput) userInput = await firstVisible(form.locator("input").nth(0));
    if(!passInput) passInput = await firstVisible(form.locator('input[type="password"], input').nth(1));
  }
  if(!userInput) throw new Error("LOGIN: username input not found");
  if(!passInput) throw new Error("LOGIN: password input not found");

  await userInput.fill(creds.username);
  await passInput.fill(creds.password);

  const submit =
    (await firstVisible(page.getByRole("button", { name: /^login$/i }))) ||
    (await firstVisible(page.locator('button[type="submit"]'))) ||
    (await firstVisible(page.locator('input[type="submit"]'))) ||
    (await firstVisible(page.locator('button')));

  if(!submit) throw new Error("LOGIN: submit button not found");

  await Promise.allSettled([
    page.waitForLoadState("networkidle", { timeout: 45000 }),
    page.waitForURL(/\/(Lead\/Inbox|Dashboard|Home)\b/i, { timeout: 45000 }).catch(()=>{}),
    submit.click()
  ]);

  // Make sure we’re on the app, then we’ll navigate ourselves to the pack:
  await page.goto(DASH_URL, { waitUntil: "domcontentloaded" }).catch(()=>{});
  dlog('Login: completed; on dashboard/home');
}

// ---------- go to All Leads ----------
async function goToAllLeads(page){
  dlog('Nav: going to All Leads');
  const myLeads =
    (await firstVisible(page.getByRole("link",  { name: /my leads/i }))) ||
    (await firstVisible(page.getByRole("button",{ name: /my leads/i }))) ||
    (await firstVisible(page.locator('a:has-text("My Leads"), button:has-text("My Leads")')));

  if(myLeads){ await myLeads.click().catch(()=>{}); await sleep(300); }

  const allLeads =
    (await firstVisible(page.getByRole("link",  { name: /all leads/i }))) ||
    (await firstVisible(page.getByRole("button",{ name: /all leads/i }))) ||
    (await firstVisible(page.locator('a:has-text("All Leads"), button:has-text("All Leads")')));

  if(allLeads){
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout: 15000 }),
      allLeads.click()
    ]);
  }

  // Force the URL either way.
  await page.goto(PACK_URL, { waitUntil: "domcontentloaded" });

  // Wait until the list actually renders links to /Lead/InboxDetail?LeadId=
  await page.waitForSelector(`a[href*="${PACK_ANCHOR}"]`, { timeout: 30000 });
  dlog('Nav: All Leads loaded with pack links present');
}

// ===== Selectors tuned for the Lead Inbox (DataTables-like) =====
// ---------- helpers to extract numbers from page text ----------
const TOKEN_RE = /(?:\+?1[\s-]?)?(?:\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}|\b\d{7}\b)(?:\s*(?:x|ext\.?|#)\s*\d{2,6})?/gi;

async function gatherVisibleNumberTokens(page){
  return await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'gi');
    const toks = new Set();
    const walk = (root) => {
      const els = root.querySelectorAll('*');
      for(const el of els){
        if(!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
        const t = (el.textContent || '').trim();
        let m; while((m = re.exec(t))){
          toks.add(m[0]);
        }
        const href = el.getAttribute && el.getAttribute('href') || '';
        if (href && /tel:/i.test(href)) toks.add(href);
        const oc = el.getAttribute && el.getAttribute('onclick') || '';
        if (/\d{7,}/.test(oc)) toks.add(oc);
        const dp = el.dataset && el.dataset.phone || '';
        if (/\d{7,}/.test(dp)) toks.add(dp);
      }
    };
    walk(document.body);
    return Array.from(toks);
  }, TOKEN_RE.source);
}

// ---------- harvest Click-to-Call by “diffing” before/after click ----------
async function harvestClickToCall(page){
  const rows = [];

  // prefer the strip Call button (the one in the row with Appt./Comments/Resolve)
  const callBtn =
    (await firstVisible(page.locator('div:has(button:has-text("Appt.")) >> button:has-text("Call")'))) ||
    (await firstVisible(page.getByRole("button", { name: /^Call$/ }))) ||
    (await firstVisible(page.locator('button:has-text("Call")'))) ||
    (await firstVisible(page.locator('a:has-text("Call")')));

  if(!callBtn) return rows;

  const before = new Set(await gatherVisibleNumberTokens(page));
  await callBtn.click().catch(()=>{});
  // drawer animates; poll ~2s until new tokens appear
  let after = new Set();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(300);
    after = new Set(await gatherVisibleNumberTokens(page));
    if (after.size > before.size) break;
  }

  const diff   = Array.from(after).filter(s => !before.has(s));
  dlog('Click2Call: tokens before/after/diff =', before.size, after.size, diff.length);

  const seen = new Set();
  for (const token of diff) {
    const norm = normalizePhoneCandidate(token, "ClickToCall");
    if (!norm) continue;
    const key = `${norm.rawDigits || norm.original}-${norm.extension||""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      primaryName: null,            // filled by caller
      source: "click2call",
      lineType: "ClickToCall",
      original: norm.original,
      rawDigits: norm.rawDigits,
      phone: norm.phone,
      extension: norm.extension || null,
      tollFree: !!norm.tollFree,
      international: !!norm.international,
      valid: !!norm.valid,
      flag: norm.flags.join(", ")
    });
  }

  return uniqBy(rows, r => `${r.rawDigits || r.original}-${r.extension||""}`);
}

// ---------- expand all policies ("More" -> "Less") ----------
async function expandAllPolicies(page){
  // one More usually expands all; loop defensively
  for(let i=0;i<12;i++){
    const more = await firstVisible(page.locator('button:has-text("More"), a:has-text("More")'));
    if(!more) break;
    await more.click().catch(()=>{});
    await sleep(350);
    const anotherMore = await firstVisible(page.locator('button:has-text("More"), a:has-text("More")'));
    if(!anotherMore) break; // no more sections left
  }
}

// ---------- get primary name from the *lead card header* (not the top-right agent name) ----------
async function getPrimaryNameFromHeader(page){
  const name = await page.evaluate(() => {
    // Anchor on the Back button, then look just below it on the LEFT half
    const back = Array.from(document.querySelectorAll('a,button'))
      .find(el => /(^|\b)back\b/i.test(el.textContent || ''));
    const backBottom = back ? back.getBoundingClientRect().bottom : 0;
    const zoneTop = backBottom;
    const zoneBottom = backBottom + 220;        // only a short band under Back
    const zoneRight = window.innerWidth * 0.55; // only left side candidates
    const bad = /^(BACK|DETAIL|CALL|APPT\.?|COMMENTS|RESOLVE|VIEWING\s+\d+\s*\/\s*\d+)$/i;

    const cands = [];
    document.querySelectorAll('body *').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top < zoneTop || rect.top > zoneBottom) return;
      if (rect.left > zoneRight) return; // discard items on right side/top bar
      const txt = (el.textContent || '').trim();
      if (!txt) return;
      if (bad.test(txt)) return;
      if (/\d{3,}/.test(txt)) return;      // no phone-esque strings
      if (/[a-z]/.test(txt)) return;       // must be uppercase-ish
      if (!/[A-Z]/.test(txt)) return;      // needs letters
      // likely LAST, FIRST pattern or single token in caps
      cands.push({ t: txt, y: rect.top, x: rect.left });
    });
    cands.sort((a,b)=>a.y - b.y || a.x - b.x);
    return cands.length ? cands[0].t : null;
  });
  return name || null;
}

// ---------- parse all policy blocks & phones; compute monthly total (active only) ----------
async function parseLeadDetail(page){
  await expandAllPolicies(page);

  // compute monthly total (= sum of Special for Active policies only)
  const pageText = await page.evaluate(() => document.body.innerText || "");
  const blocks = pageText.split(/\bStage:\s*/i).slice(1);
  let monthlyTotalActive = 0;
  let policyBlockCount = 0;
  let activeBlockCount = 0;

  for (const rawBlock of blocks) {
    policyBlockCount++;
    const block = rawBlock.slice(0, 2500);

    let isLapsed =
      /\bLAPSED\s+POLICY\b/i.test(block) ||
      /^\s*Lapsed\b/i.test(block) ||
      /\bStat:\s*99\b/i.test(block);

    const sp = block.match(/\bSpecial\s+([$\d][\d,]*(?:\.\d{1,2})?)/i);
    let specialMonthly = 0;
    if (sp) {
      const n = Number(String(sp[1]).replace(/[$,]/g, ''));
      if (!Number.isNaN(n)) specialMonthly = n;
    }

    let active = !isLapsed;
    // date-based lapsed logic (monthly/annual)
    const modeM = block.match(/\bMode\s+([A-Za-z]+)/i);
    const dueM  = block.match(/\bDue\s*(?:Date|Day)\s+([0-9]{1,2})\b/i);
    const paidM = block.match(/\bPolicy\s+Paid\s+To\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2})\b/i);
    const mode = modeM ? modeM[1].toLowerCase() : null;
    const dueDay = dueM ? parseInt(dueM[1],10) : null;

    let paidTo = null;
    if (paidM) {
      const s = paidM[1];
      const parts = s.includes('-') ? s.split('-').map(Number) : s.split('/').map(Number);
      if (s.includes('-')) {
        paidTo = new Date(parts[0], parts[1]-1, parts[2]); // YYYY-M-D
      } else {
        const Y = parts[2] < 100 ? 2000 + parts[2] : parts[2];
        paidTo = new Date(Y, parts[0]-1, parts[1]);       // M/D/YY|YYYY
      }
    }

    if (active && paidTo) {
      const today = new Date();
      if (mode === 'annual') {
        const diff = Math.floor((today - paidTo) / 86400000);
        active = diff <= 366; // >1 year is lapsed
      } else if (dueDay) {
        const last = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
        const anchor = new Date(today.getFullYear(), today.getMonth(), Math.min(Math.max(dueDay,1), last));
        const delta = Math.floor((anchor - paidTo) / 86400000);
        active = delta <= 60; // 60-day grace
      } else {
        const diff = Math.floor((today - paidTo) / 86400000);
        active = diff <= 60; // fallback monthly
      }
    }

    if (active && specialMonthly > 0) monthlyTotalActive += specialMonthly;
    if (active) activeBlockCount++;
  }

  // extract the primary name from header (after page load)
  const primaryNameHeader = await getPrimaryNameFromHeader(page);

  // ---- collect policy phones (Ph:/Sec Ph:) from DOM AND from each policy text block ----
  const policyRows = [];
  const seen = new Set();
  const pushPolicyNumber = (token, label, primaryName) => {
    const norm = normalizePhoneCandidate(token, label);
    if (!norm) return;
    const key = `${norm.rawDigits || norm.original}-${norm.extension || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    policyRows.push({
      primaryName,
      source: "policy",
      lineType: /sec/i.test(label) ? "Secondary" :
                /cell/i.test(label) ? "Cell" :
                /home/i.test(label) ? "Home" :
                /work/i.test(label) ? "Work" : "Policy",
      original: norm.original,
      rawDigits: norm.rawDigits,
      phone: norm.phone,
      extension: norm.extension || null,
      tollFree: !!norm.tollFree,
      international: !!norm.international,
      valid: !!norm.valid,
      flag: norm.flags.join(", ")
    });
  };

  // A) same-line label forms inside each policy text block (handles "Ph: 555…  Sec Ph: 444…")
  const blockTokenReSrc = TOKEN_RE.source;
  for (const rawBlock of blocks) {
    // Find label + following number-ish text, then tokenize numbers within it
    const labelSpanRe = /(Ph|Phone|Sec(?:ond(?:ary)?)?\s*Ph|Second(?:ary)?\s*Phone)\s*:?\s*([()\-\s.\d+xext#]{7,})/ig;
    let m;
    while ((m = labelSpanRe.exec(rawBlock))) {
      const label = m[1];
      const span = m[2] || '';
      const tokRe = new RegExp(blockTokenReSrc, 'gi');
      let t;
      while ((t = tokRe.exec(span))) {
        pushPolicyNumber(t[0], label, primaryNameHeader || null);
      }
    }
  }

  // B) table/sibling label:value pairs in DOM (kept for pages that separate cells)
  const domPairs = await page.evaluate(() => {
    const out = [];
    const labelRe = /^(?:Ph|Phone|Sec(?:ond(?:ary)?)?\s*Ph|Second(?:ary)?\s*Phone|Cell|Home|Work)\s*:?$/i;

    const harvest = (labelEl, valueEl) => {
      const label = (labelEl.textContent || '').trim();
      const strings = [];

      const valTxt = (valueEl.textContent || '').trim();
      if (/\d{7,}/.test(valTxt)) strings.push(valTxt);

      valueEl.querySelectorAll('a, button, span').forEach(el => {
        const href = el.getAttribute('href') || '';
        if (href.startsWith('tel:')) strings.push(href);
        const oc = el.getAttribute('onclick') || '';
        if (/\d{7,}/.test(oc)) strings.push(oc);
        const dp = (el.dataset && el.dataset.phone) || '';
        if (/\d{7,}/.test(dp)) strings.push(dp);
        const txt = el.textContent || '';
        if (/\d{7,}/.test(txt)) strings.push(txt);
      });

      if (strings.length) out.push({ label, strings });
    };

    // tables
    document.querySelectorAll('table').forEach(tbl => {
      tbl.querySelectorAll('tr').forEach(tr => {
        const cells = Array.from(tr.children);
        for (let i = 0; i < cells.length - 1; i++) {
          const key = (cells[i].textContent || '').trim();
          if (labelRe.test(key)) harvest(cells[i], cells[i+1]);
        }
      });
    });

    return out;
  });

  const tokenRe = new RegExp(TOKEN_RE.source, 'gi');
  for (const { label, strings } of domPairs) {
    for (const s of strings) {
      tokenRe.lastIndex = 0;
      let m; while ((m = tokenRe.exec(s))) pushPolicyNumber(m[0], label, primaryNameHeader || null);
    }
  }

  return {
    primaryNameHeader,
    policyRows,
    monthlyTotalActive,
    policyBlockCount,
    activeBlockCount
  };
}

// ---------- go to next lead via right-arrow; return false on end/error ----------
async function goToNextLead(page){
  const next =
    (await firstVisible(page.locator('a[href*="/Lead/MoveNext"]'))) ||
    (await firstVisible(page.getByRole('link', { name: /next/i }))) ||
    (await firstVisible(page.locator('button[onclick*="MoveNext"]')));

  if(!next) return false;

  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>null);
  await next.click().catch(()=>{});
  await nav;

  const url = page.url();
  if (/\/Lead\/MoveNext/i.test(url)) {
    // final 'Oops' page shows when there is no next record
    const oops = await page.locator('text=Error Occured').first().isVisible().catch(()=>false);
    if (oops) return false;
  }
  return true;
}

/** ======================= Lead Inbox pagination helpers ======================= */

// Set DataTables page length to 100 using select and wait until info says "to 100"
async function setInboxPageSize(page, emit) {
  // DataTables renders: <div id="LeadTable_length"><select>...</select></div>
  const lengthSelect = page.locator('#LeadTable_length select');

  await ensureInboxStable(page);

  // If the select exists, drive it directly
  if (await lengthSelect.count()) {
    const current = await lengthSelect.inputValue().catch(() => null);
    if (current !== '100') {
      await lengthSelect.selectOption('100'); // triggers redraw
    }
  }

  await ensureInboxStable(page);

  // Wait until the info text shows "... to 100 ..."
  try {
    await page.waitForFunction(
      () => /to\s+100\b/i.test(document.querySelector('#LeadTable_info')?.textContent || ''),
      null,
      { timeout: 10000 }
    );
  } catch {
    // fallback: small pause—info sometimes updates just after the redraw completes
    await page.waitForTimeout(250);
  }

  emit?.('info', { msg: 'pack: per page set to 100' });
}

async function getPackLinksFromPage(page) {
  await page.waitForSelector(`${LEAD_TABLE} tbody tr`, { state: 'visible' });
  const hrefs = await page.$$eval(PACK_LINKS_SEL, els =>
    els.map(a => a.getAttribute('href')).filter(Boolean)
  );
  return hrefs;
}

async function clickNextInboxPage(page, emit) {
  // Make sure we’re at the bottom (Paginator lives there)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});

  await ensureInboxStable(page);

  const nextLi = page.locator('#LeadTable_next');
  if (await nextLi.count()) {
    const cls = (await nextLi.getAttribute('class')) || '';
    if (/\bdisabled\b/i.test(cls)) {
      emit?.('info', { msg: 'pack: next disabled (last page)' });
      return false; // no more pages
    }
  }

  const prevInfo = await getInboxInfoText(page);
  const nextA = page.locator('#LeadTable_next a');

  // Try to click Next; if an overlay briefly appears, we'll wait it out below
  await nextA.click({ timeout: 5000 }).catch(() => {});

  await ensureInboxStable(page);
  await waitInboxInfoChange(page, prevInfo).catch(() => {
    // As a last resort, press ESC to dismiss any lingering bootstrap dropdowns/modals
    return page.keyboard.press('Escape').then(() => waitInboxInfoChange(page, prevInfo));
  });

  emit?.('info', { msg: 'nav: next page' });
  return true;
}

async function collectPaginated(page, maxLeads, emit) {
  await setInboxPageSize(page, emit);

  const all = [];
  let pageNum = 1;

  for (;;) {
    const hrefs = await getPackLinksFromPage(page);
    all.push(...hrefs);
    emit('info', { msg: `pack: page ${pageNum} collected ${hrefs.length}, total ${all.length}` });

    if (maxLeads && all.length >= maxLeads) break;
    const advanced = await clickNextInboxPage(page, emit);
    if (!advanced) break;
    pageNum += 1;
  }
  return maxLeads ? all.slice(0, maxLeads) : all;
}

/** ===================== end Lead Inbox pagination helpers ===================== */

// ---------- main scraper ----------
export async function scrapePlanet({ username, password, maxLeads } = {}){
  // Resolve max: explicit opts.max, else .env default, else 200
  const resolvedMax = (toNumber(maxLeads))
    ?? toNumber(process.env.MAX_LEADS_DEFAULT)
    ?? 200;
  const max = resolvedMax;
  console.log('[SCRAPER] starting: max=' + max);

  const startTime = Date.now();
  /* START:EMIT_START */
  emit('start', { username, maxLeads: max });
  /* END:EMIT_START */
  const { browser, context, page } = await launch();
  info('browser: ready');

  // flattened arrays (kept for convenience / jq examples)
  const clickToCallRows = [];
  const policyPhoneRows = [];

  // per-lead results
  const leads = [];
  let leadCount = 0;
  let sumAllLeadsMonthly = 0;

  try{
    info('login: starting');
    await login(page, { username, password });
    info('login: ok');
    info('nav: go to All Leads');
    await goToAllLeads(page);
    info('nav: inbox loaded');
    // Collect all lead links across all inbox pages
    const packlinks = await collectPaginated(page, max, emit);
    // Optionally cap to max strictly
    const toVisit = max ? packlinks.slice(0, max) : packlinks;
    dlog(`Pack: collected ${packlinks.length} lead link(s)`);
    if (toVisit.length === 0) {
      info('No leads found in inbox.');
      return { ok:false, error: "No leads found in inbox." };
    }

    const total = toVisit.length;
    for (let i = 0; i < total; i++) {
      const href = toVisit[i];
      const absUrl = new URL(href, page.url()).toString();
      dlog(`Lead ${i+1}/${total}: opening ${absUrl}`);
      emit('info', { msg: 'lead: opening', href: absUrl });
      await page.goto(absUrl, { waitUntil: "domcontentloaded" });
      await sleep(350);

      // primary name comes from header
      let primaryName = await getPrimaryNameFromHeader(page);
      primaryName = primaryName || null;

      /* START:EMIT_LEAD */
      emit('lead', { index: i + 1, total: total, leadName: primaryName });
      /* END:EMIT_LEAD */

      // 1) click-to-call
      const c2c = await harvestClickToCall(page);
      c2c.forEach(r => (r.primaryName = primaryName || r.primaryName));
      dlog(`Lead ${i+1}: click-to-call rows -> ${c2c.length}`);
      clickToCallRows.push(...c2c);

      // 2) policies + phones + monthly total (active only)
      const detail = await parseLeadDetail(page);
      if (!primaryName && detail.primaryNameHeader) primaryName = detail.primaryNameHeader || primaryName;

      // Build extras-only policy numbers (exclude anything already in Click-to-Call)
      const c2cDigits = new Set((c2c || []).map(r => r.rawDigits || onlyDigits(r.phone || r.original || '')));
      const policyPhonesExtra = (detail.policyRows || []).filter(r => {
        const k = r.rawDigits || onlyDigits(r.phone || r.original || '');
        return k && !c2cDigits.has(k);
      });
      info(`lead ${i+1}: monthly=${detail.monthlyTotalActive} listed=${c2c.length} extras=${policyPhonesExtra.length}`);
      dlog(`Lead ${i+1}: policy rows -> ${detail.policyRows.length} (extras only: ${policyPhonesExtra.length}), monthly active total -> ${detail.monthlyTotalActive}`);
      policyPhoneRows.push(...policyPhonesExtra);

      const flaggedNumbers = [
        ...c2c.filter(r => (r.flags || []).length),
        ...policyPhonesExtra.filter(r => (r.flags || []).length)
      ];

      /* START:EMIT_NUMBERS */
      emit('numbers', {
        leadName: primaryName,
        listedCount: c2c.length,
        extraCount: policyPhonesExtra.length,
        flaggedCount: flaggedNumbers.length
      });
      /* END:EMIT_NUMBERS */

      // per-lead rollup & badge
      const leadMonthly = Number(detail.monthlyTotalActive.toFixed(2));
      const hasAnyPolicy = detail.policyBlockCount > 0;
      const allPoliciesLapsed = hasAnyPolicy && detail.activeBlockCount === 0;

      // valid numbers across both sources (after extras filter)
      const validDigits = new Set();
      const accValid = (r) => { if (r && r.valid && (r.rawDigits||'').length===10) validDigits.add(r.rawDigits); };
      (c2c || []).forEach(accValid);
      (policyPhonesExtra || []).forEach(accValid);

      // Badge precedence:
      // 🔴 = all policies lapsed (regardless of total)
      // 🟠 = no valid numbers (unless already red)
      // ⭐ = total >= 100
      // 🟣 = total < 50 (unless already red/orange)
      // "" = 50–99.99
      let leadStar;
      if (allPoliciesLapsed) {
        leadStar = "🔴";
      } else if (validDigits.size === 0) {
        leadStar = "🟠";
      } else if (leadMonthly >= 100) {
        leadStar = "⭐";
      } else if (leadMonthly < 50) {
        leadStar = "🟣";
      } else {
        leadStar = "";
      }

      /* START:EMIT_BADGE */
      emit('badge', { leadName: primaryName, badge: leadStar, totalPremium: leadMonthly });
      /* END:EMIT_BADGE */

      leads.push({
        primaryName: primaryName || null,
        monthlySpecialTotal: leadMonthly,
        star: leadStar,
        clickToCall: c2c,
        policyPhones: policyPhonesExtra, // extras only
        allPoliciesLapsed
      });

      sumAllLeadsMonthly += leadMonthly;
      leadCount++;

      if (leadCount >= max) break;
    }

    /* START:EMIT_DONE */
    emit('done', { processed: leadCount, ms: Date.now() - startTime });
    /* END:EMIT_DONE */
    return {
      ok: true,
      leads,                    // per-lead (name, monthly, star, phones)
      // flattened for quick jq/testing:
      clickToCall: clickToCallRows,
      policyPhones: policyPhoneRows,
      meta: {
        ts: nowIso(),
        leadCount,
        sumMonthlyAcrossLeads: Number(sumAllLeadsMonthly.toFixed(2))
      }
    };

  }catch(err){
    reportError(err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }finally{
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}
