# Bharat Harvest

A persistent, multiplayer agricultural business simulation set on the real map of Tamil Nadu (32 districts, 234 areas, district soils, rainfall and seasons; see `docs/DATA.md`). Players start with a small budget and a starter plot, inspect land
suitability, buy or lease parcels, grow and harvest crops, sell at the mandi or to other players,
take loans and grow a company — alongside rule-based AI companies in one shared economy. The world
keeps advancing while players are offline.

Target platform is PC/Steam; development happens in the browser first. Design documents:
[GDD](docs/GDD.md) (product), [DESIGN](docs/DESIGN.md) (systems), [TECH](docs/TECH.md) (stack),
[IMPLEMENTATION](docs/IMPLEMENTATION.md) (binding MVP decisions), [RUNBOOK](docs/RUNBOOK.md)
(operations), [STEAM](docs/STEAM.md) (packaging plan) and [ADRs](docs/adr/).

> **Status:** MVP in development. Simulation values are calibrated for gameplay, not agronomic or
> financial advice.

## Screenshots

_Placeholder — add captures of the region view, parcel inspector and company dashboard to
`docs/images/` once the art slice lands._

## Architecture

A TypeScript modular monolith: one API process, one simulation worker, one PostgreSQL/PostGIS
database. The server is authoritative for every economic outcome; the client only renders and
submits commands.

```mermaid
flowchart LR
  subgraph Browser / Steam shell
    C[apps/client<br/>React + three.js]
  end
  C -- "HTTPS /api/v1 (REST, Idempotency-Key)" --> E[Caddy<br/>TLS edge]
  C -- "WSS /api/v1/ws (events)" --> E
  E --> S[apps/server<br/>Fastify API + WebSocket<br/>serves client build]
  S --> CORE[packages/core<br/>commands · ledger · queries · auth]
  W[apps/worker<br/>world clock · daily tick · AI companies] --> CORE
  CORE --> DOM[packages/domain<br/>pure deterministic rules]
  S -. "schemas" .- CON[packages/contracts<br/>zod API + events]
  C -. "schemas" .- CON
  CORE --> DB[(PostgreSQL 17 + PostGIS<br/>ledger · parcels · checkpoints)]
  B[backup sidecar<br/>pg_dump + restore drill] --> DB
```

- **Money** is integer paise in a double-entry ledger; every state change and its ledger postings
  commit in one transaction. **Time** is integer game days advanced by an idempotent, checkpointed
  daily tick. See the [ADRs](docs/adr/) for the reasoning.

## Quick start (development)

Prerequisites: **Node.js 22+**, **pnpm 9** (`corepack enable`), **Docker** (with Compose v2).

```bash
cp .env.example .env          # local-only defaults; never commit real secrets
pnpm install
pnpm db:up                    # PostgreSQL 17 + PostGIS on localhost:54329 (dev + test databases)
pnpm db:migrate               # apply infra/migrations
pnpm db:seed                  # bootstrap the region, markets and AI companies
pnpm dev                      # server :8080, worker, client :5173 (Vite)
```

Open http://localhost:5173. With `ENABLE_DEV_AUTH=true` (the `.env.example` default) you can sign in
with just a username.

### Tests and checks

| Command                 | What it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `pnpm typecheck`        | `tsc` in every workspace package                                       |
| `pnpm lint`             | ESLint (typescript-eslint, react-hooks)                                |
| `pnpm format:check`     | Prettier                                                               |
| `pnpm test`             | Vitest unit tests (`*.test.ts`, no database)                           |
| `pnpm test:integration` | Vitest integration tests (`*.int.test.ts`) against `TEST_DATABASE_URL` |
| `pnpm e2e`              | Playwright end-to-end tests in `tests/e2e`                             |
| `pnpm load`             | Load test against a running server (see below)                         |
| `pnpm ci`               | typecheck + lint + format + unit tests + build                         |

Integration tests use `bharat_harvest_test` (created by `infra/docker/initdb` on first `db:up`) and
refuse to touch a database whose name does not contain `_test`.

