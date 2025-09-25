import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { emit, onClientConnect, removeClient } from "./events.js";
import { createSheetAndShare } from "./sheets.js";

async function getScrapePlanet() {
  const mod = await import("./scraper.js");
  if (!mod?.scrapePlanet) throw new Error("scraper module missing export: scrapePlanet");
  return mod.scrapePlanet;
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.use(express.json());

/* =========================================================
   In-memory job metadata (per jobId)
   ========================================================= */
if (!global.__PLP_JOBS) {
  // Map<jobId, { badgeConfig?: object, createdAt: number }>
  global.__PLP_JOBS = new Map();
}

/* =========================================================
   Static + pages
   ========================================================= */
app.use(express.static(PUBLIC_DIR));             // <— serve /public at /
app.use("/static", express.static(PUBLIC_DIR));  // <— also available at /static

app.get("/login", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.get("/live", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "live.html"));
});

app.get("/", (_req, res) => res.redirect("/live"));

/* =========================================================
   SSE hub (job-scoped)
   ========================================================= */
app.get("/events", (req, res) => {
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
  res.writeHead(200, headers);

  const jobId = (req.query.jobId ?? req.query.job ?? null) || null;
  const clientId = onClientConnect(res, jobId);
  emit("info", { msg: "client: connected", clientId, jobId });
  req.on("close", () => removeClient(clientId));
});

/* =========================================================
   Health + status
   ========================================================= */
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    clients: global.__SSE_CLIENTS ? global.__SSE_CLIENTS.length : 0,
    jobs: global.__PLP_JOBS ? global.__PLP_JOBS.size : 0,
  });
});

/* =========================================================
   Cred helpers
   ========================================================= */
function envUser()  { return process.env.PLANET_USER  || process.env.PLANET_USERNAME || ""; }
function envPass()  { return process.env.PLANET_PASS  || process.env.PLANET_PASSWORD || ""; }
function envEmail() { return process.env.NOTIFY_EMAIL || process.env.REPORT_EMAIL    || ""; }

function pickCreds(body) {
  return {
    username: body?.username || envUser(),
    password: body?.password || envPass(),
    email:    body?.email    || envEmail(),
    max:      body?.max != null && String(body.max).trim() !== "" ? Number(body.max) : undefined,
  };
}

function mkJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* =========================================================
   badgeConfig validation / sanitization
   ========================================================= */
const BADGE_ORDER = ["star", "white", "purple", "orange", "red"];
const MODE = { NUMBER: "NUMBER", LAPSED: "LAPSED", NO_NUMBERS: "NO_NUMBERS" };

function toMoneyOrNull(x) {
  if (x == null) return null;
  const t = String(x).trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  // two decimals max
  return Math.round(n * 100) / 100;
}

function sanitizeBadgeRules(rulesIn = {}) {
  const out = {};
  for (const kind of BADGE_ORDER) {
    const src = rulesIn && typeof rulesIn === "object" ? rulesIn[kind] : undefined;
    const on   = !!(src?.on);
    let mode   = String(src?.mode || "").toUpperCase();
    if (!Object.values(MODE).includes(mode)) mode = MODE.NUMBER;

    // Only keep numbers if NUMBER mode; booleans ignore ranges
    const floor = mode === MODE.NUMBER ? toMoneyOrNull(src?.floor) : null;
    const ceil  = mode === MODE.NUMBER ? toMoneyOrNull(src?.ceil)  : null;

    out[kind] = { on, mode, floor, ceil };
  }
  return out;
}

function validateBadgeConfig(input) {
  if (!input || typeof input !== "object") {
    // sensible default: nothing on; fallback white
    return {
      order: [...BADGE_ORDER],
      defaultFallback: "white",
      priority: { lapsedFirst: true },
      rules: sanitizeBadgeRules({}),
    };
  }

  const order = Array.isArray(input.order) && input.order.join(",") === BADGE_ORDER.join(",")
    ? [...input.order]
    : [...BADGE_ORDER];

  const fallback = BADGE_ORDER.includes(input.defaultFallback) ? input.defaultFallback : "white";

  const priority = {
    lapsedFirst: input?.priority?.lapsedFirst !== false, // default true
  };

  const rules = sanitizeBadgeRules(input.rules);

  return { order, defaultFallback: fallback, priority, rules };
}

/* =========================================================
   Scrape runner
   ========================================================= */
async function runScrapeAndSheet({ username, password, email, max, jobId, badgeConfig }) {
  const scrapePlanet = await getScrapePlanet();

  // Let the scraper consume badgeConfig (used in Change 3c)
  const result = await scrapePlanet({ username, password, max, jobId, badgeConfig });
  if (!result?.ok) {
    emit("error", { msg: "scrape failed: " + (result?.error || "unknown"), jobId });
    return;
  }

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
    const spreadsheetId = sheet?.spreadsheetId || sheet?.id || null;
    const counts = sheet?.counts || null;

    if (ok && url) {
      // legacy event for existing UI
      emit("sheet", { url, jobId });
      emit("info", { msg: `sheet:url ${url}`, jobId });

      // new confirmation event for toast + meta
      emit("sheet_done", { url, spreadsheetId, counts, jobId });
    } else {
      const errMsg = sheet?.error || "unknown";
      emit("error", { msg: `sheet: failed (${errMsg}) [sig=${sig}]`, jobId });
    }
  } catch (e) {
    emit("error", { msg: "sheet: exception " + (e?.message || e), jobId });
  }
}

