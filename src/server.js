// src/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Local modules
import { emit, subscribe } from "./events.js";
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
app.get("/live",  (_req, res) => res.sendFile(path.join(pub, "live.html")));

// --- Server-Sent Events (Optionally filtered by ?jobId=) ---
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const wanted = (req.query.jobId || "").toString().trim();

  const un = subscribe((m) => {
    try {
      if (wanted) {
        const jid = m?.data?.jobId;
        if (!jid || jid !== wanted) return; // filter out other jobs
      }
      res.write(`data: ${JSON.stringify(m)}\n\n`);
    } catch {
      // ignore broken writes
    }
  });

  req.on("close", () => {
    try { un(); } catch {}
  });
});

// --- internal launcher: start a job and return its id ---
async function launchRun(fields) {
  const jobId = `m${Math.random().toString(36).slice(2, 7)}-${Date.now()
    .toString()
    .slice(-5)}`;

  // Announce start
  emit("start", { jobId, msg: `run: full (job ${jobId})` });

  const { username, password, email, max, autoStart } = fields || {};

  // Kick the scraper (fire-and-forget)
  (async () => {
    try {
      const result = await scrapePlanet({
        auth: { username, password },
        email,
        max,
        autorun: !!autoStart,
        jobId,
      });

      // If your scraper returns a sheet URL, emit it
      if (result?.sheetUrl) {
        emit("sheet", { jobId, url: result.sheetUrl });
      }
      emit("done", {
        jobId,
        msg: `processed=${result?.processed ?? "n/a"}`,
      });
    } catch (e) {
      emit("error", { jobId, msg: String(e && e.message ? e.message : e) });
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

// POST /scrape  (legacy)
app.post("/scrape", async (req, res) => {
  try {
    const jobId = await launchRun({ ...(req.body || {}), autoStart: true });
    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// GET /run/full?max=120  (legacy)
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
