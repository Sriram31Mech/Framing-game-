# ADR 0001: Modular monolith with a separate simulation worker

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

A solo/small team is building a persistent multiplayer simulation. Target load for the MVP is ~16
concurrent humans per region plus AI companies (DESIGN.md §9). Request handling must stay responsive
while daily ticks, offline catch-up and AI decisions run. Microservices would add deployment,
consistency and observability cost with no measured need.

## Decision

- One TypeScript codebase (pnpm workspace) with clear module boundaries: `packages/domain` (pure
  rules), `packages/contracts` (API/event schemas), `packages/core` (persistence, commands, ledger,
  simulation), thin `apps/server` (HTTP/WebSocket) and `apps/worker` (clock, ticks, AI).
- Two processes from **one image**: server and worker share `@bh/core` and the database, and
  communicate only through the database (rows, checkpoints, `domain_events`).
- Node apps are bundled with esbuild; third-party runtime dependencies stay external.

## Consequences

- Simple deployment (one image, one compose file) and transactional consistency through one
  Postgres instance.
- The worker can be restarted, scaled to a separate host, or split per region later without
  changing the server.
- Module boundaries are enforced by package structure and review, not network calls; we must keep
  `domain` free of I/O and `server` thin.
