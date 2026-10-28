# AGENTS.md

Instructions for AI coding assistants (and people) installing, deploying or changing WA Box.
Read this whole file before acting.

WA Box schedules messages to existing WhatsApp groups for a team. It sends through a linked
WhatsApp account, so mistakes reach real people. **Safety beats convenience in every decision.**

---

## Ground rules

1. **Never send a real WhatsApp message while setting up or testing.** Local copies start in practice mode; keep it on. Only the user turns it off ("Go live").
2. **Never type, invent or print the user's real passwords, API keys or WhatsApp details** into files, commits or chat. Generate secrets with the setup scripts or `openssl rand -hex 32`; secrets live in `.env` (git-ignored) or the hosting platform's secret settings.
3. **Never scan the WhatsApp QR code or link a device yourself.** The user does that on their phone.
4. **Never commit** `.env`, anything under `data/`, database files (`*.db`), or WhatsApp session folders.
5. **Don't weaken a safety rule** (gaps, limits, duplicate guard, chat check, late cut-off, practice mode default, engine privacy) unless the user explicitly asks, and say what the risk is when you do.
6. Ask the user before anything that can't be undone: deleting volumes (`down -v`, `make reset`), deleting data, force-pushing.

---

## Install on the user's computer

Prerequisites: Docker Desktop (Mac/Windows) or Docker Engine + Compose v2 (Linux), and git.

1. Check Docker: `docker info` must succeed. If not, tell the user how to install or start it:
   - Mac / Windows: install Docker Desktop from https://docs.docker.com/get-docker/ and open it.
   - Linux: install Docker Engine and the compose plugin for their distribution, then `sudo systemctl start docker`.
   - Windows: use PowerShell. WSL 2 must be enabled (Docker Desktop offers to do it).
2. Clone the repo and `cd` into it.
3. Run the setup script. Pass the user's choices as environment variables:
   - Mac / Linux: `ADMIN_USER="their@email" ORG_NAME="Their org" GROUP_KEYWORDS="Cohort,Batch" sh scripts/setup.sh`
   - Windows: `$env:ADMIN_USER="their@email"; $env:ORG_NAME="Their org"; $env:GROUP_KEYWORDS="Cohort,Batch"; powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`
   - Port 3000 busy? Add `PORT=3005` (Mac/Linux) or `$env:PORT="3005"` (Windows).
