# System Design Document (DESIGN)

## Bharat Harvest --- System Architecture and Game Systems

**Purpose:** Define system boundaries and interaction rules. Read with
`GDD.md` for product intent and `TECH.md` for implementation choices.

## 1. Principles

-   Server-authoritative shared state and economy.
-   Client renders and requests actions; it never decides final
    ownership, balances, prices, yields, or transaction success.
-   Modular monolith first; split services only when measured scale
    requires it.
-   AI companies use the same command validation as players.
-   Persistent simulation clock independent of client sessions.
-   External reference data is cached, versioned, and never required
    live for ordinary gameplay.
-   Every economic change is auditable and retry-safe.
-   Prefer deterministic, testable simulation rules over expensive
    runtime AI calls.

## 2. Logical architecture

``` mermaid
flowchart TB
  Client[Three.js + React Client] --> API[HTTP API / WebSocket Gateway]
  API --> Auth[Identity and Company Access]
  API --> Cmd[Validated Command Layer]
  Cmd --> Land[Land and Ownership]
  Cmd --> Farm[Farming and Crop Simulation]
  Cmd --> Market[Market and Trading]
  Cmd --> Inv[Inventory and Logistics]
  Cmd --> Fin[Finance and Ledger]
  AI[AI Company Scheduler] --> Cmd
  Clock[Persistent World Clock] --> Tick[Simulation Tick Coordinator]
  Tick --> Farm
  Tick --> Market
  Tick --> AI
  Land --> DB[(PostgreSQL + PostGIS)]
  Farm --> DB
  Market --> DB
  Inv --> DB
  Fin --> DB
  Cmd --> Events[Domain Events / Outbox]
  Events --> Notify[Notifications / Activity Feed]
  Import[Reference Data Import] --> RefData[(Versioned Reference Data)]
  RefData --> Land
  RefData --> Farm
```

This is a logical view; the MVP can deploy the API and modules together.

## 3. Module responsibilities

-   **Client:** 3D rendering, camera, selection, UI panels, command
    submission, and display of server-confirmed state.
-   **Identity/company:** Steam identity mapping, accounts, company
    membership, permissions, sessions, and reconnect.
-   **Command layer:** authenticate, authorize, validate, rate-limit,
    check current state, execute transactions, enforce idempotency, and
    emit events.
-   **World/land:** regions, parcel geometry, ownership, purchase/lease,
    improvements, access, and parcel versioning.
-   **Environmental data:** normalized climate, soil, water, elevation,
    crop requirements, suitability score, yield ranges, source
    provenance, and fallback data.
-   **Farming:** crop plans, growth stages, operations, inputs,
    environmental modifiers, harvest, and offline catch-up.
-   **Inventory/logistics:** stock lots, quality, location, capacity,
    spoilage, reservations, transport, and delivery.
-   **Market/trading:** prices, listings, contracts, leases, settlement,
    fees, and market safeguards.
-   **Finance:** ledger, cash flow, P&L, balance sheet, loans, interest,
    depreciation, taxes, and reconciliation.
-   **AI companies:** bounded decision scheduling and command submission
    through the same rules as players.
-   **Simulation scheduler:** daily/seasonal jobs, contract deadlines,
    loan events, checkpoints, recovery, and retry safety.
-   **Notifications:** persistent event feed, unread status, offline
    summaries, and duplicate suppression.
-   **Data import:** scheduled imports, validation, unit normalization,
    versioning, licensing metadata, and rollback to a known-good
    dataset.

## 4. Time model

Recommended hybrid: - **Daily tick:** crop progression, routine costs,
market aggregation, spoilage, selected weather/environment changes. -
**Seasonal transitions:** planting windows, crop calendars, and seasonal
market effects. - **Event-driven actions:** purchases, sales, leases,
contract acceptance, and harvest actions resolve immediately. -
**Offline catch-up:** process elapsed intervals from a persistent
checkpoint in chronological order, batching where safe.

The real-time/game-time ratio remains configurable. Persist the last
completed tick and ruleset version. Jobs must be idempotent so a restart
does not apply a tick twice. Do not simulate every animation frame while
players are offline.

## 5. Core workflows

### Land purchase

1.  Client submits parcel ID, expected parcel version, and idempotency
    key.
2.  Server verifies company access, sale status, price, restrictions,
    and funds.
3.  A database transaction locks or version-checks the parcel.
4.  Debit buyer, credit seller/treasury, update ownership, and post
    ledger entries atomically.
5.  Emit event and notify affected clients.
6.  A concurrent losing purchase fails without charging the buyer.

### Plant and harvest

1.  Verify land ownership/lease rights, crop window, inputs, and
    operational capacity.
2.  Reserve required inputs and create the crop record.
3.  Daily simulation advances crop state using recorded environmental
    inputs and the current ruleset.
4.  Risk events alter progress/yield.
5.  Harvest creates inventory and records costs.

