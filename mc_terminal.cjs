#!/usr/bin/env node
/**
 * mc_terminal.cjs — Multi-account MonkeyCode-AI CLI.
 *
 * MonkeyCode is per-task: each task spawns its own VM + terminal.
 * When a task dies (stop/delete/expiry), its VM and terminal are gone.
 *
 * Commands:
 *   mc                          connect to active account's last task terminal
 *   mc list                     list accounts + their tasks
 *   mc login [name]             sign in / add an account (saved under name)
 *   mc use <name>               switch active account
 *   mc rm <name>                remove an account
 *   mc tasks                    list active account's tasks
 *   mc new "<prompt>"           create a task, wait for VM, connect terminal
 *   mc stop <task_id>           stop a task (kills its VM)
 *   mc connect <task_id>        connect terminal of a specific task
 *
 * Protocol (reverse-engineered from index-DgOWGWHy.js):
 *   wss://monkeycode-ai.net/api/v1/users/hosts/vms/{vm}/terminals/connect?terminal_id={id}
 *   → {"type":"resize","data":"{\"row\":N,\"col\":N}"}
 *   → {"type":"data","data":"<base64-utf8>"}
 *   → {"type":"ping"} every 5s
 *   ← {"type":"connected"} / {"type":"data","data":"<base64>"} / {"type":"error"}
 */

const fs = require("fs");
const path = require("path");

const WS_BASE = process.env.MC_WS_BASE_OVERRIDE || "wss://monkeycode-ai.net/api/v1/users/hosts/vms";
const API = "https://monkeycode-ai.net/api/v1";
const SESSION_FILE = path.join(__dirname, "mc_session.json");

/* ---------------- session store (multi-account) ---------------- */

function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return { active: null, accounts: {} };
  }
}
function saveSession(s) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}
function activeAccount(s) {
  if (!s.active || !s.accounts[s.active]) {
    const names = Object.keys(s.accounts);
    if (!names.length) return null;
    s.active = names[0];
  }
  return s.accounts[s.active];
}

/* ---------------- API helpers ---------------- */

async function api(method, p, { cookie, body } = {}) {
  const headers = { Accept: "application/json", Origin: "https://monkeycode-ai.net" };
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code !== undefined && j.code !== 0)) {
    if (j.code === 10811) {
      // Free-tier concurrency limit — find WHICH task is holding the slot.
      let blocker = "";
      try {
        const lr = await fetch(`${API}/users/tasks?page=1&size=5`, { headers });
        const lj = await lr.json();
        const run = (lj.data?.tasks || []).find((t) => t.status === "processing" || t.status === "pending");
        if (run) blocker = ` (blocking: ${run.id.slice(0, 8)} — "${(run.title || run.content || "").slice(0, 40)}")`;
      } catch {}
      throw new Error(
        `Concurrency limit reached — you already have a running task${blocker}.\r\n` +
        `  Stop it:        mc stop <task_id>\r\n` +
        `  Or reconnect:   mc connect <task_id>\r\n` +
        `  Then create:    mc new "<prompt>"`
      );
    }
    throw new Error(j.message || `API ${method} ${p} failed (${res.status})`);
  }
  return j.data;
}

async function getTaskTerminals(cookie, vmId) {
  return await api("GET", `/users/hosts/vms/${vmId}/terminals`, { cookie });
}

async function createTask(cookie, content) {
  // pick sensible defaults from the account's available resources
  const [models, images] = await Promise.all([
    api("GET", "/users/models", { cookie }),
    api("GET", "/users/images", { cookie }),
  ]);

  const model =
    (models.models || []).find((m) => !m.is_hidden && m.access_level === "basic") ||
    (models.models || []).find((m) => !m.is_hidden && m.access_level === "") ||
    (models.models || []).find((m) => !m.is_hidden) ||
    (models.models || [])[0];
  const image = (images.images || []).find((i) => i.name.includes("devbox")) || (images.images || [])[0];
  if (!model || !image) throw new Error("No model/image available for this account");

  const task = await api("POST", "/users/tasks", {
    cookie,
    body: {
      content,
      cli_name: "opencode",
      model_id: model.id,
      image_id: image.id,
      host_id: "public_host", // free shared host (not a UUID!)
      repo: { branch: "" },
      resource: { core: 2, memory: 8 * 1024 * 1024 * 1024, life: 7200 },
      task_type: "develop",
    },
  });
  return { id: task.id, model: model.model };
}

/* ---------------- terminal connection (shared) ---------------- */

