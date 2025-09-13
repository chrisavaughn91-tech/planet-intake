import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { emit, onClientConnect, removeClient } from "./events.js";
// NOTE: scraper is now lazy-loaded (see getScrapePlanet below)
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
  res.sendFile(path.join(__dirname, "public", "live.html"));
});
app.get("/", (_req, res) => res.redirect("/live"));

/* =========================
   SSE events hub (shared)
   ========================= */
app.get("/events", (req, res) => {
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
  res.writeHead(200, headers);
  const clientId = onClientConnect(res, req.query.jobId || null);
  emit("info", { msg: "client: connected", clientId, jobId: req.query.jobId || null });
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
   Helpers
   ========================= */
function envUser()  { return process.env.PLANET_USER  || process.env.PLANET_USERNAME || ""; }
function envPass()  { return process.env.PLANET_PASS  || process.env.PLANET_PASSWORD || ""; }
function envEmail() { return process.env.NOTIFY_EMAIL || process.env.REPORT_EMAIL    || ""; }

function pickCreds(body) {
  return {
    username: body?.username || envUser(),
    password: body?.password || envPass(),
    email:    body?.email    || envEmail(),
    max: body?.max ? Number(body.max) : undefined,
  };
}

function mkJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- NEW: lazy-load scraper on demand
async function getScrapePlanet() {
  const mod = await import("./scraper.js");
  if (!mod?.scrapePlanet) throw new Error("scraper module missing export: scrapePlanet");
  return mod.scrapePlanet;
}

async function runScrapeAndSheet({ username, password, email, max, jobId }) {
  // lazy import here, right before first use
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
      // matches sheets.js signature
      sheet = await createSheetAndShare({ email, result });
    } catch (_e1) {
      // Optional back-compat path, if older sheets.js ever appears
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
   Run endpoints
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
  const shouldStart =
    flag === "true" || flag === "1" || flag === "yes" || flag === "on";

  // One-shot guard so autorun only fires once per process
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
