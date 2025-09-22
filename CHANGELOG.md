## 2025-09-22 — UI-Route-2
- Add POST `/session` for login page flow (returns `ok`, `jobId`, `liveUrl`) and can autoStart.
- Accept `urlencoded` forms (`express.urlencoded`) alongside JSON.
- Keep explicit routes for `/login(.html)` and `/live(.html)`.

## 2025-09-22 — UI-Route-1
- Add explicit routes for `/login` and `/login.html`; keep `/live` & `/live.html`.
- Default landing remains `/live`. No scraper/SSE logic changes.

## 2025-09-21 — Change 1C: Fallback for “Listed #s” when Call flow is blocked/redirected
- Add `harvestHeaderListedNumbers(page)` to scan the header/hero strip near the primary lead name for phone tokens.
- In `scrapePlanet`, after `harvestClickToCall(page)`:
  - If **no numbers** were captured:
    - If we were bounced off the detail page, `goto(absUrl)` to return.
    - Clear overlays, **do not click Call again**, and run `harvestHeaderListedNumbers(page)`.
    - Treat these as the **listed #** results (they’re merged into the `c2c` list so counts and badges work unchanged).
  - 7-digit phones are included and flagged **“Needs Area Code”**; they show under **Flagged Numbers** in the sheet.
- No changes to special/premium math or policy scraping.


## 2025-09-21 — Change 1B: Blocking modal overlay handling
- Add `closeBlockingOverlays(page)` to detect/dismiss `.modal-backdrop`, `body.modal-open`, and ARIA dialogs.
- Invoke overlay clearing after navigation, before click-to-call, and at the start of detail parsing.
- Add a guarded retry in click-to-call if the dropdown was blocked.
- No behavior change when no modal is present.

## 2025-09-21 — Change 1A: Due Day "00" hardening (no behavior change)
- Feed raw token (e.g., `"00"`) directly into `normalizeDueDay(...)` in `parseLeadDetail`.
- Log now shows `dueDay` raw and normalized day explicitly (e.g., `dueDay=00 → norm=31`).
- No change to active/lapsed gating or premium math.

## 2025-09-18 — Change 2: paginator collects all pages
- Fix: Inbox pagination now collects links on every page (including last page)
- Impacted file: src/scraper.js (collectPaginated loop only)
- Notes: Live log shows "page 1 of ~N", "Go to next page", "page 2 of ~N", etc.
- Result: All 122 leads processed when page size = 100 + 2 pages present
