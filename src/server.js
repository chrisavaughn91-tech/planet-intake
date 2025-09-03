// src/server.js
const express = require('express');
const bodyParser = require('body-parser');
const { scrapePlanet } = require('./scraper');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

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

// Simple HTML form for manual runs
app.get('/run', (_req, res) => {
  res.send(`<!DOCTYPE html><html><body>
    <form method="POST" action="/scrape">
      <div><input name="username" placeholder="Username" /></div>
      <div><input name="password" type="password" placeholder="Password" /></div>
      <div><input name="email" type="email" placeholder="Email" /></div>
      <button type="submit">Run</button>
    </form>
  </body></html>`);
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

    // Run the scraper and forward the email to Apps Script
    const result = await scrapePlanet({ username, password, email, maxLeads });

    if (!result?.ok) {
      return res.status(200).json(result || { ok: false, error: 'Unknown scrape error' });
    }

    return res.json(result);
  } catch (err) {
    console.error('SCRAPE ERROR:', err?.stack || err);
    res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
