#!/usr/bin/env node
/**
 * mc_agent_msg.cjs — let an agent inside a VM (or you) talk to other VMs
 * through the Cloudflare worker message bus.
 *
 * Usage:
 *   node mc_agent_msg.cjs send <channel> "<message>" [from]
 *   node mc_agent_msg.cjs read <channel> [afterTs]
 *   node mc_agent_msg.cjs watch <channel> [pollSeconds]
 *
 * The worker is the public bridge: every VM has outbound internet,
 * so agents on isolated VMs can talk through it.
 */
// Set MC_BUS_URL to your deployed worker (see README: deploy mc_worker.js)
const WORKER = process.env.MC_BUS_URL || "https://YOUR-WORKER.workers.dev";

const [, , cmd, channel, msg, from] = process.argv;

async function main() {
  switch (cmd) {
    case "send": {
      if (!channel || !msg) { console.log("Usage: mc_agent_msg send <channel> <message> [from]"); process.exit(1); }
      const res = await fetch(`${WORKER}/mailbox/${channel}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from || "agent", msg }),
      });
      const j = await res.json();
      console.log(`✓ sent to ${channel}: ${msg} (${j.id})`);
      break;
    }
    case "read": {
      if (!channel) { console.log("Usage: mc_agent_msg read <channel>"); process.exit(1); }
      const res = await fetch(`${WORKER}/mailbox/${channel}`);
      const j = await res.json();
      for (const m of j.messages || []) {
        console.log(`[${new Date(m.ts).toLocaleTimeString()}] ${m.from}${m.to && m.to !== "*" ? ` → ${m.to}` : ""}: ${m.msg}`);
      }
      console.log(`(${j.count} messages in ${channel})`);
      break;
    }
    case "watch": {
      if (!channel) { console.log("Usage: mc_agent_msg watch <channel> [pollSeconds]"); process.exit(1); }
      const poll = Number(msg || 5);
      let after = 0;
      console.log(`Watching ${channel} every ${poll}s… (Ctrl+C to stop)`);
      const tick = async () => {
        const res = await fetch(`${WORKER}/mailbox/${channel}?after=${after}`);
        const j = await res.json();
        for (const m of j.messages || []) {
          if (m.ts > after) {
            console.log(`[${new Date(m.ts).toLocaleTimeString()}] ${m.from}: ${m.msg}`);
            after = m.ts;
          }
        }
        setTimeout(tick, poll * 1000);
      };
      tick();
      break;
    }
    default:
      console.log("mc_agent_msg — talk between agents/VMs via the worker bus");
      console.log("  send <channel> <msg> [from]   post a message");
      console.log("  read <channel>                show messages");
      console.log("  watch <channel> [secs]        poll for new messages");
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });