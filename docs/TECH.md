# Technical Design Document (TECH)

## Bharat Harvest --- Implementation Stack and Delivery Plan

**Target:** PC/Steam multiplayer simulation; Three.js is the preferred
rendering approach. This is a practical baseline, not a claim that every
provider or free tier will remain free. Recheck current versions,
Steamworks details, licenses, and hosting costs when implementation
starts.

## 1. Recommended stack

### Client

-   TypeScript.
-   Three.js for rendering, camera, picking, and world presentation.
-   React + Vite for menus, management panels, dashboards, and build
    tooling.
-   WebSocket client for relevant live updates.
-   Blender for inspecting and optimizing 3D assets.
-   A state-management library only if plain React state and a small
    store become insufficient.

### Server

-   Node.js + TypeScript.
-   A structured HTTP framework such as Fastify or NestJS; start with
    the simpler option that the developer can maintain.
-   REST for queries/commands; WebSockets for selected live events.
-   Separate worker process for simulation ticks, offline catch-up, AI
    decisions, imports, and notifications.
-   Shared domain types/contracts where they do not expose server-only
    code.

### Data and deployment

-   PostgreSQL as the authoritative transactional database.
-   PostGIS for parcel geometry and spatial queries.
-   Database migrations in version control.
-   Docker Compose for local database/backend development.
-   Object/static asset storage as needed.
-   Structured logging, health checks, backups, and restoration tests.

### PC/Steam

Develop in a browser first for iteration speed. Evaluate Electron
packaging and Steam integration early in a proof of concept; confirm
memory, startup, native integration, and distribution behavior before
locking packaging. Use supported Steamworks authentication on the
server. Keep internal account IDs separate from Steam identity and never
expose server secrets in the client.

### Quality tools

TypeScript strict mode, ESLint, Prettier, Vitest or equivalent, API
integration tests, Playwright for selected UI/e2e tests, and CI checks.

## 2. Why Three.js

Three.js fits a custom isometric/oblique 3D world with
architectural-style visuals and a TypeScript UI. It offers control over
camera, materials, lighting, asset loading, procedural fields, and
selection.

It is a rendering library rather than a complete game engine.
Game-specific systems, asset workflows, performance management, desktop
packaging, and some animation/physics conventions require deliberate
implementation. Validate the camera, asset pipeline, scene performance,
and Steam packaging in a small prototype before scaling content.

## 3. Suggested repository layout

``` text
bharat-harvest/
├── apps/
│   ├── client/src/{app,ui,world,features,api,realtime,assets}/
│   ├── server/src/{api,auth,commands,modules,persistence,realtime,observability}/
│   └── worker/src/{simulation,ai,data-import,notifications}/
├── packages/
│   ├── domain/
│   ├── contracts/
│   ├── config/
│   └── simulation-data/
├── assets/{source,processed,textures,models,licenses}/
├── data/{reference,seed}/
├── infra/{docker,migrations,deployment}/
├── docs/{GDD.md,DESIGN.md,TECH.md,adr/}
├── tests/{integration,load,simulation}/
├── .env.example
├── docker-compose.yml
├── package.json
└── pnpm-workspace.yaml
```

Do not create every module before it is needed. Keep clear boundaries,
but avoid premature microservices.

## 4. Environment and secrets

Use environment variables/secret management for `DATABASE_URL`,
`APP_ENV`, `PORT`, public client URL, session signing secret, Steam app
ID and server-only validation configuration, logging level, simulation
settings, import configuration, and backup configuration.

Commit only fake placeholders in `.env.example`. Never commit Steam
secrets, database passwords, private tokens, or production credentials.
Provide a development authentication adapter, but prevent it from
running in production.

## 5. Data implementation rules

-   Use relational tables for ownership, inventory, trades, and
    finances.
-   Use decimal-safe numeric types or integer minor units for money.
-   Store timestamps in UTC and maintain explicit world simulation time.
-   Use PostGIS geometry for parcels.
-   Add foreign keys, uniqueness constraints, migrations, and
    appropriate indexes.
