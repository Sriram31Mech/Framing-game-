#!/usr/bin/env bash
# Starts an isolated API server for Playwright: fresh e2e database, its own port, dev auth on.
set -euo pipefail
cd "$(dirname "$0")/.."
export APP_ENV=test
export DATABASE_URL="${E2E_DATABASE_URL:-postgres://bh:bh_dev_password@localhost:54329/bharat_harvest_test_e2e}"
export PORT="${E2E_API_PORT:-8090}"
export SESSION_SECRET="e2e-only-session-secret-at-least-32-characters"
export ENABLE_DEV_AUTH=true ENABLE_DEV_ADMIN=true
export RATE_LIMIT_AUTH_PER_MIN=10000 RATE_LIMIT_COMMANDS_PER_MIN=10000 RATE_LIMIT_QUERIES_PER_MIN=100000
export REAL_SECONDS_PER_GAME_DAY=3600 LOG_LEVEL=warn PUBLIC_CLIENT_URL="http://localhost:${E2E_CLIENT_PORT:-5190}"
(cd packages/core && npx tsx scripts/reset-e2e-db.ts)
exec npx tsx apps/server/src/main.ts
