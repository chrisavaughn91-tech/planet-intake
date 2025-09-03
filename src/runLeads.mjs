// Self-contained lead navigation helpers using Playwright.
// Exports: runLeads, isVisible, getViewing, waitForViewingChange, clickNext.

// ---- visibility helper ----
export async function isVisible(el) {
  if (!el) return false;
  try {
    return await el.evaluate((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
      if (node.hasAttribute('disabled')) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  } catch {
    return false;
  }
}

// ---- parse "Viewing X / Y" ----
export async function getViewing(pageOrFrame) {
  try {
    const text = await pageOrFrame.evaluate(() => document.body ? document.body.innerText : '');
    const m = text.match(/Viewing\s+(\d+)\s*\/\s*(\d+)/i);
    if (!m) return null;
    return { index: Number(m[1]), total: Number(m[2]), raw: m[0] };
  } catch {
    return null;
  }
}

async function findViewing(pageOrFrame) {
  let info = await getViewing(pageOrFrame);
  if (info) return info;
  const frames = typeof pageOrFrame.frames === 'function'
    ? pageOrFrame.frames()
    : typeof pageOrFrame.childFrames === 'function'
      ? pageOrFrame.childFrames()
      : [];
  for (const f of frames) {
    const url = typeof f.url === 'function' ? f.url() : '';
    if (!url.includes('/Lead/InboxDetail')) continue;
    info = await getViewing(f);
    if (info) return info;
  }
  return null;
}

// ---- wait for lead index change ----
export async function waitForViewingChange(pageOrFrame, prevIndex, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await findViewing(pageOrFrame);
    if (info && info.index !== prevIndex) return info;
    await pageOrFrame.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for lead index to change from ${prevIndex}`);
}

// ---- click the Next control ----
export async function clickNext(page) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  const frames = [page, ...page.frames().filter(f => f.url().includes('/Lead/InboxDetail'))];

  async function collect(selectors) {
    const hits = [];
    for (const frame of frames) {
      for (const sel of selectors) {
        const elements = await frame.$$(sel);
        for (const el of elements) {
          const ancestor = await el.evaluateHandle((node) => {
            let cur = node;
            while (cur && !(cur instanceof HTMLButtonElement) && !(cur instanceof HTMLAnchorElement)) {
              cur = cur.parentElement;
            }
            return cur || node;
          });
          if (!(await isVisible(ancestor))) continue;
          const box = await ancestor.boundingBox();
          if (!box) continue;
          hits.push({ handle: ancestor, box });
        }
      }
    }
    return hits;
  }

  const preciseSelectors = [
    'button[aria-label*="Next" i]',
    'a[aria-label*="Next" i]',
    'button[title*="Next" i]',
    'a[title*="Next" i]'
  ];
  const iconSelectors = [
    '.fa-chevron-right, .fa-angle-right, .glyphicon-chevron-right, [class*="chevron-right"], [class*="angle-right"], [data-icon*="chevron-right"]',
    'text=">"',
    'text="›"',
    'text="»"'
  ];

  let candidates = await collect(preciseSelectors);
  if (!candidates.length) {
    candidates = await collect(iconSelectors);
  }

  if (!candidates.length) return false;

  const header = candidates.filter(c => c.box.y < 200);
  const usable = header.length ? header : candidates;
  usable.sort((a, b) => (b.box.x + b.box.width) - (a.box.x + a.box.width));

  for (const cand of usable) {
    try {
      await cand.handle.click({ trial: true });
      await cand.handle.click();
      return true;
    } catch {
      // try next candidate
    }
  }

  return false;
}

// ---- stub for lead processing ----
export async function processCurrentLead(/* page */) {
  console.log('processCurrentLead: TODO');
}

// ---- main runner ----
export async function runLeads(page, { leadLimit = Infinity } = {}) {
  let processed = 0;

  let viewing = await findViewing(page);
  if (!viewing) {
    throw new Error('runLeads: could not find "Viewing X / Y" indicator on page.');
  }

  while (true) {
    await processCurrentLead(page);
    processed++;

    viewing = await findViewing(page);
    if (!viewing) {
      throw new Error('Viewing indicator missing after processing a lead.');
    }

    console.log(`Processed ${processed}. Viewing ${viewing.index}/${viewing.total}.`);

    if (processed >= leadLimit) {
      console.log(`Stopping: hit leadLimit (${leadLimit}). Viewing ${viewing.index}/${viewing.total}.`);
      break;
    }
    if (viewing.index >= viewing.total) {
      console.log(`Stopping: last lead reached (${viewing.index}/${viewing.total}).`);
      break;
    }

    const prevIndex = viewing.index;
    const clicked = await clickNext(page);
    if (!clicked) {
      try { await page.screenshot({ path: 'no-next-button.png', fullPage: true }); } catch {}
      const url = page.url();
      throw new Error(`No Next button detected/clickable after processing a lead. URL: ${url}`);
    }

    const changePromise = waitForViewingChange(page, prevIndex, 15000);
    await Promise.race([
      changePromise,
      page.waitForLoadState('networkidle').catch(() => {})
    ]);
    await changePromise;
    await page.waitForTimeout(400);
  }
}

