import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { emit, onClientConnect, removeClient } from "./events.js";
import { createSheetAndShare } from "./sheets.js";

// Lazy-load scraper when first needed
async function getScrapePlanet() {
  const mod = await import("./scraper.js");
  if (!mod?.scrapePlanet) throw new Error("scraper module missing export: scrapePlanet");
  return mod.scrapePlanet;
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();

// Accept both JSON and HTML-form posts
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   Static + pages
   ========================= */

// serve /public at / and also /static
app.use(express.static(PUBLIC_DIR));
app.use("/static", express.static(PUBLIC_DIR));

// explicit page routes (so /login and /live always work)
const send = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
app.get("/login", send("login.html"));
app.get("/live",  send("live.html"));

app.get("/", (_req, res) => res.redirect("/live"));

/* =========================
   SSE hub (job-scoped)
   ========================= */
app.get("/events", (req, res) => {
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
  res.writeHead(200, headers);

  // accept ?jobId=... (preferred) or ?job=... (fallback)
  const jobId = (req.query.jobId ?? req.query.job ?? null) || null;
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
  res.json({ ok: true, clients: global.__SSE_CLIENTS ? global.__SSE_CLIENTS.length : 0 });
});

/* =========================
   Cred helpers
   ========================= */
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
function parseAuto(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}
function mkJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* =========================
   Run + Sheets
   ========================= */
async function runScrapeAndSheet({ username, password, email, max, jobId }) {
  const scrapePlanet = await getScrapePlanet();

  const result = await scrapePlanet({ username, password, max, jobId });
  if (!result?.ok) {
    emit("error", { msg: "scrape failed: " + (result?.error || "unknown"), jobId });
    return;
  }

  // Google Sheets step
  try {
    let sheet;
    let sig = "object:{email,result}";
    try {
      // preferred signature
      sheet = await createSheetAndShare({ email, result });
    } catch (_e1) {
      // fallback for older sheets.js
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
   /session for login.html
   ========================= */
app.post("/session", async (req, res) => {
  try {
    const { username, password, email, max } = pickCreds(req.body || {});
    const autoStart = parseAuto(req.body?.autoStart);
    const jobId = mkJobId();
    const liveUrl = `/live?job=${encodeURIComponent(jobId)}`;

    emit("info", { msg: `session: job created (${jobId})`, jobId });

    if (autoStart) {
      emit("info", { msg: `session: autoStart (job ${jobId})`, jobId });
      (async () => {
        try {
          await runScrapeAndSheet({ username, password, email, max, jobId });
          emit("info", { msg: `session: done (job ${jobId})`, jobId });
        } catch (e) {
          emit("error", { msg: "session: exception " + (e?.message || e), jobId });
        }
      })().catch((e) => emit("error", { msg: "session: exception " + (e?.message || e), jobId }));
    }

    res.json({ ok: true, jobId, liveUrl });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
   Compatibility run endpoints
   ========================= */
app.get("/scrape", async (req, res) => {
  const wantsSSE = String(req.headers.accept || "").includes("text/event-stream");
  const max = req.query.max
    ? Number(req.query.max)
    : (req.query.limit ? Number(req.query.limit) : undefined);
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
    const clientId = onClientConnect(res, jobId);
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
   Start
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
