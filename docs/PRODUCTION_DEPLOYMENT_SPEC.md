# WORKOUT PROGRAMMER — PRODUCTION DEPLOYMENT PHASE

## DEV DIRECTIVE

> **DEV = HANDS. THIS DOCUMENT = BRAIN.**
>
> Every implementation decision required for this task is specified below.
> Do not reinterpret the requirements or make independent product decisions.

This phase deploys the already-built `workout-logger` application to a real,
publicly reachable production environment. It does **not** add features,
does **not** touch the programming engine, and does **not** implement
Workout Logger enhancements.

## 1-2. Deployment target and cost constraints

The production target is an **Oracle Cloud Infrastructure Always Free
VM**, shape `VM.Standard.E2.1.Micro`. This is a decided architecture
choice, not open for reconsideration.

**Render Free is explicitly rejected**: its filesystem is ephemeral and
resets on every redeploy/restart, which is incompatible with this
repository's SQLite-on-disk persistence model.

**Google Cloud Run is explicitly rejected** for the same reason: its
container filesystem is disposable between instances/revisions.

Oracle Always Free is chosen specifically because it includes **persistent
block storage** that survives process restarts and VM reboots — a hard
requirement for SQLite.

**Never provision paid Oracle compute or storage.** If the free-tier shape
is temporarily unavailable in the account's home region, **STOP and
report** rather than substituting a paid shape.

## 3-4. Architecture (must be preserved exactly)

Node.js, TypeScript, Express, static HTML/JS frontend, better-sqlite3,
SQLite, and the vendored/committed Blueprint snapshot. Do **not** migrate
to Postgres. Do **not** introduce Docker (unless a step explicitly
requires it — none do). Do **not** modify the programming engine. Do
**not** implement Workout Logger enhancements in this phase.

Target request path:

```
Internet → Nginx :443 → Express/Node localhost:3000 → SQLite → persistent VM disk
```

Port 3000 must **never** be exposed publicly — Nginx is the only
public-facing listener besides SSH.

## 5. Health endpoint (application change required)

Add `GET /api/health` returning exactly `{"status":"ok"}` with HTTP 200,
containing **zero** sensitive information: no database contents, no user
info, no environment variables, no filesystem paths, no secrets, no stack
traces. Cover it with an automated test.

## 7. Production database path

Production `DB_PATH=/var/lib/workout-logger/workout-logger.sqlite` —
never the dev default `./data/...`. Owned by the dedicated `workout`
Linux service user. Lives entirely outside the Git checkout: never inside
`dist/`, never in `/tmp`, never committed.

## 9. Service account

Create a dedicated non-root Linux service account `workout`. The Node
process must run as this user, never as `root`.

## 10. Application directory

`/opt/workout-logger`.

## 11. Node.js version

Node.js >= 20 LTS on the VM. Verify via `node --version` / `npm --version`.

## 12-14. Clone, install, build

Clone from GitHub **on the VM itself** — never copy `node_modules/` or
`dist/` from a developer machine. Use `npm ci` (never `npm install`) for
deterministic installs. `npm run build` must succeed and produce
`dist/server/index.js`.

## 15. Pre-production verification gate

`npm run verify` **MUST** pass before starting the production service. If
it fails, **STOP** — do not bypass.

## 16-17. Data directory and environment file

Create `/var/lib/workout-logger` (owner `workout:workout`, mode `700`).

Create `/etc/workout-logger.env` (owner `root:workout`, mode `640`, **not**
committed to Git) containing:

```
NODE_ENV=production
PORT=3000
DB_PATH=/var/lib/workout-logger/workout-logger.sqlite
```

Explicitly **no** `BLUEPRINT_REPO_PATH` — there is no runtime Blueprint
dependency; the committed snapshot at `src/blueprint/snapshot/` is
authoritative. No API keys or LLM secrets exist.

## 18-19. systemd service

Exact unit file:

