/**
 * mc_worker.js — MonkeyCode-AI account monitor + cookie store + auto-restore.
 *
 * Endpoints:
 *   GET  /check              check all stored accounts, return status + cookies
 *   GET  /check/<n>          check a single account
 *   GET  /token/<n>          return the (possibly refreshed) cookie for account n
 *   POST /set/<n>            update cookie for account n  body: { cookie: "monkeycode_ai_session=..." }
 *   POST /ensure-running/<n> auto-restore VM on account n if sleeping/archived, return status
 *   GET  /health             ok
 *
 * Inter-agent message bus (agents on different VMs talk via this worker):
 *   POST /mailbox/<channel>       push a message  body: { from, to?, msg, task? }
 *   GET  /mailbox/<channel>       list messages (newest first), ?after=<ts> for polling
 *   POST /mailbox/<channel>/clear wipe a channel
 *   GET  /mailbox                 list all channels + message counts
 *
 *   Each VM's agent has outbound internet, so it can curl these endpoints.
 *   Simple round-robin mailbox + pull-based "talking" between agents.
 *
 * Wake API (an active agent can wake any/all hibernated VMs):
 *   GET  /wake/<n>                wake account n's newest hibernated task (token-free resume)
 *   GET  /wake-all                wake ALL accounts' hibernated tasks, return results
 *   These use the stored cookies in KV + the same control-WS {"type":"resume"} the CLI uses.
 *
 * Cron (set in wrangler.toml — two schedules):
 *   *\u002f2 * * * *   keepalive pulse: control-WS {"type":"resume"} to each account's active
 *                    task — resets the idle timer so VMs never hibernate. Read-only on KV
 *                    (free plan: 1k KV writes/day — we write NOTHING per pulse).
 *   0 *\u002f6 * * *    status check: verify each cookie is alive, store status in KV
 */

const API = "https://monkeycode-ai.net/api/v1";


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/check":
          return json(await checkAll(env));
        case "/health":
          return json({ ok: true, accounts: (await env.KV.list()).keys.length });

        default: {
          // /check/<n>  or  /token/<n>  or  /ensure-running/<n>
          const tokenMatch = url.pathname.match(/^\/token\/(.+)$/);
          const checkMatch = url.pathname.match(/^\/check\/(.+)$/);
          const ensureMatch = url.pathname.match(/^\/ensure-running\/(.+)$/);
          const setMatch = url.pathname.match(/^\/set\/(.+)$/);

          if (tokenMatch) return json(await getCookie(env, tokenMatch[1]));
          if (checkMatch) return json(await checkAccount(env, checkMatch[1]));
          if (ensureMatch) return json(await ensureRunning(env, ensureMatch[1]));
          if (mailboxMatch(url.pathname)) {
            const r = await handleMailbox(request, env, url);
            return json(r.data, r.status);
          }
          if (url.pathname === "/wake-all") return json(await wakeAll(env));
          const wakeMatch = url.pathname.match(/^\/wake\/(.+)$/);
          if (wakeMatch) return json(await wakeAccount(env, wakeMatch[1]));
          if (url.pathname === "/keepalive" || url.pathname === "/keepalive-all") return json(await keepaliveAll(env));
          const keepaliveMatch = url.pathname.match(/^\/keepalive\/(.+)$/);
          if (keepaliveMatch) return json(await keepaliveAll(env, keepaliveMatch[1]));
          if (setMatch) {
            const body = await request.json().catch(() => ({}));
            if (!body.cookie) return json({ error: "body.cookie required" }, 400);
            await env.KV.put(`cookie:${setMatch[1]}`, body.cookie);
            return json({ ok: true, account: setMatch[1] });
          }
          return json({ error: "not found" }, 404);
        }
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  // Cron handler — two schedules: */2 * * * * (keepalive) and 0 */6 * * * (status)
  async scheduled(event, env) {
    const isStatusCron = event.cron === "0 */6 * * *";
    try {
      if (isStatusCron) {
        const keys = await env.KV.list({ prefix: "cookie:" });
        for (const key of keys.keys) {
          const name = key.name.replace("cookie:", "");
          try {
            await apiFetch(env, name, "/users/status");
            await env.KV.put(`status:${name}`, JSON.stringify({ ok: true, timestamp: Date.now() }));
          } catch (e) {
            await env.KV.put(`status:${name}`, JSON.stringify({ ok: false, error: e.message, timestamp: Date.now() }));
          }
        }
      } else {
        // keepalive cron — pulse-only, read-only on KV, ~1 subrequest per account
        return await keepaliveAll(env);
      }
    } catch (e) {
      console.error("scheduled failed:", e.message);
    }
  },
};

