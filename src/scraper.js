const { chromium } = require("playwright");
const { emit } = require('./events');

// ---- URLs ----
const BASE = "https://m.planetaltig.com";
const LOGIN_URL = `${BASE}/Account/Login`;
const DASH_URL  = `${BASE}/`;
const PACK_URL  = `${BASE}/Lead/Inbox`; // "All Leads" ends here
const PACK_ANCHOR = '/Lead/InboxDetail?LeadId=';

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
  if(/[01]/.test(npa[0])) return false;
  if(/[01]/.test(nxx[0])) return false;
  if(npa === '555' && /^01\d\d$/.test(line)) return false;
  if(/^(211|311|411|511|611|711|811|911)$/.test(npa)) return false;
  return true;
}

const TOLL_FREE = new Set(["800","888","877","866","855","844","833","822"]);

function normalizePhoneCandidate(raw, contextLabel){
  if (/\b(dnc|do\s*not\s*call)\b/i.test(String(raw))) return null;

  let ext = null;
  const extMatch = String(raw).match(/\b(?:x|ext\.?|#)\s*([0-9]{2,6})\b/i);
  if(extMatch) ext = extMatch[1];

  let s = String(raw)
    .replace(/\b(?:x|ext\.?|#)\s*[0-9]{2,6}\b/ig,'')
    .replace(/[^\d+]/g, '');

  if(s.startsWith('+1')) s = s.slice(2);
  if(s.length === 11 && s.startsWith('1')) s = s.slice(1);

  let rawDigits = null, pretty = null, valid = false, flags = [];
  let tollFree = false, international = false;

  if(s.startsWith('+') && !s.startsWith('+1')) international = true;

  if(/^\d{10}$/.test(s)){
    rawDigits = s;
    valid = validUS10(s);
    pretty = valid ? toPretty(s) : null;
    if(TOLL_FREE.has(s.slice(0,3))) tollFree = true;
  }else if(/^\d{7}$/.test(s)){
    rawDigits = s;
    flags.push("Needs Area Code");
    pretty = `${s.slice(0,3)}-${s.slice(3)}`;
  }else{
    return null;
  }

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
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  dlog('Browser/context/page launched');
  return { browser, context, page };
}

// ---------- login ----------
async function login(page, creds){
  dlog('Login: navigating to login page');
  await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 60000 });

  let userInput =
    (await firstVisible(page.locator('input[type="text"]'))) ||
    (await firstVisible(page.locator('input[type="email"]'))) ||
    (await firstVisible(page.locator('form input').first()));

  let passInput = await firstVisible(page.locator('input[type="password"]'));

  if(!userInput || !passInput){
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

  await page.goto(PACK_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`a[href*="${PACK_ANCHOR}"]`, { timeout: 30000 });
  dlog('Nav: All Leads loaded with pack links present');
}

// ---------- collect this page’s links fast ----------
async function collectLeadPackLinksFast(page, limit){
  return await page.$$eval(
    `a[href*="${PACK_ANCHOR}"]`,
    (els, arg) => {
      const { limit, base } = arg;
      const out = [];
      for (const a of els) {
        const href = a.getAttribute('href');
        if (!href) continue;
        let name = (a.textContent || '').trim();
        if (/^detail$/i.test(name)) {
          const tr = a.closest('tr');
          const firstCell = tr && tr.querySelector('td, th');
          const nameAnchor = firstCell && firstCell.querySelector('a');
          const candidate = (nameAnchor ? nameAnchor.textContent : (firstCell && firstCell.textContent)) || '';
          name = (candidate || name).trim();
        }
        out.push({ href: new URL(href, base).toString(), name });
        if (out.length >= limit) break;
      }
      return out;
    },
    { limit, base: BASE }   // SINGLE object arg (prevents “Too many arguments”)
  );
}

// ---------- robust paginator (keeps page-size; numeric first, then Next) ----------
async function collectLeadLinks(page, maxLeads, emitFn){
  const seen = new Set();
  let pageNo = 1;

  const emitPag = async (action, extra = {}) => {
    try { emitFn && emitFn({ action, page: pageNo, ...extra }); } catch {}
  };

  // Parse "Showing 51 to 73 of 73 entries"
  async function readInfo() {
    return await page.evaluate(() => {
      const n = Array.from(document.querySelectorAll('*'))
        .find(el => /Showing\s+\d+\s+to\s+\d+\s+of\s+\d+\s+entries/i.test(el.textContent || ''));
      if (!n) return null;
      const m = (n.textContent || '').match(/Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+entries/i);
      if (!m) return null;
      return {
        from: +m[1],
        to: +m[2],
        total: +m[3],
        perPage: (+m[2]) - (+m[1]) + 1,
        raw: n.textContent.trim()
      };
    });
  }

  async function getActivePageNumber(infoRow){
    const cur = await page.$eval(
      '.dataTables_paginate .paginate_button.current, ul.pagination li.active a, [aria-current="page"]',
      el => (el.textContent || '').trim()
    ).catch(()=>null);
    if (cur && /^\d+$/.test(cur)) return parseInt(cur, 10);

    if (infoRow && infoRow.perPage) {
      return Math.floor((infoRow.from - 1) / infoRow.perPage) + 1;
    }
    return 1;
  }

  async function clickNumeric(toNum){
    const sel = `.dataTables_paginate a:has-text("${toNum}"), ul.pagination a:has-text("${toNum}")`;
    const h = await page.$(sel);
    if (h) {
      await page.evaluate((s) => {
        const a = document.querySelector(s);
        if (a) { a.scrollIntoView({block:'center'}); a.click(); }
      }, sel).catch(()=>{});
      return sel;
    }
    return null;
  }

  async function clickNext(){
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const sels = [
      '.dataTables_paginate a.next:not(.disabled)',
      'li.next:not(.disabled) a',
      'a.paginate_button.next:not(.disabled)',
      'a[aria-label="Next"]:not([aria-disabled="true"])',
      'a:has-text("Next")'
    ];
    for (const sel of sels) {
      const h = await page.$(sel);
      if (h) {
        await page.evaluate((s) => {
          const a = document.querySelector(s);
          if (a) { a.scrollIntoView({block:'center'}); a.click(); }
        }, sel).catch(()=>{});
        return sel;
      }
    }
    return null;
  }

  const firstHref = async () => {
    const h = await page.$(`a[href*="${PACK_ANCHOR}"]`);
    if (!h) return null;
    const raw = await h.getAttribute('href');
    return raw ? new URL(raw, BASE).toString() : null;
  };

  while (seen.size < maxLeads) {
    await page.waitForSelector(`a[href*="${PACK_ANCHOR}"]`, { timeout: 30000 });

    const need = maxLeads - seen.size;
    const pageLinks = await collectLeadPackLinksFast(page, need);
    for (const L of pageLinks) {
      if (!seen.has(L.href)) seen.add(L.href);
      if (seen.size >= maxLeads) break;
    }

    if (seen.size >= maxLeads) break;

    const infoRow = await readInfo();
    if (infoRow && infoRow.to >= infoRow.total) {
      await emitPag('end-of-list', { info: infoRow });
      break;
    }

    const prevFirst = await firstHref();
    const prevInfoRaw = infoRow ? infoRow.raw : null;
    const activeNum = await getActivePageNumber(infoRow);
    let clickedKind = null;

    // Prefer numeric (go to active+1) so page 1 -> click "2" first
    const numericSel = await clickNumeric(activeNum + 1);
    if (numericSel) {
      clickedKind = { kind: 'click-page', detail: { from: activeNum, to: activeNum + 1, selector: numericSel } };
    } else {
      const nextSel = await clickNext();
      if (nextSel) clickedKind = { kind: 'click-next', detail: nextSel };
    }

    if (!clickedKind) {
      await emitPag('no-next-visible', { info: infoRow || null });
      break;
    }

    await emitPag(clickedKind.kind, clickedKind.detail ? { detail: clickedKind.detail } : {});

    // Wait up to 8s for change (either first link changes OR “Showing …” text changes)
    const changed = await page.waitForFunction(
      ({ selector, prevHref, base, prevInfoRaw }) => {
        const a = document.querySelector(selector);
        if (a) {
          const href = a.getAttribute('href') || '';
          const abs = new URL(href, base).toString();
          if (abs && abs !== prevHref) return true;
        }
        const el = Array.from(document.querySelectorAll('*'))
          .find(e => /Showing\s+\d+\s+to\s+\d+\s+of\s+\d+\s+entries/i.test(e.textContent || ''));
        if (el) {
          const raw = (el.textContent || '').trim();
          if (!prevInfoRaw || raw !== prevInfoRaw) return true;
        }
        return false;
      },
      { selector: `a[href*="${PACK_ANCHOR}"]`, prevHref: prevFirst, base: BASE, prevInfoRaw },
      { timeout: 8000 }
    ).catch(() => false);

    if (!changed) {
      if (clickedKind.kind === 'click-next') {
        const numSel2 = await clickNumeric(activeNum + 1);
        if (!numSel2) {
          const info2 = await readInfo();
          await emitPag('next-inert', { info: info2 || infoRow || null });
          break;
        }
        await emitPag('fallback-click-page', { detail: { from: activeNum, to: activeNum + 1, selector: numSel2 } });
        await page.waitForTimeout(600);
      } else {
        const nextSel2 = await clickNext();
        if (!nextSel2) {
          const info2 = await readInfo();
          await emitPag('next-inert', { info: info2 || infoRow || null });
          break;
        }
        await emitPag('fallback-click-next', { detail: nextSel2 });
        await page.waitForTimeout(600);
      }
    }

    pageNo += 1;
    await page.waitForSelector(`a[href*="${PACK_ANCHOR}"]`, { timeout: 15000 }).catch(()=>{});
  }

  return Array.from(seen).map(href => ({ href, name: null }));
}

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

  const callBtn =
    (await firstVisible(page.locator('div:has(button:has-text("Appt.")) >> button:has-text("Call")'))) ||
    (await firstVisible(page.getByRole("button", { name: /^Call$/ }))) ||
    (await firstVisible(page.locator('button:has-text("Call")'))) ||
    (await firstVisible(page.locator('a:has-text("Call")')));

  if(!callBtn) return rows;

  const before = new Set(await gatherVisibleNumberTokens(page));
  await callBtn.click().catch(()=>{});
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
      flag: norm.flags.join(", ")
    });
  }

  return uniqBy(rows, r => `${r.rawDigits || r.original}-${r.extension||""}`);
}