### Load test

```bash
pnpm load                                     # 16 players, 120 s, http://localhost:8080
pnpm load --players 64 --duration 300 --p95 300 --out tests/load/results/64p.json
```

Simulated players log in (dev-login when enabled, else register + password), create a company, keep
a WebSocket open, poll world/map/overview/markets and issue idempotent commands (buy land, plant,
harvest, sell, list, buy listings — including replaying a command to check idempotency). The run
prints p50/p95/p99 per endpoint, errors by code, throughput and WebSocket event counts, and exits
non-zero on any 5xx/network error, idempotency mismatch, p95 above `--p95` ms, or if not every
player became active. Auth is rate-limited to 10/min per IP, so allow ~6 s of `--ramp` per player
(e.g. `--ramp 75` for 16). Each run founds new companies and a region caps human companies
(`regions.max_human_companies`, 24), so run against a freshly seeded database.

### Backups locally

```bash
scripts/backup.sh                             # dump the dev DB to ./backups (+ .sha256)
scripts/restore-test.sh                       # dump → restore into a scratch DB → verify
scripts/restore.sh --target-db my_copy backups/<file>.dump
```

The scripts run the PostgreSQL tools inside the compose `db` container when no matching local
`pg_dump` is installed (`BH_PG_MODE=compose`).

## Project layout

```
apps/client         Vite + React 19 + three.js (@react-three/fiber, drei) + TanStack Query + zustand
apps/server         Fastify 5 HTTP API + WebSocket gateway (thin: auth, validation, routing)
apps/worker         World clock, daily ticks, offline catch-up, AI companies
packages/domain     Pure deterministic game rules (crops, suitability, growth, weather, prices, finance)
packages/contracts  zod schemas for the HTTP API and realtime events
packages/core       Server-only core: Postgres, migrations, commands, ledger, queries, simulation
infra/migrations    Plain SQL migrations (NNNN_name.sql)
infra/docker        db image, app/backup Dockerfiles, production compose, Caddy config
scripts             build-node.mjs (esbuild bundler), backup/restore scripts
tests               e2e (Playwright), load, cross-package integration tests
docs                GDD, DESIGN, TECH, IMPLEMENTATION, RUNBOOK, STEAM, ADRs
assets              Art sources and licence/provenance records
```

## Configuration

All configuration is environment variables, validated at start-up by
[`packages/core/src/config.ts`](packages/core/src/config.ts). Unsafe production settings fail fast.

