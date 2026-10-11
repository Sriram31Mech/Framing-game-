# ADR 0004: Deterministic daily tick with persistent checkpoints

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The world advances while players are offline and while servers are down. A crashed, restarted or
duplicated worker must never apply a day twice or skip one, and simulation results must be
reproducible for testing and debugging.

## Decision

- Time is an integer game day; the target day is derived from wall-clock time and
  `REAL_SECONDS_PER_GAME_DAY`.
- `advanceDay` processes one day in **one database transaction** and inserts
  `simulation_checkpoints(region, day)`; the primary key makes the tick idempotent. A per-region
  advisory lock ensures a single ticking worker.
- Catch-up runs oldest-first in batches (`MAX_CATCHUP_DAYS_PER_BATCH`).
- Randomness comes from seeded RNG (`rngFor(regionSeed, entityId, day)`), so a day's outcome is a
  pure function of state + seed.

## Consequences

- Restarting the worker is always safe; downtime is recovered automatically.
- Tick duration must stay well below the real-time day length; tick duration and backlog are
  monitored (RUNBOOK §6).
- Rule changes are versioned (`ruleset_versions`) so replays and comparisons remain meaningful.
