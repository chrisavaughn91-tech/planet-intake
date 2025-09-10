# Planet Intake

## Quick Runs

- **Smoke:** `npm run test:e2e` *(~10 leads by default)*
- **Full:** 
  - `npm run start:full` *(honors `.env` MAX_LEADS_DEFAULT)*, then visit `/live`
  - or:
    - `GET  http://localhost:8080/run/full?max=200`
    - `POST http://localhost:8080/run` with `{"max":200}`

## Environment Variables

Set these in `.env` (never commit secrets):
PLANET_USERNAME=...
PLANET_PASSWORD=...
REPORT_EMAIL=...
GSCRIPT_WEBAPP_URL=https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec

MAX_LEADS_DEFAULT=200


- Keep the **Live Stream** open at `/live` to watch progress in real time.