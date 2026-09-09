#!/usr/bin/env node
/**
 * mc_login.cjs — MonkeyCode login (paste-cookie mode).
 *
 * Flow:
 *   1. Asks monkeycode for a Google OAuth URL (same call the site's login button makes)
 *   2. Prints the URL — open it in YOUR browser and sign in with Google
 *   3. Copy the session cookie and paste it back here:
 *      DevTools → Network → reload → click any api request → copy the
 *      "Cookie" request header → paste the whole thing (or just the value)
 *
 * The session cookie is HttpOnly — only the browser that finishes the OAuth
 * holds it, so you paste it from your own browser. No browser automation
 * needed, no Playwright.
 *
 * Usage:
 *   node mc_login.cjs <account-name>
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const API = "https://monkeycode-ai.net";
const SESSION_FILE = path.join(__dirname, "mc_session.json");
const SESSION_COOKIE = "monkeycode_ai_session";

const accountName = process.argv[2] || "1";

function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); }
  catch { return { active: null, accounts: {} }; }
}

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); }));
}

async function getAuthUrl() {
  const res = await fetch(`${API}/api/v1/users/oauth/google/login?redirect_url=%2Fconsole%2Ftasks`, {
    headers: { Accept: "application/json", Origin: API, Referer: API + "/" },
  });
  const j = await res.json();
  const url = j?.data?.auth_url;
  if (!url) throw new Error("No auth_url returned: " + JSON.stringify(j).slice(0, 200));
  return url;
}

function saveCookie(cookieVal) {
  const s = loadSession();
  s.accounts[accountName] = {
    cookie: `${SESSION_COOKIE}=${cookieVal}`,
    tasks: (s.accounts[accountName] && s.accounts[accountName].tasks) || {},
    saved_at: new Date().toISOString(),
  };
  s.active = accountName;
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
  console.log(`\n✓ Account '${accountName}' saved to mc_session.json`);
  console.log("  Run:  mc   ·   mc new \"<prompt>\"   ·   mc list");
}

(async () => {
  console.log("Fetching login URL…");
  let authUrl;
  try { authUrl = await getAuthUrl(); }
  catch (e) { console.error("✗ " + e.message); process.exit(1); }

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("  1. Open this URL in your browser and sign in with Google:");
  console.log("  " + authUrl);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("\n  2. After signing in, copy the session cookie:");
  console.log("     DevTools → Network → reload → click any api request");
  console.log("     → copy the 'Cookie' request header");
  console.log("     → paste it below (or just the UUID after monkeycode_ai_session=)");

  const raw = await ask("\n  Paste the Cookie header value: ");

  let val = null;
  // accept: full cookie header, just the pair, or just the uuid
  const m = raw.match(/monkeycode_ai_session=([0-9a-fA-F-]{36})/);
  if (m) val = m[1];
  else if (/^[0-9a-fA-F-]{36}$/.test(raw)) val = raw;

  if (!val) {
    console.error("✗ Couldn't find monkeycode_ai_session in that. Make sure you copied the Cookie header.");
    process.exit(1);
  }
  saveCookie(val);
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });