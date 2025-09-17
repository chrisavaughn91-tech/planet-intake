// src/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Local modules
import { emit, onClientConnect, removeClient } from "./events.js";
import { scrapePlanet } from "./scraper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Static files and simple page routes
const pub = path.join(__dirname, "public");
app.use(express.static(pub));

app.get("/", (_req, res) => res.redirect("/login"));
app.get("/login", (_req, res) => res.sendFile(path.join(pub, "login.html")));
app.get("/live", (_req, res) => res.sendFile(path.join(pub, "live.html")));

// --- Server-Sent Events (optionally filtered by ?jobId=...) ---
app.get("/events", (req, res) => {
  // Standard SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const jobId =
    typeof req.query.jobId === "string" && req.query.jobId.trim()
      ? req.query.jobId.trim()
      : null;

  // Register client with optional job scoping
  const clientId = onClientConnect(res, jobId);

  // Cleanup on disconnect
  req.on("close", () => {
    try { removeClient(clientId); } catch {}
  });
});

// --- Internal launcher: start a job and return its id ---
async function launchRun(fields) {
  const jobId = `m${Math.random().toString(36).slice(2, 7)}-${Date.now()
    .toString()
    .slice(-5)}`;

  emit("start", { jobId, msg: `run: full (job ${jobId})` });

  const { username, password, email, max, autoStart } = fields || {};

  // Fire-and-forget scrape
  (async () => {
    try {
      const result = await scrapePlanet({
        auth: { username, password },
        email,
        max,
        autorun: !!autoStart,
        jobId,
      });

      if (result?.sheetUrl) {
        emit("sheet", { jobId, url: result.sheetUrl });
      }
      emit("done", {
        jobId,
        msg: `processed=${result?.processed ?? "n/a"}`,
      });
    } catch (e) {
      emit("error", { jobId, msg: String(e?.message ?? e) });
    }
  })();

  return jobId;
}

// --- Primary endpoint used by login.html ---
app.post("/run", async (req, res) => {
  try {
    const jobId = await launchRun(req.body || {});
    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Compatibility helpers (keep older entry points working) ---

// POST /scrape (legacy)
app.post("/scrape", async (req, res) => {
  try {
    const jobId = await launchRun({ ...(req.body || {}), autoStart: true });
    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// GET /run/full?max=120 (legacy)
app.get("/run/full", async (req, res) => {
  try {
    const max = req.query.max ? Number(req.query.max) : undefined;
    const jobId = await launchRun({ max, autoStart: true });
    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Default 404
app.use((req, res) => res.status(404).send(`Cannot ${req.method} ${req.path}`));

// Start server
app.listen(PORT, () => {
  emit("info", { msg: `server listening on ${PORT}` });
});
