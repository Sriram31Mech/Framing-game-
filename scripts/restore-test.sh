#!/usr/bin/env bash
# Automated backup/restore drill. Exits non-zero if anything does not match.
#
#   scripts/restore-test.sh [--source-db NAME] [--keep]        dump NAME, restore, compare
#   scripts/restore-test.sh --from-file DUMP [--keep]          restore an existing backup, check it
#
# Steps:
#   1. Dump the source database with scripts/backup.sh (into a temporary directory), or take an
#      existing dump (checksum verified).
#   2. Restore it into the scratch database RESTORE_CHECK_DB (default bharat_harvest_restore_check),
#      dropping any previous scratch copy.
#   3. Checks on the restored copy:
#      - every source table exists with the same row count (source mode; if the source changed while
#        dumping, the restored count must lie between the before/after counts)
#      - schema_migrations names + checksums identical (source mode)
#      - ledger balanced: no ledger transaction whose entries do not sum to zero
#      - cash/escrow reconciliation: companies.cash_paise/escrow_paise equal ledger sums
#        (same query as findLedgerMismatches in packages/core/src/ledger/ledger.ts)
#      - PostGIS available and all parcel geometries valid
#   4. Drop the scratch database (unless --keep).
#
# Connection: DATABASE_URL / PG* / BH_PG_MODE (scripts/lib/pg.sh). Only the scratch database is ever
# dropped; its name must contain "restore_check".
set -euo pipefail

BH_SCRIPT_NAME=restore-test
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pg.sh
source "$SCRIPT_DIR/lib/pg.sh"

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

source_db=""
from_file=""
keep=0
while (($#)); do
  case "$1" in
    --source-db) source_db="${2:?--source-db needs a value}" && shift ;;
    --from-file) from_file="${2:?--from-file needs a value}" && shift ;;
    --keep) keep=1 ;;
    -h | --help) usage && exit 0 ;;
    *) usage >&2 && die "unknown argument: $1" ;;
  esac
  shift
done

bh_pg_init
source_db="${source_db:-$PGDATABASE}"
scratch="${RESTORE_CHECK_DB:-bharat_harvest_restore_check}"
[[ "$scratch" == *restore_check* ]] || die "RESTORE_CHECK_DB must contain 'restore_check' (got '$scratch')"
[[ "$scratch" != "$source_db" ]] || die "scratch database must differ from the source"

work="$(mktemp -d "${TMPDIR:-/tmp}/bh-restore-test.XXXXXX")"
cleanup() {
  local rc=$?
  rm -rf "$work"
  if ((!keep)); then
    bh_psql postgres -c "DROP DATABASE IF EXISTS $(bh_ident "$scratch") WITH (FORCE)" >/dev/null 2>&1 || true
  fi
  if ((rc == 0)); then log "PASS"; else log "FAIL (exit $rc)"; fi
}
trap cleanup EXIT

failures=0
fail() {
  log "MISMATCH: $*"
  failures=$((failures + 1))
}

# "table count" per line, sorted, exact counts for every base table in public.
table_counts() {
  bh_psql "$1" -At -F ' ' -c "
    SELECT table_name,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                               false, true, '')))[1]::text::bigint
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY 1"
}

has_table() {
  [[ "$(bh_scalar "$1" "SELECT to_regclass($(bh_literal "public.$2")) IS NOT NULL")" == t ]]
}

migrations_fingerprint() {
  if has_table "$1" schema_migrations; then
    bh_scalar "$1" "SELECT coalesce(string_agg(name || ':' || checksum, ',' ORDER BY name), '') FROM schema_migrations"
  else
    printf 'none\n'
  fi
}

# ---------------------------------------------------------------------------------------------
# 1. Obtain a dump
if [[ -n "$from_file" ]]; then
  dump="$from_file"
  log "using existing dump $dump"
else
  has_db="$(bh_scalar postgres "SELECT 1 FROM pg_database WHERE datname = $(bh_literal "$source_db")")"
  [[ "$has_db" == 1 ]] || die "source database '$source_db' does not exist"
  table_counts "$source_db" >"$work/before.txt"
  src_migrations="$(migrations_fingerprint "$source_db")"
  dump="$(BACKUP_UPLOAD_CMD='' BACKUP_PREFIX=restore_test "$SCRIPT_DIR/backup.sh" \
    --database "$source_db" --dir "$work" --no-prune)"
  table_counts "$source_db" >"$work/after.txt"
fi

# ---------------------------------------------------------------------------------------------
# 2. Restore into the scratch database
"$SCRIPT_DIR/restore.sh" --target-db "$scratch" --drop-existing --yes "$dump"

# ---------------------------------------------------------------------------------------------
# 3. Checks
table_counts "$scratch" >"$work/restored.txt"
restored_tables="$(wc -l <"$work/restored.txt" | tr -d ' ')"
log "restored $restored_tables table(s)"

