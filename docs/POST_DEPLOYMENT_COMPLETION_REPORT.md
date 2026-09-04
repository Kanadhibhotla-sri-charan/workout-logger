# Post-Deployment Completion — Status Report

Per `docs/POST_DEPLOYMENT_COMPLETION_SPEC.md`.

## Why this report is incomplete by design

This development session runs in a sandboxed remote environment with
**no network path to the Oracle VM** — outbound traffic is HTTPS-only
through a fixed proxy; a direct connectivity test to
`68.233.97.63:22` timed out with no response — and **no SSH key** for
it either. Every step in the spec (§3–§18) requires running commands
*on* the VM over SSH. None of those steps have been executed. Per this
repo's own established rule (never report `PASS` for anything not
actually tested), this report states plainly what is prepared versus
what still needs someone with real SSH access to run.

**What's prepared below**: every command from the spec, in the exact
order given, plus the backup script/systemd units (already updated in
`ops/` to match the real deployment's paths — see the note atop
`docs/PRODUCTION_DEPLOYMENT.md`) ready to copy onto the VM. Whoever has
SSH access (you, running it yourself, or a Claude Code session that
actually has that access) can execute this checklist mechanically.

```
Database integrity check:            NOT RUN (needs SSH)
Reboot persistence:                  NOT RUN (needs SSH)
SQLite permissions verified:         NOT RUN (needs SSH)
Backup script installed + tested:    NOT RUN (needs SSH) — script ready in ops/
Automated daily backup working:      NOT RUN (needs SSH) — unit files ready in ops/
Firewall (port 80) verified:         NOT RUN (needs SSH)
systemd enabled + stable:            NOT RUN (needs SSH)
Nginx config valid:                  NOT RUN (needs SSH)
Resource sanity (swap/disk):         NOT RUN (needs SSH)
Final end-to-end test:               NOT RUN (needs SSH)
Free-tier audit:                     NOT RUN (needs SSH/OCI console)
```

---

## Application

- Repository: this repo (`workout-logger`), `main` branch.
- Application directory (live): `/home/ubuntu/workout-logger`
- Node version required: >= 20 LTS (see `package.json` `engines`)
- Build: `npm ci && npm run build`
- Start: `npm start` (`node dist/server/index.js`) — matches the
  systemd `ExecStart` convention used by `ops/systemd/workout-logger.service`,
  adjusted for `WorkingDirectory=/home/ubuntu/workout-logger`,
  `User=ubuntu`, `Group=ubuntu` on the real VM (not `workout`/`/opt` —
  see the divergence note in `docs/PRODUCTION_DEPLOYMENT.md`).

## Services

- systemd service name: `workout-logger`
- Nginx config location: (not independently confirmed from this
  session — typically `/etc/nginx/sites-available/` +
  `sites-enabled/` per `docs/PRODUCTION_DEPLOYMENT.md` §22-24; confirm
  the real path with `sudo nginx -T | grep -A2 'server_name'` on the VM)
- Application port: `3000` (internal only, never public)
- Public port: `80` (HTTP only — no HTTPS yet, per spec §11's ₹0
  constraint: a real cert needs a domain name, which hasn't been
  provisioned)

## Database

- SQLite path (live): `/home/ubuntu/workout-logger/data/workout-logger.sqlite`
- Backup directory: `/home/ubuntu/workout-logger-backups/`
- Backup procedure: install `ops/scripts/backup-workout-logger.sh` to
  `/usr/local/bin/backup-workout-logger.sh` (`chmod +x`), install
  `ops/systemd/workout-logger-backup.service` +
  `ops/systemd/workout-logger-backup.timer` to
  `/etc/systemd/system/`, then:
  ```bash
  sudo systemctl daemon-reload
  sudo systemctl enable --now workout-logger-backup.timer
  sudo systemctl start workout-logger-backup.service   # run once immediately to test
  ls -la /home/ubuntu/workout-logger-backups/
  ```
