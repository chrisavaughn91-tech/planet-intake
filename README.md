# Planet Intake

## Smoke vs Full Run

- Smoke: `npm run test:e2e` (processes ~10)
- Full:
  - `npm run start:full` (honors `.env` MAX_LEADS_DEFAULT)
  - or curl:
    - `GET  http://localhost:8080/run/full?max=200`
    - `POST http://localhost:8080/run  -H "content-type: application/json" -d '{"max":200}'`
