# Implementation Guide — Bharat Harvest MVP

Read with `docs/GDD.md` (product), `docs/DESIGN.md` (systems), `docs/TECH.md` (stack). This file records
the concrete decisions taken for the MVP build and is binding for all contributors.

## 1. Workspace

```
apps/client     Vite + React 19 + Three.js (@react-three/fiber, drei) + TanStack Query + zustand
apps/server     Fastify 5 HTTP + WebSocket gateway (thin: auth, validation, routing)
apps/worker     Simulation process: world clock, daily ticks, offline catch-up, AI companies, maintenance
packages/domain Pure deterministic rules (no I/O). Shared by client, server, worker.
packages/contracts  zod schemas for HTTP API + realtime events (client <-> server contract)
packages/core   Server-only game core: Postgres access, migrations runner, command layer, ledger,
                queries, auth/sessions, world bootstrap, simulation tick, AI scheduler
infra/migrations  Plain SQL migrations (NNNN_name.sql), applied by packages/core/src/db/migrate.ts
infra/docker      Dockerfiles, production compose, backup
tests/            Cross-package e2e (Playwright), load tests, cross-cutting integration tests
```

- TypeScript strict, ESM everywhere, `moduleResolution: Bundler`. Workspace packages export `src/*.ts`
  directly; Node apps run via `tsx` in dev and are bundled with esbuild (`scripts/build-node.mjs`) for prod.
- Imports between files inside a package: extensionless relative imports (`./foo`).
- Tests: Vitest. `*.test.ts` = unit (no DB). `*.int.test.ts` = integration (real Postgres via
  `TEST_DATABASE_URL`, helpers in `packages/core/test/helpers/db.ts`). Run `pnpm test` / `pnpm test:integration`.
- Local DB: `pnpm db:up` (docker compose, PostGIS 3 on port 54329; dev DB `bharat_harvest`, test DB `bharat_harvest_test`).

## 2. Units and conventions (non-negotiable)

- Money = integer **paise** (`number`, always `Number.isSafeInteger`); DB `BIGINT`. Never floats for money.
  Use `mulPaise`/`applyBps` from `@bh/domain` for rates; round half away from zero.
- Produce = integer **kg**. Quality = integer 0..100.
- Time = integer **game day**. 360-day year, 12 × 30-day months. Day 0 = 1 June, Year 1.
  Seasons: Kharif Jun–Oct, Rabi Nov–Feb, Zaid Mar–May.
- Map = local metres; x east, y south; region spans [-halfSize, halfSize] on both axes. Client maps y → three.js z.
- Ids: UUIDs for runtime entities; holdings have stable text ids `TN-<ac>-<nn>` (e.g. `TN-174-03`);
  segments `tn-ac-174`; markets `mandi-<district>` (Chennai: Koyambedu).
- World: the real map of Tamil Nadu — see `docs/DATA.md` (32 districts, 234 segments, ~2,000
  holdings measured in acres, district climate/soils/water, one mandi per district).

## 3. Simulation model

- `world_clock.game_day` is the current day. `advanceDay` processes the end of day D and moves to D+1 in
  ONE database transaction which also inserts `simulation_checkpoints(region, D+1)`. The checkpoint primary key
  makes a tick idempotent: a crashed/restarted/duplicated worker cannot apply a day twice. A Postgres
  advisory lock (per region) ensures one ticking worker at a time.
- Target day = floor((now − epoch_at) / real_seconds_per_game_day). The worker advances until caught up,
  in batches (`MAX_CATCHUP_DAYS_PER_BATCH`), oldest first. That IS offline catch-up: the world keeps
  moving while players are offline and while the server is down.
- Daily tick steps (in order): weather record → crop growth for every live plot (`advanceCropDay`, seeded
  by `rngFor(regionSeed, plotId, day)`) → irrigation costs → spoilage of expired lots → market price update
  + snapshot → listing/contract expiry & contract default → lease expiry → loan instalments (missed payment
  if cash insufficient: cash may go negative) → land tax on the 1st of each month → machinery depreciation &
  maintenance → solvency (`evaluateSolvency`; distress/bankruptcy) → yearly income tax on day-of-year 0 →
  checkpoint + `world.time_updated` event. AI companies act AFTER the day commits, through
  `executeCommand` with idempotency keys `ai:<companyId>:<day>:<n>` so a retry never double-acts.
- Bankruptcy: distressed after cash < 0; grace `DISTRESS_GRACE_DAYS`; then liquidation (land returns to
  state for `LIQUIDATION_RECOVERY` × base price, machinery at book × recovery, inventory sold to mandi,
  open listings cancelled, accepted contracts defaulted, loans written off), company restarted as
  'active' with `BANKRUPTCY_RESTART_GRANT_PAISE` and `bankruptcies + 1` (recovery path). Players get
  warning notifications on entering distress and at 14/7/3/1 days remaining.

## 4. Economy rules

