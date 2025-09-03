// src/scraper.js
const { chromium } = require("playwright");
const fs = require("fs");
const { createSheetAndShare } = require("./sheets");
const {
  normalizePersonName,
  normalizeAndFlag,
  dedupePhones,
  labelWindowAccepts,
} = require("./utils/phone");

function makeLogger(runId, stream) {
  return (msg) => {
    if (stream) stream(runId, msg);
    else console.log(msg);
  };
}

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

async function firstVisible(locator){
  const n = await locator.count();
  for(let i=0;i<n;i++){
    const el = locator.nth(i);
    if(await el.isVisible()) return el;
  }
  return null;
}

// ---------- browser helpers ----------
async function dismissAnyModal(page, log) {
  try {
    const hasBackdrop = await page.$('.modal-backdrop.in, .modal-backdrop.show');
    const hasDialog   = await page.$('.modal.in, .modal.show, [role="dialog"].modal');

    if (hasBackdrop || hasDialog) {
      log('Modal detected — attempting to dismiss');

      const closeSelectors = [
        'button.close',
        'button[aria-label="Close"]',
        'button:has-text("Close")',
        'button:has-text("Cancel")',
        'a:has-text("Close")',
        '#SeniorPreCallerModal button.close',
        '#SeniorPreCallerModal button:has-text("Close")',
      ];

      for (const sel of closeSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          try { await btn.click({ timeout: 1000 }); } catch {}
        }
      }

      try { await page.keyboard.press('Escape'); } catch {}

      const backdrop = await page.$('.modal-backdrop.in, .modal-backdrop.show');
      if (backdrop) {
        try { await backdrop.click({ timeout: 1000 }); } catch {}
      }

      await page.evaluate(() => {
        document.querySelectorAll('.modal-backdrop, .modal').forEach(el => {
          el.style.pointerEvents = 'none';
        });
      });

      await page.waitForTimeout(200);

      log('Modal dismiss attempt finished');
    }
  } catch (e) {
    // non-fatal
  }
}

async function clickWithModalGuard(page, locator, label = 'click target', maxTries = 5, log) {
  for (let i = 1; i <= maxTries; i++) {
    try {
      const el = (typeof locator === 'string') ? page.locator(locator) : locator;
      await el.waitFor({ state: 'visible', timeout: 3000 });
      await el.click({ timeout: 2000 });
      return;
    } catch (err) {
      const msg = String(err || '');
      const maybeBackdrop = /intercepts pointer events|not receive pointer events|Element is not attached/i.test(msg);
      log(`Click failed on ${label} (try ${i}/${maxTries}) — ${msg.slice(0,120)}…`);
      if (maybeBackdrop) {
        await dismissAnyModal(page, log);
      } else {
        await page.waitForTimeout(300);
      }
      if (i === maxTries) throw err;
    }
  }
}

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
  return { browser, context, page };
}

// ---------- login ----------
async function login(page, creds, log){
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
  await dismissAnyModal(page, log);
}

// ---------- go to All Leads ----------
async function goToAllLeads(page, log){
  const myLeads =
    (await firstVisible(page.getByRole("link",  { name: /my leads/i }))) ||
    (await firstVisible(page.getByRole("button",{ name: /my leads/i }))) ||
    (await firstVisible(page.locator('a:has-text("My Leads"), button:has-text("My Leads")')));

  if (myLeads) { await clickWithModalGuard(page, myLeads, 'My Leads', 5, log); await sleep(300); }

  const allLeads =
    (await firstVisible(page.getByRole("link",  { name: /all leads/i }))) ||
    (await firstVisible(page.getByRole("button",{ name: /all leads/i }))) ||
    (await firstVisible(page.locator('a:has-text("All Leads"), button:has-text("All Leads")')));

  if (allLeads) { await clickWithModalGuard(page, allLeads, 'All Leads', 5, log); }

  // Force the URL either way.
  await page.goto(PACK_URL, { waitUntil: "domcontentloaded" });
  await dismissAnyModal(page, log);

  // Wait until the list actually renders links to /Lead/InboxDetail?LeadId=
  await page.waitForSelector(`a[href*="${PACK_ANCHOR}"]`, { timeout: 30000 });
}