/* =========================================================
   /session for login.html
   ========================================================= */
app.post("/session", async (req, res) => {
  try {
    const body = req.body || {};
    const { username, password, email, max, autoStart } = {
      ...pickCreds(body),
      autoStart: body?.autoStart === true || body?.autoStart === "true",
    };

    // sanitize badgeConfig from client (Change 3a)
    const badgeConfig = validateBadgeConfig(body?.badgeConfig);

    const jobId = mkJobId();
    const liveUrl = `/live?job=${encodeURIComponent(jobId)}`;

    // store job meta for the scraper / future endpoints
    global.__PLP_JOBS.set(jobId, { badgeConfig, createdAt: Date.now() });

    emit("info", { msg: `session: job created (${jobId})`, jobId });
    emit("info", { msg: `badge:config ${JSON.stringify({ order: badgeConfig.order, priority: badgeConfig.priority })}`, jobId });

    if (autoStart) {
      emit("info", { msg: `session: autoStart (job ${jobId})`, jobId });
      (async () => {
        try {
          await runScrapeAndSheet({ username, password, email, max, jobId, badgeConfig });
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

/* =========================================================
   Compatibility run endpoints
   (accept optional badgeConfig if provided by caller)
   ========================================================= */
app.get("/scrape", async (req, res) => {
  const wantsSSE = String(req.headers.accept || "").includes("text/event-stream");
  const max = req.query.max
    ? Number(req.query.max)
    : (req.query.limit ? Number(req.query.limit) : undefined);
  const username = envUser();
  const password = envPass();
  const email = envEmail();
  const jobId = mkJobId();

  // No badgeConfig provided on GET; use defaults
  const badgeConfig = validateBadgeConfig(null);
  global.__PLP_JOBS.set(jobId, { badgeConfig, createdAt: Date.now() });

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
      await runScrapeAndSheet({ username, password, email, max, jobId, badgeConfig });
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
  (async () => { await runScrapeAndSheet({ username, password, email, max, jobId, badgeConfig }); })()
    .catch((e) => emit("error", { msg: "scrape: exception " + (e?.message || e), jobId }));
  res.json({ ok: true, jobId, mode: "compat:/scrape(json)" });
});

app.post("/run", async (req, res) => {
  const body = req.body || {};
  const { username, password, email, max } = pickCreds(body);
  const badgeConfig = validateBadgeConfig(body?.badgeConfig);
  const jobId = mkJobId();

  global.__PLP_JOBS.set(jobId, { badgeConfig, createdAt: Date.now() });

  emit("info", { msg: `run: start (job ${jobId})`, jobId });
  (async () => { await runScrapeAndSheet({ username, password, email, max, jobId, badgeConfig }); })()
    .catch((e) => emit("error", { msg: "run: exception " + (e?.message || e), jobId }));

  res.json({ ok: true, jobId });
});

app.get("/run/full", async (req, res) => {
  const max = req.query.max ? Number(req.query.max) : undefined;
  const username = envUser();
  const password = envPass();
  const email = envEmail();
  const jobId = mkJobId();

  // No badgeConfig on GET; use defaults
  const badgeConfig = validateBadgeConfig(null);
  global.__PLP_JOBS.set(jobId, { badgeConfig, createdAt: Date.now() });

  emit("info", { msg: `run: full (job ${jobId})`, jobId });

  (async () => { await runScrapeAndSheet({ username, password, email, max, jobId, badgeConfig }); })()
    .catch((e) => emit("error", { msg: "run/full: exception " + (e?.message || e), jobId }));

  res.json({ ok: true, jobId });
});

/* =========================================================
   Start
   ========================================================= */
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

    // autorun uses default badgeConfig unless you wire something different
    const badgeConfig = validateBadgeConfig(null);
    global.__PLP_JOBS.set(jobId, { badgeConfig, createdAt: Date.now() });

    emit("info", { msg: `autorun: scheduled in ${delayMs}ms (job ${jobId}, max=${startMax ?? "default"})`, jobId });

    setTimeout(() => {
      emit("info", { msg: `autorun: start (job ${jobId})`, jobId });
      (async () => {
        try {
          await runScrapeAndSheet({ username, password, email, max: startMax, jobId, badgeConfig });
          emit("info", { msg: `autorun: end (job ${jobId})`, jobId });
        } catch (e) {
          emit("error", { msg: "autorun: exception " + (e?.message || e), jobId });
        }
      })().catch((e) => emit("error", { msg: "autorun: exception " + (e?.message || e), jobId }));
    }, delayMs);
  }
});
