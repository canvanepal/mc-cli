# Agent Setup Guide — install `mc` on a fresh Windows PC, automatically

> Read this if you are an AI agent tasked with setting up `mc` on a new
> Windows machine. Follow every step; do not skip verification.

## Goal

Install Node.js, clone this repo, verify the CLI, and leave the user at
`mc login 1` with everything working. **No npm packages, no Playwright,
no browser automation** — login is paste-cookie only.

## Step 1 — Check what's already installed

```powershell
node -v          # need v22+ (v18-21 may lack stable WebSocket)
git --version
```

If `node` is missing, install Node LTS silently:

```powershell
winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
```

> After installing Node, **restart the shell** so PATH picks it up (or use
> `$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')`).

If `git` is missing:

```powershell
winget install Git.Git --silent --accept-package-agreements --accept-source-agreements
```

## Step 2 — Clone the repo

```powershell
cd $HOME
git clone <REPO_URL>
cd <REPO_DIR>
```

## Step 3 — Verify scripts (no dependencies to install)

```powershell
node --check mc_terminal.cjs
node --check mc_login.cjs
node --check mc_check.cjs
```

All must exit 0. If any fails, stop — the files are corrupt or the wrong Node.

## Step 4 — Smoke test (no login needed)

```powershell
mc list
```
Expected: shows an empty/active-account listing — proves Node can run the CLI.

> If `mc` is not on PATH, use `.\mc.cmd list` or `node mc_terminal.cjs list`.

## Step 5 — Hand off to the user

Login is **paste-cookie** (no browser automation). Tell them, in order:

```
1.  mc login 1
    → it prints a Google sign-in URL
    → open it in YOUR browser, sign in
    → DevTools → Network → reload → click any api request
    → copy the 'Cookie' request header → paste it back in the terminal
2.  mc login 2        ...repeat for every account they want
3.  mc check          (all should say alive)
4.  mc                (connect terminal)
```

## What NOT to do

- ❌ Do NOT commit or push `mc_session.json` (contains live cookies — gitignored).
- ❌ Do NOT print cookies/tokens in logs or chat.
- ❌ Do NOT log into the MonkeyCode website to "test" — website login rotates
     sessions and can kill CLI cookies.
- ❌ Do NOT install Playwright or any npm packages — the CLI has zero deps.
- ❌ Do NOT change the scripts' portability: `mc.cmd` uses `%~dp0` so it works
     from any folder.

## Troubleshooting quick table

| Symptom | Fix |
|---|---|
| `'node' is not recognized` | Node not on PATH — reopen terminal / restart PC |
| `✗ DEAD EXPIRED` | `mc login <n>` for that account |
| `✗ Couldn't find monkeycode_ai_session` | Copy the full Cookie header (or the UUID after `=`), not something else |
| WebSocket is not defined | Node < 22 — install LTS |
| `mc` not recognized | Use `.\mc.cmd` or add the folder to PATH |

## Done

When `mc check` shows all accounts alive, setup is complete. The user can now
run `mc`, `mc 2 new "..."`, `mc wake`, etc. — no website needed.