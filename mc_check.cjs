#!/usr/bin/env node
/**
 * mc_check.cjs — Check all stored MonkeyCode account cookies.
 *
 * Pings GET /api/v1/users/status for each account and reports:
 *   alive (plan, email) or dead (401 expired / other error)
 *
 * Usage:
 *   node mc_check.cjs           check all accounts
 *   node mc_check.cjs 2         check only account 2
 */

const fs = require("fs");
const path = require("path");

const SESSION_FILE = path.join(__dirname, "mc_session.json");
const API = "https://monkeycode-ai.net/api/v1";

function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); }
  catch { return { active: null, accounts: {} }; }
}

async function checkAccount(name, cookie) {
  const started = Date.now();
  try {
    const res = await fetch(`${API}/users/status`, {
      headers: { Cookie: cookie, Accept: "application/json", Origin: "https://monkeycode-ai.net" },
    });
    const latency = Date.now() - started;
    if (res.status === 401) {
      return { ok: false, status: 401, label: "EXPIRED", ms: latency };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, label: `HTTP ${res.status}`, ms: latency };
    }
    const j = await res.json();
    if (j.code !== 0) {
      return { ok: false, status: j.code, label: j.message || `code ${j.code}`, ms: latency };
    }
    const user = j.data?.user || {};
    const email = user.email || "?";
    const plan = "—"; // subscription endpoint needed
    // quick task count + real VM status of the latest task
    let tasks = "?", vm = null;
    try {
      const tr = await fetch(`${API}/users/tasks?page=1&size=5`, {
        headers: { Cookie: cookie, Accept: "application/json", Origin: "https://monkeycode-ai.net" },
      });
      const tj = await tr.json();
      if (tj.code === 0) {
        const all = tj.data?.tasks || [];
        const active = all.filter(t => t.status === "pending" || t.status === "processing").length;
        tasks = `${active} running / ${all.length} total`;
        // fetch detail of newest task for VM status
        const newest = all[0];
        if (newest) {
          const dr = await fetch(`${API}/users/tasks/${newest.id}`, {
            headers: { Cookie: cookie, Accept: "application/json", Origin: "https://monkeycode-ai.net" },
          });
          const dj = await dr.json();
          if (dj.code === 0 && dj.data?.virtualmachine) {
            const v = dj.data.virtualmachine;
            const hib = (v.conditions || []).some(c => c.type === "Hibernated" && c.status === 2);
            vm = v.status === "online" ? "alive" : (hib ? "hibernated" : (v.status || "offline"));
          }
        }
      }
    } catch {}
    return { ok: true, email, tasks, vm, ms: latency };
  } catch (e) {
    return { ok: false, status: 0, label: e.message, ms: Date.now() - started };
  }
}

async function main() {
  const s = loadSession();
  const target = process.argv[2];
  const names = target ? [target] : Object.keys(s.accounts || {});

  if (!names.length) {
    process.stdout.write("No accounts stored. Run: mc login 1\n");
    process.exit(0);
  }

  process.stdout.write(`Checking ${names.length} account${names.length > 1 ? "s" : ""}…\n\n`);
  const results = await Promise.all(names.map(async (n) => {
    const a = s.accounts[n];
    if (!a) return { name: n, result: { ok: false, label: "not found" } };
    return { name: n, result: await checkAccount(n, a.cookie) };
  }));

  for (const { name, result: r } of results) {
    const dot = r.ok ? "\x1b[32m●\x1b[0m" : "\x1b[31m✗\x1b[0m";
    if (r.ok) {
      const vmDot = r.vm === "alive" ? "\x1b[32m●\x1b[0m" : (r.vm === "hibernated" ? "\x1b[33m◐\x1b[0m" : "\x1b[90m○\x1b[0m");
      const vmTxt = r.vm ? `${vmDot} ${r.vm}` : "";
      process.stdout.write(`${dot}  ${name.padEnd(4)} alive  ${r.email}  VM: ${vmTxt}  tasks: ${r.tasks}  (${r.ms}ms)\n`);
    } else {
      process.stdout.write(`${dot}  ${name.padEnd(4)} DEAD   ${r.label}  (${r.ms}ms)\n`);
    }
  }
  process.stdout.write("\n");
}

main().catch(e => { console.error(e.message); process.exit(1); });