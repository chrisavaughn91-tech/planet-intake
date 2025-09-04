/* START:DOTENV */
try { require('dotenv').config(); } catch {}
/* END:DOTENV */
if (!process.env.GSCRIPT_WEBAPP_URL) {
  console.log('⚠️  GSCRIPT_WEBAPP_URL is not set (check your .env).');
}

const express = require('express');
const bodyParser = require('body-parser');
const { scrapePlanet } = require('./scraper');
const { createSheetAndShare } = require('./sheets');
const { emit } = require('./events');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

/* START:SSE_BLOCK */
const path = require('path');
const { bus } = require('./events');

// Keep track of connected SSE clients
const sseClients = new Set();

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.(); // in case compression is on

  // Welcome ping so the client knows we're connected
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);

  // Heartbeat to keep the connection open on proxies
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(`event: ping\ndata: {}\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// Broadcast helper
function broadcast(evt) {
  const line = `event: ${evt.type || 'evt'}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const client of sseClients) {
    if (!client.writableEnded) client.write(line);
  }
}

// Pipe events from the bus to connected clients
bus.on('evt', broadcast);

// Serve the tiny dashboard at /live
app.get('/live', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'live.html'));
});
/* END:SSE_BLOCK */

/* START:STATUS */
app.get('/status', (_req, res) => {
  res.json({ ok: true, listeners: [...sseClients].length, time: new Date().toISOString() });
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
