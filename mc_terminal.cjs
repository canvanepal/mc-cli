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

const WS_BASE = "wss://monkeycode-ai.net/api/v1/users/hosts/vms";
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
      throw new Error("Concurrency limit reached — you already have a running task. Stop it first: mc stop <task_id>");
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

let ws, pingInterval, attempt = 0, gotConnected = false;

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

async function connectTerminal(cookie, vmId, terminalId) {
  const url = `${WS_BASE}/${vmId}/terminals/connect?terminal_id=${encodeURIComponent(terminalId)}`;
  ws = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : {} });
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    attempt = 0;
    sendResize();
    clearInterval(pingInterval);
    pingInterval = setInterval(() => send({ type: "ping" }), 5000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { process.stdout.write(String(ev.data)); return; }
    switch (msg.type) {
      case "data":
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
    if (!gotConnected && ev.code !== 1000) {
      process.stdout.write(`\r\n\x1b[31mConnection failed (${ev.code}${ev.reason ? ": " + ev.reason : ""}) — task VM may be dead. Try: mc new \"<prompt>\"\x1b[0m\r\n`);
      cleanup();
      process.exit(1);
    }
    const delay = [1000, 2000, 4000, 8000][Math.min(attempt, 3)];
    attempt++;
    process.stdout.write(`\r\n\x1b[33m── Reconnecting (${Math.round(delay / 1000)}s) ──\x1b[0m\r\n`);
    setTimeout(() => connectTerminal(cookie, vmId, terminalId), delay);
  };
  ws.onerror = (e) => { if (!gotConnected) process.stdout.write(`\r\n\x1b[31mWebSocket error\x1b[0m\r\n`); };
}

function cleanup() {
  clearInterval(pingInterval);
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

async function cmdConnectTask(account, taskId) {
  const t = (account.tasks || {})[taskId];
  if (!t) throw new Error(`No saved task ${taskId}. Run: mc tasks`);
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
    throw new Error(`${e.message} — task VM is gone. Create a new one: mc new "<prompt>"`);
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
  try {
    await api("PUT", "/users/tasks/stop", { cookie: s.accounts[name].cookie, body: { id: taskId } });
    process.stdout.write(`Stopped ${taskId.slice(0, 8)} (VM will be destroyed)\r\n`);
  } catch (e) {
    process.stdout.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
  }
}

function cmdList(s) {
  const names = Object.keys(s.accounts || {});
  if (!names.length) {
    process.stdout.write("No accounts. Run: mc login 1\r\n");
    return;
  }
  process.stdout.write(`Accounts (${names.length}):\r\n`);
  names.forEach((n, i) => {
    const a = s.accounts[n];
    const tasks = Object.keys(a.tasks || {});
    const mark = n === s.active ? " *" : "";
    const saved = a.saved_at ? " · " + new Date(a.saved_at).toLocaleString(undefined, { month: "short", day: "numeric" }) : "";
    process.stdout.write(`  [${i + 1}] ${n}${mark}${saved}  (${tasks.length} task${tasks.length === 1 ? "" : "s"})\r\n`);
    for (const tid of tasks) {
      process.stdout.write(`       ${tid.slice(0, 8)}  ${(a.tasks[tid].title || "").slice(0, 50)}\r\n`);
    }
  });
  process.stdout.write(`Use: mc <n> · mc login <n> · mc new \"<prompt>\" · mc tasks\r\n`);
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
    case "list": return cmdList(s);
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
        process.stdout.write(`MonkeyCode CLI — per-task terminals.\n\nCommands:\n  mc login <n>      sign in account n (opens browser)\n  mc list           show accounts + tasks\n  mc <n>            connect account n's last task\n  mc new \"<prompt>\"  create a task on active account and open its terminal\n  mc tasks          list active account's tasks\n  mc stop <id>      stop a task (destroys its VM)\n  mc connect <id>   connect a saved task\n  mc keepalive [n|all]  keep tasks awake (no hibernation, token-free)\n`);
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
main();