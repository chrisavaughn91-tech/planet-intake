import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { emit, onClientConnect, removeClient } from "./events.js";
import { scrapePlanet } from "./scraper.js";
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

async function runScrapeAndSheet({ username, password, email, max, jobId }) {
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
      // ✅ matches your sheets.js signature
      sheet = await createSheetAndShare({ email, result });
    } catch (e1) {
      // Optional back-compat if an older sheets.js ever appears
      sig = "fallback:(leads,email)";
      sheet = await createSheetAndShare(result.leads, email);
    }

    // Accept BOTH shapes:
    //   { url }  OR  { ok:true, url }
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
    const clientId = onClientConnect(res, null); // global; job events mirrored via events.js
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
   Server start + optional auto-run
   ========================= */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log("server listening on", PORT);

  // Optional: kick off a run on boot if enabled
  const flag = String(process.env.START_ON_BOOT || "").toLowerCase();
  const shouldStart =
    flag === "true" || flag === "1" || flag === "yes" || flag === "on";

  if (shouldStart) {
    const username = envUser();
    const password = envPass();
    const email = envEmail();

    // Use START_MAX if provided; else fall back to MAX_LEADS_DEFAULT; else undefined (scraper default)
    const startMax =
      process.env.START_MAX != null
        ? Number(process.env.START_MAX)
        : (process.env.MAX_LEADS_DEFAULT != null
            ? Number(process.env.MAX_LEADS_DEFAULT)
            : undefined);

    const jobId = mkJobId();
    emit("info", { msg: `autorun: start (job ${jobId}, max=${startMax ?? "default"})`, jobId });

    // Don't block the boot; fire it off asynchronously
    (async () => {
      try {
        await runScrapeAndSheet({ username, password, email, max: startMax, jobId });
      } catch (e) {
        emit("error", { msg: "autorun: exception " + (e?.message || e), jobId });
      }
    })().catch((e) => emit("error", { msg: "autorun: exception " + (e?.message || e), jobId }));
  }
});
