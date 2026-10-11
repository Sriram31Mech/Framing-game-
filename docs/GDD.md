# Game Design Document (GDD)

## Working title: Bharat Harvest

**Platform:** PC / Steam \| **Genre:** Multiplayer agricultural
business, strategy, and logistics simulation \| **Status:** MVP baseline

## 1. Vision

Build a persistent multiplayer business simulation where players begin
with a small budget and a small plot in an Indian Tier 3/Tier 4 region,
then grow an agricultural company through land strategy, crop
production, logistics, processing, finance, and player-driven trade.
Human players and AI companies share the same regional economy. The
world continues to advance while players are offline.

The visual target is the user's Emons interactive 3D logistics website
reference: premium architectural-style scenes, detailed buildings and
machinery, clean composition, believable materials and lighting, and a
polished miniature-world feel. The game must remain interactive, not a
static 3D showcase.

## 2. Design pillars

1.  **Agriculture with real consequences:** soil, water, climate, crop
    requirements, seasonal windows, pests, and management affect
    outcomes.
2.  **Land is a strategic asset:** players inspect suitability, yield
    forecasts, access, market proximity, price, and ownership terms
    before buying or leasing.
3.  **A real business loop:** cash flow, profit and loss, assets,
    liabilities, depreciation, loans, taxes, working capital, and
    bankruptcy matter.
4.  **Player-driven economy:** trade produce, inputs, machinery,
    labor/services, leases, and contracts with other players.
5.  **India first, globally expandable:** launch with one carefully
    scoped Indian region, then add district, state, national, and global
    markets.
6.  **Premium interactive 3D:** a hybrid stylized-realistic look with
    detailed environments and a rotatable isometric camera.
7.  **Solo-developer feasibility:** AI-assisted assets, procedural
    generation, licensed reusable assets, and a modular implementation.

## 3. MVP goals

-   Online accounts and persistent companies.
-   One compact Indian region with selectable land parcels.
-   Purchase and basic leasing of land.
-   Crop suitability, planting, growth, harvest, and inventory.
-   Local market with evolving prices and sales.
-   One or more rule-based AI companies in the same economy.
-   Basic accounting and company dashboard.
-   Server-authoritative marketplace or contract trade between players.
-   Persistent simulation that advances while players are offline.
-   One polished 3D vertical slice with farm, crop rows, road, vehicle,
    warehouse, and market facility.

### Non-goals for MVP

-   A full map of India.
-   Literal ownership of municipal cities; tradable assets are parcels,
    leases, businesses, and facilities.
-   MMO-scale population, exhaustive real-world agronomy, full
    pedestrian simulation, or live API dependency for every action.
-   Advanced auctions, global exports, and every crop/industry at
    launch.

## 4. Core gameplay loop

1.  Survey land and inspect soil, water, climate, elevation, roads,
    markets, and crop suitability.
2.  Buy or lease a parcel.
3.  Select crops based on suitability, expected yield, season, inputs,
    and market conditions.
4.  Assign operations, labor, machinery, irrigation, and other inputs.
5.  Grow crops through persistent simulation; manage risks and costs.
6.  Harvest and allocate produce to inventory or storage.
7.  Transport, sell, fulfill a contract, or process goods into
    higher-value products.
8.  Review cash flow, P&L, assets, liabilities, inventory, and upcoming
    obligations.
9.  Reinvest in land, machinery, storage, processing, staff, and market
    access.
10. Trade with players and compete with AI companies for land, supplies,
    contracts, and market share.

## 5. World and regional identity

India is the first setting. Begin with one fictionalized but
data-informed region inspired by a real Tier 3/Tier 4 agricultural area.
Choose it based on useful public soil, climate, elevation, crop, and
land-cover data; clear crop identity; varied land; and manageable visual
scope.

Progression: local/district markets in MVP → regional/state trade →
national trade → international exports. Real-world data is imported,
validated, cached, and versioned. The simulated economy then evolves
independently.

## 6. Land system

Each parcel has a stable ID, geometry, area, elevation, slope, soil
profile, drainage, water access, climate, road access, nearby
buyers/processors, price, owner, sale/lease status, improvements, and
suitability/yield estimates.

-   **MVP acquisition:** direct purchase and simple leases.
-   **Later:** auctions, complex lease terms, mortgages, portfolio
    deals, and richer business acquisitions.
-   **Suitability:** explain scores with crop-specific environmental
    requirements. For example, tea may depend on elevation, temperature,
    rainfall, soil acidity, drainage, and water---not merely its state
    association.
-   **Forecasts:** show ranges and uncertainty; actual yield depends on
    weather, inputs, pests, and management.
-   **Transactions:** land, leases, facilities, machinery, goods, and
    services may be traded. "Buying a city" is not in the MVP unless
    later defined as a specific business/land abstraction.

## 7. Farming

Crops have growing stages, season windows,
temperature/rainfall/soil/water requirements, input needs, yield
potential, harvest windows, perishability, and risk sensitivities. Use a
small launch crop set with distinct profiles. Prefer data-driven crop
definitions to duplicated code.

