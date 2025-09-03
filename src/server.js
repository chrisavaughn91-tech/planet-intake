// src/server.js
const express = require('express');
const bodyParser = require('body-parser');
const { scrapePlanet } = require('./scraper');

const newRunId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const sseClients = new Map(); // runId -> Set(res)

function attachSse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function addClient(runId, res) {
  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  const set = sseClients.get(runId);
  set.add(res);
  res.on('close', () => {
    set.delete(res);
    if (!set.size) sseClients.delete(runId);
  });
}

function stream(runId, msg) {
  console.log(msg);
  const set = sseClients.get(runId);
  if (!set) return;
  const line = `data: ${msg}\n\n`;
  for (const res of set) res.write(line);
}

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Health endpoint (used by Cloud Run)
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Live log streaming endpoint for specific runs (Server-Sent Events)
app.get('/logs', (req, res) => {
  const runId = String(req.query.runId || '');
  if (!runId) return res.status(400).send('Missing runId');
  attachSse(res);
  addClient(runId, res);
  res.write(`data: [SSE] Live log stream started for ${runId}...\n\n`);
});

// Simple HTML form for manual runs
app.get('/run', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Planet Leads Scraper</title>
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
        <h1>Planet Leads Scraper</h1>
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
          <small><a id="watchLogsLink" href="#" target="_blank" rel="noopener">watch live logs</a></small>
        </label>
        <div class="row">
          <label>Max leads
            <input name="max" type="number" min="1" max="2000" value="200" />
          </label>
        </div>
        <div class="actions">
          <button id="go" type="submit">Run scraper →</button>
          <span id="msg" class="muted"></span>
        </div>
      </form>
    </div>
  </div>
  <script>
    const f = document.getElementById('f');
    const msg = document.getElementById('msg');
    const go = document.getElementById('go');
    const watchLogsLink = document.getElementById('watchLogsLink');
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
          watchLogsLink.href = j.logsUrl;
          window.open(j.logsUrl, '_blank');
          msg.textContent = 'Running… check the logs tab.';
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
app.post('/scrape', (req, res) => {
  try {
    const isJson = (req.headers['content-type'] || '').includes('application/json');
    const body = isJson ? (req.body || {}) : (req.body || {});
    const { username, password, email } = body;

    // NEW: max leads (form value overrides env default)
    let max = Number(body.max);
    if (!Number.isFinite(max) || max <= 0) {
      max = Number(process.env.MAX_LEADS_DEFAULT || 200);
    }
    max = Math.max(1, Math.min(2000, Math.floor(max)));

    if (!username || !password || !email) {
      return res.status(400).json({ ok:false, error:'Missing username, password, or email' });
    }

    const runId = newRunId();
    scrapePlanet({ username, password, email, maxLeads: max, runId, stream })
      .catch(err => {
        stream(runId, `SCRAPE ERROR: ${err && err.message ? err.message : err}`);
      });
    return res.json({ ok:true, runId, logsUrl: `/logs?runId=${runId}` });
  } catch (err) {
    console.error('SCRAPE ERROR:', err);
    return res.status(500).json({ ok:false, error:String(err && err.message || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
