# Planet Lead Pull

A Node/Express + Playwright app that logs into Planet, scrapes leads, writes a Google Sheet via an Apps Script Web App, and streams progress to a live dashboard.  
Multi-user runs are isolated by **channel/job id** so each user only sees their own stream.

---

## Quick Start (Local)

### 1) Install & run
~~~bash
npm ci
cp -n env.txt .env   # or create .env from scratch (see below)
npm run start
# open your Codespaces public URL on port 8080, e.g. https://...-8080.app.github.dev/
~~~

### 2) Health check (server)
~~~bash
curl -sS "http://127.0.0.1:8080/health"
~~~

### 3) Health check (Apps Script Web App)
~~~bash
# Replace with your deployed Web App URL
curl -sS "https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec?action=health"
~~~

---

## Environment Variables (`.env`)

Create a `.env` file (never commit real secrets):

~~~ini
# Apps Script Web App endpoint (exec URL)
GSCRIPT_WEBAPP_URL=https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec

# Default credentials/email for ad-hoc/admin runs (sessions supply their own)
PLANET_USERNAME=your_username
PLANET_PASSWORD=your_password
REPORT_EMAIL=you@example.com

# Behavior / defaults
MAX_LEADS_DEFAULT=200
START_ON_BOOT=false
START_MAX=200
AUTORUN_DELAY_MS=3000

# Session security (change in prod)
SESSION_SECRET=dev-session-secret-change-me
JOB_TTL_HOURS=24
~~~

---

## Running a Scrape

### Option A — Session flow (recommended for end users)
1. Open `/login` in your browser.  
2. Enter **Planet username**, **password**, and **email** (where the sheet link will be sent).  
3. Submit. The server creates a private channel and returns:
   ~~~json
   {
     "ok": true,
     "jobId": "<id>",
     "liveUrl": "/live?channel=<id>&token=<signed>"
   }
   ~~~
4. You’ll be redirected to your **private live page**. Watch your run in real time.  
5. When done, you’ll get a **Google Sheets link** (also emitted in the stream).

### Option B — Ad-hoc/admin run (dev/testing)
1. In a terminal:
   ~~~bash
   curl -sS "http://127.0.0.1:8080/run/full?max=50"
   # => {"ok":true,"jobId":"<id>"}
   ~~~
2. Watch it in the browser (no session token; dev only):
   ~~~
   http://127.0.0.1:8080/live?channel=<id>&token=dev
   ~~~
3. Legacy path style also works:
   ~~~
   http://127.0.0.1:8080/live/<id>?token=dev
   ~~~

---

## Live Streams — Channels & Tokens

- The live page subscribes via:
  ~~~
  /events?channel=<id>&token=<signed-or-dev>
  ~~~
- **Session runs** use a **signed token** and a private channel.  
- **Ad-hoc runs** (dev only) can use `token=dev`.

**Binding runs to what you’re watching**
- You can kick a run tied to a specific stream by providing `channel` (or `job` / `jobId`) to the run endpoint:
  ~~~bash
  curl -sS -X POST "http://127.0.0.1:8080/run" \
    -H "content-type: application/json" \
    -d '{"channel":"<id>","max":25}'
  ~~~
- The legacy GET also accepts binding:
  ~~~bash
  curl -sS "http://127.0.0.1:8080/run/full?channel=<id>&max=25"
  ~~~

---

## E2E / Smoke Tests

- **SSE + sheet smoke** (waits for a sheet link within a timeout):
  ~~~bash
  npm run test:e2e
  ~~~
  > This test is backend-only; it doesn’t bind to your live UI.

- **Direct Apps Script push smoke**:
  ~~~bash
  npm run test:push
  ~~~

---

## Docker (optional)

~~~bash
# Build
docker build -t planet-intake:latest .

# Run
docker run --rm -p 8080:8080 --env-file .env planet-intake:latest
~~~

---

## Troubleshooting

**Live page shows only `client: connected`**
- Make sure the URL includes a **channel id** and **valid token**.
  - Session: `liveUrl` already has both.
  - Ad-hoc: append `&token=dev`, e.g. `/live?channel=<id>&token=dev`.
- If you open the live page **after** a run finishes, it will look empty (SSE doesn’t replay history). Kick a new run bound to the same channel.

**I see events in the terminal but not in the browser**
- Verify the browser can read raw SSE at `/events?token=dev`.  
- If raw events appear there, your `live.html` URL likely lacks `channel` or `token`.

**Apps Script health returns not ok**
- Re-deploy your Web App and confirm you’re using the latest “exec” URL.  
- Ensure `GSCRIPT_WEBAPP_URL` in `.env` matches your latest deployment.

---

## Git Hygiene (per confirmed Change)

~~~bash
git add -A
git commit -m "change <n>: <short summary>"
git push -u origin <branch-for-that-change>
~~~

---

## License

Proprietary — internal use for Planet Intake project subscribers.