Operations include land preparation, sowing, irrigation, fertilization,
pest management, and harvesting. Model worker and machinery capacity
before attempting detailed physical worker simulation. Automation adds
scheduled operations and capacity but requires capital, maintenance, and
planning.

## 8. Economy, markets, and trade

-   Local/district markets first; regional/state, national, and global
    markets later.
-   Price responds to supply, demand, seasonality, quality, storage,
    transport, contracts, and events.
-   AI companies and players influence the same market.
-   MVP: sell produce to a local market and implement at least one
    secure player-to-player marketplace or contract flow.
-   Planned trade types: raw produce, processed goods, inputs,
    machinery, labor/services, land, leases, storage, transport, and
    export contracts.
-   Use controlled money sources/sinks and safeguards against market
    manipulation or runaway inflation.

## 9. Finance and failure

Provide cash flow, profit and loss, assets/liabilities, inventory
valuation, depreciation, taxes/fees, loans, interest, repayment
schedules, working capital, and a transparent company valuation.
Bankruptcy must have consequences but include understandable rules and a
recovery path. Do not allow a single mistake to permanently lock a
player out without warning.

## 10. AI companies and multiplayer

AI companies should use the same validated action interface as humans.
Start with deterministic rules and weighted utility scoring; avoid
requiring paid LLM inference for routine decisions. AI may evaluate
land, select crops, trade, use storage, and compete for contracts within
budgets and action limits.

The shared server owns land, money, inventories, contracts, crop state,
and market outcomes. Initial capacity planning assumption: about **16
concurrent human players per region**, plus AI companies; actual
capacity must be load-tested. Start with one shared region rather than a
global distributed world.

## 11. UX and primary screens

-   3D region/map and parcel selection.
-   Land inspector with suitability explanations.
-   Farm/crop operations.
-   Inventory and storage.
-   Market, listings, contracts, and leases.
-   Company dashboard and financial statements.
-   Logistics and processing.
-   Notifications and event history.
-   Account/settings.

Use the 3D world for spatial understanding and context. Use clear 2D
panels for dense trading and accounting. Explain risks before expensive
actions and summarize changes after a player returns from offline time.

## 12. Locked art direction

-   **Style:** hybrid stylized-realistic.
-   **Camera:** rotatable isometric with zoom and closer inspection.
-   **Detail:** detailed environment.
-   **Benchmark:** user-provided Emons 3D logistics website reference.
-   **Visuals:** clean architectural forms, natural terrain/crops,
    recognizable machinery, believable materials, controlled lighting,
    Indian regional identity, readable silhouettes.
-   **Pipeline:** procedural crop rows/fields/roads/repeated props;
    licensed reusable assets; AI-assisted concept/texture/model
    workflows; Blender for scale, pivots, UVs, materials, and
    optimization; Three.js instancing and LOD.
-   Validate commercial licenses and inspect all generated assets for
    topology, seams, scale, and performance.

## 13. MVP acceptance criteria

-   Player can log in, resume the same company, and see persisted assets
    after restart.
-   Land purchase cannot succeed twice under concurrent requests.
-   Crop state advances correctly during offline time.
-   Sale updates inventory, cash, and ledger exactly once.
-   AI participates in the same economy.
-   Two players can complete a validated trade or contract.
-   Suitability and yield predictions show their key contributing
    factors.
-   A representative detailed scene meets a measured target PC
    performance budget.
-   Backups, restoration, logs, and basic exploit tests exist before
    public testing.

## 14. Roadmap

**Phase 0:** prove Three.js camera, asset pipeline, backend, database,
and persistent clock.\
**Phase 1:** one region, parcels, crops, harvest, inventory, local
market, ledger, one AI company.\
**Phase 2:** account persistence, Steam identity, offline catch-up,
reconnect behavior.\
**Phase 3:** multiplayer listings/contracts, leases, transaction
protections, notifications.\
**Phase 4:** polish, optimization, onboarding, backups, load/security
tests, Steam packaging.\
**Post-MVP:** auctions, more crops/regions, processing chains, advanced
finance, national/global markets, deeper AI, more Steamworks features.

## 15. Inspirations

These are design references, not instructions to copy proprietary
content: - **Farming Simulator:** machinery, farm operations, equipment
progression. - **Workers & Resources: Soviet Republic:** production
chains and infrastructure dependencies. - **Cities: Skylines:** spatial
readability and management interfaces. - **Transport Fever 2:**
transport networks and distribution economics. - **Anno series:**
production chains and expansion strategy. - **OpenTTD:** durable
logistics/economic simulation. - **EVE Online:** player-driven trade,
contracts, and shared markets. - **User-provided Emons interactive 3D
logistics website:** premium architectural 3D composition, detailed
logistics environments, and polished interactive presentation.

**Identity to create:** Indian agriculture + business finance + land
strategy + player-driven logistics, presented as a premium interactive
3D world.
