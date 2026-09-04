> **Note — actual deployment diverged from this plan.** The application
> was deployed by hand against a simpler layout than the one below: it
> runs as the ordinary `ubuntu` user (no dedicated `workout` service
> account), the app lives at `/home/ubuntu/workout-logger`, and SQLite
> lives under that same directory's `data/` subdirectory (never
> `/var/lib/workout-logger`). The architecture (Node/Express/SQLite/
> systemd/Nginx, no Docker, no Postgres) and every "MUST NOT" in this
> document still hold — only the specific paths/user below differ from
> what is actually running. See `docs/POST_DEPLOYMENT_COMPLETION_SPEC.md`
> and `docs/POST_DEPLOYMENT_COMPLETION_REPORT.md` for the real
> deployment's current, accurate operational reference. The backup
> script/unit under `ops/` have been updated to match the real paths.

# Production Deployment Runbook — Oracle Cloud Always Free VM

This is the exact, ordered runbook for deploying `workout-logger` to an
Oracle Cloud Infrastructure (OCI) Always Free VM, per the Production
Deployment Phase specification. It preserves the existing architecture
(Node.js/TypeScript/Express, static HTML/JS, better-sqlite3/SQLite, the
committed Blueprint snapshot) — no database migration, no Docker, no
programming-engine changes.

```
GitHub → Oracle Always Free VM → Node.js/Express (localhost:3000)
       → Nginx (:80/:443, reverse proxy) → HTTPS (Let's Encrypt)
       → SQLite at /var/lib/workout-logger/ (outside the Git checkout)
```

Steps 1-11 are one-time infrastructure/account setup. Steps 12+ are
executed on the VM over SSH. Committed helper files live in `ops/`:

```
ops/systemd/workout-logger.service
ops/systemd/workout-logger-backup.service
ops/systemd/workout-logger-backup.timer
ops/nginx/workout-logger.conf
ops/scripts/backup-workout-logger.sh
ops/workout-logger.env.example
```

## 0. Prerequisites (the user must provide these — see §46 of the spec)

These cannot be inferred from the repository or performed without
account access:

