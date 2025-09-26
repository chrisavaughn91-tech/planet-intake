# Planet Intake – Source of Truth (SoT) Index

This document anchors the **exact** state we share. Any time we accept a change, we update this file (and the Change Log) so we never drift.

- **Codespaces**: public port **3000** (Live UI + trigger endpoints), private port **8080**
  - Live UI served at **/live** on **3000**
  - Trigger a run with: `GET /run/full?max=200` (on port **3000**)


---

## A. Repositories & Running Context

- **Codespaces**: public port **3000** (Live UI), private port **8080**
  - Ports panel shows 3000 → `node src/server.js` (Public), 8080 → Private
- **Server entry**: `src/server.js`
- **Scraper**: `src/scraper.js` (Playwright)
- **Event stream (SSE) client**: `public/live.html` + `src/events.js`
- **Tests**: `test-e2e.js`, `test-push.js`, `scripts/test-push.js`
- **Environment**: `.env` (e.g., `MAX_LEADS`; **no secrets** in repo)
- Live UI served at **/live** on forwarded port **3000**.
- Files updated in latest confirmed change:
  - `public/live.html`
  - `src/server.js` (adds `sheet_done` SSE)

> Run basics
> ```bash
> pkill -f "node src/server.js" || true
> npm ci
> node src/server.js
> # open the forwarded 3000 URL → /live
> ```

---

## B. External Services

- **Google Apps Script (Sheet web app)**
  - Deployment: **v4 canonical**
  - Health: `?action=health` → `{ ok:true, version:4, tag:"v4-planet-intake-canonical" }`
  - **Active Web App URL**: paste the current `/exec` URL you’re using here for quick reference.

- **Sheet output**
  - Tabs: **Summary**, **AllNumbers**
  - Response (success): `{ ok, url, spreadsheetId, counts, versionTag: "sheet-polish-v4" }`

---

## C. UI Conventions (current)

- Pill types: Info, Lead, Policy, Numbers, Badge; lapsed tag (red); ⭐ badge logic.
- Newest-event “pulse” preferred on top item only (Change 1c implements refinement).
- Sheet name formatting: LAST, FIRST → First Last (Apps Script).
- Toolbar chips: Auto-scroll, **Only ⭐/🔴** filter.
- Run meta: elapsed time + processed leads.
- Newest-event pulse on top row only.
- Sheet toast appears on `sheet_done`.

---

## D. File Inventory (essentials)

- `public/live.html` – Live feed UI (SSE client)
- `public/login.html` – Login page (if used)
- `src/server.js` – Node server (SSE + routes + GAS POST)
- `src/events.js` – Client-side event handling for SSE
- `src/scraper.js` – Playwright scraper
- `src/sheets.js` – GAS payload builder / sender
- `apps-script/Code.gs` – Apps Script (sheet creation/format)
- `scripts/test-push.js`, `test-e2e.js` – tests

> A complete (path,size,sha256) manifest exists out-of-band for verification. This index stays concise and human-usable.

---

## E. Version Pins

- **Apps Script Tag**: `v4-planet-intake-canonical`
- **Sheet Version Tag**: `sheet-polish-v4`
- **This SoT Index**: initialized on Change 0; update on every confirmed change.
- Apps Script Tag: `v4-planet-intake-canonical`
- Sheet Version Tag: `sheet-polish-v4`
- SoT: includes **Change 1C (2025-09-25)**.

---

## F. Workflow Guardrails

1. Every edit is a numbered **Change** (1, 1b, 2, …).  
2. **List files to be touched** before sending code.  
3. **Deliver full-file replacements** (no snippets).  
4. Include **post-change commands** (git add/commit/push; server/test steps).  
5. Update **SOT-INDEX.md** + **CHANGELOG.md** after confirmation.  
6. **No secrets in repo** — use `.env`.
- SoT: includes **Change 1C (2025-09-25)**, **Change 2a (2025-09-26)**.