let ws, pingInterval, attempt = 0, gotConnected = false, lastRx = 0, healthTimer = null, currentTaskId = null;
let downSince = null, bannerTimer = null;

const enc = (s) => Buffer.from(s, "utf8").toString("base64");
const dec = (b) => Buffer.from(b, "base64").toString("utf8");

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const rows = process.stdout.rows || 24, cols = process.stdout.columns || 80;
    send({ type: "resize", data: JSON.stringify({ row: rows, col: cols }) });
  }
}

const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`);

// Live downtime banner: redraws in place every second until the socket is back.
function startDownBanner() {
  if (downSince === null) downSince = Date.now();
  clearInterval(bannerTimer);
  const label = gotConnected ? "Reconnecting" : "Connecting";
  const render = () => {
    const s = Math.floor((Date.now() - downSince) / 1000);
    process.stdout.write(`\r\x1b[K\x1b[33m── ${label}… down ${fmtSecs(s)} (attempt ${attempt}) ──\x1b[0m`);
  };
  render();
  bannerTimer = setInterval(render, 1000);
}

// Clears the banner. back=true prints the "back online" summary line.
function stopDownBanner(back) {
  clearInterval(bannerTimer);
  bannerTimer = null;
  if (downSince !== null) {
    const s = Math.floor((Date.now() - downSince) / 1000);
    downSince = null;
    if (back) process.stdout.write(`\r\x1b[K\x1b[32m── Back online — was down ${fmtSecs(s)} ──\x1b[0m\r\n`);
    else process.stdout.write(`\r\x1b[K`);
  }
}

async function connectTerminal(cookie, vmId, terminalId) {
  const url = `${WS_BASE}/${vmId}/terminals/connect?terminal_id=${encodeURIComponent(terminalId)}`;
  ws = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : {} });
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    attempt = 0;
    lastRx = Date.now();
    stopDownBanner(true);
    sendResize();
    clearInterval(pingInterval);
    pingInterval = setInterval(() => send({ type: "ping" }), 5000);
    // Health watchdog: server going silent while the socket LOOKS open
    // (half-open TCP after wifi drop / sleep) would hang forever — detect
    // no inbound traffic for 25s, force-close, and let onclose reconnect.
    clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastRx > 25000) {
        process.stdout.write(`\r\n\x1b[33m── Connection looks dead (no data 25s) — forcing reconnect ──\x1b[0m\r\n`);
        try { ws.terminate(); } catch {}
      }
    }, 5000);
  };
  ws.onmessage = (ev) => {
    lastRx = Date.now();
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { process.stdout.write(String(ev.data)); return; }
    switch (msg.type) {
      case "data":
        gotConnected = true; // shell output flowing = healthy session
        try { process.stdout.write(dec(msg.data)); } catch { process.stdout.write(String(msg.data)); }
        break;
      case "connected":
        gotConnected = true;
        try {
          const info = JSON.parse(msg.data);
          if (info.username) process.stdout.write(`\r\n\x1b[36mConnected as ${info.username}\x1b[0m\r\n`);
        } catch {}
        break;
      case "error":
        process.stdout.write(`\r\n\x1b[31mServer: ${msg.data}\x1b[0m\r\n`);
        break;
    }
  };
  ws.onclose = (ev) => {
    clearInterval(pingInterval);
    clearInterval(healthTimer);
    const clean = ev.code === 1000;
    const task = currentTaskId;
    if (clean) {
      stopDownBanner(false);
      process.stdout.write(`\r\n\x1b[90m── Session closed ──\x1b[0m\r\n`);
      cleanup();
      setImmediate(() => process.exit(0)); // setImmediate: exit AFTER ws teardown (UV win/async fix)
      return;
    }
    // First connect never succeeded + explicit reject = task/VM is really gone.
    // Transient codes (1006 etc.) still fall through to retry — a network drop
    // or a VM mid-hibernate looks identical to a dead task at this layer.
    const deadTask = ev.code === 4404 || /not.?found|no such|dead|destroyed/i.test(ev.reason || "");
    if (!gotConnected && deadTask) {
      stopDownBanner(false);
      process.stdout.write(`\r\n\x1b[31mConnection failed (${ev.code}${ev.reason ? ": " + ev.reason : ""}) — task VM may be dead. Try: mc new \"<prompt>\"\x1b[0m\r\n`);
      cleanup();
      setImmediate(() => process.exit(1));
      return;
    }
    // Cap the attempt counter so retries never stop and delays stay bounded.
    // attempt 0-3 → 1/2/4/8s, then 15s forever.
    const delay = [1000, 2000, 4000, 8000][Math.min(attempt, 3)] || 15000;
    if (attempt >= 4) attempt = 4;
    else attempt++;
    startDownBanner();
    setTimeout(async () => {
      try {
        // If the VM dropped into hibernation/sleep while we were offline,
        // the terminal WS will never answer — wake it first (token-free),
        // then reconnect. isTaskHibernated is cheap; only check after a
        // few failed tries so a quick blip doesn't add an API round-trip.
        if (attempt >= 2 && task && cookie) {
          try {
            if (await isHibernated(cookie, task)) {
              process.stdout.write(`\x1b[33mVM hibernated while offline — waking…\x1b[0m\r\n`);
              await wakeTask(cookie, task);
            }
          } catch {}
        }
        await connectTerminal(cookie, vmId, terminalId);
      } catch {}
    }, delay);
  };
  ws.onerror = (e) => { if (!gotConnected) process.stdout.write(`\r\n\x1b[31mWebSocket error — retrying…\x1b[0m\r\n`); };
}

// Backstop for the pathological case: WS neither opens NOR closes (network
// black hole). Poll task status over HTTP; the moment the VM reports online
// (or 20s pass, whichever first), force the pending socket closed so
// onclose's retry loop takes over.
function startConnectWatchdog(cookie, taskId) {
  const t0 = Date.now();
  const iv = setInterval(async () => {
    if (ws && ws.readyState !== WebSocket.CONNECTING) { clearInterval(iv); return; }
    let online = false;
    try {
      online = !(await isHibernated(cookie, taskId)); // false only when confirmed hibernated
      if (Date.now() - t0 > 20000) online = true; // give up waiting, let WS retry loop run
    } catch { online = Date.now() - t0 > 20000; }
    if (online && ws && ws.readyState === WebSocket.CONNECTING) {
      clearInterval(iv);
      try { ws.terminate(); } catch {}
    }
  }, 4000);
}

function cleanup() {
  clearInterval(pingInterval);
  clearInterval(healthTimer);
  clearInterval(bannerTimer);
  try { ws && ws.close(); } catch {}
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try { process.stdin.pause(); } catch {}
}

function attachStdin() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) send({ type: "data", data: enc(data.toString("utf8")) });
    });
    process.stdout.on("resize", () => sendResize());
  } else {
    process.stdout.write("\x1b[33mNon-interactive mode — run from a real terminal for full shell.\x1b[0m\r\n");
  }
  process.on("SIGINT", () => send({ type: "data", data: enc("\u0003") }));
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
}

/* ---------------- commands ---------------- */

const TERMINAL_STATES = new Set(["finished", "failed", "stopped", "completed"]);

async function cmdConnectTask(account, taskId) {
  const t = (account.tasks || {})[taskId];
  if (!t) throw new Error(`No saved task ${taskId}. Run: mc tasks`);
  currentTaskId = taskId; // used by the reconnect loop for wake-on-reconnect
  // Refuse terminal states up front — the platform archives their VMs and will
  // never resume them (wake times out, terminals endpoint 500s).
  try {
    const d = await api("GET", `/users/tasks/${taskId}`, { cookie: account.cookie });
    if (d?.status && TERMINAL_STATES.has(d.status)) {
      throw new Error(
        `Task ${taskId.slice(0, 8)} is ${d.status} — its VM is archived and can't be reconnected.\r\n` +
        `  Start a fresh one: mc new "<prompt>"`
      );
    }
  } catch (e) {
    if (/archived and can't be reconnected/.test(e.message)) throw e; // our refusal
    // status probe failed (network etc.) — fall through, legacy flow handles it
  }
  process.stdout.write(`\x1b[36mConnecting to task ${taskId.slice(0, 8)}…\x1b[0m\r\n`);

  // auto-wake if VM is hibernated — token-free control signal (no chat)
  const hib = await isHibernated(account.cookie, taskId);
  if (hib) {
    process.stdout.write(`\x1b[33mVM is hibernated — waking it (token-free resume signal)…\x1b[0m\r\n`);
    try {
      await wakeTask(account.cookie, taskId);
      process.stdout.write(`\x1b[32mVM is back online\x1b[0m\r\n`);
    } catch (e) {
      process.stdout.write(`\x1b[31mWake failed: ${e.message}\x1b[0m\r\n`);
    }
  }

  // hold the connection open with a token-free pulse so the idle timer
  // never reaches hibernation while the user is attached
  startKeepalive(account.cookie, [taskId]);

  let terminals;
  try {
    terminals = await getTaskTerminals(account.cookie, t.vm_id);
  } catch (e) {
    throw new Error(
      `${e.message} — task VM is unreachable.\r\n` +
      `  If it's stuck 'processing': mc stop ${taskId.slice(0, 8)} then mc new "<prompt>"`
    );
  }
  // Terminals are client-generated (randomUUID) — if none exist, create one
  // like the web UI does: just pick an ID and connect via WS
  const terminalId = terminals.length
    ? (terminals.find((x) => x.connected_count > 0)?.id || terminals[0].id)
    : require("crypto").randomUUID();
  account.tasks[taskId].terminal_id = terminalId;
  saveSession(loadSession()); // refresh active pointer
  await connectTerminal(account.cookie, t.vm_id, terminalId);
}

async function cmdNew(s, name, content) {
  const account = s.accounts[name];
  process.stdout.write(`\x1b[36mCreating task on ${name}…\x1b[0m\r\n`);
  const { id } = await createTask(account.cookie, content);
  account.tasks = account.tasks || {};
  account.tasks[id] = { title: content.slice(0, 60), vm_id: null, terminal_id: null, created: new Date().toISOString() };
  saveSession(s);
  process.stdout.write(`\x1b[36mTask ${id.slice(0, 8)} created — waiting for VM…\x1b[0m\r\n`);

  // poll task detail until virtualmachine appears
  let vmId = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const d = await api("GET", `/users/tasks/${id}`, { cookie: account.cookie });
      if (d?.virtualmachine?.id) {
        vmId = d.virtualmachine.id;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!vmId) throw new Error("Timed out waiting for VM — task may have failed");

  account.tasks[id].vm_id = vmId;
  saveSession(s);
  process.stdout.write(`\x1b[36mVM ready (${vmId.slice(0, 20)}…) — connecting terminal…\x1b[0m\r\n`);
  startConnectWatchdog(account.cookie, id); // network black-hole backstop during first connect
  await cmdConnectTask(account, id);
}

/* ---------------- wake (un-hibernate) a task ---------------- */

// Wakes a hibernated VM via the task control WebSocket with {"type":"resume"}.
// Token-free — no user-input message, so the agent does NOT process anything.
// (The web UI's "re-chat" wake costs credits; this control signal does not.)
function wakeTask(cookie, taskId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(
      `${API.replace("https", "wss")}/users/tasks/control?id=${encodeURIComponent(taskId)}`,
      { headers: cookie ? { Cookie: cookie } : {} }
    );
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error("Wake timed out")); }
    }, 20000);
    keepaliveTimers.has(taskId) && stopKeepalive(taskId); // avoid duplicate keepalive for same task
    ws.onopen = () => ws.send(JSON.stringify({ type: "resume" }));
    ws.onerror = () => { /* keep polling — signal already sent */ };
    ws.onclose = () => { /* control WS may close — keep polling */ };
    // poll VM until online
    (async () => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        try {
          const d = await api("GET", `/users/tasks/${taskId}`, { cookie });
          const vm = d?.virtualmachine;
          if (vm?.status === "online") {
            if (!settled) { settled = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(vm.id); }
            return;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!settled) { settled = true; clearTimeout(timer); try { ws.close(); } catch {} reject(new Error("Timed out waiting for VM to wake")); }
    })();
  });
}

/* ---------------- keepalive (prevent hibernation) ---------------- */

// A control-WS {"type":"resume"} to an ONLINE vm is verified harmless (no state
// change, no error) — so we reuse it as an "activity" pulse that resets the
// idle timer. Cheap: one short-lived WS every KEEPALIVE_INTERVAL ms.
const KEEPALIVE_INTERVAL = 3 * 60 * 1000; // every 3 min (hibernation kicks in ~4-5 min idle)
const keepaliveTimers = new Map(); // taskId -> interval

function pingResume(cookie, taskId) {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(
        `${API.replace("https", "wss")}/users/tasks/control?id=${encodeURIComponent(taskId)}`,
        { headers: cookie ? { Cookie: cookie } : {} }
      );
      const done = (v) => { try { ws.close(); } catch {}; resolve(v); };
      const t = setTimeout(() => done("timeout"), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "resume" }));
      ws.onmessage = () => { clearTimeout(t); done("ack"); };
      ws.onerror = () => { clearTimeout(t); done("error"); };
      ws.onclose = () => { clearTimeout(t); done("closed"); };
    } catch { resolve("error"); }
  });
}

