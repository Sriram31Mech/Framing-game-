#!/usr/bin/env bash
# Logical backup of the Bharat Harvest database.
#
#   scripts/backup.sh [--database NAME] [--dir DIR] [--no-prune]
#
# Writes <dir>/<prefix>_<UTC timestamp>.dump (pg_dump custom format, compressed) plus a
# <file>.sha256 checksum (sha256sum -c compatible), verifies the archive is readable, runs the
# optional upload hook and prunes old backups. Prints the new dump path on stdout.
#
# Environment:
#   DATABASE_URL / PG*          connection (see scripts/lib/pg.sh); BH_PG_MODE=native|compose|auto
#   BACKUP_DIR                  output directory (default: <repo>/backups)
#   BACKUP_RETENTION_DAYS       delete dumps older than this many days (default 14)
#   BACKUP_MIN_KEEP             always keep at least this many newest dumps (default 3)
#   BACKUP_PREFIX               file name prefix (default: database name)
#   BACKUP_UPLOAD_CMD           optional off-site copy hook, run as `bash -c "$BACKUP_UPLOAD_CMD"`
#                               with $1 = dump path and $2 = checksum path. Provider-agnostic, e.g.
#                                 'rclone copy "$1" offsite:bh-backups && rclone copy "$2" offsite:bh-backups'
#                                 'aws s3 cp "$1" "$BACKUP_S3_URI/" --endpoint-url "$BACKUP_S3_ENDPOINT"'
#                               A failed upload keeps the local copy and makes the script exit 3.
set -euo pipefail

BH_SCRIPT_NAME=backup
# shellcheck source=lib/pg.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/pg.sh"

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

prune=1
db_arg=""
dir_arg=""
while (($#)); do
  case "$1" in
    --database) db_arg="${2:?--database needs a value}" && shift ;;
    --dir) dir_arg="${2:?--dir needs a value}" && shift ;;
    --no-prune) prune=0 ;;
    -h | --help) usage && exit 0 ;;
    *) usage >&2 && die "unknown argument: $1" ;;
  esac
  shift
done

bh_pg_init
db="${db_arg:-$PGDATABASE}"
dir="${dir_arg:-${BACKUP_DIR:-$BH_REPO_ROOT/backups}}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
min_keep="${BACKUP_MIN_KEEP:-3}"
prefix="${BACKUP_PREFIX:-$db}"
[[ "$retention_days" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be a whole number"
[[ "$min_keep" =~ ^[0-9]+$ ]] || die "BACKUP_MIN_KEEP must be a whole number"
[[ "$prefix" =~ ^[A-Za-z0-9_.-]+$ ]] || die "backup prefix may only contain [A-Za-z0-9_.-]"

umask 077
mkdir -p "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$dir/${prefix}_${stamp}.dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

log "dumping database '$db' (mode: $BH_PG_MODE) -> $file"
started=$SECONDS
bh_pg pg_dump --format=custom --lock-wait-timeout=60s --no-password -d "$db" >"$partial"

# A truncated or corrupt archive fails to list its table of contents.
if ! bh_pg pg_restore --list <"$partial" >/dev/null; then
  die "dump verification failed (pg_restore --list); keeping nothing"
fi
mv "$partial" "$file"
printf '%s  %s\n' "$(bh_sha256 "$file")" "$(basename "$file")" >"$file.sha256"
size="$(wc -c <"$file" | tr -d ' ')"
log "backup complete: $(basename "$file") (${size} bytes, $((SECONDS - started))s)"

status=0
if [[ -n "${BACKUP_UPLOAD_CMD:-}" ]]; then
  log "running upload hook"
  if ! bash -c "$BACKUP_UPLOAD_CMD" bh-backup-upload "$file" "$file.sha256"; then
    log "WARNING: upload hook failed; local backup kept"
    status=3
  fi
fi

if ((prune)); then
  # Newest first (timestamps sort lexically). Keep the newest $min_keep regardless of age.
  # (while-read rather than mapfile: macOS ships bash 3.2.)
  seen=0
  removed=0
  while IFS= read -r f; do
    seen=$((seen + 1))
    ((seen <= min_keep)) && continue
    if [[ -n "$(find "$f" -mmin "+$((retention_days * 1440))")" ]]; then
      rm -f "$f" "$f.sha256"
      removed=$((removed + 1))
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name "${prefix}_*.dump" | sort -r)
  log "retention: kept $((seen - removed)), removed ${removed} older than ${retention_days}d"
fi

printf '%s\n' "$file"
exit "$status"
