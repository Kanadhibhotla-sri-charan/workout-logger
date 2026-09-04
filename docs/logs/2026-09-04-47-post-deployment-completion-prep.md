# 2026-09-04 — Post-Deployment Completion Prep

## What changed

Per `docs/POST_DEPLOYMENT_COMPLETION_SPEC.md` (saved verbatim to the
repo), the app is now confirmed already live on an Oracle VM
(`workout-programmer-new`, `68.233.97.63`, `ubuntu` user,
`/home/ubuntu/workout-logger`) — a real deployment that diverged from
the earlier-planned runbook in `docs/PRODUCTION_DEPLOYMENT.md`: it runs
as the ordinary `ubuntu` user rather than a dedicated `workout` service
account, and SQLite lives under the app directory's own `data/`
subdirectory rather than `/var/lib/workout-logger`. Added a prominent
note to that effect atop `docs/PRODUCTION_DEPLOYMENT.md` so it doesn't
mislead anyone reading it against the real deployment.

Updated `ops/scripts/backup-workout-logger.sh`'s default `DB_PATH`/
`BACKUP_DIR` and `ops/systemd/workout-logger-backup.service`'s `User`/
`Group`/`Environment=` lines to match the real live paths (the script
itself needed no logic changes — it was already parameterized via
environment variables).

Wrote `docs/POST_DEPLOYMENT_COMPLETION_REPORT.md`: every command from
the spec's §3-§18, in order, ready to run against the real VM, plus the
backup/restore procedure and a recovery reference — everything this
session could prepare without SSH access.

## Why this session could not execute the checklist itself

This remote sandbox has no network path to the VM (outbound is
HTTPS-only through a fixed proxy; a direct TCP connectivity test to
`68.233.97.63:22` timed out) and no SSH key for it. Every step in the
spec (database integrity check, reboot test, backup install/test,
firewall/systemd/Nginx verification, the final end-to-end test,
free-tier audit) requires running commands on the VM over SSH — none
of that was attempted to fake-pass; the report states plainly what
still needs to be run by whoever has real SSH access.

## Not done in this pass

Everything requiring live VM access — tracked explicitly in
`docs/POST_DEPLOYMENT_COMPLETION_REPORT.md`'s status table, all marked
"NOT RUN (needs SSH)" rather than a guessed PASS.