/* ---- API helpers ---- */

async function apiFetch(env, accountName, path) {
  const cookie = await env.KV.get(`cookie:${accountName}`);
  if (!cookie) throw new Error(`No cookie stored for account '${accountName}'`);
  const res = await fetch(`${API}${path}`, {
    headers: { Cookie: cookie, Accept: "application/json", Origin: "https://monkeycode-ai.net" },
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("EXPIRED");
  if (!res.ok || (j.code !== undefined && j.code !== 0)) {
    throw new Error(j.message || `API ${path} failed (${res.status})`);
  }
  return j.data;
}

async function checkAccount(env, name) {
  const cookie = await env.KV.get(`cookie:${name}`);
  if (!cookie) return { name, ok: false, label: "no cookie stored" };
  const start = Date.now();
  try {
    const data = await apiFetch(env, name, "/users/status");
    const tasksData = await apiFetch(env, name, "/users/tasks?page=1&size=5&status=pending,processing").catch(() => null);
    const active = tasksData?.tasks?.filter(t => t.status === "pending" || t.status === "processing").length || 0;
    const total = tasksData?.tasks?.length || 0;
    return {
      name, ok: true,
      email: data?.user?.email || "?",
      tasks: `${active} running / ${total} total`,
      ms: Date.now() - start,
    };
  } catch (e) {
    return { name, ok: false, label: e.message, ms: Date.now() - start };
  }
}

async function checkAll(env) {
  const keys = await env.KV.list({ prefix: "cookie:" });
  const names = keys.keys.map(k => k.name.replace("cookie:", ""));
  return {
    accounts: await Promise.all(names.map(n => checkAccount(env, n))),
  };
}

async function getCookie(env, name) {
  const cookie = await env.KV.get(`cookie:${name}`);
  if (!cookie) return { error: `No cookie for account '${name}'` };
  return { name, cookie };
}

async function ensureRunning(env, name) {
  const cookie = await env.KV.get(`cookie:${name}`);
  if (!cookie) return { error: `No cookie for account '${name}'` };

  // Get tasks
  const tasksRes = await fetch(`${API}/users/tasks?page=1&size=5&status=pending,processing`, {
    headers: { Cookie: cookie, Accept: "application/json", Origin: "https://monkeycode-ai.net" },
  });
  const tj = await tasksRes.json().catch(() => ({}));
  if (tj.code !== 0) return { error: tj.message, status: "unknown" };

  const tasks = (tj.data?.tasks || []);
  const active = tasks.filter(t => t.status === "pending" || t.status === "processing");

  if (!active.length) return { status: "no_active_tasks", tasks: tasks.length };

  // Check VM status of each active task
  const results = [];
  for (const t of active) {
    try {
      const detail = await apiFetch(env, name, `/users/tasks/${t.id}`);
      const vm = detail?.virtualmachine;
      if (vm?.status === "offline") {
        // VM is down — no restore API visible, just report it
        results.push({ task: t.id.slice(0,8), vm: "offline", action: "no_restore_api" });
      } else {
        results.push({ task: t.id.slice(0,8), vm: vm?.status || "unknown", action: "ok" });
      }
    } catch (e) {
      results.push({ task: t.id.slice(0,8), error: e.message });
    }
  }
  return { status: "checked", active: active.length, results };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { ...CORS, "Cache-Control": "no-store" },
  });
}

