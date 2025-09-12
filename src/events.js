// Simple SSE event hub with required job-scoped channels in multi-user mode.
// Exports:
//   - onClientConnect(res, jobId?) -> clientId
//   - removeClient(clientId)
//   - emit(type, payload)  // payload must include jobId for per-run streams

let nextId = 1;
/** @type {Array<{id:number, res:import('http').ServerResponse, jobId:string|null}>} */
const CLIENTS = [];

/** Writes a single SSE event to a connected client. */
function writeEvent(res, type, dataObj) {
  try {
    const data = JSON.stringify(dataObj ?? {});
    res.write(`event: ${type}\n`);
    res.write(`data: ${data}\n\n`);
  } catch {
    // ignore broken pipe
  }
}

/** Add an SSE client; returns clientId. */
export function onClientConnect(res, jobId = null) {
  const id = nextId++;
  CLIENTS.push({ id, res, jobId: jobId || null });

  try {
    res.write(`retry: 3000\n\n`);
    writeEvent(res, "info", { msg: "client: subscribed", clientId: id, jobId: jobId || null });
  } catch {}

  return id;
}

/** Remove SSE client by id. */
export function removeClient(clientId) {
  const idx = CLIENTS.findIndex((c) => c.id === clientId);
  if (idx >= 0) {
    try { CLIENTS[idx].res.end(); } catch {}
    CLIENTS.splice(idx, 1);
  }
}

/** Emit to matching job; mirror to global listeners only when jobId is null. */
export function emit(type, payload = {}) {
  // Require jobId for scoped run events; allow null for legacy info.
  const targetJob = Object.prototype.hasOwnProperty.call(payload, "jobId")
    ? payload.jobId
    : null;

  for (const c of CLIENTS) {
    if (targetJob !== null) {
      // Send only to clients for same jobId, or any clients that didn't specify one (legacy)
      if (c.jobId !== targetJob && c.jobId !== null) continue;
    }
    writeEvent(c.res, type, payload);
  }
}

// Heartbeat
const HEARTBEAT_MS = 25000;
setInterval(() => {
  for (const c of CLIENTS) {
    try { c.res.write(`:hb ${Date.now()}\n\n`); } catch {}
  }
}, HEARTBEAT_MS);

global.__SSE_CLIENTS = CLIENTS;
