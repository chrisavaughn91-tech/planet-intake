# Planet Intake

## Quick Runs

- Smoke: `npm run test:e2e` (about 10 leads by default)
- Full:
  - `npm run start:full` (honors `.env` MAX_LEADS_DEFAULT), then visit `/live`
  - or:
    - GET  http://localhost:8080/run/full?max=200
    - POST http://localhost:8080/run  with body: {"max":200}

## Safe Stop / Restart (Codespaces-friendly)
- Stop only the app server (does **not** kill VS Code):
  
      npm run stop

- Restart quickly:

      npm run restart

## Health Check (Apps Script)
Verify the deployed Apps Script Web App with `?action=health`:

    curl -s "https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec?action=health"

Sample JSON (shape may vary):

    {"ok":true,"version":4,"tag":"v4-planet-intake-canonical","deployedAt":"2025-09-10T19:40:00.000Z"}

## Environment Variables

Set these in `.env` (never commit secrets):

    PLANET_USERNAME=...
    PLANET_PASSWORD=...
    REPORT_EMAIL=...
    GSCRIPT_WEBAPP_URL=https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec
    MAX_LEADS_DEFAULT=200

- Keep the Live Stream open at `/live` to watch progress in real time.

## Optional: Auto-run on Server Start

Set the following to automatically kick off a scrape when the server boots:

    START_ON_BOOT=true     # enable autorun on server start (default: off)
    START_MAX=200          # optional; overrides MAX_LEADS_DEFAULT for this autorun only
    AUTORUN_DELAY_MS=1500  # optional; delay before autorun to avoid Codespaces reconnects

Behavior:
- If START_ON_BOOT is true/1/yes/on, the server will trigger a run once after it starts.
- The run uses START_MAX if set; otherwise falls back to MAX_LEADS_DEFAULT; else scraper default.
- All events stream to `/live` as usual.

## Troubleshooting: Live page keeps reconnecting
- Disable autorun temporarily:

      START_ON_BOOT=false

  Then restart and trigger a manual run:

      npm run start:full
      curl -sS "http://127.0.0.1:8080/run/full?max=200"

## Notes
- The scraper module is **lazy-loaded** on first run to keep startup light in Codespaces.
- Server binds to **0.0.0.0** to ensure port forwarding works reliably.