// Keep one task (or all tasks of an account) awake until stopped.
function startKeepalive(cookie, taskIds, { log } = {}) {
  const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
  const timer = setInterval(async () => {
    for (const id of ids) {
      const r = await pingResume(cookie, id);
      if (log) process.stdout.write(`\x1b[90m[keepalive ${id.slice(0, 8)}] ${r}\x1b[0m\r\n`);
    }
  }, KEEPALIVE_INTERVAL);
  // fire one pulse immediately so the task is refreshed right away
  for (const id of ids) pingResume(cookie, id);
  return timer;
}

function stopKeepalive(taskId) {
  if (taskId) { const t = keepaliveTimers.get(taskId); if (t) { clearInterval(t); keepaliveTimers.delete(taskId); } }
  else { for (const t of keepaliveTimers.values()) clearInterval(t); keepaliveTimers.clear(); }
}

// standalone `mc keepalive [n|all]` — keeps tasks awake while this process runs
async function cmdKeepalive(s, name, all) {
  const targets = all ? Object.keys(s.accounts) : [name];
  for (const n of targets) {
    const acc = s.accounts[n];
    const ids = Object.keys(acc.tasks || {});
    if (!ids.length) { process.stdout.write(`${n}: no saved tasks\r\n`); continue; }
    keepaliveTimers.set(ids[ids.length - 1], startKeepalive(acc.cookie, ids, { log: true }));
    process.stdout.write(`\x1b[32m${n}: keepalive ON for ${ids.length} task(s) — Ctrl+C to stop\x1b[0m\r\n`);
  }
  if (!keepaliveTimers.size) { process.stdout.write("Nothing to keep alive\r\n"); return; }
  process.stdout.write(`\x1b[90mPulse every ${KEEPALIVE_INTERVAL / 60000} min · token-free resume signal\x1b[0m\r\n`);
  setInterval(() => {}, 1 << 30); // keep process alive
}

