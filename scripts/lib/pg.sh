#!/usr/bin/env bash
# Shared helpers for scripts/backup.sh, scripts/restore.sh and scripts/restore-test.sh.
# Source this file; do not execute it.
#
# Connection settings (first match wins):
#   1. Standard libpq variables PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
#   2. DATABASE_URL (postgres://user:pass@host:port/db) — parsed into the PG* variables
#   3. Local dev defaults from docker-compose.yml (bh @ localhost:54329 / bharat_harvest)
#
# How the PostgreSQL client tools are run (BH_PG_MODE):
#   native  — pg_dump/pg_restore/psql from PATH (used inside the backup container)
#   compose — `docker compose exec -T <service>` into the database container, so no local
#             client install is needed and versions always match the server. Connects over the
#             container's local socket; PGHOST/PGPORT are ignored.
#   auto    — (default) native if a pg_dump with the server's major version is on PATH,
#             otherwise compose.
# BH_COMPOSE_FILE (default: <repo>/docker-compose.yml) and BH_DB_SERVICE (default: db) select the
# compose service.

# shellcheck disable=SC2034  # variables are consumed by the sourcing scripts
BH_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${BH_SCRIPT_NAME:-pg}" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# Decode %XX escapes (passwords in URLs are often percent-encoded).
urldecode() {
  local s="${1//+/ }"
  printf '%b' "${s//%/\\x}"
}

bh_parse_database_url() {
  local url="${DATABASE_URL:-}"
  [[ -n "$url" ]] || return 0
  local re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)'
  if [[ "$url" =~ $re ]]; then
    : "${PGUSER:=$(urldecode "${BASH_REMATCH[2]}")}"
    : "${PGPASSWORD:=$(urldecode "${BASH_REMATCH[4]}")}"
    : "${PGHOST:=${BASH_REMATCH[5]}}"
    : "${PGPORT:=${BASH_REMATCH[7]:-5432}}"
    : "${PGDATABASE:=${BASH_REMATCH[8]}}"
  else
    die "DATABASE_URL is not a postgres:// URL with user, host and database"
  fi
}

bh_pg_init() {
  bh_parse_database_url
  : "${PGHOST:=localhost}"
  : "${PGPORT:=54329}"
  : "${PGUSER:=bh}"
  : "${PGDATABASE:=bharat_harvest}"
  export PGHOST PGPORT PGUSER PGDATABASE
  if [[ -n "${PGPASSWORD:-}" ]]; then export PGPASSWORD; fi

  BH_COMPOSE_FILE="${BH_COMPOSE_FILE:-$BH_REPO_ROOT/docker-compose.yml}"
  BH_DB_SERVICE="${BH_DB_SERVICE:-db}"
  BH_PG_MODE="${BH_PG_MODE:-auto}"
  if [[ "$BH_PG_MODE" == auto ]]; then
    if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1 &&
      command -v psql >/dev/null 2>&1 && bh_native_version_ok; then
      BH_PG_MODE=native
    elif command -v docker >/dev/null 2>&1; then
      BH_PG_MODE=compose
    else
      die "no usable pg_dump on PATH and docker not available; set BH_PG_MODE"
    fi
  fi
  case "$BH_PG_MODE" in
    native | compose) ;;
    *) die "BH_PG_MODE must be native, compose or auto (got '$BH_PG_MODE')" ;;
  esac
}

# pg_dump must be >= the server major version; only trust the native tools if they can reach the
# server and are new enough.
bh_native_version_ok() {
  local client server
  client="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  server="$(psql -X -At -d postgres -c 'SHOW server_version_num' 2>/dev/null)" || return 1
  [[ -n "$server" ]] || return 1
  ((client >= server / 10000))
}

# bh_pg <tool> [args...] — run a PostgreSQL client tool with stdin/stdout passed through.
bh_pg() {
  local tool="$1"
  shift
  if [[ "$BH_PG_MODE" == native ]]; then
    "$tool" "$@"
  else
    local env_args=(-e "PGUSER=$PGUSER")
    if [[ -n "${PGPASSWORD:-}" ]]; then env_args+=(-e "PGPASSWORD=$PGPASSWORD"); fi
    docker compose -f "$BH_COMPOSE_FILE" exec -T "${env_args[@]}" "$BH_DB_SERVICE" "$tool" "$@"
  fi
}

# bh_psql <database> [psql args...] — psql with safe defaults (no psqlrc, stop on error).
bh_psql() {
  local db="$1"
  shift
  bh_pg psql -X -q -v ON_ERROR_STOP=1 -d "$db" "$@"
}

# bh_scalar <database> <sql> — single unaligned value.
bh_scalar() {
  bh_psql "$1" -At -c "$2"
}

# Quote a SQL identifier.
bh_ident() {
  printf '"%s"' "${1//\"/\"\"}"
}

# Quote a SQL string literal.
bh_literal() {
  printf "'%s'" "${1//\'/\'\'}"
}

bh_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# System databases our scripts never drop or restore into.
bh_is_protected_db() {
  case "$1" in
    postgres | template0 | template1) return 0 ;;
    *) return 1 ;;
  esac
}