| Variable                                                                                 | Default                 | Meaning                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `APP_ENV`                                                                                | `development`           | `development` \| `test` \| `staging` \| `production`                                             |
| `LOG_LEVEL`                                                                              | `info`                  | pino level (`fatal` … `trace`, `silent`)                                                         |
| `PORT`                                                                                   | `8080`                  | API server port                                                                                  |
| `HOST`                                                                                   | `0.0.0.0`               | API bind address                                                                                 |
| `PUBLIC_CLIENT_URL`                                                                      | `http://localhost:5173` | Allowed CORS origin / public URL of the client                                                   |
| `DATABASE_URL`                                                                           | — (required)            | `postgres://user:pass@host:port/db`                                                              |
| `DATABASE_POOL_MAX`                                                                      | `20`                    | Max pooled connections per process                                                               |
| `SESSION_SECRET`                                                                         | — (required)            | HMAC key for session tokens. ≥ 32 chars and not a placeholder in staging/production              |
| `SESSION_TTL_HOURS`                                                                      | `720`                   | Session lifetime                                                                                 |
| `ENABLE_DEV_AUTH`                                                                        | `false`                 | Username-only login. **Refused when `APP_ENV=production`**                                       |
| `ENABLE_DEV_ADMIN`                                                                       | `false`                 | Dev endpoints (time fast-forward). **Refused when `APP_ENV=production`**                         |
| `ENABLE_PASSWORD_AUTH`                                                                   | `true`                  | Username + password accounts                                                                     |
| `STEAM_APP_ID`                                                                           | empty                   | Steam App ID; Steam login is enabled only when this and the key are set                          |
| `STEAM_WEB_API_KEY`                                                                      | empty                   | Steam Web API publisher key (server-side ticket validation). Secret                              |
| `RATE_LIMIT_AUTH_PER_MIN` / `RATE_LIMIT_COMMANDS_PER_MIN` / `RATE_LIMIT_QUERIES_PER_MIN` | `10` / `120` / `600`    | Per-minute limits (auth per IP; commands/queries per session)                                    |
| `REGION_ID`                                                                              | `tamil-nadu`            | Region simulated by this deployment                                                              |
| `REAL_SECONDS_PER_GAME_DAY`                                                              | `120`                   | Wall-clock seconds per game day                                                                  |
| `WORKER_POLL_MS`                                                                         | `2000`                  | Worker clock poll interval                                                                       |
| `MAX_CATCHUP_DAYS_PER_BATCH`                                                             | `30`                    | Days processed per catch-up batch after downtime                                                 |
| `AI_COMPANY_COUNT`                                                                       | `3`                     | Rule-based AI companies to bootstrap                                                             |
| `SERVE_CLIENT_DIR`                                                                       | empty                   | If set, the server serves the built client from this directory (production image: `/app/client`) |
| `TRUST_PROXY`                                                                            | `false`                 | Trust `X-Forwarded-*` from the reverse proxy (set `true` behind Caddy)                           |
| `MIGRATIONS_DIR`                                                                         | `infra/migrations`      | SQL migrations directory (production image: `/app/migrations`)                                   |
| `TEST_DATABASE_URL`                                                                      | local `_test` DB        | Integration-test database (must contain `_test`)                                                 |

Backup variables (`BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_MIN_KEEP`, `BACKUP_AT`,
`BACKUP_UPLOAD_CMD`, `RESTORE_DRILL_WEEKDAY`) are documented in [`scripts/backup.sh`](scripts/backup.sh)
and [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Production deployment (summary)

One small VPS (2 vCPU / 4 GB is plenty for the MVP target of ~16 concurrent players per region)
running [`infra/docker/compose.prod.yml`](infra/docker/compose.prod.yml):

- **db** — PostgreSQL 17 + PostGIS (our multi-arch image), private network only, tuned for the box.
- **migrate** — one-shot migration run; server and worker start only after it succeeds.
- **server** — API + WebSocket + built client, non-root, read-only filesystem.
- **worker** — simulation clock and AI companies.
- **caddy** — automatic HTTPS for `$DOMAIN`, security headers, blocks `/metrics` and dev routes.
- **backup** — daily `pg_dump` with checksums, retention and an optional off-site upload hook, plus
  a weekly automated restore drill.

```bash
cp infra/docker/production.env.example infra/docker/.env.production   # fill in; never commit
docker compose -f infra/docker/compose.prod.yml --env-file infra/docker/.env.production build
docker compose -f infra/docker/compose.prod.yml --env-file infra/docker/.env.production up -d
```

Full procedures (deploy, rollback, migrations, backups, monitoring, incidents) are in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Security notes

- This repository is public. Commit only placeholders (`.env.example`,
  `infra/docker/production.env.example`); real `.env*` files are git- and docker-ignored.
- The server is authoritative: clients never send authoritative prices, balances or outcomes;
  commands are authenticated, rate-limited and idempotent (`Idempotency-Key`), and money moves only
  through balanced ledger transactions.
- Dev auth/admin are refused in production by configuration validation and blocked at the proxy.
- Session tokens are stored only as HMACs; passwords use scrypt. Steam tickets are validated
  server-side; the Web API key never reaches the client.
- Report vulnerabilities privately to the maintainer rather than in public issues.

## License

All rights reserved unless a licence file states otherwise. Third-party assets and data are tracked
in [`assets/licenses/README.md`](assets/licenses/README.md); inspiration titles named in the design
documents grant no rights to their code, art or branding.

Map boundaries © DataMeet contributors, CC BY 2.5 India.
