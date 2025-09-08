# Planet Intake

## Running the scraper

### Running: smoke vs full

- Smoke (fast, 10 leads):  
  `npm run test:e2e`

- Full run (honors `.env` MAX_LEADS_DEFAULT, override with `max`):  
  - Start + auto-run: `npm run start:full`  
  - Or server only: `npm run start`, then trigger:
    - `curl -sS -X POST http://localhost:8080/run -H 'content-type: application/json' -d '{"max":200}'`
    - or `curl -sS 'http://localhost:8080/run/full?max=200'`
