# Daily DB backup installed; RIR 0 confirmed

**No code change** (operations record), 2026-10-20.

## Daily backup
Log 88 found the daily backup timer had never been installed on the VM.
Owner: "yes back it up". Installed from the repo's own files (VM checkout
at a5ced2c, `ops/` unchanged):

- `ops/scripts/backup-workout-logger.sh` -> `/usr/local/bin/` (755)
- `ops/systemd/workout-logger-backup.service` and `.timer` ->
  `/etc/systemd/system/`; `systemctl enable --now workout-logger-backup.timer`

What it does: every day at 00:00 UTC (05:30 IST; `Persistent=true` runs a
missed one at boot) it makes an online `sqlite3 .backup` of
`data/workout-logger.sqlite` (safe in WAL mode), checks
`PRAGMA integrity_check` = ok, saves
`~/workout-logger-backups/workout-logger-<UTC ts>.sqlite`, and deletes
backups older than 7 days.

Verified: first run by hand 2026-10-20 17:59 UTC ->
`workout-logger-20261020T175954Z.sqlite` (1.6 MB, integrity ok); timer
enabled, next run 2026-10-21 00:00 UTC. Disk: 39 GB free.

Limit: the backups are on the same disk as the database, so they do not
protect against losing the VM. Pre-deploy backups in
`~/workout-logger/deployment-backups/` are kept as before.

Rollback: `sudo systemctl disable --now workout-logger-backup.timer`.

## RIR 0
Owner confirmed logging RIR 0 on most sets is intentional: 0 means the set
went to failure. No change; noted in the decision log section 18.