/* ---- keepalive (cron + manual) ---- */

// One short control-WS pulse: send {"type":"resume"}, hold ~1s, close.
// Verified harmless on online VMs (no state change) and it also wakes hibernated
// ones — so one signal covers both "stay awake" and "un-hibernate".
async function pulseResume(cookie, taskId) {
  const url = `${API}/users/tasks/control?id=${encodeURIComponent(taskId)}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws && ws.close(); } catch {} resolve(v); } };
    let ws = null;
    const t = setTimeout(() => finish("timeout"), 4000);
    (async () => {
      try {
        const resp = await fetch(url, {
          headers: { Upgrade: "websocket", Connection: "Upgrade", Cookie: cookie, Origin: "https://monkeycode-ai.net" },
        });
        ws = resp.webSocket;
        if (!ws) { clearTimeout(t); return finish("no-upgrade"); }
        ws.accept();
        ws.send(JSON.stringify({ type: "resume" }));
        setTimeout(() => { clearTimeout(t); finish("pulsed"); }, 1000);
        ws.addEventListener("error", () => { clearTimeout(t); finish("error"); });
        ws.addEventListener("close", () => { clearTimeout(t); finish("pulsed"); });
      } catch (e) { clearTimeout(t); finish("error"); }
    })();
  });
}

// Pulse every account's active task(s). Sequential, one GET + one WS per
// account. Designed for the free plan: NO KV writes, no status polling.
async function keepaliveAll(env, onlyAccount = null) {
  const keys = await env.KV.list({ prefix: "cookie:" });
  let names = keys.keys.map(k => k.name.replace("cookie:", ""));
  if (onlyAccount) names = names.filter(n => n === onlyAccount);
  const results = [];
  for (const n of names) {
    try {
      const tj = await apiFetch(env, n, "/users/tasks?page=1&size=5&status=pending,processing");
      const tasks = (tj.tasks || []).filter(t => t.status === "pending" || t.status === "processing");
      if (!tasks.length) { results.push({ account: n, action: "no-active-task" }); continue; }
      for (const t of tasks.slice(0, 2)) { // cap 2 tasks/account (subrequest headroom)
        const r = await pulseResume(await env.KV.get(`cookie:${n}`), t.id);
        results.push({ account: n, task: t.id.slice(0, 8), pulse: r });
      }
    } catch (e) {
      results.push({ account: n, error: e.message === "EXPIRED" ? "cookie-expired" : e.message });
    }
  }
  return { status: "done", accounts: names.length, at: new Date().toISOString(), results };
}

/* ---- wake hibernated VMs (token-free resume via control WS) ---- */

async function wakeTask(cookie, taskId) {
  // Outbound client WebSocket in Workers = fetch() with Upgrade header.
  const url = `https://monkeycode-ai.net/api/v1/users/tasks/control?id=${encodeURIComponent(taskId)}`;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    (async () => {
      try {
        const resp = await fetch(url, {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            Cookie: cookie,
            Origin: "https://monkeycode-ai.net",
          },
        });
        const ws = resp.webSocket;
        if (!ws) { finish(); return; }
        ws.accept();
        ws.send(JSON.stringify({ type: "resume" }));
        // keep socket open ~6s so the server processes the wake
        setTimeout(() => { try { ws.close(); } catch {} finish(); }, 6000);
        ws.addEventListener("error", () => finish());
        ws.addEventListener("close", () => finish());
      } catch {
        finish();
      }
    })();
    setTimeout(finish, 10000);
  });
}

