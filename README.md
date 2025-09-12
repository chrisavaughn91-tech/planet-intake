# README.md — Planet Lead Pull

A Node/Express + Playwright app that scrapes leads, writes a Google Sheet through an Apps Script Web App, and streams progress to a live dashboard. Multi-user runs are isolated by **job id** so each user sees only their own stream.

---

## Quick Runs

- **Smoke / E2E** (defaults to small sample):
  
  ~~~bash
  npm run test:e2e
  ~~~

- **Full run**:
  - Start the server then visit `/live`:
    ~~~bash
    npm run start:full
    ~~~
  - Or trigger via HTTP:
    ~~~bash
    # GET
    curl -sS "http://127.0.0.1:8080/run/full?max=200"

    # POST (if your server exposes /run with body)
    curl -sS -X POST "http://127.0.0.1:8080/run" \
      -H "content-type: application/json" \
      -d '{"max":200}'
    ~~~

---

## Safe Stop / Restart (Codespaces-friendly)

- **Stop** only the app server (does **not** kill VS Code):
  ~~~bash
  npm run stop
  ~~~

- **Restart** with a tiny safety pause to avoid race conditions:
  ~~~bash
  npm run restart
  ~~~

> `restart` runs: `stop` → short sleep → `start`, ensuring the previous server has fully exited.

---

## Health Check (Apps Script)

Verify your deployed Apps Script Web App with `?action=health`:

~~~bash
curl -s "https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec?action=health"
~~~

Sample (shape may vary):

~~~json
{"ok":true,"version":4,"tag":"v4-planet-intake-canonical","deployedAt":"2025-09-10T19:40:00.000Z"}
~~~

---

## Environment Variables

Create `.env` (never commit secrets):

~~~ini
GSCRIPT_WEBAPP_URL=https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec
PLANET_USERNAME=your_username
PLANET_PASSWORD=your_password
REPORT_EMAIL=you@example.com

# Defaults / behavior toggles
MAX_LEADS_DEFAULT=200
START_ON_BOOT=false
AUTORUN_DELAY_MS=3000
~~~

---

## Optional: Auto-run on Server Start

Set the following to auto-start one scrape shortly after the server boots (useful in Codespaces):

~~~ini
START_ON_BOOT=true
START_MAX=200         # optional; overrides MAX_LEADS_DEFAULT for this single autorun
AUTORUN_DELAY_MS=1500 # small delay helps avoid reconnect races
~~~

Behavior:
- If `START_ON_BOOT` is true/1/yes/on, the server triggers **one** run after startup.
- The run uses `START_MAX` if set; otherwise `MAX_LEADS_DEFAULT`; otherwise scraper default.
- All events stream to `/live` as usual.

---

## Live Stream (Change 7)

- **Elapsed timer** starts at **00:00:00** (locks to the first `start` event; falls back to first message).
- **Filter chips** — toggle: `info`, `start`, `lead`, `numbers`, `badge`, `sheet`, `error`, `done`, `client`.
- **Search box** — quick text filter (e.g., `autorun`, `sheet:url`, a job id).
- **Auto-scroll** — on by default; when off, a sticky “New messages ↓” appears.
- **Sheet link** — appears clickable when available; opens in a new tab.

Open:
~~~text
/live
~~~

---

## Multi-user Login (Change 8)

Use the built-in form to start an **isolated** run with your own credentials:

- Open:
  ~~~text
  /login
  ~~~
- Fields: **username**, **password**, **report email**, optional **max**, and an **auto-start** toggle.
- On submit, server returns:
  ~~~json
  { "jobId": "abc123", "liveUrl": "/live?job=abc123" }
  ~~~
- You’re redirected to `/live?job=abc123`, which shows only **your** run (events are scoped by job id).
- Multiple users can run simultaneously; each gets a private stream and their own sheet shared to their email.

---

## Manual Run (advanced)

~~~bash
# Start server
npm run start

# Kick a full run for a given job id
curl -sS "http://127.0.0.1:8080/run/full?job=test123&max=200"

# open: /live?job=test123
~~~

If your server exposes POST `/run`:
~~~bash
curl -sS -X POST "http://127.0.0.1:8080/run" \
  -H "content-type: application/json" \
  -d '{"username":"u","password":"p","email":"me@example.com","max":100,"autoStart":true}'
~~~

---

## Troubleshooting

**Live page keeps reconnecting**
~~~bash
# Disable autorun temporarily
echo "START_ON_BOOT=false" >> .env
npm run restart

# Then manually trigger:
curl -sS "http://127.0.0.1:8080/run/full?max=200"
~~~

**No port shows in Ports panel**
~~~bash
pkill -f "node .*server.js" || true
npm run start
~~~

---

## Git hygiene (after each confirmed change)

~~~bash
git add -A
git commit -m "change <n>: <short summary>"
git push -u origin <branch-for-that-change>
# Optional SoT checkpoint:
git tag -a "sot-v1-change-<n>" -m "SoT v1 after change <n>"
git push origin --tags
~~~

---

## Notes

- The scraper module is **lazy-loaded** on first run to keep startup light in Codespaces.
- Server binds to **0.0.0.0:8080** so port forwarding works reliably.
- Timestamps in `/live` start at **00:00:00** for true elapsed runtime.
