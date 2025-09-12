import express from "express";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { emit, onClientConnect, removeClient } from "./events.js";
// NOTE: scraper is lazy-loaded right before first use
import { createSheetAndShare } from "./sheets.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/* =========================
   Static + basic routes
   ========================= */
app.use("/static", express.static(path.join(__dirname, "public")));
app.get("/live", (_req, res) => {
  // Back-compat: old shared view (not job-scoped). Keep for admin quick check if needed.
  res.sendFile(path.join(__dirname, "public", "live.html"));
});
app.get("/live/:jobId", (_req, res) => {
  // New: private per-job live page (requires jobId & token in URL)
  res.sendFile(path.join(__dirname, "public", "live.html"));
});
app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/", (_req, res) => res.redirect("/login"));

/* =========================
   Config & helpers
   ========================= */
const SESSION_SECRET = String(process.env.SESSION_SECRET || "dev-session-secret-change-me");
const TOKEN_TTL_HOURS = Number(process.env.JOB_TTL_HOURS || 24);
const TOKEN_TTL_MS = TOKEN_TTL_HOURS * 3600 * 1000;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 3));

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function signToken(jobId, issuedAtMs) {
  const h = crypto.createHmac("sha256", SESSION_SECRET);
  h.update(`${jobId}.${issuedAtMs}`);
  return `${issuedAtMs}.${b64url(h.digest())}`;
}
function verifyToken(jobId, token) {
  if (!token) return false;
  const [issuedAtStr, sig] = String(token).split(".");
  const issuedAt = Number(issuedAtStr);
  if (!issuedAt || !sig) return false;
  if (Date.now() - issuedAt > TOKEN_TTL_MS) return false;
  const expected = signToken(jobId, issuedAt).split(".")[1];
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function envUser()  { return process.env.PLANET_USER  || process.env.PLANET_USERNAME || ""; }
function envPass()  { return process.env.PLANET_PASS  || process.env.PLANET_PASSWORD || ""; }
function envEmail() { return process.env.NOTIFY_EMAIL || process.env.REPORT_EMAIL    || ""; }

function pickCreds(body) {
  return {
    username: body?.username || envUser(),
    password: body?.password || envPass(),
    email:    body?.email    || envEmail(),
    max:      body?.max != null ? Number(body.max) : undefined,
  };
}

function mkJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Lazy-load scraper on demand
async function getScrapePlanet() {
  const mod = await import("./scraper.js");
  if (!mod?.scrapePlanet) throw new Error("scraper module missing export: scrapePlanet");
  return mod.scrapePlanet;
}

/* =========================
   Queue & concurrency
   ========================= */
const ACTIVE = new Set(); // jobIds currently running
const QUEUE = []; // fifo: { jobId, username, password, email, max }

function enqueue(job) {
  QUEUE.push(job);
  emit("info", { msg: `queue: queued (pos=${QUEUE.length})`, jobId: job.jobId });
  maybeStart();
}
function maybeStart() {
  while (ACTIVE.size < MAX_CONCURRENCY && QUEUE.length > 0) {
    const job = QUEUE.shift();
    ACTIVE.add(job.jobId);
    emit("start", { msg: "queued: start", jobId: job.jobId, maxLeads: job.max });
    runScrapeAndSheet(job)
      .catch((e) => emit("error", { msg: "run: exception " + (e?.message || e), jobId: job.jobId }))
      .finally(() => {
        ACTIVE.delete(job.jobId);
        emit("done", { msg: "job: done", jobId: job.jobId, processed: undefined, ms: undefined });
        maybeStart();
      });
  }
}

/* =========================
   Core run function
   ========================= */
async function runScrapeAndSheet({ username, password, email, max, jobId }) {
  const scrapePlanet = await getScrapePlanet();
  const result = await scrapePlanet({ username, password, max, jobId });
  if (!result?.ok) {
    emit("error", { msg: "scrape failed: " + (result?.error || "unknown"), jobId });
    return;
  }

  // === Sheets step ===
  try {
    let sheet;
    let sig = "object:{email,result}";
    try {
      sheet = await createSheetAndShare({ email, result });
    } catch (_e1) {
      sig = "fallback:(leads,email)";
      sheet = await createSheetAndShare(result.leads, email);
    }

    const url = sheet?.url || null;
    const ok  = url ? true : (sheet?.ok === true && !!sheet?.url);
    if (ok && url) {
      emit("sheet", { url, jobId });
      emit("info", { msg: `sheet:url ${url}`, jobId });
    } else {
      const errMsg = sheet?.error || "unknown";
      emit("error", { msg: `sheet: failed (${errMsg}) [sig=${sig}]`, jobId });
    }
  } catch (e) {
    emit("error", { msg: "sheet: exception " + (e?.message || e), jobId });
  }
}

/* =========================
   SSE events (token-gated)
   ========================= */
app.get("/events", (req, res) => {
  const jobId = req.query.jobId || null;
  const token = req.query.token || null;

  // Require both jobId & token for private live pages; allow null for legacy /live
  if (jobId !== null) {
    const ok = verifyToken(jobId, token);
    if (!ok) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
  }

  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
  res.writeHead(200, headers);

  const clientId = onClientConnect(res, jobId);
  emit("info", { msg: "client: connected", clientId, jobId });
  req.on("close", () => removeClient(clientId));
});

/* =========================
   Health + status
   ========================= */
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});
app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    clients: global.__SSE_CLIENTS ? global.__SSE_CLIENTS.length : 0,
    active: Array.from(ACTIVE),
    queued: QUEUE.map(j => j.jobId),
    maxConcurrency: MAX_CONCURRENCY,
  });
});

