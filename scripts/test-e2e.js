#!/usr/bin/env node
/**
 * E2E smoke:
 *   - Triggers /run/full?max=...
 *   - Prints enough info to watch /live
 *   - Exits 0 on successful trigger
 *
 * Env:
 *   E2E_SERVER  -> base URL (default http://127.0.0.1:3000)
 *   E2E_LIMIT   -> lead max (default 10)
 */

const BASE  = process.env.E2E_SERVER || "http://127.0.0.1:3000";
const LIMIT = Number(process.env.E2E_LIMIT || 10);

if (typeof globalThis.fetch !== "function") {
  console.error("[E2E] Requires Node 18+ with global fetch");
  process.exit(1);
}

function now() { return new Date().toLocaleTimeString(); }
function log(...a) { console.log(`[E2E ${now()}]`, ...a); }

(async () => {
  try {
    log(`base: ${BASE}`);
    log(`limit: ${LIMIT}`);
    const live = BASE.replace("127.0.0.1", "localhost") + "/live";
    log(`tip: open ${live} to watch events`);

    const url = `${BASE}/run/full?max=${LIMIT}`;
    log(`GET ${url}`);
    const res = await fetch(url, { method: "GET" });
    const ctype = res.headers.get("content-type") || "";
    let body;
    try { body = await res.json(); } catch { body = await res.text(); }

    if (!res.ok) {
      log(`ERROR: HTTP ${res.status}`);
      console.error(body);
      process.exit(1);
    }

    log(`server response:`);
    console.log(body);
    log(`run triggered — monitor ${live}`);
    process.exit(0);
  } catch (err) {
    console.error("[E2E] FAIL:", err?.message || String(err));
    process.exit(1);
  }
})();
