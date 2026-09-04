#!/usr/bin/env bash
# Deployment Phase §37 / Post-Deployment Completion §6-7: daily backup
# of the production SQLite database. Uses SQLite's own online backup
# mechanism (the `.backup` command, via the sqlite3 CLI) rather than
# copying the live file directly, so a WAL-mode database mid-write is
# still backed up consistently.
#
# DB_PATH/BACKUP_DIR are overridden via the systemd unit's Environment=
# lines (see ops/systemd/workout-logger-backup.service) to match
# wherever this is actually deployed — the defaults below match the
# real live deployment (Post-Deployment Completion spec §2: app under
# /home/ubuntu/workout-logger, SQLite under its data/ subdirectory, run
# as the `ubuntu` user — simpler than the original /opt +
# dedicated-service-account plan in docs/PRODUCTION_DEPLOYMENT.md,
# which is what was actually followed when this was deployed by hand).
#
# Exit codes: 0 on success, non-zero on any failure (so the invoking
# systemd service is correctly reported as failed).

set -euo pipefail

DB_PATH="${DB_PATH:-/home/ubuntu/workout-logger/data/workout-logger.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/workout-logger-backups}"
RETENTION_DAYS=7

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: database not found at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/workout-logger-$TIMESTAMP.sqlite"
TMP_DEST="$DEST.tmp"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 CLI not found — install it (e.g. apt-get install sqlite3) before running this script" >&2
  exit 1
fi

# The .backup command uses SQLite's own Online Backup API, which is safe
# against a live WAL-mode database — never a raw `cp` of the live file.
if ! sqlite3 "$DB_PATH" ".backup '$TMP_DEST'"; then
  echo "ERROR: sqlite3 .backup failed" >&2
  rm -f "$TMP_DEST"
  exit 1
fi

# Sanity-check the backup actually opens before trusting it.
if ! sqlite3 "$TMP_DEST" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "ERROR: backup failed integrity check" >&2
  rm -f "$TMP_DEST"
  exit 1
fi

mv "$TMP_DEST" "$DEST"
echo "Backup created: $DEST"

# Retention: remove backups older than RETENTION_DAYS.
find "$BACKUP_DIR" -name 'workout-logger-*.sqlite' -mtime "+$((RETENTION_DAYS - 1))" -print -delete

exit 0