if [[ -z "$from_file" ]]; then
  if ! cmp -s "$work/before.txt" "$work/after.txt"; then
    log "source changed while dumping; accepting restored counts between before/after values"
  fi
  # Join before/after/restored on table name and compare.
  mismatches="$(awk '
    FILENAME == ARGV[1] { before[$1] = $2; next }
    FILENAME == ARGV[2] { after[$1] = $2; next }
    { restored[$1] = $2 }
    END {
      for (t in after) {
        lo = before[t] + 0; hi = after[t] + 0
        if (!(t in before)) lo = 0
        if (lo > hi) { tmp = lo; lo = hi; hi = tmp }
        if (!(t in restored)) { print t ": missing from restored database"; continue }
        if (restored[t] < lo || restored[t] > hi)
          print t ": restored " restored[t] " rows, source had " before[t] " (before) / " after[t] " (after)"
      }
      for (t in restored) if (!(t in after)) print t ": unexpected table in restored database"
    }' "$work/before.txt" "$work/after.txt" "$work/restored.txt")"
  if [[ -n "$mismatches" ]]; then
    while IFS= read -r line; do fail "$line"; done <<<"$mismatches"
  else
    log "row counts match for $(wc -l <"$work/after.txt" | tr -d ' ') table(s)"
  fi

  restored_migrations="$(migrations_fingerprint "$scratch")"
  if [[ "$src_migrations" != "$restored_migrations" ]]; then
    fail "schema_migrations differ (source: $src_migrations; restored: $restored_migrations)"
  else
    log "schema_migrations identical"
  fi
else
  # Every table in the archive's table of contents must exist after restore.
  bh_pg pg_restore --list <"$dump" |
    awk '$4 == "TABLE" && $5 == "public" { print $6 }' | sort -u >"$work/toc_tables.txt"
  awk '{ print $1 }' "$work/restored.txt" | sort -u >"$work/restored_names.txt"
  missing="$(comm -23 "$work/toc_tables.txt" "$work/restored_names.txt")"
  if [[ -n "$missing" ]]; then
    while IFS= read -r t; do fail "table $t from archive missing after restore"; done <<<"$missing"
  else
    log "all $(wc -l <"$work/toc_tables.txt" | tr -d ' ') archived table(s) present"
  fi
fi

if has_table "$scratch" ledger_entries; then
  unbalanced="$(bh_scalar "$scratch" "SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY 1 HAVING SUM(amount_paise) <> 0) u")"
  if [[ "$unbalanced" != 0 ]]; then
    fail "$unbalanced unbalanced ledger transaction(s)"
  else
    log "ledger balanced ($(bh_scalar "$scratch" 'SELECT count(*) FROM ledger_entries') entries)"
  fi
else
  log "no ledger_entries table (schema not migrated yet); skipping ledger checks"
fi

if has_table "$scratch" ledger_entries && has_table "$scratch" companies; then
  # Keep in sync with findLedgerMismatches() in packages/core/src/ledger/ledger.ts.
  recon="$(bh_scalar "$scratch" "
    WITH sums AS (
      SELECT company_id, account_code, SUM(amount_paise)::bigint AS total
      FROM ledger_entries WHERE company_id IS NOT NULL AND account_code IN ('cash', 'escrow')
      GROUP BY company_id, account_code
    )
    SELECT count(*)
    FROM companies c
    CROSS JOIN LATERAL (VALUES ('cash', c.cash_paise), ('escrow', c.escrow_paise)) AS a(account, denormalised)
    LEFT JOIN sums s ON s.company_id = c.id AND s.account_code = a.account
    WHERE a.denormalised <> COALESCE(s.total, 0)")"
  if [[ "$recon" != 0 ]]; then
    fail "$recon company cash/escrow balance(s) disagree with the ledger"
  else
    log "cash/escrow reconciliation OK ($(bh_scalar "$scratch" 'SELECT count(*) FROM companies') companies)"
  fi
fi

if [[ "$(bh_scalar "$scratch" "SELECT count(*) FROM pg_extension WHERE extname = 'postgis'")" == 1 ]]; then
  log "PostGIS $(bh_scalar "$scratch" 'SELECT postgis_lib_version()') available in restored database"
  if has_table "$scratch" land_parcels; then
    invalid="$(bh_scalar "$scratch" 'SELECT count(*) FROM land_parcels WHERE NOT ST_IsValid(geom)')"
    [[ "$invalid" == 0 ]] || fail "$invalid parcel geometr(y/ies) invalid after restore"
  fi
elif has_table "$scratch" land_parcels; then
  fail "postgis extension missing in restored database"
fi

if ((failures > 0)); then
  log "$failures check(s) failed"
  exit 1
fi