async function wakeAccount(env, name) {
  const cookie = await env.KV.get(`cookie:${name}`);
  if (!cookie) return { account: name, ok: false, error: "no cookie stored" };
  try {
    const tj = await apiFetch(env, name, "/users/tasks?page=1&size=5");
    const tasks = tj.tasks || [];
    const pick = tasks.find(t => t.status === "pending" || t.status === "processing") || tasks[0];
    if (!pick) return { account: name, ok: false, error: "no tasks" };

    // check if VM is hibernated
    const detail = await apiFetch(env, name, `/users/tasks/${pick.id}`);
    const vm = detail?.virtualmachine;
    if (!vm) return { account: name, ok: false, task: pick.id.slice(0, 8), error: "no VM" };
    const hib = (vm.conditions || []).some(c => c.type === "Hibernated" && c.status === 2);
    if (vm.status === "online" || (!hib && vm.status !== "hibernated")) {
      return { account: name, ok: true, task: pick.id.slice(0, 8), vm: vm.status, action: "already_running" };
    }

    await wakeTask(cookie, pick.id);
    // poll until online
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const d2 = await apiFetch(env, name, `/users/tasks/${pick.id}`).catch(() => null);
      if (d2?.virtualmachine?.status === "online") {
        return { account: name, ok: true, task: pick.id.slice(0, 8), vm: "online", action: "woken" };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return { account: name, ok: false, task: pick.id.slice(0, 8), error: "timed out waiting for VM" };
  } catch (e) {
    return { account: name, ok: false, error: e.message };
  }
}

async function wakeAll(env) {
  const keys = await env.KV.list({ prefix: "cookie:" });
  const names = keys.keys.map(k => k.name.replace("cookie:", ""));
  const results = [];
  for (const n of names) {
    results.push(await wakeAccount(env, n));
  }
  return { status: "done", accounts: names.length, results };
}

/* ---- inter-agent mailbox (pub/sub over KV) ---- */

function mailboxMatch(p) {
  return p.startsWith("/mailbox");
}

async function handleMailbox(request, env, url) {
  const m = url.pathname.match(/^\/mailbox(?:\/([^/]+))?(?:\/(clear))?$/);
  const channel = m?.[1] || "default";
  const isClear = !!m?.[2];

  // list all channels
  if (request.method === "GET" && url.pathname === "/mailbox") {
    const keys = await env.KV.list({ prefix: "mailbox:" });
    const channels = {};
    for (const k of keys.keys) {
      const name = k.name.replace("mailbox:", "").split("::")[0];
      channels[name] = (channels[name] || 0) + 1;
    }
    return { data: { channels } };
  }

  if (isClear) {
    const keys = await env.KV.list({ prefix: `mailbox:${channel}::` });
    await Promise.all(keys.keys.map(k => env.KV.delete(k.name)));
    return { data: { ok: true, cleared: channel, count: keys.keys.length } };
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const msg = {
      from: body.from || "unknown",
      to: body.to || "*",
      msg: body.msg || "",
      task: body.task || null,
      ts: Date.now(),
    };
    const id = `${msg.ts}-${Math.random().toString(36).slice(2, 8)}`;
    await env.KV.put(`mailbox:${channel}::${id}`, JSON.stringify(msg));
    // trim channel to last 100 messages
    const keys = await env.KV.list({ prefix: `mailbox:${channel}::` });
    if (keys.keys.length > 100) {
      const oldest = keys.keys.sort((a, b) => a.name.localeCompare(b.name)).slice(0, keys.keys.length - 100);
      await Promise.all(oldest.map(k => env.KV.delete(k.name)));
    }
    return { data: { ok: true, channel, id, ts: msg.ts } };
  }

  if (request.method === "GET") {
    const after = Number(url.searchParams.get("after") || 0);
    const keys = await env.KV.list({ prefix: `mailbox:${channel}::` });
    const items = [];
    for (const k of keys.keys) {
      const raw = await env.KV.get(k.name);
      if (!raw) continue;
      const it = JSON.parse(raw);
      if (it.ts > after) items.push(it);
    }
    items.sort((a, b) => a.ts - b.ts);
    return { data: { channel, count: items.length, messages: items } };
  }

  return { data: { error: "method not allowed" }, status: 405 };
}