```ini
[Unit]
Description=Workout Programmer
After=network.target

[Service]
Type=simple
User=workout
Group=workout
WorkingDirectory=/opt/workout-logger
EnvironmentFile=/etc/workout-logger.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start it; verify `active (running)`. If not, **STOP** and
inspect `journalctl -u workout-logger -n 100 --no-pager`.

## 20-21. Local checks before touching Nginx

Against `127.0.0.1:3000`: `/`, `/today.html`, `/program.html`,
`/profile.html`, `/history.html` must all succeed, plus `/api/health`.

## 22-24. Nginx reverse proxy

Install Nginx. Exact config:

```nginx
server {
    listen 80;
    server_name <DEPLOYMENT_HOSTNAME>;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Proxy to `127.0.0.1:3000`, preserve `Host`/`X-Real-IP`/`X-Forwarded-For`/
`X-Forwarded-Proto` headers and all HTTP methods/bodies. `nginx -t` must
pass before `systemctl reload nginx`.

## 25/30. HTTPS

HTTPS via Let's Encrypt/Certbot for the real deployment hostname.
Production must not remain permanently on plain HTTP.

## 26/46. Deployment hostname (user manual step)

The deployment hostname and its DNS A record pointing at the VM's public
IPv4 are a **user manual step**. Do not invent the user's domain. Do not
assume a domain is already available.

## 27/46. Oracle account setup (user manual step)

Oracle account sign-in, VM creation, shape/image selection, SSH key
configuration, and network security rules are **user manual steps**.

## 28-29. Firewall

Both the OCI security list and any VM-local firewall (e.g. `ufw`) must
allow only 22/80/443. Port 3000 must never be publicly exposed at any
layer.

## 31. Database persistence test (mandatory)

Create data via the UI → confirm it → `systemctl restart workout-logger`
→ confirm data survives → `sudo reboot` the VM → after reconnecting,
confirm the service is `active (running)` and the data still exists. Do
**not** declare deployment complete until this passes.

## 32. Application smoke test (mandatory, manual)

Across all pages: Home, Profile, Program, Today (including verifying
Gym/Badminton/Rest classification displays correctly), Logger, History —
with data persistence checks.

## 33-34. Blueprint at runtime

Production must not require a live `workout-blueprint` repository at
runtime. Never run `npm run sync-blueprint` on normal startup. Blueprint
updates are an entirely separate manual developer-machine process (sync →
review → verify → commit → push → redeploy).

## 35. Future deployment updates (documented procedure)

```bash
git pull && npm ci && npm run verify && npm run build && systemctl restart workout-logger
```

Then health-check.

## 36-39. Backups (mandatory)

Persistence ≠ backup. Daily backup script at
`/usr/local/bin/backup-workout-logger.sh`:

- Verify the DB exists.
- Use SQLite's own backup mechanism rather than raw-copying a live WAL
  DB where possible.
- Timestamp each backup; store in `/var/lib/workout-logger/backups/`.
- Prune backups older than 7 days.
- Exit non-zero on failure.

Scheduled via a **systemd timer** (`workout-logger-backup.timer`, not
cron) firing `workout-logger-backup.service` daily.

A **mandatory** restore test must be performed before declaring
deployment complete: restore a backup into a *temporary* SQLite database
(never overwrite the live production DB), confirm it opens and contains
expected data.

## 40. Authentication

NO authentication is to be added in this phase (the repo is explicitly
single-user/no-auth already) — but this fact must be clearly documented
as "Authentication: NOT IMPLEMENTED" since the app will be publicly
reachable; it must not be represented as secure for arbitrary multi-user
access.

## 41. CORS

NO CORS to be added — frontend and API already share one origin.

## 42. AI/LLM dependency

NO AI/LLM dependency of any kind (Gemini, OpenAI, Claude, Nemotron, or
otherwise). The engine remains deterministic.

## 43. Calorie Tracker

Do **not** deploy, modify, or implement anything for the Calorie Tracker
in this phase.

## 44. Blueprint repository

Do **not** modify the Blueprint repository. The relationship stays
read-only knowledge snapshot → Workout Programmer.

## 45. Production checklist

Deployment is complete only when every item passes across these
categories: Infrastructure, Application, Web, Persistence, Backup,
Application smoke test.

## 46. Things only the user can do

- Oracle Cloud VM creation + public IP.
- SSH public key.
- DNS A record for the deployment hostname.
- Providing SSH/terminal access for the actual deployment execution.
- Approving/using the hostname for Certbot.
- Final manual UI verification.

The user should **not** need to modify source code.

## 47. Scope of questions allowed

Do not ask the user to make already-decided architecture choices (SQLite
vs Postgres, Render vs Cloud Run vs Docker, Nginx vs alternatives,
systemd vs alternatives, VM vs alternatives). Only ask for information
that genuinely cannot be known from the repository/account: Oracle
account access, SSH public key, VM public IP, deployment hostname.

## 48. Post-deployment verification commands

```bash
systemctl status workout-logger
curl -I https://<DEPLOYMENT_HOSTNAME>/
curl https://<DEPLOYMENT_HOSTNAME>/api/health
systemctl status nginx
systemctl status workout-logger-backup.timer
```

## 49. Deployment report

Return a "DEPLOYMENT REPORT" covering every checklist item as PASS/FAIL.
Do not report `PASS` for anything that was not actually tested.

## 50. Failure rule

Any critical deployment step failure (verify failure, build failure,
Node startup failure, DB init failure, health endpoint failure, Nginx
failure, HTTPS failure, SQLite persistence failure, backup failure)
requires an immediate **STOP**, an exact failure report, and no silent
workaround.

## 51. Acceptance criteria

The full chain — GitHub → Oracle VM → Node/Express → Nginx → HTTPS → app
→ persistent SQLite — must work end-to-end, reachable from another
device/network, with all core user flows (Profile, Program, Today,
Logger, History) functioning and data surviving both a Node restart and
a VM reboot.

## 52. Stop condition

Once acceptance criteria pass, stop entirely. Do not begin Workout Logger
enhancements, do not touch the programming engine, calorie tracker,
authentication, AI, analytics, or speculative infrastructure.

**IMPLEMENT → DEPLOY → VERIFY → REPORT → STOP.**
