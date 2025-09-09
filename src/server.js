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
// UX: visiting "/" redirects to the live stream
app.get("/", (_req, res) => {
  res.redirect("/live");
});

/* =========================
   SSE events
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
// Accept BOTH new and legacy env names so .env doesn’t have to change.
function envUser() {
  return process.env.PLANET_USER || process.env.PLANET_USERNAME || "";
}
function envPass() {
  return process.env.PLANET_PASS || process.env.PLANET_PASSWORD || "";
}
function envEmail() {
  return process.env.NOTIFY_EMAIL || process.env.REPORT_EMAIL || "";
}
function pickCreds(body) {
  return {
    username: body?.username || envUser(),
    password: body?.password || envPass(),
    email: body?.email || envEmail(),
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
  try {
    const sheet = await createSheetAndShare({ leads: result.leads, email });
    if (sheet?.ok && sheet.url) {
      emit("sheet", { url: sheet.url, jobId });
      emit("info", { msg: `sheet:url ${sheet.url}`, jobId });
    } else {
      emit("error", { msg: `sheet: failed (${sheet?.error || "unknown"})`, jobId });
    }
  } catch (e) {
    emit("error", { msg: "sheet: exception " + (e?.message || e), jobId });
  }
}

/* =========================
   Run endpoints
   ========================= */
// Back-compat: /scrape (GET) — used by your existing e2e test
app.get("/scrape", async (req, res) => {
  const max = req.query.max ? Number(req.query.max) : undefined;
  const username = envUser();
  const password = envPass();
  const email = envEmail();
  const jobId = mkJobId();

  emit("info", { msg: `scrape: start (job ${jobId})`, jobId });

  (async () => {
    await runScrapeAndSheet({ username, password, email, max, jobId });
  })().catch((e) => emit("error", { msg: "scrape: exception " + (e?.message || e), jobId }));

  res.json({ ok: true, jobId, mode: "compat:/scrape" });
});

// Current: POST /run (accepts creds in body; responds immediately)
app.post("/run", async (req, res) => {
  const { username, password, email, max } = pickCreds(req.body || {});
  const jobId = mkJobId();

  emit("info", { msg: `run: start (job ${jobId})`, jobId });

  (async () => {
    await runScrapeAndSheet({ username, password, email, max, jobId });
  })().catch((e) => emit("error", { msg: "run: exception " + (e?.message || e), jobId }));

  res.json({ ok: true, jobId });
});

// Convenience: GET /run/full?max=...
app.get("/run/full", async (req, res) => {
  const max = req.query.max ? Number(req.query.max) : undefined;
  const username = envUser();
  const password = envPass();
  const email = envEmail();
  const jobId = mkJobId();

  emit("info", { msg: `run: full (job ${jobId})`, jobId });

  (async () => {
    await runScrapeAndSheet({ username, password, email, max, jobId });
  })().catch((e) => emit("error", { msg: "run/full: exception " + (e?.message || e), jobId }));

  res.json({ ok: true, jobId });
});

/* =========================
   Server start
   ========================= */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log("server listening on", PORT);
});
