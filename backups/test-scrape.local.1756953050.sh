#!/usr/bin/env bash
set -euo pipefail
: "${PLANET_USERNAME:?Set PLANET_USERNAME}"
: "${PLANET_PASSWORD:?Set PLANET_PASSWORD}"
: "${REPORT_EMAIL:?Set REPORT_EMAIL}"
curl -sS -X POST http://localhost:8080/scrape \
  -H 'Content-Type: application/json' \
  -d "{
        \"username\": \"${PLANET_USERNAME}\",
        \"password\": \"${PLANET_PASSWORD}\",
        \"email\":    \"${REPORT_EMAIL}\"
      }"