// ---------- collect first N links (fallback path) ----------
async function collectLeadPackLinks(page, limit){
  const anchors = page.locator(`a[href*="${PACK_ANCHOR}"]`);
  const count = await anchors.count();
  const out = [];

  for(let i=0; i<count && out.length<limit; i++){
    const el = anchors.nth(i);
    const href = await el.getAttribute("href");
    if(!href) continue;

    // Try to get the name from the same row’s first cell if the link text is "Detail"
    const name = await page.evaluate((a) => {
      const link = a;
      const txt  = (link.textContent || '').trim();
      if (!/^detail$/i.test(txt)) return txt;

      const tr = link.closest('tr');
      if (!tr) return txt;

      const firstCell = tr.querySelector('td, th');
      if (!firstCell) return txt;

      const nameAnchor = firstCell.querySelector('a');
      const candidate = (nameAnchor ? nameAnchor.textContent : firstCell.textContent) || '';
      return candidate.trim() || txt;
    }, await el.elementHandle());

    out.push({ href: new URL(href, BASE).toString(), name });
  }
  return out;
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

function buildCompactCsv(rows){
  const byName = new Map();
  for (const r of rows) {
    if (r.status !== 'ok') continue;
    const name = r.primaryName || '';
    const key = `${r.rawDigits || ''}#${r.extension || ''}`;
    if (!byName.has(name)) byName.set(name, new Map());
    const map = byName.get(name);
    if (!map.has(key)) map.set(key, r.pretty || r.rawDigits || r.phone || '');
  }
  const lines = ['"Primary Name","Phones"'];
  for (const [name, map] of byName.entries()) {
    const phones = Array.from(map.values()).join(', ');
    const esc = (s) => String(s).replace(/"/g, '""');
    lines.push(`"${esc(name)}","${esc(phones)}"`);
  }
  return lines.join('\n');
}

// ---------- harvest Click-to-Call by “diffing” before/after click ----------
async function harvestClickToCall(page, log){
  const rows = [];

  const callBtn =
    (await firstVisible(page.getByRole("button", { name: /^Call$/ }))) ||
    (await firstVisible(page.locator('button:has-text("Call")'))) ||
    (await firstVisible(page.locator('a:has-text("Call")')));

  if(!callBtn) return rows;

  const before = new Set(await gatherVisibleNumberTokens(page));
  await clickWithModalGuard(page, callBtn, 'Click-to-Call', 5, log);
  await page.waitForTimeout(800); // numbers slide down

  const after  = new Set(await gatherVisibleNumberTokens(page));
  const diff   = Array.from(after).filter(s => !before.has(s));

  for (const token of diff) {
    const norm = normalizeAndFlag(token, { from: 'click', inPdfLabelWindow: true });
    rows.push({ ...norm, source: 'click', label: '' });
  }

  return dedupePhones(rows);
}

// ---------- expand all policies ("More" -> "Less") ----------
async function expandAllPolicies(page){
  for(let i=0;i<5;i++){
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

async function getCityStateZip(page){
  const txt = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('body *'))
      .map(el => (el.textContent || '').trim())
      .filter(t => /,\s*[A-Za-z]{2,}\s*,?\s*\d{5}/.test(t));
    return cands.length ? cands[0] : '';
  });
  let city = '', state = '', zip = '';
  if (txt) {
    const parts = txt.split(',');
    city = (parts[0] || '').trim();
    state = (parts[1] || '').trim();
    const m = String(txt).match(/(\d{5})/);
    zip = m ? m[1] : '';
  }
  return { city, state, zip };
}

// ---------- parse all policy blocks & phones; compute monthly total (active only) ----------
async function parseLeadDetail(page){
  await expandAllPolicies(page);

  // compute monthly total (= sum of Special for Active policies only)
  const pageText = await page.evaluate(() => document.body.innerText || "");
  const blocks = pageText.split(/\bStage:\s*/i).slice(1);
  let monthlyTotalActive = 0;

  for (const rawBlock of blocks) {
    const block = rawBlock.slice(0, 2500);

    const isLapsed =
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
    if (active) {
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

      if (paidTo) {
        const today = new Date();
        if (mode === 'annual') {
          const diff = Math.floor((today - paidTo) / 86400000);
          active = diff <= 365;
        } else if (dueDay) {
          const last = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
          const anchor = new Date(today.getFullYear(), today.getMonth(), Math.min(Math.max(dueDay,1), last));
          const delta = Math.floor((anchor - paidTo) / 86400000);
          active = delta <= 31;
        } else {
          const diff = Math.floor((today - paidTo) / 86400000);
          active = diff <= 62;
        }
      }
    }

    if (active && specialMonthly > 0) monthlyTotalActive += specialMonthly;
  }

  // extract the primary name from header (after page load)
  const primaryNameHeader = await getPrimaryNameFromHeader(page);

  // ---- collect policy phones (Ph:/Sec Ph:) from DOM AND from each policy text block ----
  const policyRows = [];
  const seen = new Set();
  const pushPolicyNumber = (token, label) => {
    const windowText = `${label || ''} ${token}`;
    const norm = normalizeAndFlag(token, { from: 'pdf', inPdfLabelWindow: labelWindowAccepts(windowText) });
    const key = `${norm.digits || ''}-${norm.extension || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    policyRows.push({ ...norm, source: 'pdf', label: label || '' });
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
        pushPolicyNumber(t[0], label);
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
      let m; while ((m = tokenRe.exec(s))) pushPolicyNumber(m[0], label);
    }
  }

  return {
    primaryNameHeader,
    policyRows,
    monthlyTotalActive
  };
}

// ---------- go to next lead via right-arrow; return false on end/error ----------
async function goToNextLead(page, log){
  const next =
    (await firstVisible(page.locator('a[href*="/Lead/MoveNext"]'))) ||
    (await firstVisible(page.getByRole('link', { name: /next/i }))) ||
    (await firstVisible(page.locator('button[onclick*="MoveNext"]')));

  if(!next) return false;
  log('Moving to next lead');

  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>null);
  await clickWithModalGuard(page, next, 'MoveNext / Next lead', 5, log);
  await nav;

  const url = page.url();
  if (/\/Lead\/MoveNext/i.test(url)) {
    // final 'Oops' page shows when there is no next record
    const oops = await page.locator('text=Error Occured').first().isVisible().catch(()=>false);
    if (oops) return false;
  }
  return true;
}

// ---------- main scraper ----------
async function scrapePlanet({ username, password, email, maxLeads = 5, runId, stream }){
  const log = makeLogger(runId, stream);
  log(`Starting scrape with max ${maxLeads} leads...`);
  const { browser, context, page } = await launch();

  // flattened arrays (kept for convenience / jq examples)
  const allRows = [];
  let leadCount = 0;

  try{
    await login(page, { username, password }, log);
    log('Logged in, navigating to leads...');
    await goToAllLeads(page, log);

    // Open the first lead (fallback path if arrowing fails)
    const links = await collectLeadPackLinks(page, Math.max(1, maxLeads));
    if (links.length === 0) {
      return { ok:false, error: "No leads found in inbox." };
    }
    // go to first lead card
    log('Opening first lead');
    await clickWithModalGuard(page, page.locator('a[href*="/Lead/InboxDetail"]').first(), 'open first lead', 5, log);
    await page.waitForLoadState('domcontentloaded');
    await sleep(350);

    while (leadCount < maxLeads) {
      await dismissAnyModal(page, log);
      log(`Processing lead ${leadCount + 1}`);

      const leadUrl = page.url();
      const leadIdMatch = leadUrl.match(/LeadId=(\d+)/i);
      const leadId = leadIdMatch ? leadIdMatch[1] : '';

      let primaryNameRaw = await getPrimaryNameFromHeader(page);
      let primaryName = normalizePersonName(primaryNameRaw || '') || '(Unknown Lead)';

      const { city, state, zip } = await getCityStateZip(page);

      const clickItems = await harvestClickToCall(page, log);
      const detail = await parseLeadDetail(page);
      const pdfItems = detail.policyRows || [];

      // Override primary name if detail has a better header
      if (detail.primaryNameHeader) {
        primaryName = normalizePersonName(detail.primaryNameHeader) || primaryName;
      }

      const clickSet = new Set(clickItems.map(i => `${i.digits || ''}#${i.extension || ''}`));
      const policyExtra = pdfItems.filter(i => !clickSet.has(`${i.digits || ''}#${i.extension || ''}`));

      const clickCount = clickItems.length;
      const policyExtraCount = policyExtra.length;

      const combined = dedupePhones([...clickItems, ...pdfItems]);
      for (const item of combined) {
        const flags = [...(item.flags || [])];
        if (item.status === 'discard') flags.push('Discard');
        allRows.push({
          leadId,
          primaryName,
          phone: item.pretty || item.digits,
          pretty: item.pretty || item.digits,
          rawDigits: item.digits || '',
          extension: item.extension || '',
          flags: flags.join(', '),
          status: item.status,
          source: item.source,
          label: item.label || '',
          city,
          state,
          zip,
          clickCount,
          policyExtraCount,
        });
      }

      leadCount++;
      if (leadCount >= maxLeads) break;
      const moved = await goToNextLead(page, log);
      if (!moved) break;
      await sleep(300);
    }

    const result = { ok: true, allRows, meta: { ts: nowIso(), leadCount } };

    let sheet = null;
    if (email) {
      const csvString = buildCompactCsv(allRows);
      const csvPath = '/tmp/leads.csv';
      require('fs').writeFileSync(csvPath, csvString, 'utf8');
      const payload = { email, result: { allRows }, csvData: csvString };
      sheet = await createSheetAndShare(payload);
    }

    if (sheet) {
      log(`Sheet ready: ${sheet.url}`);
      log(`CSV emailed to ${email}`);
    }
    log('Scrape finished.');

    if (sheet) {
      return { ok: true, sheetUrl: sheet.url, csvUrl: sheet.csvUrl || null, meta: result.meta, leadCount: result.meta.leadCount };
    }

    return result;

  }catch(err){
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }finally{
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

module.exports = { scrapePlanet };
