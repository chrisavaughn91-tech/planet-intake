## 2025-09-22 — UI-Route-2
- Add POST /session for login page flow (returns {ok, jobId, liveUrl} and can autoStart).
- Accept urlencoded forms (express.urlencoded) alongside JSON.
- Keep explicit routes for /login(+.html) and /live(+.html).

## 2025-09-22 — UI-Route-1
- Add explicit routes for `/login` and `/login.html`; keep `/live` & `/live.html`.
- Default landing remains `/live`. No scraper/SSE logic changes.

## 2025-09-13 20:56 UTC – Live UI polish (2a/2b) promoted to main
- Locked Neon Command Center
- Auto-scroll on by default; single toggle
- Removed key + theme selector
- Lead row grouping (lead + numbers + badge)
- Elapsed timestamps from first start
- Sheet URLs clickable

