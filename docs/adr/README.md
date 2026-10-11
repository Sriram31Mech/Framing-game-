# Architecture Decision Records

Short records of decisions that shape the codebase. Format: context → decision → consequences.
Add a new numbered file for a new decision; supersede rather than rewrite accepted ones.

| ADR                                                      | Decision                                        | Status   |
| -------------------------------------------------------- | ----------------------------------------------- | -------- |
| [0001](0001-modular-monolith-and-worker.md)              | Modular monolith + separate simulation worker   | Accepted |
| [0002](0002-postgres-postgis-paise-ledger.md)            | PostgreSQL/PostGIS with an integer-paise ledger | Accepted |
| [0003](0003-server-authoritative-idempotent-commands.md) | Server-authoritative, idempotent commands       | Accepted |
| [0004](0004-deterministic-daily-tick.md)                 | Deterministic daily tick with checkpoints       | Accepted |
| [0005](0005-react-three-fiber-client.md)                 | React + three.js via React Three Fiber          | Accepted |
| [0006](0006-custom-postgis-image.md)                     | Custom multi-arch PostGIS image                 | Accepted |
