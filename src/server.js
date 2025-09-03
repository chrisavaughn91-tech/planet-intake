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
app.get('/run', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Planet Intake • Run Scraper</title>
  <style>
    :root{
      --bg:#0b1220; --panel:#111a2b; --ink:#eaf2ff; --muted:#a9b7d0; --accent:#43b6ff; --accent2:#6ee7b7; --danger:#ff7676;
    }
    *{box-sizing:border-box} body{margin:0;background:linear-gradient(120deg,#0b1220,#0e1730 40%,#0b1220);
      color:var(--ink); font:500 15px/1.5 system-ui,Segoe UI,Inter,Roboto,Helvetica,Arial}
    .wrap{min-height:100dvh; display:grid; place-items:center; padding:24px}
    .card{width:min(720px,92vw); background:rgba(17,26,43,.9); backdrop-filter:saturate(140%) blur(10px);
      padding:28px; border:1px solid #1e2a44; border-radius:16px; box-shadow:0 12px 40px rgba(0,0,0,.35)}
    h1{margin:0 0 6px; font-weight:800; letter-spacing:.2px}
    p.sub{margin:0 0 22px; color:var(--muted)}
    form{display:grid; gap:14px}
    label{display:grid; gap:6px; font-size:14px; color:#c9d6ee}
    input{
      height:44px; padding:0 12px; color:var(--ink); background:#0b1220; border:1px solid #24304b; border-radius:12px;
      outline:0; transition:.15s border-color,.15s box-shadow;
    }
    input:focus{border-color:var(--accent); box-shadow:0 0 0 4px #43b6ff22}
    .row{display:grid; gap:14px; grid-template-columns:1fr 1fr}
    @media (max-width:720px){.row{grid-template-columns:1fr}}
    .hint{color:var(--muted); font-size:12px}
    .actions{display:flex; gap:12px; align-items:center; margin-top:6px}
    button{
      appearance:none; border:0; border-radius:12px; height:44px; padding:0 16px 0 14px; cursor:pointer;
      background:linear-gradient(135deg,var(--accent),#7cc9ff);
      color:#001225; font-weight:800; letter-spacing:.2px; box-shadow:0 8px 24px #43b6ff33;
      display:inline-flex; align-items:center; gap:8px;
    }
    button:disabled{opacity:.6; cursor:not-allowed}
    .ghost{background:#1a2742; color:#cfe2ff; box-shadow:none}
    .muted{color:var(--muted)}
    .badge{display:inline-block; padding:2px 8px; border-radius:999px; background:#16233e; color:#a9c4ff; font-size:12px}
    .footer{margin-top:16px; display:flex; justify-content:space-between; align-items:center; gap:10px}
    code.k{background:#0b1220; padding:2px 8px; border-radius:8px; border:1px solid #24304b}
    a{color:#7cc9ff}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px">
        <h1>Run Planet Intake Scraper</h1>
        <span class="badge">Live</span>
      </div>
      <p class="sub">Enter your Planet credentials and an email. We’ll run the scraper, build your Google Sheet and CSV, and email them to you.</p>

      <form id="f" method="post" action="/scrape">
        <div class="row">
          <label>Username
            <input name="username" autocomplete="username" required />
          </label>
          <label>Password
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
        </div>
        <label>Email (delivery address)
          <input name="email" type="email" placeholder="you@company.com" required />
        </label>
        <div class="hint">Tip: keep this tab open and <a href="/logs" target="_blank">watch live logs</a> while it runs.</div>
        <div class="actions">
          <button id="go" type="submit">Run scraper →</button>
          <a class="ghost" href="/logs" target="_blank"><button class="ghost" type="button">Open live logs</button></a>
          <span id="msg" class="muted"></span>
        </div>
      </form>

      <div class="footer">
        <div class="muted">Need help? Ping the team.</div>
        <div class="muted">Keyboard: <code class="k">Ctrl</code> + <code class="k">Enter</code> to submit</div>
      </div>
    </div>
  </div>
  <script>
    const f = document.getElementById('f');
    const msg = document.getElementById('msg');
    const go = document.getElementById('go');
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') f.requestSubmit();
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = 'Starting...';
      go.disabled = true;
      try {
        const fd = new FormData(f);
        const body = new URLSearchParams(fd);
        const r = await fetch('/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const j = await r.json();
        if (j.ok) {
          msg.innerHTML = 'Done. '
            + (j.sheetUrl ? '<a href="' + j.sheetUrl + '" target="_blank">Open Sheet</a>' : '')
            + (j.csvUrl ? ' • <a href="' + j.csvUrl + '" target="_blank">CSV</a>' : '');
        } else {
          msg.textContent = 'Failed: ' + (j.error || 'Unknown error');
        }
      } catch (err) {
        msg.textContent = 'Error: ' + err.message;
      } finally {
        go.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
  try {
    const isJson = (req.headers['content-type'] || '').includes('application/json');
    const { username, password, email } = isJson ? req.body : req.body || {};
    if (!username || !password || !email) {
      return res.status(400).json({ ok: false, error: 'Missing username, password, or email' });
    }

    const result = await scrapePlanet({ username, password, email, maxLeads: MAX_LEADS_DEFAULT });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('SCRAPE ERROR:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
