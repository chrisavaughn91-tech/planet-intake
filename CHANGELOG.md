## 2025-09-21 — Change 1A: Due Day "00" hardening (no behavior change)
- Feed raw token (e.g., `"00"`) directly into `normalizeDueDay(...)` in `parseLeadDetail`.
- Log now shows `dueDay` raw and normalized day explicitly (e.g., `dueDay=00 → norm=31`).
- No change to active/lapsed gating or premium math.

## 2025-09-18 — Change 2: paginator collects all pages
- Fix: Inbox pagination now collects links on every page (including last page)
- Impacted file: src/scraper.js (collectPaginated loop only)
- Notes: Live log shows "page 1 of ~N", "Go to next page", "page 2 of ~N", etc.
- Result: All 122 leads processed when page size = 100 + 2 pages present

## 2025-09-13 20:56 UTC – Live UI polish (2a/2b) promoted to main
- Locked Neon Command Center
- Auto-scroll on by default; single toggle
- Removed key + theme selector
- Lead row grouping (lead + numbers + badge)
- Elapsed timestamps from first start
- Sheet URLs clickable