4. The first build takes 3–10 minutes (it downloads Chrome and runs the test suite). The script waits and prints the address, username and a one-time password. Give these to the user.
5. Walk the user through, in the browser:
   1. Sign in, choose a new password.
   2. **WhatsApp & groups → Show QR code**, then on the phone: WhatsApp → Settings → Linked devices → Link a device → scan.
   3. Set **Group keywords** (strongly recommended if they're in many groups), then **Sync from WhatsApp**.
   4. Write a message, press **Send a test to my WhatsApp** (goes to their own "Message yourself" chat), and schedule one in practice mode to see how it works.
6. Tell them: it only runs while the computer is on and awake; for dependable weekend sends, deploy to a server.

Useful: `make help`, `make logs`, `make status`, `make password`, `make down`.
Without `make`: `docker compose -f docker-compose.local.yml <up -d --build | logs -f | down>`.

### If something fails

| Symptom | Fix |
|---|---|
| `Cannot connect to the Docker daemon` | Docker isn't running. Open Docker Desktop / start the service. |
| Port already in use | Set `PORT=3005` in `.env`, run setup again, use `http://localhost:3005`. |
| Build fails in `npm test` | A safety test failed. Don't skip tests. Read the failing test name and fix the cause. |
| Engine keeps restarting on Apple Silicon / ARM | It uses Debian's Chromium there; give Docker at least 4 GB of memory. |
| No one-time password printed | `ADMIN_PASSWORD` was set in `.env`, or the database already had an admin. `make password` shows it if it was generated. |
| QR never appears | `docker compose -f docker-compose.local.yml logs engine`. Usually Docker memory, or WhatsApp Web was slow; wait a minute and press Show QR code again. |

---

## Deploy

The production file is `docker-compose.yml`: two services.

- `wabox`: the app (port 3000). The only service that gets a domain / reverse proxy.
- `engine`: WhatsApp in headless Chrome. **No domain, no published ports.** Reached only by `wabox` on the private network with `WA_ENGINE_KEY`.

### Coolify

1. New resource → Git repository → build pack **Docker Compose** → `/docker-compose.yml`.
2. Domain on `wabox` only, e.g. `https://example.com/wabox` (`BASE_PATH=/wabox`) or `https://wabox.example.com` (set `BASE_PATH=/`).
3. Set `ADMIN_USER`, `ORG_NAME`, `GROUP_KEYWORDS` in `docker-compose.yml`. Coolify generates `SERVICE_PASSWORD_64_ENGINEKEY` and `SERVICE_PASSWORD_ADMIN` itself.
4. Deploy. The user finds the first admin password in Coolify (Environment Variables → `SERVICE_PASSWORD_ADMIN`) and changes it on first sign-in.
5. Check `https://<domain>/<base>/healthz` returns `{"ok":true}`.
6. Recommend an uptime monitor on `/health/monitor` (503 means someone should look).

### Plain Docker host

Set `SERVICE_PASSWORD_64_ENGINEKEY` (random, 64 chars) and `SERVICE_PASSWORD_ADMIN` in the environment,
`docker compose up -d --build`, and put an HTTPS reverse proxy (Caddy, Traefik, nginx) in front of `wabox:3000`.
The session cookie is `Secure`, so the app must be served over HTTPS (except `localhost` with `COOKIE_INSECURE=true`).

---

## Code map

```
app/                       WA Box app (Node 22, Express 5, better-sqlite3, vanilla JS front end)
  src/server.js            HTTP: web app, session API (/api/*), mounts the public API
  src/jobs.js              Validation + createJob(): the ONE way a message gets scheduled (app and API)
  src/scheduler.js         The send loop: lease lock, pacing, limits, duplicate guard, chat check, repeats, digest
  src/wa.js                Client for the engine. Defines definitelyNotSent() (the 4xx contract)
  src/api_v1.js            Public API /api/v1
  src/apikeys.js           API keys (hashed) + idempotency
  src/hooks.js             Outgoing webhooks: queue, signing, retries
  src/alerts.js            Alerts, check-in, done notes
  src/groups.js            Saved groups, keywords, group lists
  src/auth.js              Users, sessions, passwords
  src/render.js            {group} {day} {date} (same as public/lib.js)
  src/time.js              India-time helpers
  public/                  index.html, app.js, lib.js (shared with tests), style.css, openapi.yaml
  test/                    scheduler.test.js (fake engine), api.test.js, delights.test.js
engine/                    WhatsApp engine (whatsapp-web.js + Chrome)
  src/engine.js            Session lifecycle, watchdog, version pin, receipts
  src/server.js            Private HTTP API (X-API-Key)
  test/engine.test.js      Fake WhatsApp client
docs/                      API.md, USER-GUIDE.md, screenshots, logo
scripts/                   setup.sh, setup.ps1
docker-compose.yml         Production (Coolify)
docker-compose.local.yml   Local copy (localhost only, always practice mode)
```

## Rules for changing code

- **Run the tests** before saying something works: `cd app && npm test` and `cd engine && npm test` (Node 22). They also run in the Docker build; a failing test blocks the deploy, on purpose.
- **Add a test** for every behaviour you add or fix, in the style of `app/test/scheduler.test.js`: act out the real-world failure, assert nothing was sent twice and nothing failed silently.
- **Keep the send contract**: engine `4xx` = definitely not sent; anything else = maybe sent → the app must check the chat (`resolveUncertain`) and never retry blindly.
- **Every new way to schedule must call `createJob()`** in `app/src/jobs.js`, so limits and validation can't drift.
- **Write-ahead**: a send is recorded as `sending` before the request leaves; keep it that way.
- **No silent failure**: anything that doesn't go out must end in a visible status and, where someone must act, an alert (`alerts.raise`).
- **Front end**: no inline `style=""` or inline scripts (strict CSP). No build step. Keep `public/lib.js` and `src/render.js` in step (a test checks they match).
- **Copy**: plain, short sentences a non-technical teammate understands. Say what happened and what to do.
- **Dependencies**: pinned exact versions. Don't add an "anti-ban" package or swap the engine library without the user asking.
- **Time**: everything user-facing is India time (`Asia/Kolkata`).
- **Credit**: the product is "WA Box", designed by Bhavishya (https://www.linkedin.com/in/bhavishyabharadwaj/). Keep that credit in the README, sign-in page and app; don't add other attribution.
