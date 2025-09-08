/* eslint-disable */
// scripts/test-e2e.js  (CommonJS)
// E2E hits /scrape via SSE, waits for {type:"done"}, asserts we saw a sheet URL,
// and exits. Designed to finish quickly with smaller lead count.

const BASE = process.env.BASE_URL || 'http://localhost:8080';

// Resolve a smoke-test cap: CLI --max > E2E_MAX_LEADS > 10
const argv = process.argv.slice(2);
const getFlag = (name) => {
  const p = `--${name}=`;
  const hit = argv.find(a => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
};
const cliMax = getFlag('max');
const envMax = process.env.E2E_MAX_LEADS;
const SMOKE_LIMIT = Number.isFinite(Number(cliMax)) ? Number(cliMax)
                 : Number.isFinite(Number(envMax))  ? Number(envMax)
                 : 10; // default smoke size

console.log('[E2E] using smoke limit =', SMOKE_LIMIT);

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 15 * 60 * 1000);

function parseBlocks(buffer) {
  // Split by empty line; return {events, leftover}
  const parts = buffer.split('\n\n');
  let leftover = '';
  if (!buffer.endsWith('\n\n')) leftover = parts.pop() ?? '';
  const events = [];
  for (const b of parts) {
    if (!b.trim()) continue;
    let type = 'message';
    let data = '';
    for (const line of b.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
    }
    events.push({ type, data });
  }
  return { events, leftover };
}

(async () => {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let sawSheet = false;
  let sheetUrl = null;
  let processed = 0;

  try {
    const url = `${BASE}/scrape?limit=${encodeURIComponent(SMOKE_LIMIT)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, leftover } = parseBlocks(buffer);
      buffer = leftover;

      for (const ev of events) {
        if (ev.type === 'error') {
          let msg = ev.data;
          try { msg = JSON.parse(ev.data).msg || msg; } catch {}
          throw new Error(`/scrape reported error: ${msg}`);
        }

        if (ev.type === 'sheet') {
          try {
            const d = JSON.parse(ev.data);
            sheetUrl = d.url || d.sheetUrl || null;
            if (sheetUrl && /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(sheetUrl)) {
              sawSheet = true;
            }
          } catch {}
        }

        if (ev.type === 'done') {
          try {
            const d = JSON.parse(ev.data);
            processed = Number(d.processed || 0);
          } catch {}
          if (!sawSheet) throw new Error('did not receive sheet url');
          if (processed <= 0) throw new Error('processed count is 0');
          console.log(`E2E PASS: sheet=${sheetUrl} processed=${processed}`);
          clearTimeout(abortTimer);
          process.exit(0);
        }

        if (ev.type === 'end') {
          // Server ended SSE without "done"
          throw new Error('stream ended without "done"');
        }
      }
    }

    throw new Error('stream ended unexpectedly without "done"');
  } catch (err) {
    clearTimeout(abortTimer);
    console.error('E2E FAIL:', err.stack || err);
    process.exit(1);
  }
})();