// Check if a task's VM is hibernated (needs wake)
async function isHibernated(cookie, taskId) {
  try {
    const d = await api("GET", `/users/tasks/${taskId}`, { cookie });
    const vm = d?.virtualmachine;
    if (!vm) return null; // no VM yet
    const hibernated = (vm.conditions || []).some((c) => c.type === "Hibernated" && c.status === 2);
    return vm.status === "hibernated" || hibernated;
  } catch { return null; }
}

async function cmdWake(s, name, taskId) {
  const account = s.accounts[name];
  process.stdout.write(`\x1b[36mWaking task ${taskId.slice(0, 8)} (${account.tasks?.[taskId]?.title || ""}) — token-free resume…\x1b[0m\r\n`);
  const vmId = await wakeTask(account.cookie, taskId);
  process.stdout.write(`\x1b[32mVM is back online (${vmId.slice(0, 20)}…)\x1b[0m\r\n`);
  return vmId;
}

async function cmdTasks(s, name) {
  const account = s.accounts[name];
  try {
    const data = await api("GET", "/users/tasks", { cookie: account.cookie });
    const tasks = data.tasks || [];
    process.stdout.write(`\x1b[36mTasks for ${name}:\x1b[0m\r\n`);
    for (const t of tasks) {
      process.stdout.write(`  ${t.id.slice(0, 8)}  ${(t.status || "?").padEnd(12)} ${(t.content || "").slice(0, 50)}\r\n`);
    }
  } catch (e) {
    process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
  }
}