-   Use locks or optimistic version checks for contested records.
-   Keep imported reference data separate from live simulation state.
-   Version crop definitions, suitability formulas, and simulation
    rules.
-   Record dataset source, license, version, import time, units,
    transformations, and checksum.

## 6. API outline

Use a versioned prefix such as `/api/v1`.

**Queries** - `GET /api/v1/me` - `GET /api/v1/regions/:regionId/map` -
`GET /api/v1/parcels/:parcelId` -
`GET /api/v1/parcels/:parcelId/suitability` -
`GET /api/v1/companies/:companyId/overview` -
`GET /api/v1/companies/:companyId/ledger` -
`GET /api/v1/companies/:companyId/inventory` -
`GET /api/v1/markets/:marketId/prices` -
`GET /api/v1/markets/:marketId/listings`

**Commands** - `POST /api/v1/parcels/:parcelId/purchase` -
`POST /api/v1/parcels/:parcelId/lease` - `POST /api/v1/crop-plans` -
`POST /api/v1/crop-plans/:cropPlanId/plant` -
`POST /api/v1/crop-plots/:cropPlotId/harvest` -
`POST /api/v1/market-listings` -
`POST /api/v1/market-listings/:listingId/purchase` -
`POST /api/v1/contracts` - `POST /api/v1/contracts/:contractId/accept`

These are endpoint examples; finalize schemas during implementation.
Every command must be validated and protected against duplicate
execution.

## 7. Realtime events

Use WebSockets for meaningful updates, not every object transform. Event
examples: `company.updated`, `parcel.ownership_changed`,
`crop.stage_changed`, `crop.harvest_ready`, `market.price_updated`,
`trade.completed`, `contract.updated`, `notification.created`,
`world.time_updated`.

Events need stable IDs, schema versions, timestamps, and relevant entity
IDs. If a client misses events, it refetches authoritative state. The
database remains the source of truth.

## 8. Simulation and agricultural model

Use daily crop progression, routine costs, market aggregation, spoilage,
and selected environmental changes; seasonal transitions update planting
windows and demand; transactions resolve immediately; AI decisions run
in bounded jobs. Persist checkpoints and make jobs retry-safe.

Crop requirements should be data-driven: temperature, rainfall/water,
soil texture, drainage, pH, fertility, elevation/slope where relevant,
and growing season. Start with explainable weighted suitability and
penalties, then a predicted yield range. Calibrate with sourced
agricultural data and label it as a game simulation, not a precise
agronomic guarantee. Tea, for example, should depend on elevation,
temperature, rainfall, soil acidity, drainage, and water rather than a
hard-coded state association.

## 9. Finance and transaction safety

-   Never accept a final price or balance from the client.
-   Post ledger entries in the same transaction as money/inventory
    changes.
-   Keep transfers balanced and reconcile summaries.
-   Use idempotency keys for purchases, sales, payments, and contract
    actions.
-   Reserve inventory for listings and contracts.
-   Test simultaneous purchases, replayed requests, forged prices, and
    negative-stock attempts.
-   Model loan payments, interest, depreciation, and taxes as explicit
    events/entries.

## 10. 3D art pipeline

**Locked art direction:** hybrid stylized-realistic, rotatable isometric
camera with zoom/close inspection, detailed environments, benchmarked
against the supplied Emons logistics website reference.

1.  Write an asset brief/reference board for each family.
2.  Use AI for concepts, textures, or model generation where useful.
3.  Use licensed reusable assets where commercial terms permit.
4.  Inspect/correct in Blender: scale, pivots, orientation, UVs,
    materials, topology, and texture seams.
5.  Export consistent glTF/GLB assets.
6.  Test in Three.js with correct lighting, selection, and performance.
7.  Record source and license in `assets/licenses/`.
8.  Create LODs and simplify distant/repeated objects.

Use procedural generation for crop rows, fields, parcel fills, repeated
vegetation, fences, roads, and irrigation segments. Reserve high-detail
hero assets for tractors, major machinery, warehouses, processing
plants, markets, and regional architecture. Do not generate a unique
model for every crop instance.

