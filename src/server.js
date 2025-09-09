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
   Static assets
   ========================= */
app.use("/static", express.static(path.join(__dirname, "public")));
app.get("/live", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "live.html"));
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
  emit("info", { msg: "client: connected", clientId });
  req.on("close", () => {
    removeClient(clientId);
  });
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
   Run endpoints
   ========================= */
function pickCreds(body) {
  return {
    username: body?.username || process.env.PLANET_USER || "",
    password: body?.password || process.env.PLANET_PASS || "",
    email: body?.email || process.env.NOTIFY_EMAIL || "",
    max: body?.max ? Number(body.max) : undefined,
  };
}

app.post("/run", async (req, res) => {
  const { username, password, email, max } = pickCreds(req.body || {});
  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  emit("info", { msg: `run: start (job ${jobId})` });

  // Fire and respond immediately; client watches /events
  (async () => {
    const result = await scrapePlanet({ username, password, max, jobId });

    if (result?.ok) {
      try {
        const sheet = await createSheetAndShare({ leads: result.leads, email });
        if (sheet?.ok && sheet.url) {
          emit("sheet", { url: sheet.url, jobId });
          emit("info", { msg: `sheet:url ${sheet.url}` });
        } else {
          emit("error", { msg: `sheet: failed (${sheet && sheet.error ? sheet.error : "unknown"})` });
        }
      } catch (e) {
        emit("error", { msg: "sheet: exception " + (e?.message || e) });
      }
    } else {
      emit("error", { msg: "scrape failed: " + (result?.error || "unknown") });
    }
  })().catch((e) => emit("error", { msg: "run: exception " + (e?.message || e) }));

  res.json({ ok: true, jobId });
});

app.get("/run/full", async (req, res) => {
  const max = req.query.max ? Number(req.query.max) : undefined;
  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const username = process.env.PLANET_USER || "";
  const password = process.env.PLANET_PASS || "";
  const email = process.env.NOTIFY_EMAIL || "";

  emit("info", { msg: `run: full (job ${jobId})` });

  (async () => {
    const result = await scrapePlanet({ username, password, max, jobId });
    if (result?.ok) {
      try {
        const sheet = await createSheetAndShare({ leads: result.leads, email });
        if (sheet?.ok && sheet.url) {
          emit("sheet", { url: sheet.url, jobId });
          emit("info", { msg: `sheet:url ${sheet.url}` });
        } else {
          emit("error", { msg: `sheet: failed (${sheet && sheet.error ? sheet.error : "unknown"})` });
        }
      } catch (e) {
        emit("error", { msg: "sheet: exception " + (e?.message || e) });
      }
    } else {
      emit("error", { msg: "scrape failed: " + (result?.error || "unknown") });
    }
  })().catch((e) => emit("error", { msg: "run: exception " + (e?.message || e) }));

  res.json({ ok: true, jobId });
});

/* =========================
   Server start
   ========================= */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log("server listening on", PORT);
});