async function cmdStop(s, name, taskId) {
  const acc = s.accounts[name];
  // accept ID prefixes — resolve against locally saved tasks
  const full = (Object.keys(acc.tasks || {}).find((k) => k.startsWith(taskId))) || taskId;
  try {
    await api("PUT", "/users/tasks/stop", { cookie: acc.cookie, body: { id: full } });
    process.stdout.write(`Stopped ${full.slice(0, 8)} (VM will be destroyed)\r\n`);
    stopKeepalive(full); // no more pulses at a dead task
    delete acc.tasks[full];
    if (acc.last_task === full) acc.last_task = null;
    saveSession(s);
    process.stdout.write(`Free slot ready — create a new task: mc new "<prompt>" ${name}\r\n`);
  } catch (e) {
    process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
  }
}

// Probe server status for a batch of task ids (parallel).
async function taskStatuses(cookie, ids) {
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const d = await api("GET", `/users/tasks/${id}`, { cookie });
      out[id] = d?.status || "?";
    } catch { out[id] = "?"; } // unknown → keep, never delete blindly
  }));
  return out;
}

async function cmdList(s) {
  const names = Object.keys(s.accounts || {});
  if (!names.length) {
    process.stdout.write("No accounts. Run: mc login 1\r\n");
    return;
  }
  // Probe live status for every saved task (parallel) so stale local entries
  // get marked instead of silently showing as connectable.
  const rows = await Promise.all(names.map(async (n) => {
    const a = s.accounts[n];
    const ids = Object.keys(a.tasks || {});
    return { n, a, ids, st: ids.length ? await taskStatuses(a.cookie, ids) : {} };
  }));
  process.stdout.write(`Accounts (${names.length}):\r\n`);
  for (const { n, a, ids, st } of rows) {
    const mark = n === s.active ? " *" : "";
    const saved = a.saved_at ? " · " + new Date(a.saved_at).toLocaleString(undefined, { month: "short", day: "numeric" }) : "";
    process.stdout.write(`  [${names.indexOf(n) + 1}] ${n}${mark}${saved}  (${ids.length} task${ids.length === 1 ? "" : "s"})\r\n`);
    for (const tid of ids) {
      const stt = st[tid];
      const tag = stt === undefined ? ""
        : TERMINAL_STATES.has(stt) ? `\x1b[90m[${stt} — prune]\x1b[0m`
        : (stt === "processing" || stt === "pending") ? `\x1b[32m[${stt}]\x1b[0m`
        : `\x1b[33m[${stt}]\x1b[0m`;
      process.stdout.write(`       ${tid.slice(0, 8)}  ${(a.tasks[tid].title || "").slice(0, 40)}  ${tag}\r\n`);
    }
    const def = a.last_task || ids[ids.length - 1];
    if (def && st[def] && TERMINAL_STATES.has(st[def])) {
      process.stdout.write(`       \x1b[33m⚠ default task ${def.slice(0, 8)} is ${st[def]} — fix: mc prune ${n}\x1b[0m\r\n`);
    }
  }
  process.stdout.write(`Use: mc <n> · mc login <n> · mc new "<prompt>" · mc tasks · mc prune\r\n`);
}

