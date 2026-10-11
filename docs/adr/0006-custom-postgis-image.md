# ADR 0006: Custom multi-arch PostGIS image

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

Development happens on Apple Silicon (arm64) and production may run on arm64 VPSes, which are often
cheaper. The upstream `postgis/postgis` image is published for amd64 only.

## Decision

- `infra/docker/db/Dockerfile` extends the official multi-arch `postgres:17-bookworm` image and
  installs `postgresql-17-postgis-3` from the PGDG apt repository bundled in that image.
- Local development and production compose both build this image. CI integration tests use the
  upstream `postgis/postgis:17-3.5` service image because GitHub-hosted runners are amd64.
- The backup sidecar uses the same Postgres major version so `pg_dump` always matches the server.

## Consequences

- Identical database behaviour on arm64 and amd64.
- We own the image's patch cadence: Dependabot (docker, monthly) and periodic rebuilds pick up
  Postgres/PostGIS security updates.
- CI and local PostGIS minor versions may differ slightly; migrations must not rely on
  minor-version-specific PostGIS functions.