### Marketplace sale

1.  Seller creates a listing and reserves inventory.
2.  Buyer requests purchase.
3.  Server checks listing status, stock, funds, fees, and limits.
4.  One transaction transfers funds and inventory, updates listing
    quantity, and posts balanced ledger entries.
5.  Emit trade event; retries with the same idempotency key return the
    prior result.

### Contract

Define quantity, quality, price, delivery window, acceptance,
reservations, settlement, cancellation, and default rules. Both parties
accept the same contract version. Reserve funds/stock where appropriate
and audit each state transition.

## 6. Data model

Core entities: `Account`, `SteamIdentity`, `Company`,
`CompanyMembership`, `Region`, `LandParcel`, `LandOwnershipHistory`,
`LandLease`, `CropDefinition`, `CropRequirement`, `CropPlan`,
`CropPlotState`, `WeatherRecord`, `InventoryLocation`, `InventoryLot`,
`InventoryReservation`, `Market`, `MarketPriceSnapshot`,
`MarketListing`, `Trade`, `Contract`, `TransportJob`, `Facility`,
`MachineryAsset`, `Loan`, `LedgerAccount`, `LedgerTransaction`,
`LedgerEntry`, `WorldClock`, `SimulationCheckpoint`, `DomainEvent`,
`Notification`, `ReferenceDataset`, `RulesetVersion`.

Use stable internal IDs, foreign keys, timestamps, and version/locking
strategies for contested records. Use PostGIS for parcel geometry. Use
decimal-safe money representation, not floating point.

## 7. Economic integrity and security

-   Never trust client-provided prices, balances, yields, ownership, or
    market outcomes.
-   All state-changing commands are authenticated, authorized,
    validated, and rate-limited.
-   Use idempotency keys for purchases, sales, payments, and contract
    actions.
-   Use database transactions for settlement and ownership transfer.
-   Prevent negative inventory and reserve stock for listings/contracts.
-   Use row locks or optimistic version checks for contested assets.
-   Keep an audit trail and reconciliation jobs for balances, inventory,
    and ownership.
-   Protect secrets; never ship server keys in the client.
-   Back up production data and test restoration.
-   Separate dev, staging, and production environments.

## 8. Performance

**Client:** instanced meshes for repeated crops/trees/props; LOD;
frustum/distance culling; progressive loading; shared materials;
measured texture/geometry budgets; limited dynamic lights.\
**Server:** batch simulation, index frequent queries, cache static
definitions, paginate market history, separate background jobs from
request handling, and profile database contention before horizontal
scaling.

## 9. Shared world and scale

MVP: one shared region, one authoritative database, `region_id` on
relevant records, one API deployment and worker. Design region-aware
data but do not build a distributed multi-region simulation prematurely.

Scale path: 1. Optimize query plans and jobs. 2. Add read caching and
separate worker processes. 3. Partition expensive background workloads.
4. Partition by region or move simulation workers only when metrics
justify it.

Plan for approximately 16 concurrent humans per region plus AI as an
initial load-test target, not as a guaranteed capacity.

## 10. Observability and tests

Track API latency/errors, tick duration/backlog, database latency,
failed/retried transactions, inventory reservations, ledger mismatches,
market outliers, CPU/RAM/storage, and reconnects. Do not log
authentication tickets or secrets.

Tests: - Unit tests for suitability, crop growth, price formation,
finance, and loans. - Invariants: ledger balances, non-negative stock,
valid ownership. - Concurrency: simultaneous parcel purchase and
last-stock purchase. - Restart and offline catch-up tests. -
Replay/idempotency and forged-price tests. - Multi-season economy
simulations. - Load tests at and above the target concurrency. - 3D
performance tests on representative hardware.

## 11. Architecture decisions

  ---------------------------------------------------------------------------------
  Area                    MVP choice                        Reason
  ----------------------- --------------------------------- -----------------------
  Client                  Three.js + TypeScript + React UI  Custom interactive
                                                            isometric 3D

  Server                  TypeScript modular monolith       Solo-friendly, testable

  Database                PostgreSQL + PostGIS              Transactions plus
                                                            spatial queries

  Authority               Server-authoritative              Economic integrity

  Time                    Daily + seasonal + event-driven   Persistent offline
                                                            world

  AI                      Rule-based first                  Cheap and reproducible

  Data                    Cached, versioned imports         Resilient and
                                                            affordable

  World                   One shared region                 Proves multiplayer
                                                            before global scale

  Assets                  Hybrid                            Low artist budget
                          procedural/licensed/AI-assisted   
  ---------------------------------------------------------------------------------

## 12. Configuration rather than hard-coded decisions

Keep game-time ratio, crop list, initial region, parcel count, market
coefficients, tick schedule, notification rules, hosting, and target
hardware configurable. Record ruleset versions so changes do not
silently corrupt existing simulation state.
