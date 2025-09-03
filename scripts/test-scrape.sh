#!/usr/bin/env bash
set -euo pipefail

# Load .env into this shell (supports special chars like ! in passwords)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${PLANET_USERNAME:?Set PLANET_USERNAME in .env}"
: "${PLANET_PASSWORD:?Set PLANET_PASSWORD in .env}"
: "${REPORT_EMAIL:?Set REPORT_EMAIL in .env}"

curl -sS -X POST http://localhost:8080/scrape \
  -H 'Content-Type: application/json' \
  -d "{
        \"username\": \"${PLANET_USERNAME}\",
        \"password\": \"${PLANET_PASSWORD}\",
        \"email\":    \"${REPORT_EMAIL}\"
      }"