/* =========================
   Sessions & runs
   ========================= */
// Login submits here to create a job and get a private liveUrl
app.post("/session", (req, res) => {
  const { username, password, email, max } = pickCreds(req.body || {});
  if (!username || !password || !email) {
    return res.status(400).json({ ok: false, error: "missing username/password/email" });
  }

  const jobId = mkJobId();
  const issuedAt = Date.now();
  const token = signToken(jobId, issuedAt);

  const safeMax = max != null ? Number(max) : (process.env.MAX_LEADS_DEFAULT != null ? Number(process.env.MAX_LEADS_DEFAULT) : undefined);
  const job = { jobId, username, password, email, max: safeMax };
  enqueue(job);

  const liveUrl = `/live/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`;
  res.json({ ok: true, jobId, liveUrl });
});

// (Optional) Manual kick for a queued job (admin)
app.post("/run/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const qIdx = QUEUE.findIndex(j => j.jobId === jobId);
  if (qIdx === -1) return res.status(404).json({ ok: false, error: "job not queued" });
  // Move job to front and try to start
  const [job] = QUEUE.splice(qIdx, 1);
  QUEUE.unshift(job);
  maybeStart();
  res.json({ ok: true, jobId, movedToFront: true });
});

/* =========================
   Legacy run endpoints (admin/shared)
   ========================= */
app.get("/scrape", async (req, res) => {
  const wantsSSE = String(req.headers.accept || "").includes("text/event-stream");
  const max = req.query.max ? Number(req.query.max) : (req.query.limit ? Number(req.query.limit) : undefined);
  const username = envUser();
  const password = envPass();
  const email = envEmail();
  const jobId = mkJobId();

  if (wantsSSE) {
    const headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    };
    res.writeHead(200, headers);
    const clientId = onClientConnect(res, null);
    emit("info", { msg: `scrape(sse): start (job ${jobId})`, jobId });

    try {
      await runScrapeAndSheet({ username, password, email, max, jobId });
      try { res.write(`event: end\n`); res.write(`data: {}\n\n`); } catch {}
    } catch (e) {
      try {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ msg: String(e?.message || e) })}\n\n`);
      } catch {}
    } finally {
      removeClient(clientId);
      try { res.end(); } catch {}
    }
    return;
  }

  emit("info", { msg: `scrape: start (job ${jobId})`, jobId });
  (async () => { await runScrapeAndSheet({ username, password, email, max, jobId }); })()
    .catch((e) => emit("error", { msg: "scrape: exception " + (e?.message || e), jobId }));
  res.json({ ok: true, jobId, mode: "compat:/scrape(json)" });
});

app.post("/run", async (req, res) => {
  const { username, password, email, max } = pickCreds(req.body || {});
  const jobId = mkJobId();
  emit("info", { msg: `run: start (job ${jobId})`, jobId });
  (async () => { await runScrapeAndSheet({ username, password, email, max, jobId }); })()
    .catch((e) => emit("error", { msg: "run: exception " + (e?.message || e), jobId }));
  res.json({ ok: true, jobId });
});

app.get("/run/full", async (req, res) => {
  const max = req.query.max ? Number(req.query.max) : undefined;
  const username = envUser();
  const password = envPass();
  const email = envEmail();
  const jobId = mkJobId();

  emit("info", { msg: `run: full (job ${jobId})`, jobId });
  (async () => { await runScrapeAndSheet({ username, password, email, max, jobId }); })()
    .catch((e) => emit("error", { msg: "run/full: exception " + (e?.message || e), jobId }));
  res.json({ ok: true, jobId });
});

/* =========================
   Global error surfacing
   ========================= */
process.on("unhandledRejection", (e) => {
  emit("error", { msg: "unhandledRejection: " + (e?.message || e) });
});
process.on("uncaughtException", (e) => {
  emit("error", { msg: "uncaughtException: " + (e?.message || e) });
});

/* =========================
   Server start + optional autorun (guarded)
   ========================= */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log("server listening on", PORT);

  const flag = String(process.env.START_ON_BOOT || "").toLowerCase();
  const shouldStart = flag === "true" || flag === "1" || flag === "yes" || flag === "on";

  if (shouldStart && !global.__AUTORUN_STARTED) {
    global.__AUTORUN_STARTED = true;

    const delayMs = Number(process.env.AUTORUN_DELAY_MS || 1500);
    const username = envUser();
    const password = envPass();
    const email = envEmail();

    const startMax =
      process.env.START_MAX != null
        ? Number(process.env.START_MAX)
        : (process.env.MAX_LEADS_DEFAULT != null
            ? Number(process.env.MAX_LEADS_DEFAULT)
            : undefined);

    const jobId = mkJobId();
    emit("info", { msg: `autorun: scheduled in ${delayMs}ms (job ${jobId}, max=${startMax ?? "default"})`, jobId });

    setTimeout(() => {
      emit("info", { msg: `autorun: start (job ${jobId})`, jobId });
      (async () => {
        try {
          await runScrapeAndSheet({ username, password, email, max: startMax, jobId });
          emit("info", { msg: `autorun: end (job ${jobId})`, jobId });
        } catch (e) {
          emit("error", { msg: "autorun: exception " + (e?.message || e), jobId });
        }
      })().catch((e) => emit("error", { msg: "autorun: exception " + (e?.message || e), jobId }));
    }, delayMs);
  }
});
