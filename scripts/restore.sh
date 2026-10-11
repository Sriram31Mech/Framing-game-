#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into a target database.
#
#   scripts/restore.sh --target-db NAME [--drop-existing] [--yes] [--no-verify] DUMP_FILE
#
#   --target-db NAME   database to restore into (required; never postgres/template*)
#   --drop-existing    if NAME exists, DROP it (terminating its connections) and recreate it.
#                      Without this flag the restore refuses to touch a database that has tables.
#   --yes              skip the interactive confirmation (required when not on a terminal)
#   --no-verify        skip the <dump>.sha256 checksum check (not recommended)
#
# Connection: DATABASE_URL / PG* / BH_PG_MODE as described in scripts/lib/pg.sh. The database in
# DATABASE_URL is only used to locate the server; the restore goes to --target-db.
#
# Production restore: stop server + worker first (see docs/RUNBOOK.md), restore, start them again.
set -euo pipefail

BH_SCRIPT_NAME=restore
# shellcheck source=lib/pg.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/pg.sh"

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

target=""
drop_existing=0
assume_yes=0
verify=1
dump=""
while (($#)); do
  case "$1" in
    --target-db) target="${2:?--target-db needs a value}" && shift ;;
    --drop-existing) drop_existing=1 ;;
    --yes | -y) assume_yes=1 ;;
    --no-verify) verify=0 ;;
    -h | --help) usage && exit 0 ;;
    -*) usage >&2 && die "unknown option: $1" ;;
    *)
      [[ -z "$dump" ]] || die "only one dump file may be given"
      dump="$1"
      ;;
  esac
  shift
done

[[ -n "$dump" ]] || {
  usage >&2
  die "missing DUMP_FILE"
}
[[ -n "$target" ]] || die "--target-db is required"
[[ -f "$dump" ]] || die "dump file not found: $dump"
[[ "$target" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "invalid database name: $target"
bh_is_protected_db "$target" && die "refusing to restore into system database '$target'"

if ((verify)); then
  sumfile="$dump.sha256"
  [[ -f "$sumfile" ]] || die "checksum file missing: $sumfile (use --no-verify to skip)"
  expected="$(awk '{print $1; exit}' "$sumfile")"
  actual="$(bh_sha256 "$dump")"
  [[ "$expected" == "$actual" ]] || die "checksum mismatch for $dump (expected $expected, got $actual)"
  log "checksum OK ($actual)"
fi

bh_pg_init

exists="$(bh_scalar postgres "SELECT 1 FROM pg_database WHERE datname = $(bh_literal "$target")")"
if [[ "$exists" == 1 ]]; then
  tables="$(bh_scalar "$target" "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tablename <> 'spatial_ref_sys'")"
  if ((tables > 0)) && ((!drop_existing)); then
    die "database '$target' already has $tables table(s); pass --drop-existing to replace it"
  fi
fi

confirm() {
  local what="$1"
  if ((assume_yes)); then return 0; fi
  if [[ ! -t 0 ]]; then die "confirmation required: $what Re-run with --yes"; fi
  printf '%s\nType the database name (%s) to continue: ' "$what" "$target" >&2
  local answer
  read -r answer
  [[ "$answer" == "$target" ]] || die "confirmation did not match; aborting"
}

if [[ "$exists" == 1 ]]; then
  confirm "This will DROP and recreate database '$target' on ${PGHOST}:${PGPORT} (mode $BH_PG_MODE)."
  log "dropping database '$target'"
  bh_psql postgres -c "DROP DATABASE $(bh_ident "$target") WITH (FORCE)"
else
  confirm "This will create database '$target' on ${PGHOST}:${PGPORT} and restore $(basename "$dump") into it."
fi

log "creating database '$target'"
bh_psql postgres -c "CREATE DATABASE $(bh_ident "$target")"

log "restoring $(basename "$dump") into '$target'"
started=$SECONDS
bh_pg pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
  -d "$target" <"$dump"
bh_psql "$target" -c 'ANALYZE'

tables="$(bh_scalar "$target" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
log "restore complete in $((SECONDS - started))s: $tables table(s) in public schema of '$target'"
