#!/usr/bin/env bash
# Triggers a full scrape run via the app server and prints a helpful tip.
# Defaults:
#   BASE  -> http://127.0.0.1:3000  (override with E2E_SERVER)
#   MAX   -> 10                     (override with first arg)

set -euo pipefail

BASE="${E2E_SERVER:-http://127.0.0.1:3000}"
MAX="${1:-10}"

echo "[scrape] Base: ${BASE}"
echo "[scrape] Max:  ${MAX}"
URL="${BASE}/run/full?max=${MAX}"
echo "[scrape] GET ${URL}"

# Fire the run
RESP="$(curl -fsS "${URL}")" || {
  echo "[scrape] ERROR: request failed"
  exit 1
}

echo "[scrape] Server response:"
echo "${RESP}"
echo
LIVE="${BASE/127.0.0.1/localhost}/live"
echo "[scrape] Watch progress at: ${LIVE}"