Performance practices: instancing, LOD, frustum/distance culling,
progressive loading, shared materials, optimized textures/geometry,
restrained dynamic lighting, and profiling on target hardware.

## 11. Hosting and cost

Near-zero initial budget means prototype locally first. Use Docker
Compose for local services, then a private test deployment. Compare
current free-tier sleep behavior, storage, egress, database limits,
backup options, and reliability before choosing a provider; do not
assume a free tier is permanent.

Before public tests: measure CPU/RAM, database load, bandwidth, storage
growth, and tick duration; configure spending alerts, health checks,
backups, and restore tests. Recommended initial shape: one application
deployment, PostgreSQL/PostGIS, and a worker process. Use a managed
database plus application server if affordable and reliable; otherwise
use a small VPS with explicit backup/security controls. Keep migration
paths portable.

## 12. Delivery sequence

1.  Create TypeScript workspace, lint/test scripts, and CI.
2.  Build a small Three.js scene: camera, lighting, selection, parcel
    grid, a few buildings/vehicles.
3.  Add PostgreSQL/PostGIS and migrations.
4.  Add health/version endpoints and structured logging.
5.  Implement accounts/companies and development authentication.
6.  Implement land inspection, suitability, purchase, and concurrency
    tests.
7.  Implement crops, growth, harvest, and offline catch-up.
8.  Implement inventory, market sale, and balanced ledger.
9.  Add one rule-based AI company.
10. Add Steam identity and reconnect behavior.
11. Add one server-authoritative player trade/contract.
12. Build and optimize the detailed art slice.
13. Add backups, observability, security/load tests, and Steam
    packaging.

Each milestone must remain runnable. Do not build all crops, screens,
and regions before the first complete gameplay loop works.

## 13. Definition of done

A feature is done when domain rules and migrations are documented,
server validation exists, tests cover important outcomes,
retry/concurrency behavior is defined, client loading/error/stale states
work, failures can be diagnosed, the feature survives restart, and asset
provenance is recorded.

## 14. Risks and mitigations

  -----------------------------------------------------------------------
  Risk                                Mitigation
  ----------------------------------- -----------------------------------
  Scene too heavy                     Benchmark early; instance repeated
                                      objects; use LOD/culling

  AI assets inconsistent              Blender validation and standardized
                                      scale/materials

  Economy exploits                    Server authority, transactions,
                                      idempotency, audit trail

  Duplicate offline ticks             Persistent checkpoints and
                                      idempotent jobs

  Free hosting unreliable             Portability, backups, monitoring,
                                      measured capacity

  Poor source data                    Versioned imports, provenance,
                                      visible uncertainty

  Solo scope too large                One region, small crop set, one AI,
                                      one complete trade loop

  Premature distributed architecture  Modular monolith; split only after
                                      measurement
  -----------------------------------------------------------------------

## 15. Inspirations and technical references

**Game/product inspiration:** Farming Simulator (farm operations),
Workers & Resources: Soviet Republic (production systems), Cities:
Skylines (spatial readability), Transport Fever 2 (logistics), Anno
(production chains), OpenTTD (economic transport), EVE Online
(player-driven markets), and the user's Emons 3D logistics website
reference (architectural scene quality and polished interaction).

**Documentation to consult:** official Three.js docs/examples,
PostgreSQL/PostGIS docs, Steamworks documentation, Blender glTF export
docs, and official docs for the chosen Node.js server framework. Verify
current versions, APIs, licenses, and terms before adoption. Inspiration
does not grant permission to copy proprietary code, art, branding, or
assets.

## 16. Final recommendation

Build a Three.js + TypeScript client, TypeScript modular-monolith
backend, PostgreSQL/PostGIS persistence, and a persistent
worker/simulation scheduler. Prove one polished Indian region and the
complete loop---inspect land, acquire it, grow a crop, harvest, sell,
account for the result, and trade with another player---before scaling
map size or adding advanced industries.
