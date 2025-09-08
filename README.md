# Planet Intake

## Running the scraper

### Smoke run (10 leads)
Defaults to 10 for fast verification. Override with `--max` or `E2E_MAX_LEADS`:
```bash
npm run test:e2e
# or
npm run test:e2e -- --max=15
E2E_MAX_LEADS=15 npm run test:e2e
```

### Full run (honors .env)
Uses `MAX_LEADS_DEFAULT` from your `.env` (fallback 200). Override with `--max`:
```bash
npm run start:full
npm run start:full -- --max=50
```