- **Oracle Cloud account** with an Always Free eligible VM created
  (shape `VM.Standard.E2.1.Micro`, a supported Linux image, a public
  IPv4 address, SSH access configured with the user's own public key).
  If `VM.Standard.E2.1.Micro` capacity is unavailable in the account's
  home region, **stop and report that** — do not substitute a paid
  shape.
- **`DEPLOYMENT_HOSTNAME`** — a real hostname with its DNS A record
  pointed at the VM's public IPv4 address.
- **SSH access to the VM** for whoever executes steps 12+ (either the
  user runs this runbook themselves, or grants the executing agent a
  way to reach the VM).

Nothing below invents a hostname or IP — every `<PLACEHOLDER>` must be
replaced with the real value before running a command.

## 1-2. Target and cost constraints

Already decided (do not revisit): OCI Always Free VM, Node.js + Express
+ Nginx + systemd + Let's Encrypt, existing SQLite — no Postgres, no
Docker beyond what's already implied, no paid compute, no paid block
storage.

## 3. Architecture

```
Internet → Nginx :443 → Express (127.0.0.1:3000) → SQLite → VM disk
```

Port 3000 is never exposed publicly — Nginx is the only public-facing
listener (besides SSH on 22).

## 5. Health endpoint (already implemented in this repo)

`GET /api/health` returns HTTP 200 with exactly `{"status":"ok"}` — see
`src/server/app.ts` and `tests/routes/health.test.ts`. No database
contents, env vars, paths, or stack traces are ever included.

## 11. Install Node.js 20 LTS on the VM

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # must report >= 20
npm --version
```

(Adjust for the actual Linux distribution/package manager on the chosen
image — the above is for a Debian/Ubuntu-family OCI image, which is the
common Always Free choice.)

## 9. Create the service account

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin workout
```

## 12-14. Clone, install, build

```bash
sudo mkdir -p /opt/workout-logger
sudo chown "$USER":"$USER" /opt/workout-logger   # temporarily, for the clone/build below
cd /opt
git clone <WORKOUT_LOGGER_REPOSITORY_URL> workout-logger
cd workout-logger
npm ci                 # never `npm install` for production
npm run build           # tsc -> dist/
ls dist/server/index.js # must exist
```

## 15. Pre-production verification — MUST pass before proceeding

```bash
npm run verify
```

If this fails: **STOP**. Do not start the production service. Report
the exact failure.

## 16. Production data directory

```bash
sudo mkdir -p /var/lib/workout-logger
sudo chown -R workout:workout /var/lib/workout-logger
sudo chmod 700 /var/lib/workout-logger
ls -ld /var/lib/workout-logger   # owner must be workout workout
```

## 17. Production environment file

```bash
sudo cp /opt/workout-logger/ops/workout-logger.env.example /etc/workout-logger.env
sudo chown root:workout /etc/workout-logger.env
sudo chmod 640 /etc/workout-logger.env
```

Confirm its contents match:

```
NODE_ENV=production
PORT=3000
DB_PATH=/var/lib/workout-logger/workout-logger.sqlite
```

No `BLUEPRINT_REPO_PATH` — production only ever reads the committed
snapshot at `src/blueprint/snapshot/`.

Finish handing ownership of the application directory to the service
account:

```bash
sudo chown -R workout:workout /opt/workout-logger
```

## 18-19. systemd service

```bash
which npm   # confirm this matches ExecStart below; edit the unit file if it differs
sudo cp /opt/workout-logger/ops/systemd/workout-logger.service /etc/systemd/system/workout-logger.service
sudo systemctl daemon-reload
sudo systemctl enable workout-logger
sudo systemctl start workout-logger
sudo systemctl status workout-logger   # expect: active (running)
```

If not active:

```bash
sudo journalctl -u workout-logger -n 100 --no-pager
```

**STOP** and report the exact failure — do not work around it.

## 20-21. Local health/application checks (on the VM, before Nginx)

```bash
curl http://127.0.0.1:3000/api/health          # expect {"status":"ok"}, HTTP 200
curl -I http://127.0.0.1:3000/
curl -I http://127.0.0.1:3000/today.html
curl -I http://127.0.0.1:3000/program.html
curl -I http://127.0.0.1:3000/profile.html
curl -I http://127.0.0.1:3000/history.html
```

All must return a successful HTTP response.

## 22-24. Nginx

```bash
sudo apt-get install -y nginx
sudo cp /opt/workout-logger/ops/nginx/workout-logger.conf /etc/nginx/sites-available/workout-logger
sudo sed -i 's/<DEPLOYMENT_HOSTNAME>/YOUR_ACTUAL_HOSTNAME/' /etc/nginx/sites-available/workout-logger
sudo ln -s /etc/nginx/sites-available/workout-logger /etc/nginx/sites-enabled/workout-logger
sudo nginx -t                     # must report success
sudo systemctl reload nginx
curl -I http://<DEPLOYMENT_HOSTNAME>/
```

## 25/30. HTTPS via Certbot

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <DEPLOYMENT_HOSTNAME>
```

Certbot rewrites the Nginx config to add the HTTPS server block and
HTTP→HTTPS redirect. Then verify:

```bash
curl -I https://<DEPLOYMENT_HOSTNAME>/
curl https://<DEPLOYMENT_HOSTNAME>/api/health   # expect {"status":"ok"}
```

## 28-29. Firewall

OCI network security list / security group: allow TCP 22, 80, 443. Do
**not** open 3000 publicly.

If the VM image also runs a local firewall (e.g. `ufw` or
`firewalld`), mirror the same rule set:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# do NOT: sudo ufw allow 3000/tcp
sudo ufw status
```

## 31. Database persistence test (mandatory — do not skip)

1. Through the deployed UI, create a small harmless piece of data
   (e.g. a training profile, or a test goal).
2. Confirm it appears.
3. `sudo systemctl restart workout-logger`
4. Reload the app, confirm the data is still there.
5. `sudo reboot`
6. After reconnecting: `sudo systemctl status workout-logger` (expect
   `active (running)` — it should have started automatically via
   `systemctl enable`), then confirm the data is still there.

Deployment is not complete until this passes.

## 32. Application smoke test

Manually, in a browser, against `https://<DEPLOYMENT_HOSTNAME>`:

- `/` loads.
- `/profile.html` loads; create/update a training profile; it persists.
- `/program.html` loads; the generated weekly program appears.
- `/today.html` loads; verify a gym day shows "Gym"/the session
  purpose, a configured badminton day shows "Badminton" (never
  "Rest"), and a genuine rest day shows "Rest".
- `/logger.html`: start a session, log a set, confirm it persists.
- `/history.html`: the logged session appears.

## 33-34. Blueprint snapshot

No action needed at deploy time — `BlueprintAdapter` reads the
committed `src/blueprint/snapshot/*.json` directly; there is no runtime
dependency on a live `workout-blueprint` checkout, and
`npm run sync-blueprint` must never run as part of normal startup.
When Blueprint data actually changes, that's a separate, manual,
developer-machine process (sync → review → `npm run verify` → commit →
push → redeploy via §35 below) — not part of this deployment.

## 35. Future deployment updates

```bash
cd /opt/workout-logger
git pull
npm ci
npm run verify
npm run build
sudo systemctl restart workout-logger
curl https://<DEPLOYMENT_HOSTNAME>/api/health
```

## 36-38. Backups

```bash
sudo -u workout mkdir -p /var/lib/workout-logger/backups
sudo cp /opt/workout-logger/ops/scripts/backup-workout-logger.sh /usr/local/bin/backup-workout-logger.sh
sudo chmod +x /usr/local/bin/backup-workout-logger.sh
sudo apt-get install -y sqlite3   # the backup script needs the sqlite3 CLI's .backup command

sudo cp /opt/workout-logger/ops/systemd/workout-logger-backup.service /etc/systemd/system/
sudo cp /opt/workout-logger/ops/systemd/workout-logger-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now workout-logger-backup.timer
sudo systemctl status workout-logger-backup.timer   # expect: active (waiting)
```

Run one backup immediately to confirm it works, rather than waiting a
full day:

```bash
sudo systemctl start workout-logger-backup.service
sudo systemctl status workout-logger-backup.service   # expect: succeeded
ls -la /var/lib/workout-logger/backups/
```

The script (`ops/scripts/backup-workout-logger.sh`) uses SQLite's own
online-backup mechanism (`sqlite3 <db> ".backup <dest>"`, safe against
a live WAL-mode database — never a raw file copy), verifies the backup
with `PRAGMA integrity_check`, and prunes backups older than 7 days.

## 39. Backup restore test (mandatory — do not skip; never overwrite the live DB)

```bash
LATEST=$(ls -t /var/lib/workout-logger/backups/*.sqlite | head -1)
cp "$LATEST" /tmp/restore-test.sqlite
sqlite3 /tmp/restore-test.sqlite "PRAGMA integrity_check;"   # expect: ok
sqlite3 /tmp/restore-test.sqlite "SELECT count(*) FROM goals;"   # or another real table — confirm expected data is present
rm /tmp/restore-test.sqlite
```

## 48. Final verification commands

```bash
sudo systemctl status workout-logger --no-pager
curl -I https://<DEPLOYMENT_HOSTNAME>/
curl https://<DEPLOYMENT_HOSTNAME>/api/health
sudo systemctl status nginx --no-pager
sudo systemctl status workout-logger-backup.timer --no-pager
```

All must report healthy status before declaring deployment complete.

## 40-44. Explicit non-goals of this deployment

No authentication (document this — the app is single-user, publicly
reachable but not secured for arbitrary multi-user access). No CORS
(same origin serves both API and frontend). No AI/LLM dependency of any
kind. No Calorie Tracker changes. No Blueprint repository
modifications.
