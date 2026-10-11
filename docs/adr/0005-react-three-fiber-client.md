# ADR 0005: React + three.js via React Three Fiber for the client

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The game needs a custom isometric/oblique 3D world with architectural-quality presentation plus
dense management UI (dashboards, ledgers, markets). It ships first in the browser and later in a
desktop shell for Steam (TECH.md §1–2).

## Decision

- three.js for rendering, used declaratively through **@react-three/fiber** and **drei**, so world
  and UI share React state, data fetching (TanStack Query) and a small zustand store.
- Vite for development and builds; the production server serves the static build.
- Repeated objects use instancing; parcels and terrain are procedural to keep asset budgets small.

## Consequences

- One language and component model for 3D and UI; fast iteration in the browser.
- three.js is a renderer, not an engine: camera, picking, LOD and performance budgets are our
  responsibility and must be benchmarked on representative hardware.
- Desktop packaging (Electron) wraps the same build (see docs/STEAM.md).