// ---------- expand all policies ("More" -> "Less") ----------
async function expandAllPolicies(page){
  for(let i=0;i<12;i++){
    const more = await firstVisible(page.locator('button:has-text("More"), a:has-text("More")'));
    if(!more) break;
    await more.click().catch(()=>{});
    await sleep(350);
    const anotherMore = await firstVisible(page.locator('button:has-text("More"), a:has-text("More")'));
    if(!anotherMore) break;
  }
}

// ---------- get primary name from the *lead card header* ----------
async function getPrimaryNameFromHeader(page){
  const name = await page.evaluate(() => {
    const back = Array.from(document.querySelectorAll('a,button'))
      .find(el => /(^|\b)back\b/i.test(el.textContent || ''));
    const backBottom = back ? back.getBoundingClientRect().bottom : 0;
    const zoneTop = backBottom;
    const zoneBottom = backBottom + 220;
    const zoneRight = window.innerWidth * 0.55;
    const bad = /^(BACK|DETAIL|CALL|APPT\.?|COMMENTS|RESOLVE|VIEWING\s+\d+\s*\/\s*\d+)$/i;

    const cands = [];
    document.querySelectorAll('body *').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top < zoneTop || rect.top > zoneBottom) return;
      if (rect.left > zoneRight) return;
      const txt = (el.textContent || '').trim();
      if (!txt) return;
      if (bad.test(txt)) return;
      if (/\d{3,}/.test(txt)) return;
      if (/[a-z]/.test(txt)) return;
      if (!/[A-Z]/.test(txt)) return;
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
        paidTo = new Date(parts[0], parts[1]-1, parts[2]);
      } else {
        const Y = parts[2] < 100 ? 2000 + parts[2] : parts[2];
        paidTo = new Date(Y, parts[0]-1, parts[1]);
      }
    }

    if (active && paidTo) {
      const today = new Date();
      if (mode === 'annual') {
        const diff = Math.floor((today - paidTo) / 86400000);
        active = diff <= 366;
      } else if (dueDay) {
        const last = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
        const anchor = new Date(today.getFullYear(), today.getMonth(), Math.min(Math.max(dueDay,1), last));
        const delta = Math.floor((anchor - paidTo) / 86400000);
        active = delta <= 60;
      } else {
        const diff = Math.floor((today - paidTo) / 86400000);
        active = diff <= 60;
      }
    }

    if (active && specialMonthly > 0) monthlyTotalActive += specialMonthly;
    if (active) activeBlockCount++;
  }

  const primaryNameHeader = await getPrimaryNameFromHeader(page);

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

  // A) same-line label forms inside each policy text block
  const blockTokenReSrc = TOKEN_RE.source;
  for (const rawBlock of blocks) {
    const labelSpanRe = /(Ph|Phone|Sec(?:ond(?:ary)?)?\s*Ph|Second(?:ary)?\s*Phone)\s*:?\s*([()\-\s.\d+xext#]{7,})/ig;
    let m;
    while ((m = labelSpanRe.exec(rawBlock))) {
      const label = m[1];
      const span = m[2] || '';
      const tokRe = new RegExp(blockTokenReSrc, 'gi');
      let t;
      while ((t = tokRe.exec(span))) pushPolicyNumber(t[0], label, primaryNameHeader || null);
    }
  }

  // B) table/sibling label:value pairs in DOM
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
    const oops = await page.locator('text=Error Occured').first().isVisible().catch(()=>false);
    if (oops) return false;
  }
  return true;
}

