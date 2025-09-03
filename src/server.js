// src/server.js
const express = require('express');
const bodyParser = require('body-parser');
const { scrapePlanet } = require('./scraper');
const { createSheetAndShare } = require('./sheets');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// Backend-only max leads (default 200). Users never set this.
// You can change it at deploy time with:
//   --set-env-vars MAX_LEADS_DEFAULT=200
const MAX_LEADS_DEFAULT = Number(process.env.MAX_LEADS_DEFAULT || 200);

// Health endpoint (used by Cloud Run)
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Live log streaming endpoint using Server-Sent Events (SSE)
app.get('/logs', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg) => res.write(`data: ${msg}\n\n`);
  global.__logStream = log;

  log('[SSE] Live log stream started...');

  req.on('close', () => {
    global.__logStream = null;
  });
});

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

    return res.json({
      ok: true,
      sheetUrl: sheet.url,
      csvUrl: sheet.csvUrl || null,
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
