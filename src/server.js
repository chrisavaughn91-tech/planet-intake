/* START:DOTENV */
import 'dotenv/config';
/* END:DOTENV */
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scrapePlanet } from './scraper.js';
import { createSheetAndShare } from './sheets.js';
import { emit, bus } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === dev-time env sanity ===
const IS_PROD = process.env.NODE_ENV === 'production';
const REQUIRED_ENV = ['GSCRIPT_WEBAPP_URL'];

(function ensureEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    const msg = `[ENV] Missing required env var(s): ${missing.join(', ')}. Add them to .env (GSCRIPT_WEBAPP_URL is required).`;
    if (!IS_PROD) {
      console.error(msg);
      process.exit(1); // fail fast during local/dev
    } else {
      console.warn(msg); // warn in prod; container can still boot
    }
  }
})();

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

async function verifyScript(scriptUrl) {
  // Ensure we hit the JSON endpoint and follow redirects
  const u = new URL(scriptUrl);
  u.searchParams.set('fn', 'hashes');
  let res, text;
  try {
    res = await fetch(u.toString(), { redirect: 'follow' });
    text = await res.text();
  } catch (err) {
    console.error('[SERVER] GS verify fetch error:', u.toString(), err);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.error('[SERVER] GS verify error: failed to parse JSON', {
      url: u.toString(),
      status: res && res.status,
      preview: (text || '').slice(0, 200)
    });
    throw err;
  }
  app.locals.appsScriptHashes = data;
  console.log('[SERVER] Apps Script hashes loaded OK:', data.commit || '(no commit field)');
}

const scriptUrl = process.env.GSCRIPT_WEBAPP_URL;
if (!scriptUrl) {
  throw new Error('GSCRIPT_WEBAPP_URL env is required');
}
verifyScript(scriptUrl).catch((e) => {
  console.error('[SERVER] Startup verifyScript failed:', e);
  process.exit(1);
});

const clients = new Set();
export function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch {}
  }
}
bus.on('evt', broadcast);

const GS_EXPECTED_VERSION = 4;           // must match CANONICAL_VERSION in Code.gs
const GS_EXPECTED_TAG = 'v4-planet-intake-canonical'; // must match CANONICAL_TAG in Code.gs

let GS_STATUS = { ok:false, reason:'not verified' };

async function verifyGScript() {
  const url = process.env.GSCRIPT_WEBAPP_URL;
  if (!url) {
    GS_STATUS = { ok:false, reason:'GSCRIPT_WEBAPP_URL missing in .env' };
    console.warn('[SERVER] GS verify skipped:', GS_STATUS.reason);
    return;
  }
  try {
    const res = await fetch(`${url}?action=health`, { method:'GET' });
    const j = await res.json();
    const localSrc = fs.readFileSync(path.join(process.cwd(), 'apps-script', 'Code.gs'), 'utf8');
    const localSha = crypto.createHash('sha256').update(localSrc, 'utf8').digest('hex');

    GS_STATUS = {
      ok: (j.version === GS_EXPECTED_VERSION && j.tag === GS_EXPECTED_TAG),
      expected: { version: GS_EXPECTED_VERSION, tag: GS_EXPECTED_TAG },
      remote: j,
      local: { sha256: localSha }
    };

    const msg = GS_STATUS.ok
      ? `[SERVER] Apps Script OK v${j.version} ${j.tag}`
      : `[SERVER] Apps Script MISMATCH: expected v${GS_EXPECTED_VERSION}/${GS_EXPECTED_TAG} but got v${j.version}/${j.tag}`;
    console.log(msg);
  } catch (err) {
    GS_STATUS = { ok:false, reason:String(err) };
    console.error('[SERVER] GS verify error:', err);
  }
}

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify({type:'hello', ts: Date.now()})}\n\n`);

  req.on('close', () => clients.delete(res));
});

// heartbeat
setInterval(() => broadcast({ type: 'heartbeat', ts: Date.now() }), 10000);

// Serve the tiny dashboard at /live
app.get('/live', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'live.html'));
});

// landing page
app.get('/', (_req, res) => {
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Planet Intake – Live Stream</title>
<style>body{font:14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;padding:16px;}
#log{white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; border:1px solid #ddd; border-radius:8px; padding:12px; max-height:70vh; overflow:auto;}
.badge{display:inline-block; padding:2px 8px; border-radius:999px; background:#eee; margin-right:8px;}
</style></head>
<body>
  <h1>Planet Intake – Live Stream</h1>
  <div><span class="badge">SSE</span>Connecting to <code>/events</code>…</div>
  <div id="log" style="margin-top:12px;"></div>
  <script>
    const el = document.getElementById('log');
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      try { const msg = JSON.parse(e.data); append(msg); }
      catch { append({raw:e.data}); }
    };
    es.onerror = () => append({type:'error', at: Date.now()});
    function append(obj){
      const line = '['+new Date().toLocaleTimeString()+'] ' + JSON.stringify(obj);
      el.textContent += line + "\\n";
      el.scrollTop = el.scrollHeight;
    }
  </script>
</body></html>`);
});

