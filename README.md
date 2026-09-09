# mc — MonkeyCode CLI (multi-account terminal)

Control MonkeyCode-AI task VMs entirely from the command line: create tasks,
connect to the VM terminal over WebSocket, wake hibernated VMs without spending
credits, run multiple accounts in parallel, and let agents on different VMs
talk to each other through a Cloudflare Worker message bus.

```
mc                    → connect to active account's last task terminal
mc 2                  → switch to account 2 + connect
mc 3 new "build api"  → create a task on account 3
mc wake <task_id>     → wake a hibernated VM (token-free)
mc check              → cookie + VM status for all accounts
mc list               → all accounts + saved tasks
```

> ⚠️ This repo is a clean public copy — **no cookies, no tokens, no personal
> paths**. Your `mc_session.json` (which holds live session cookies) is
> gitignored and created locally by `mc login`.

---

## Requirements

| Tool | Why | Install |
|---|---|---|
| Node.js **22+** | CLI uses built-in `fetch` + `WebSocket` (zero npm deps for the core) | [nodejs.org](https://nodejs.org) LTS |
| Playwright (global) | Only needed for `mc login` managed-browser capture | `npm install -g playwright && npx playwright install chromium` |

---

## Setup on a new Windows PC

### Option A — one click (recommended)

```cmd
git clone <this-repo-url>
cd mc
setup.cmd
```

Installs Node (via winget if missing), Playwright, and syntax-checks everything.

### Option B — manual

```cmd
:: 1. Install Node 22+ from nodejs.org
:: 2. Install Playwright
npm install -g playwright
npx playwright install chromium

:: 3. Make mc available anywhere (optional)
setx PATH "%PATH%;%CD%"
```

### Then — sign in your accounts

```cmd
mc login 1     :: [Enter] opens browser → sign in with Google → auto-captured
mc login 2     :: repeat for each account
mc check       :: all alive?
```

You can also paste a cookie manually (option P) if you prefer your own browser.

---

## Commands

| Command | What it does |
|---|---|
| `mc` | Connect to the active account's most recent task terminal |
| `mc <n>` | Switch to account `n` + connect |
| `mc new "<prompt>"` | Create a new task (starts a fresh VM) |
| `mc <n> new "<prompt>"` | Create a task on account `n` |
| `mc tasks [n]` | List tasks (optionally per account) |
| `mc connect <task_id>` | Connect a specific task's terminal |
| `mc stop <task_id>` | Stop/kill a task (destroys its VM) |
| `mc wake [task_id]` | Wake a hibernated VM — **token-free** (control-WS `{"type":"resume"}`) |
| `mc check` | Cookie alive/dead + VM status (● alive / ◐ hibernated / ○ offline) |
| `mc list` | All accounts + saved tasks |
| `mc login <n>` | Sign in account `n` (managed browser or paste cookie) |
| `mc <n> wake` | Wake account n's latest task |

### Account-first forms

`mc 3 new hi`, `mc 3 tasks`, `mc 3 stop <id>`, `mc 3 connect <id>`, `mc 3 wake` — all work.

---

## How it works (protocol notes)

- **Auth:** session cookie `monkeycode_ai_session` (30-day `Max-Age`), set once at
  OAuth login. No API endpoint refreshes it — the CLI is the only way to keep it alive
  without touching the website (website login/logout rotates/revokes other sessions).
- **Terminals are client-generated:** no pre-created terminal exists. The CLI generates
  a UUID and connects — same as the web UI.
- **Wake:** tasks don't die, they *hibernate*. The task control WebSocket
  (`wss://.../tasks/control?id=<task_id>`) accepts `{"type":"resume"}` which wakes the
  VM with **zero tokens consumed** (no agent processing).
- **Isolation:** each VM is network-isolated from other VMs (no internal IP routing).
  Outbound internet works, so inter-VM communication goes through the public worker bus.

### Concurrency limits (server-enforced)

- 1 concurrent task per account → use multiple accounts for parallel tasks
- Accounts are independent: `mc 2` and `mc 3` can both run tasks simultaneously

### Cookie lifecycle

| Action | Effect |
|---|---|
| 30 days pass | Cookie expires naturally |
| Logout on website | That session dies immediately |
| Login to another account on website | May rotate/kill other accounts' sessions |
| `mc login n` | May also rotate others — prefer re-login only when needed |

**Best practice:** pick accounts you keep CLI-only; don't log into them on the website.

---

## Inter-agent messaging + wake (optional, advanced)

Agents inside VMs can talk to each other and wake peers through a deployed
Cloudflare Worker (`mc_worker.js`). See:

- **[`mc_agent_bus_SKILL.md`](mc_agent_bus_SKILL.md)** — drop-in skill file that
  teaches any agent the protocol (mailbox endpoints, polling, wake API, naming).
- **[`mc_agent_msg.cjs`](mc_agent_msg.cjs)** — helper: `node mc_agent_msg.cjs send <channel> "<msg>" [from]`

To deploy your own bus worker:

```cmd
npm install -g wrangler
wrangler kv namespace create MC_KV          :: paste id into wrangler.toml
wrangler deploy
:: seed cookies so agents can wake VMs:
curl -X POST <worker>/set/1 -d "{\"cookie\":\"monkeycode_ai_session=...\"}"
```

Then set the worker URL for the helper:
```
set MC_BUS_URL=https://your-worker.workers.dev
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `✗ DEAD EXPIRED` in mc check | `mc login <n>` for that account |
| "Concurrency limit reached" on new | `mc stop <old_task_id>` first (1 task/account) |
| "no saved tasks" | Create one: `mc new "<prompt>"` (or `mc <n> new "..."`) |
| VM ◐ hibernated | `mc <n>` auto-wakes (token-free) or `mc wake` |
| Terminal 503 / VM offline | Wake first: `mc wake <task_id>`, then connect |
| Playwright not found | `npm install -g playwright && npx playwright install chromium` |
| Cookie died after website login | Server rotated sessions — re-login via `mc login <n>` |

---

## Repo structure

```
mc/
├── mc.cmd                  # Windows launcher (portable %~dp0)
├── setup.cmd               # one-click setup
├── mc_terminal.cjs         # main CLI (terminal, tasks, wake)
├── mc_login.cjs            # OAuth login (managed browser or paste)
├── mc_check.cjs            # cookie + VM health checker
├── mc_agent_msg.cjs        # agent-to-agent message helper
├── mc_agent_bus_SKILL.md   # agent skill: inter-VM protocol
├── mc_worker.js            # optional Cloudflare Worker (bus + wake)
├── wrangler.toml           # worker config template
└── .gitignore              # excludes mc_session.json, node_modules, etc.
```

---

*Reverse-engineered from public web traffic — use at your own risk, respect the
platform's terms of service.*