/* ---------------- main ---------------- */

async function main() {
  const args = process.argv.slice(2);
  let cmd = args[0], arg1 = args[1], arg2 = args[2];
  let s = loadSession();

  // account-first form: `mc <n> new hi`, `mc <n> tasks`, `mc <n> stop <id>`, `mc <n> connect <id>`, `mc <n> wake <id>`
  if (cmd && s.accounts[cmd] && (arg1 === "new" || arg1 === "tasks" || arg1 === "stop" || arg1 === "connect" || arg1 === "wake")) {
    s.active = cmd; saveSession(s);
    cmd = arg1; arg1 = arg2; arg2 = undefined;
  }

  switch (cmd) {
    case "list": await cmdList(s); return;
    case "prune": {
      // mc prune [n] — reconcile local session with server task state.
      // Keeps running tasks, removes finished/failed/stopped ones, repairs last_task.
      const targets = arg1 && s.accounts[arg1] ? [arg1] : Object.keys(s.accounts);
      if (!targets.length) { process.stdout.write("No accounts. Run: mc login 1\r\n"); return; }
      for (const n of targets) {
        const a = s.accounts[n];
        const ids = Object.keys(a.tasks || {});
        if (!ids.length) { process.stdout.write(`  ${n.padEnd(4)} no saved tasks\r\n`); continue; }
        const st = await taskStatuses(a.cookie, ids);
        const removed = [];
        for (const id of ids) {
          if (TERMINAL_STATES.has(st[id])) {
            delete a.tasks[id];
            if (a.last_task === id) a.last_task = null;
            removed.push(`${id.slice(0, 8)} [${st[id]}]`);
          }
        }
        // point last_task at a still-running task if the default died
        const remaining = Object.keys(a.tasks || {});
        if (!a.last_task && remaining.length) a.last_task = remaining[remaining.length - 1];
        saveSession(s);
        process.stdout.write(removed.length
          ? `  ${n.padEnd(4)} pruned: ${removed.join(", ")} — kept: ${remaining.map((x) => x.slice(0, 8)).join(", ") || "none"}\r\n`
          : `  ${n.padEnd(4)} clean (${remaining.length} task${remaining.length === 1 ? "" : "s"}, nothing to prune)\r\n`);
      }
      return;
    }
    case "use": {
      if (!s.accounts[arg1]) { process.stdout.write(`No account '${arg1}'. Run: mc login ${arg1}\r\n`); return; }
      s.active = arg1; saveSession(s);
      process.stdout.write(`Switched to ${arg1}\r\n`);
      return;
    }
    case "rm": {
      if (s.accounts[arg1]) { delete s.accounts[arg1]; if (s.active === arg1) s.active = null; saveSession(s); process.stdout.write(`Removed ${arg1}\r\n`); }
      else process.stdout.write(`No account '${arg1}'\r\n`);
      return;
    }
    case "tasks": {
      // optional: mc tasks <n>
      const target = arg1 && s.accounts[arg1] ? arg1 : (activeAccount(s) && (saveSession(s), s.active));
      if (!target) { process.stdout.write("No accounts. Run: mc login 1\r\n"); return; }
      return cmdTasks(s, target);
    }
    case "stop": {
      // mc stop <task_id> [n]
      const target = arg2 && s.accounts[arg2] ? arg2 : (activeAccount(s) && (saveSession(s), s.active));
      if (!target || !arg1) { process.stdout.write("Usage: mc stop <task_id> [account]\r\n"); return; }
      return cmdStop(s, target, arg1);
    }
    case "new": {
      // mc new "<prompt>" [n]
      const target = arg2 && s.accounts[arg2] ? arg2 : (activeAccount(s) && (saveSession(s), s.active));
      if (!target) { process.stdout.write("No accounts. Run: mc login 1\r\n"); return; }
      if (!arg1) { process.stdout.write('Usage: mc new "<prompt>" [account]\r\n'); return; }
      return cmdNew(s, target, arg1).catch((e) => { process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`); });
    }
    case "connect": {
      const a = activeAccount(s); saveSession(s);
      if (!a || !arg1) { process.stdout.write("Usage: mc connect <task_id>\r\n"); return; }
      attachStdin();
      return cmdConnectTask(a, arg1).catch((e) => { process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`); });
    }
    case "wake": {
      // mc wake <task_id>  (wakes active account's task, like re-chatting)
      const a = activeAccount(s); saveSession(s);
      if (!a || !arg1) { process.stdout.write("Usage: mc wake <task_id>\r\n"); return; }
      return cmdWake(s, s.active, arg1).catch((e) => { process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`); });
    }
    case "keepalive": {
      // mc keepalive        → keep ACTIVE account's tasks awake
      // mc keepalive <n>    → keep account n's tasks awake
      // mc keepalive all    → keep every account's tasks awake
      const target = arg1 && s.accounts[arg1] ? arg1 : (arg1 === "all" ? undefined : (activeAccount(s) && (saveSession(s), s.active)));
      if (arg1 === "all") return cmdKeepalive(s, null, true);
      if (!target) { process.stdout.write("Usage: mc keepalive [account|all]\r\n"); return; }
      return cmdKeepalive(s, target, false);
    }
    case "sync": {
      // mc sync [n|all] — push local cookie(s) into the worker KV so the
      // cron keepalive + wake endpoints cover them. `all` is the default.
      // Worker URL: set MC_WORKER_URL env var, or drop a gitignored mc_worker_url.txt
      const WORKER_URL = process.env.MC_WORKER_URL
        || (require("fs").existsSync(require("path").join(__dirname, "mc_worker_url.txt"))
          ? require("fs").readFileSync(require("path").join(__dirname, "mc_worker_url.txt"), "utf8").trim()
          : "");
      if (!WORKER_URL) { process.stdout.write("Worker URL not set (MC_WORKER_URL or mc_worker_url.txt)\r\n"); return; }
      const targets = (!arg1 || arg1 === "all") ? Object.keys(s.accounts) : (s.accounts[arg1] ? [arg1] : null);
      if (!targets) { process.stdout.write(`No account '${arg1}'\r\n`); return; }
      process.stdout.write(`Syncing ${targets.length} account(s) → worker KV…\r\n`);
      const results = await Promise.all(targets.map(async (n) => {
        try {
          const res = await fetch(`${WORKER_URL}/set/${encodeURIComponent(n)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookie: s.accounts[n].cookie }),
          });
          const j = await res.json().catch(() => ({}));
          return { n, ok: res.ok && j.ok };
        } catch { return { n, ok: false };
        }
      }));
      for (const r of results) {
        process.stdout.write(`  ${r.n.padEnd(4)} ${r.ok ? "\x1b[32m● synced\x1b[0m" : "\x1b[31m✗ failed\x1b[0m"}\r\n`);
      }
      const okCount = results.filter(r => r.ok).length;
      process.stdout.write(okCount === results.length
        ? `\x1b[32mAll ${okCount} account(s) synced — cron keepalive now covers them\x1b[0m\r\n`
        : `\x1b[33m${okCount}/${results.length} synced — retry failures with: mc sync <n>\x1b[0m\r\n`);
      return;
    }
    case "check": {
      // pass [n] to check only one account, or no arg for all
      const { execSync } = require("child_process");
      const target = arg1 && s.accounts[arg1] ? arg1 : undefined;
      try {
        const args = target ? target : "";
        const out = execSync(`node "${path.join(__dirname, "mc_check.cjs")}" ${args}`, { encoding: "utf8", timeout: 20000 });
        process.stdout.write(out);
      } catch (e) { process.stdout.write(e.stdout || e.message + "\r\n"); }
      return;
    }
    case "login": {
      // handled by mc_login.cjs; keep as hint
      process.stdout.write("Run: mc login <n> (opens browser)\r\n");
      return;
    }
    default: {
      // `mc` or `mc <account>` → connect that account's last task
      const a = activeAccount(s); saveSession(s);
      if (!a) {
        process.stdout.write(`MonkeyCode CLI — per-task terminals.\n\nCommands:\n  mc login <n>      sign in account n (opens browser)\n  mc list           show accounts + tasks\n  mc <n>            connect account n's last task\n  mc new \"<prompt>\"  create a task on active account and open its terminal\n  mc tasks          list active account's tasks\n  mc stop <id>      stop a task (destroys its VM)\n  mc prune [n]      remove finished/zombie tasks from local session\n  mc connect <id>   connect a saved task\n  mc keepalive [n|all]  keep tasks awake (no hibernation, token-free)\n  mc sync [n|all]     push cookies to worker KV (cron keepalive + wake coverage)\n`);
        return;
      }
      // `mc <name>` where <name> is an existing account → switch + connect IT
      let acc = a;
      if (cmd && s.accounts[cmd]) {
        s.active = cmd;
        acc = s.accounts[cmd];
        saveSession(s);
      }
      let ids = Object.keys(acc.tasks || {});
      // no saved tasks → fetch live tasks from API and pick the latest running one
      if (!ids.length) {
        try {
          process.stdout.write(`Fetching live tasks for account '${s.active}'…\r\n`);
          const data = await api("GET", "/users/tasks", { cookie: acc.cookie });
          const live = (data.tasks || []).filter(t => t.status === "pending" || t.status === "processing");
          const all = data.tasks || [];
          const pick = live[0] || all[0];
          if (pick) {
            // pull VM info from task detail so we have vm_id
            const detail = await api("GET", `/users/tasks/${pick.id}`, { cookie: acc.cookie });
            const vmId = detail?.virtualmachine?.id || null;
            acc.tasks = acc.tasks || {};
            acc.tasks[pick.id] = {
              title: (pick.content || "").slice(0, 60),
              vm_id: vmId,
              terminal_id: null,
              created: pick.created_at ? new Date(pick.created_at * 1000).toISOString() : new Date().toISOString(),
            };
            acc.last_task = pick.id;
            ids = Object.keys(acc.tasks);
            saveSession(s);
          }
        } catch (e) {
          process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
          return;
        }
      }
      if (!ids.length) {
        process.stdout.write(`Account '${s.active}' has no tasks. Create one: mc new \"<prompt>\"\r\n`);
        return;
      }
      attachStdin();
      const last = acc.last_task || ids[ids.length - 1];
      cmdConnectTask(acc, last).catch((e) => { process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`); });
    }
  }
}

process.stdout.write("\x1b[2J\x1b[H");
// A hard TCP reset on the WS can surface as an unhandled ECONNRESET and kill the
// whole CLI — treat it as a reconnect case instead (onclose handles the retry).
process.on("uncaughtException", (e) => {
  if (e && (e.code === "ECONNRESET" || e.code === "EPIPE")) {
    process.stdout.write(`\r\n\x1b[33m── Network reset (${e.code}) ──\x1b[0m\r\n`);
    try { ws && ws.terminate(); } catch {} // force onclose → retry loop
    return;
  }
  process.stdout.write(`\r\n\x1b[31mUnexpected error: ${e && e.stack ? e.stack.split("\n")[0] : e}\x1b[0m\r\n`);
  cleanup();
  setImmediate(() => process.exit(1));
});
main();