/* START:STATUS */
app.get('/status', (_req, res) => {
  res.json({ ok: true, listeners: clients.size, time: new Date().toISOString() });
});
/* END:STATUS */

// Backend-only max leads (default 200). Users never set this.
// You can change it at deploy time with:
//   --set-env-vars MAX_LEADS_DEFAULT=200
const MAX_LEADS_DEFAULT = Number(process.env.MAX_LEADS_DEFAULT || 200);

// Health endpoint (used by Cloud Run)
app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/gs-health', (_req, res) => res.json(GS_STATUS));

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }
  if (!email) {
    return res.status(400).json({ ok: false, error: 'email is required to share the sheet' });
  }

  if (!process.env.GSCRIPT_WEBAPP_URL) {
    return res.status(500).json({ ok: false, error: 'GSCRIPT_WEBAPP_URL not configured' });
  }

  try {
    // Users don’t choose maxLeads; enforce backend default.
    const maxLeads = MAX_LEADS_DEFAULT;

    // Run the scraper
    const result = await scrapePlanet({ username, password, maxLeads });

    if (!result?.ok) {
      return res.status(200).json(result || { ok: false, error: 'Unknown scrape error' });
    }

    // Create a new Google Sheet for this run and share it with the user
    const sheet = await createSheetAndShare({ email, result });

    /* START:EMIT_SHEET */
    if (sheet?.url) emit('sheet', { url: sheet.url });
    /* END:EMIT_SHEET */

    return res.json({
      ok: true,
      sheetUrl: sheet.url,
      meta: result.meta,
      leadCount: result.meta?.leadCount,
      sumMonthlyAcrossLeads: result.meta?.sumMonthlyAcrossLeads
    });
  } catch (err) {
    console.error('SCRAPE ERROR:', err?.stack || err);
    res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
});

// SSE scrape endpoint for automation and streaming progress
app.get('/scrape', async (req, res) => {
  const username = process.env.PLANET_USERNAME;
  const password = process.env.PLANET_PASSWORD;
  const email    = process.env.REPORT_EMAIL;
  if (!username || !password || !email) {
    return res.status(500).json({ ok: false, error: 'missing PLANET_USERNAME/PASSWORD/REPORT_EMAIL env vars' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  const emit = (obj) => {
    try { res.write(`event: ${obj.type}\n`); } catch {}
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  };
  const end = () => {
    try { res.write('event: end\ndata: {}\n\n'); } catch {}
    try { res.end(); } catch {}
  };

  const maxLeads = Number(req.query.maxLeads || MAX_LEADS_DEFAULT) || MAX_LEADS_DEFAULT;
  const startTime = Date.now();

  let doneStats = { processed: 0, ms: 0 };
  const forward = (evt) => {
    if (evt.type === 'done') {
      doneStats = { processed: evt.processed, ms: evt.ms };
      return; // delay final done until after sheet creation
    }
    try {
      res.write(`event: ${evt.type}\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  };

  bus.on('evt', forward);

  try {
    const result = await scrapePlanet({ username, password, maxLeads });

    let sheet;
    try {
      sheet = await createSheetAndShare({ email, result });
    } catch (err) {
      emit({ type: 'error', msg: String(err?.message || err) });
      return end();
    }

    if (sheet?.url) emit({ type: 'sheet', url: sheet.url });
    emit({ type: 'done', processed: doneStats.processed || result?.meta?.leadCount || 0, ms: doneStats.ms || (Date.now() - startTime) });
    end();
  } catch (err) {
    emit({ type: 'error', msg: String(err?.message || err) });
    end();
  } finally {
    bus.off('evt', forward);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  verifyGScript().catch(() => {});
});
