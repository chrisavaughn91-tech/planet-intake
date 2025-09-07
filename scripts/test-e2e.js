/* scripts/test-e2e.js
 * E2E hits /scrape via SSE, waits for {type:"done"}, asserts we saw a sheet URL,
 * and exits. Designed to finish in a few minutes.
 */
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const MAX  = Number(process.env.E2E_MAX || 10);                 // keep E2E fast
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 15*60*1000); // 15m ceiling

function parseSSE(chunk) {
  // Very small, line-based SSE parser
  const events = [];
  const blocks = chunk.split('\n\n');
  for (const b of blocks) {
    if (!b.trim()) continue;
    let type = 'message';
    let data = '';
    for (const line of b.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:'))  data += (data ? '\n' : '') + line.slice(5).trim();
    }
    events.push({ type, data });
  }
  return events;
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

let sawSheet = false;
let sheetUrl  = null;
let processed = 0;

try {
  const url = `${BASE}/scrape?maxLeads=${encodeURIComponent(MAX)}`;
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
    const events = parseSSE(buffer);
    // keep only the last partial block (if any)
    buffer = buffer.endsWith('\n\n') ? '' : buffer.slice(buffer.lastIndexOf('\n\n') + 2);

    for (const ev of events) {
      if (ev.type === 'error') {
        const e = (() => { try { return JSON.parse(ev.data); } catch { return { msg: ev.data }; } })();
        throw new Error(`/scrape reported error: ${e.msg || ev.data}`);
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
        // success criteria
        if (!sawSheet) throw new Error('did not receive sheet url');
        if (processed <= 0) throw new Error('processed count is 0');
        console.log(`E2E PASS: sheet=${sheetUrl} processed=${processed}`);
        process.exit(0);
      }
    }
  }

  throw new Error('stream ended unexpectedly without "done"');
} catch (err) {
  console.error('E2E FAIL:', err?.stack || err);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}

