/* START:DOTENV */
try { require('dotenv').config(); } catch {}
/* END:DOTENV */
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { scrapePlanet } = require('./scraper');
const { createSheetAndShare } = require('./sheets');
const { emit, bus } = require('./events');

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

const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch {}
  }
}
module.exports.broadcast = broadcast;

bus.on('evt', broadcast);

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
