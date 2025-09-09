// Simple SSE smoke test for /scrape that waits for a sheet URL.
// Usage: node scripts/test-e2e.js
// Config via env:
//   E2E_LIMIT         -> how many leads (?limit=), default 10
//   E2E_SMOKE_LIMIT   -> seconds to wait for sheet url, default 180
//   E2E_SERVER        -> base URL, default http://127.0.0.1:8080
//
// Exits nonzero if sheet url not seen within the window.

import { fetch } from "undici";

const BASE   = process.env.E2E_SERVER || "http://127.0.0.1:8080";
const LIMIT  = Number(process.env.E2E_LIMIT || 10);
const WAIT_S = Number(process.env.E2E_SMOKE_LIMIT || 180);

function now() {
  return new Date().toLocaleTimeString();
}

function log(...a) {
  console.log(`[E2E ${now()}]`, ...a);
}

async function run() {
  log(`using limit = ${LIMIT}`);
  log(`waiting up to ${WAIT_S}s for sheet url`);

  // Start an SSE connection to /scrape so we see live events.
  const url = `${BASE}/scrape?limit=${LIMIT}`;
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
  });

  if (!res.ok || (res.headers.get("content-type") || "").indexOf("text/event-stream") === -1) {
    throw new Error(`HTTP ${res.status}: expected event-stream`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();

  let buffer = "";
  let gotSheet = false;
  let sheetUrl = null;
  let gotDone = false;

  const deadline = Date.now() + WAIT_S * 1000;

  function parseChunk(txt) {
    buffer += txt;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // Parse a single SSE event block
      const lines = raw.split("\n");
      let ev = "message";
      let data = "";

      for (const ln of lines) {
        if (ln.startsWith("event:")) ev = ln.slice(6).trim();
        else if (ln.startsWith("data:")) data += (data ? "\n" : "") + ln.slice(5).trim();
      }

      handleEvent(ev, data);
    }
  }

  function handleEvent(ev, data) {
    // be permissive: data may be JSON or plain text
    let payload = null;
    try { payload = JSON.parse(data); } catch { payload = { msg: data }; }

    switch (ev) {
      case "sheet":
        if (payload && payload.url) {
          sheetUrl = payload.url;
          gotSheet = true;
          log(`sheet:url ${sheetUrl}`);
        } else {
          log(`sheet event without url:`, payload);
        }
        break;
      case "done":
        gotDone = true;
        log(`done event received`);
        break;
      case "error":
        log(`ERROR`, payload);
        break;
      default:
        // Uncomment to see everything:
        // log(`ev=${ev}`, payload);
        break;
    }
  }

  // Pump the stream until deadline or we have sheet url.
  while (Date.now() < deadline && !gotSheet) {
    const { value, done } = await reader.read();
    if (done) {
      if (!gotDone && !gotSheet) throw new Error(`stream ended unexpectedly without "done" or sheet url`);
      break;
    }
    parseChunk(dec.decode(value, { stream: true }));
  }

  if (!gotSheet || !sheetUrl) {
    throw new Error(`did not receive sheet url within ${WAIT_S}s`);
  }

  log(`SUCCESS: got sheet url: ${sheetUrl}`);
}

run().catch((e) => {
  console.error(`[E2E] FAIL: ${e.message}`);
  process.exit(1);
});