- New human company: `STARTING_CASH_PAISE` + one random reserved starter plot (status `reserved`,
  granted free); once those run out, a random state holding for sale of at most
  `STARTER_GRANT_MAX_HA`; only if no such land is left, `NO_STARTER_PLOT_BONUS_PAISE` cash. Starting cash is posted as
  `world_treasury → cash` (equity contribution) so the ledger reconciles from day one.
- Land: state-owned parcels are `for_sale` at `base_price`. Owners may list (`for_sale` with
  `list_price`), delist, or sell back to the state for `LAND_SELL_TO_STATE_FRACTION` × base price.
  Leasing: state parcels may be leased for 1–3 seasons (120 days each) at `lease_rent` per season,
  paid upfront. Parcels with a live crop cannot change hands. Land tax applies to owned + leased land.
- Purchase concurrency: lock parcel row `FOR UPDATE`, check `version = expectedVersion`, status,
  price = expected; debit buyer, credit seller (or treasury), bump version — one transaction. The loser
  of a race gets 409 CONFLICT and is not charged.
- Planting requires ownership or active lease, sowing month open, no live plot, funds for planting cost
  (seed + sowing labour [+ fertiliser], machinery multipliers). Irrigation requires water access or a
  pump set. Harvest creates an inventory lot (`expires_day` = day + shelfLife × warehouse multiplier),
  charges harvest labour, moves accumulated cost basis into inventory value.
- Mandi sale: one statewide (Tamil Nadu) price per crop shared by every mandi (all mandi rows of an
  item hold the same state; a sale at any mandi moves it, rows locked in market_id order);
  `quoteMarketSale` + `transportCostPaise` from the company's nearest owned/leased parcel
  (or 5 km if none) to the market; slippage guard `minNetUnitPricePaise`; FIFO consumption of available
  (unreserved) stock, lowest-quality-first for the market; fee is a money sink.
- P2P listings: seller reserves stock from one lot; buyer pays `unit × qty`; seller receives minus
  `P2P_TRADE_FEE_BPS` (sink); buyer receives a new lot with the same quality/expiry. Unit price must
  lie in `p2pPriceBand(statewide Tamil Nadu price)`. Cannot buy own listing.
- Contracts (buy-side): buyer escrows `total` (cash → escrow). Any other company accepts with matching
  `version` + `termsHash` (sha256 of canonical terms). Seller delivers before `delivery_by_day` from
  available stock with quality ≥ min: escrow → seller cash (minus fee), buyer gets a lot. Unaccepted at
  deadline → expired, escrow refunded. Accepted but undelivered at deadline → defaulted: escrow refunded
  and seller pays `CONTRACT_DEFAULT_PENALTY_BPS` × total to buyer (cash may go negative → distress).
  Buyer may cancel only while `open`.
- Loans: from `world_bank`; principal ≤ `maxBorrowablePaise`; EMI every 30 days from start; each payment
  split interest (expense) / principal (liability). Early repayment allowed, no penalty.
- Every money movement is a balanced ledger transaction posted with `postLedger` in the same DB
  transaction as the state change. `findLedgerMismatches` must always return [].

## 5. API and security

- See `packages/contracts/src/api.ts` (endpoints, schemas, error codes) and `events.ts` (WebSocket).
- Sessions: random 32-byte token returned once; DB stores HMAC-SHA256(SESSION_SECRET, token). Passwords:
  Node `crypto.scrypt` (N=2^15, r=8, p=1, 16-byte salt, 64-byte key), constant-time compare.
- Dev auth/admin are refused in production (`loadConfig` throws). Steam auth validates tickets server-side
  via `ISteamUserAuth/AuthenticateUserTicket/v1` using `STEAM_WEB_API_KEY`; only enabled when configured.
- Idempotency: `idempotency_keys` row is written in the SAME transaction as the command's effects.
  Domain errors are also stored (so a retried failed purchase returns the same failure).
- Rate limits: auth 10/min/IP; commands 120/min/session; queries 600/min/session.
- Helmet, strict CORS (`PUBLIC_CLIENT_URL`), 64 KB body limit, no stack traces to clients, pino
  redaction of `authorization`, `cookie`, `password`, `token`, `ticket`.

## 6. Ownership map for parallel development

| Area | Owner | Paths |
| --- | --- | --- |
| Rules | domain agent | `packages/domain/**` |
| Commands, queries, auth, bootstrap, HTTP/WS | backend agent | `packages/core/src/{backend.ts,commands,queries,auth,world/bootstrap*.ts,companies}`, `apps/server/**`, new migrations `infra/migrations/0002+` |
| Daily tick, catch-up, AI, worker | simulation agent | `packages/core/src/{simulation,ai}/**`, `apps/worker/**` |
| Client | client agent | `apps/client/**` |
| Infra, CI, backup, docs | infra agent | `infra/docker/**`, `.github/**`, `scripts/**` (except build-node.mjs), `README.md`, `docs/RUNBOOK.md` |

Shared foundation (change only with coordination): `packages/contracts/**`, `packages/core/src/{config,errors,db,ledger,events,world/clock,commands/types}.ts`, `infra/migrations/0001_init.sql`, root configs.
