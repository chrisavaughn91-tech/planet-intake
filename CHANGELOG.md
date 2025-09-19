
## 2025-09-13 20:56 UTC – Live UI polish (2a/2b) promoted to main
- Locked Neon Command Center
- Auto-scroll on by default; single toggle
- Removed key + theme selector
- Lead row grouping (lead + numbers + badge)
- Elapsed timestamps from first start
- Sheet URLs clickable

## 2025-09-18 — Change 2: paginator collects all pages
- Fix: Inbox pagination now collects links on every page (including last page)
- Impacted file: src/scraper.js (collectPaginated loop only)
- Notes: Live log shows "page 1 of ~N", "Go to next page", "page 2 of ~N", etc.
- Result: All 122 leads processed when page size = 100 + 2 pages present

