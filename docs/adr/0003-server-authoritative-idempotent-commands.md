# ADR 0003: Server-authoritative, idempotent commands

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

Clients are untrusted and networks are unreliable: requests are retried, duplicated and raced.
Economic exploits (forged prices, double purchases, replayed sales) must be impossible.

## Decision

- Clients send **intent** only. The server derives the acting company from the session, computes
  prices/costs/outcomes itself, and accepts client-sent prices only as guards (409
  `PRICE_CHANGED` when they differ).
- Every state-changing POST requires an `Idempotency-Key`. The key, request hash and response
  (including domain errors) are stored **in the same transaction** as the command's effects; a
  replay returns the original response, a different body with the same key returns 422
  `IDEMPOTENCY_KEY_REUSED`.
- AI companies use the same command layer with deterministic keys (`ai:<companyId>:<day>:<n>`).
- Commands are authenticated, authorised, validated with zod and rate-limited.

## Consequences

- Safe client retries and reconnects; concurrency losers get a clean 409 and are not charged.
- The load test (`tests/load`) replays commands to check idempotency end-to-end.
- `idempotency_keys` grows and needs a retention job.
