// src/sheets.js  (CommonJS; Node 18+)

/**
 * Post payload to an Apps Script Web App while preserving POST across redirects.
 * Handles Google’s /echo? → /exec? hop automatically.
 * @param {string} execUrl - The Apps Script Web App "exec" URL.
 * @param {object} payload - JSON serializable body.
 * @returns {Promise<object|string>} Parsed JSON or raw text.
 */
async function pushToSheets(execUrl, payload) {
  if (!execUrl) throw new Error("Missing execUrl");

  async function post(url, hops = 0) {
    if (hops > 6) throw new Error("Too many redirects");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",           // we will follow ourselves
    });

    // Follow Google’s bounce while keeping POST
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      let next = res.headers.get("location");
      if (!next) throw new Error("Redirect without Location header");
      // Apps Script’s first hop is often /echo?; normalize to /exec?
      next = next.replace("/echo?", "/exec?");
      return post(next, hops + 1);
    }

    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  return post(execUrl, 0);
}

module.exports = { pushToSheets };

