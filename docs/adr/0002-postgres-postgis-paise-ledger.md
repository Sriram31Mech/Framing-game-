# ADR 0002: PostgreSQL + PostGIS with an integer-paise double-entry ledger

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The game is an economy: ownership transfers, trades, contracts, loans and taxes must be exact,
auditable and safe under concurrency. Land parcels are polygons that need spatial queries.

## Decision

- PostgreSQL 17 is the single authoritative store; PostGIS stores parcel geometry.
- Money is **integer paise** (`BIGINT` in SQL, safe-integer `number` in TypeScript). No floats for
  money; rates use basis points with explicit rounding helpers in `@bh/domain`.
- Every money movement is a **balanced double-entry transaction** (`ledger_transactions` +
  `ledger_entries`), posted in the same database transaction as the state change. A deferred
  constraint trigger rejects unbalanced transactions at commit.
- `companies.cash_paise`/`escrow_paise` are denormalised for fast reads and must always equal the
  ledger sums; `findLedgerMismatches` (and `scripts/restore-test.sh`) verify this.
- Contested rows use `SELECT … FOR UPDATE` in deterministic order plus optimistic `version` checks.

## Consequences

- Reconciliation and audit are queries, not forensics; backups can be verified automatically.
- Writes are slightly heavier (several rows per money movement) — acceptable at MVP scale.
- Corrections are new balanced transactions, never edits of history.
