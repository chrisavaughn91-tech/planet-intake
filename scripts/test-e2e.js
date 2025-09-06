#!/usr/bin/env node
/* E2E: POST /scrape and verify we get a Google Sheet URL + spreadsheetId */

const { setTimeout: sleep } = require('timers/promises');
require('dotenv').config();

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST       = process.env.HOST || arg('--host', 'http://localhost:8080');
const username   = process.env.PLANET_USERNAME || arg('--user');
const password   = process.env.PLANET_PASSWORD || arg('--pass');
const email      = process.env.REPORT_EMAIL     || arg('--email');
const maxLeads   = Number(arg('--max', process.env.MAX_LEADS_DEFAULT || 5)) || 5;
const timeoutMs  = Number(arg('--timeout', 180000)) || 180000; // 3 min

if (!username || !password || !email) {
  console.error('Usage: node scripts/test-e2e.js --user <u> --pass <p> --email <you@host> [--max 5] [--host http://localhost:8080]');
  console.error('Or set PLANET_USERNAME, PLANET_PASSWORD, REPORT_EMAIL in .env');
  process.exit(2);
}

async function main() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();

  const payload = { username, password, email, maxLeads };
  const res = await fetch(`${HOST}/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  }).catch(err => {
    clearTimeout(t);
    throw err;
  });

  clearTimeout(t);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from /scrape: ${text.slice(0, 400)}`);
  }

  const data = await res.json().catch(() => ({}));
  // Accept either {ok:true, url, spreadsheetId} or {ok:true, sheet:{url, spreadsheetId}}
  const sheet = data.sheet || data;
  const url = sheet.url || sheet.link || sheet.webViewLink;
  const spreadsheetId = sheet.spreadsheetId;

  if (data.ok === false) {
    throw new Error(`/scrape reported error: ${data.error || JSON.stringify(data).slice(0,400)}`);
  }
  if (!url || !spreadsheetId) {
    throw new Error(`Missing sheet url or spreadsheetId in response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const took = ((Date.now() - started) / 1000).toFixed(1);
  console.log('E2E OK:', { url, spreadsheetId, took: `${took}s` });
  process.exit(0);
}

main().catch(err => {
  console.error('E2E FAIL:', String(err && err.stack || err));
  process.exit(1);
});

