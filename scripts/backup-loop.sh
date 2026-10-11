#!/usr/bin/env bash
# Scheduler for the production backup sidecar (infra/docker/compose.prod.yml, service `backup`).
#
#   - On start: takes a backup unless one newer than BACKUP_INTERVAL_HOURS already exists.
#   - Then daily at BACKUP_AT (HH:MM, UTC): scripts/backup.sh (dump + checksum + upload hook +
#     retention pruning).
#   - Weekly on RESTORE_DRILL_WEEKDAY (1=Mon … 7=Sun; empty disables): restores the newest dump into
#     a scratch database with scripts/restore-test.sh --from-file and checks ledger invariants.
#
# Failures are logged and retried at the next slot; the container healthcheck alerts when the newest
# dump is older than BACKUP_MAX_AGE_HOURS (see backup.Dockerfile).
set -euo pipefail

BH_SCRIPT_NAME=backup-loop
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pg.sh
source "$SCRIPT_DIR/lib/pg.sh"

at="${BACKUP_AT:-02:30}"
interval_hours="${BACKUP_INTERVAL_HOURS:-20}"
drill_weekday="${RESTORE_DRILL_WEEKDAY-7}"
dir="${BACKUP_DIR:-/backups}"
[[ "$at" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "BACKUP_AT must be HH:MM (24h, UTC)"

newest_dump() {
  find "$dir" -maxdepth 1 -type f -name '*.dump' 2>/dev/null | sort | tail -n 1
}

run_backup() {
  if "$SCRIPT_DIR/backup.sh" >/dev/null; then
    log "scheduled backup succeeded"
  else
    log "scheduled backup FAILED (exit $?)"
  fi
}

run_drill() {
  local latest
  latest="$(newest_dump)"
  if [[ -z "$latest" ]]; then
    log "restore drill skipped: no dump found"
    return 0
  fi
  if "$SCRIPT_DIR/restore-test.sh" --from-file "$latest"; then
    log "restore drill PASSED for $(basename "$latest")"
  else
    log "restore drill FAILED for $(basename "$latest")"
  fi
}

seconds_until_next_slot() {
  local now next
  now="$(date -u +%s)"
  next="$(date -u -d "today $at" +%s)"
  if ((next <= now)); then next="$(date -u -d "tomorrow $at" +%s)"; fi
  printf '%s\n' "$((next - now))"
}

trap 'log "stopping"; exit 0' TERM INT

mkdir -p "$dir"
latest="$(newest_dump)"
if [[ -z "$latest" ]] || [[ -z "$(find "$latest" -mmin "-$((interval_hours * 60))")" ]]; then
  log "no recent backup; taking one now"
  run_backup
fi

while true; do
  wait_s="$(seconds_until_next_slot)"
  log "next backup at $at UTC (in ${wait_s}s)"
  sleep "$wait_s" &
  wait $! # interruptible by SIGTERM
  run_backup
  if [[ -n "$drill_weekday" ]] && [[ "$(date -u +%u)" == "$drill_weekday" ]]; then
    run_drill
  fi
done