- Restore procedure (never overwrite the live DB — restore into a
  temporary file first):
  ```bash
  LATEST=$(ls -t /home/ubuntu/workout-logger-backups/*.sqlite | head -1)
  cp "$LATEST" /tmp/restore-test.sqlite
  sqlite3 /tmp/restore-test.sqlite "PRAGMA integrity_check;"   # expect: ok
  sqlite3 /tmp/restore-test.sqlite "SELECT count(*) FROM workout_sessions;"  # sanity: real data present
  rm /tmp/restore-test.sqlite
  ```
  To actually restore onto the live path (only after confirming the
  above): stop the service, copy the chosen backup file over the live
  `workout-logger.sqlite`, remove any stale `-wal`/`-shm` sidecar
  files, then start the service again.

## Oracle

- VM: `workout-programmer-new`
- Shape: `VM.Standard.E2.1.Micro` (Always Free)
- OS: Ubuntu 24.04 LTS
- Public IP at time of writing: `68.233.97.63` (verify current value in
  the OCI console before relying on it — not confirmed static/reserved
  from this session)
- Network/security configuration: TCP 22 (SSH), TCP 80 (HTTP) allowed;
  TCP 3000 must remain internal-only (not independently re-verified
  this session)

## Recovery

- SSH: `ssh ubuntu@<current-public-ip>` (private key held by whoever
  set up the VM — never documented here)
- Restart the app: `sudo systemctl restart workout-logger`
- Restart Nginx: `sudo systemctl restart nginx`
- Inspect logs: `sudo journalctl -u workout-logger -n 100 --no-pager`
- Restore a SQLite backup: see "Restore procedure" above
- Update procedure (spec §15):
  ```bash
  cd ~/workout-logger
  sudo systemctl start workout-logger-backup.service   # backup before any update, per spec §16
  git pull
  npm ci
  npm run verify   # do NOT restart the service if this fails
  npm run build
  sudo systemctl restart workout-logger
  sudo systemctl status workout-logger --no-pager
  curl -I http://localhost:3000/api/health
  ```

## Everything still to actually run on the VM (spec §3–§18, verbatim order)

```bash
# §3 — database integrity
sudo apt install -y sqlite3   # only if not already installed
cd ~/workout-logger
sqlite3 data/workout-logger.sqlite "PRAGMA integrity_check;"   # expect: ok

# §4 — reboot persistence (do this only after §3 passes)
sudo systemctl status workout-logger --no-pager
sudo systemctl status nginx --no-pager
# note current profile/program/workout state in the app first
sudo reboot
# reconnect, then:
sudo systemctl status workout-logger --no-pager
sudo systemctl status nginx --no-pager
curl -I http://localhost
curl -I http://localhost:3000
# then re-open the app from a browser and confirm all state persisted

# §5 — SQLite permissions
ls -lah ~/workout-logger/data/   # owner should be ubuntu

# §6-7 — backups (see "Backup procedure" above for the exact commands)

# §9 — firewall
sudo iptables -L INPUT -n --line-numbers
sudo iptables-save | grep -- '--dport 80'

# §12 — systemd
sudo systemctl is-enabled workout-logger
sudo systemctl is-enabled nginx
sudo systemctl status workout-logger --no-pager
sudo journalctl -u workout-logger -n 100 --no-pager

# §13 — nginx
sudo nginx -t
sudo systemctl status nginx --no-pager

# §14 — resources
free -h
df -h
```

Then the full manual end-to-end test (spec §17): open the app, load
profile, confirm daily activity assignments (Gym/Badminton/Both),
generate/load the program, change one day Gym→Badminton and another to
Both, add an unplanned Blueprint exercise, log a workout, refresh the
browser, confirm everything persisted, reboot the VM, reopen the app,
confirm state and history remain.

## What this session did NOT do

- No SSH connection was made or attempted to succeed (none is possible
  from here).
- No changes were made on the live VM.
- No claim is made about the live VM's current actual health — only
  that it was reported working prior to this checklist per spec §1/§2.