// ---------- main scraper ----------
async function scrapePlanet({ username, password, maxLeads = 5 }){
  const startTime = Date.now();
  /* START:EMIT_START */
  emit('start', { username, maxLeads: maxLeads || process.env.MAX_LEADS_DEFAULT || 5 });
  /* END:EMIT_START */
  const { browser, context, page } = await launch();

  const clickToCallRows = [];
  const policyPhoneRows = [];

  const leads = [];
  let leadCount = 0;
  let sumAllLeadsMonthly = 0;

  try{
    await login(page, { username, password });
    await goToAllLeads(page);

    const links = await collectLeadLinks(
      page,
      Math.max(1, maxLeads),
      (payload) => emit('paginate', payload)
    );

    dlog(`Pack: collected ${links.length} lead link(s)`);
    if (links.length === 0) {
      info('No leads found in inbox.');
      return { ok:false, error: "No leads found in inbox." };
    }

    const total = Math.min(links.length, maxLeads);
    for (let i = 0; i < total; i++) {
      const link = links[i];
      dlog(`Lead ${i+1}/${total}: opening ${link.href}`);
      await page.goto(link.href, { waitUntil: "domcontentloaded" });
      await sleep(350);

      let primaryName = link.name || null;
      if (!primaryName) {
        const hdr = await getPrimaryNameFromHeader(page);
        primaryName = hdr || null;
      }

      /* START:EMIT_LEAD */
      emit('lead', { index: i + 1, total: total, leadName: primaryName });
      /* END:EMIT_LEAD */

      const c2c = await harvestClickToCall(page);
      c2c.forEach(r => (r.primaryName = primaryName || r.primaryName));
      dlog(`Lead ${i+1}: click-to-call rows -> ${c2c.length}`);
      clickToCallRows.push(...c2c);

      const detail = await parseLeadDetail(page);
      if (!primaryName && detail.primaryNameHeader) primaryName = detail.primaryNameHeader || primaryName;

      const c2cDigits = new Set((c2c || []).map(r => r.rawDigits || onlyDigits(r.phone || r.original || '')));
      const policyPhonesExtra = (detail.policyRows || []).filter(r => {
        const k = r.rawDigits || onlyDigits(r.phone || r.original || '');
        return k && !c2cDigits.has(k);
      });
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

      const leadMonthly = Number(detail.monthlyTotalActive.toFixed(2));
      const hasAnyPolicy = detail.policyBlockCount > 0;
      const allPoliciesLapsed = hasAnyPolicy && detail.activeBlockCount === 0;

      const validDigits = new Set();
      const accValid = (r) => { if (r && r.valid && (r.rawDigits||'').length===10) validDigits.add(r.rawDigits); };
      (c2c || []).forEach(accValid);
      (policyPhonesExtra || []).forEach(accValid);

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
        policyPhones: policyPhonesExtra,
        allPoliciesLapsed
      });

      sumAllLeadsMonthly += leadMonthly;
      leadCount++;

      if (leadCount >= maxLeads) break;
    }

    /* START:EMIT_DONE */
    emit('done', { processed: leadCount, ms: Date.now() - startTime });
    /* END:EMIT_DONE */
    return {
      ok: true,
      leads,
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

module.exports = { scrapePlanet };
