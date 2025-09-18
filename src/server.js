// src/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import { scrapePlanet } from "./scraper.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 8080;

// trust Codespaces proxy
app.set("trust proxy", true);

// parse bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// static files (serves /login and /live)
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// health + root
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/", (_req, res) => res.redirect(302, "/login"));

// --- tiny in-memory SSE hub keyed by jobId ---------------------
const streams = new Map(); // Map<jobId, Set<res>>

function sseWrite(res, { event = "info", data = {} }) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch { /* ignore broken pipes */ }
}
function broadcast(jobId, payload) {
  const set = streams.get(jobId);
  if (!set || set.size === 0) return;
  for (const res of set) sseWrite(res, payload);
}
function makeEmitter(jobId) {
  return (event, data = {}) => {
    const payload = typeof data === "string" ? { msg: data } : (data || {});
    broadcast(jobId, { event, data: payload });
  };
}

// --- SSE endpoint: accept ?job= or ?jobId= ---------------------
app.get("/events", (req, res) => {
  const jobId = String(req.query.job || req.query.jobId || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, error: "missing job (use ?job=...)" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  if (!streams.has(jobId)) streams.set(jobId, new Set());
  streams.get(jobId).add(res);

  sseWrite(res, { event: "info", data: { msg: "stream: connected" } });
  const ping = setInterval(() => sseWrite(res, { event: "ping", data: {} }), 15000);

  req.on("close", () => {
    clearInterval(ping);
    const set = streams.get(jobId);
    if (set) {
      set.delete(res);
      if (set.size === 0) streams.delete(jobId);
    }
  });
});

// --- serve pages ------------------------------------------------
app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/live", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "live.html"));
});

// --- run a scrape ----------------------------------------------
app.post("/run", async (req, res) => {
  try {
    const {
      username = "",
      password = "",
      email = "",
      max
    } = req.body || {};

    const jobId = `job${Math.random().toString(36).slice(2, 7)}-${Date.now().toString().slice(-5)}`;
    const emit  = makeEmitter(jobId);

    emit("start", { job: jobId, max: max ? Number(max) : null });

    // fire-and-forget so we can immediately respond/redirect
    (async () => {
      try {
        await scrapePlanet({
          username,
          password,
          reportEmail: email,
          max: max ? Number(max) : undefined,
          jobId,
          emit, // <— wire scraper logs to this job’s SSE channel
        });
        emit("done", { ok: true, job: jobId });
      } catch (e) {
        emit("error", { msg: e?.message || String(e) });
        emit("done",  { ok: false, job: jobId });
      }
    })();

    // Browser form? send them to their private live view
    if ((req.headers.accept || "").includes("text/html")) {
      return res.redirect(303, `/live?job=${encodeURIComponent(jobId)}`);
    }

    // Programmatic caller
    res.json({ ok: true, job: jobId, live: `/live?job=${encodeURIComponent(jobId)}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// --- start ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
