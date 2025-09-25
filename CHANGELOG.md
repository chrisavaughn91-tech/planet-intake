# Planet Intake – Change Log

> Protocol: Each change is numbered (Change 1, 1b, 2, …). We commit *full-file* replacements and update SoT after your confirmation. This log is the human-readable timeline.

## Legend
- **Status**: proposed ▸ applied ▸ confirmed
- **Scope**: list of touched files for each change
- **Why**: purpose and user-visible effect

---

## Change 0 — Bookkeeping: Live Change Log + SoT Index
- **Date**: <fill on commit>
- **Status**: applied (awaiting confirm)
- **Scope**:
  - `CHANGELOG.md` (replace with merged)
  - `SOT-INDEX.md` (new)
- **Why**: Prevent drift; create a single glanceable index of the exact files and endpoints we’re both referencing.

---

## Queue (next up)
- **Change 1C — UI “Deluxe Polish”**  
  Scope (tentative): `public/live.html`, `src/events.js`, `src/server.js` (tiny new `sheet_done` SSE).  
  Status: **proposed** (pending green light).

---

# Prior Changes (preserved)

## 2025-09-21 — Change 1C: Fallback for “Listed #’s” when Call flow is blocked/redirected
- Add `harvestHeaderListedNumbers(page)` to scan the header/hero strip near the primary lead name for phone tokens.
- In `scrapePlanet`, after `harvestClickToCall(page)`:
  - If **no numbers** were captured:  
    - If we were bounced off the detail page, `goto(absUrl)` to return.  
    - Clear overlays, **do not click Call again**, and run `harvestHeaderListedNumbers(page)`.
    - Treat these as the **listed #** results (they’re merged into the `c2c` list so counts and badges work unchanged).
- 7-digit phones are included and flagged “Needs Area Code”; they will show under **Flagged Numbers** in the sheet.
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
