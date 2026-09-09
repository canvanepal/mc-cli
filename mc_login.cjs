#!/usr/bin/env node
/**
 * mc_login.cjs — MonkeyCode login (URL mode).
 *
 * Flow:
 *   1. Asks monkeycode for a Google OAuth URL (same call the site's login button makes)
 *   2. Prints the URL for you to open
 *   3. Two ways to complete:
 *      a. Open it in your own browser → sign in → paste the session cookie back here
 *         (DevTools → Network → reload → click any api request → copy the
 *          "Cookie" request header → paste the whole thing here)
 *      b. Press Enter → opens a managed browser that captures the cookie automatically
 *
 * The session cookie is HttpOnly — only the browser that finishes the OAuth holds it,
 * so a URL alone can't hand it to the CLI; either that browser is ours (b) or you
 * paste it (a).
 *
 * Usage:
 *   node mc_login.cjs <account-name>
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
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

function findPlaywright() {
  // 1. local node_modules
  const local = path.join(__dirname, "node_modules", "playwright");
  try { require.resolve(local); return local; } catch {}
  // 2. global npm root
  try {
    const { execSync } = require("child_process");
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const global = path.join(root, "playwright");
    require.resolve(global);
    return global;
  } catch {}
  throw new Error(
    "Playwright not found. Install it with:  npm install -g playwright && npx playwright install chromium"
  );
}

async function managedBrowserCapture(authUrl) {
  const { chromium } = require(findPlaywright());
  const PROFILES = path.join(os.tmpdir(), `mc-login-profile-${accountName}`);
  console.log(`Opening managed browser for account '${accountName}' — sign in with Google if asked…`);
  const ctx = await chromium.launchPersistentContext(PROFILES, {
    headless: false,
    viewport: { width: 1100, height: 800 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try { await page.goto(authUrl, { waitUntil: "domcontentloaded" }); } catch {}

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const c = (await ctx.cookies(API)).find((x) => x.name === SESSION_COOKIE);
    if (c && c.value) { await ctx.close(); return c.value; }
    if (page.url().includes("/console/")) {
      const c2 = (await ctx.cookies(API)).find((x) => x.name === SESSION_COOKIE);
      if (c2 && c2.value) { await ctx.close(); return c2.value; }
    }
    await page.waitForTimeout(1000);
  }
  await ctx.close();
  throw new Error("Timed out waiting for session cookie.");
}

(async () => {
  console.log("Fetching login URL…");
  let authUrl;
  try { authUrl = await getAuthUrl(); }
  catch (e) { console.error("✗ " + e.message); process.exit(1); }

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("  Open this URL and sign in with Google:");
  console.log("  " + authUrl);
  console.log("──────────────────────────────────────────────────────────────");

  const choice = await ask(
    "\n  [Enter] open in managed browser (auto-capture)\n" +
    "  [P]aste the session cookie from your own browser\n" +
    "  → "
  );

  // accept a bare UUID (monkeycode_ai_session value) typed straight at the menu
  if (/^[0-9a-fA-F-]{36}$/.test(choice)) {
    saveCookie(choice);
    return;
  }

  if (choice.toLowerCase() === "p") {
    const raw = await ask("Paste the Cookie header value (contains monkeycode_ai_session=…): ");
    let val = null;
    // accept: full cookie header, just the pair, or just the uuid
    const m = raw.match(/monkeycode_ai_session=([0-9a-fA-F-]{36})/);
    if (m) val = m[1];
    else if (/^[0-9a-fA-F-]{36}$/.test(raw)) val = raw;
    if (!val) { console.error("✗ Couldn't find monkeycode_ai_session in that. Try again or use [Enter]."); process.exit(1); }
    saveCookie(val);
  } else {
    try {
      const val = await managedBrowserCapture(authUrl);
      saveCookie(val);
    } catch (e) { console.error("✗ " + e.message); process.exit(1); }
  }
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });