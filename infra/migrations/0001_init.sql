-- Bharat Harvest — initial schema.
-- Conventions:
--   * money: BIGINT paise (never floating point); quantities: BIGINT kg
--   * game time: INTEGER game_day; wall-clock: TIMESTAMPTZ (UTC)
--   * contested rows carry `version INTEGER` for optimistic checks; commands also take row locks
--   * parcel geometry: PostGIS, SRID 0 = local metres (x east, y south) relative to region origin

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Reference / ruleset

CREATE TABLE ruleset_versions (
  version      TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reference_datasets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  source        TEXT NOT NULL,
  license       TEXT NOT NULL,
  version       TEXT NOT NULL,
  units         TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  transformations TEXT NOT NULL DEFAULT '',
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Identity

CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT,                       -- scrypt; NULL for steam-only / dev / AI accounts
  kind          TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'ai', 'dev')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  disabled_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX accounts_username_lower_uq ON accounts (lower(username));

CREATE TABLE steam_identities (
  steam_id    TEXT PRIMARY KEY,
  account_id  UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT NOT NULL UNIQUE,       -- HMAC-SHA256(SESSION_SECRET, token); raw token never stored
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX sessions_account_idx ON sessions (account_id);

-- ---------------------------------------------------------------------------
-- World

CREATE TABLE regions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  half_size_m   DOUBLE PRECISION NOT NULL,
  origin_lat    DOUBLE PRECISION NOT NULL,
  origin_lon    DOUBLE PRECISION NOT NULL,
  climate       JSONB NOT NULL,
  map_features  JSONB NOT NULL,             -- roads, river, features (static render data)
  max_human_companies INTEGER NOT NULL DEFAULT 24,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE world_clock (
  region_id               TEXT PRIMARY KEY REFERENCES regions(id),
  game_day                INTEGER NOT NULL DEFAULT 0,      -- last COMPLETED tick's day
  epoch_at                TIMESTAMPTZ NOT NULL DEFAULT now(), -- wall time corresponding to game day 0
  real_seconds_per_game_day INTEGER NOT NULL CHECK (real_seconds_per_game_day > 0),
  ruleset_version         TEXT NOT NULL REFERENCES ruleset_versions(version),
  paused                  BOOLEAN NOT NULL DEFAULT false,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per completed daily tick: the idempotency guard for the simulation.
CREATE TABLE simulation_checkpoints (
  region_id     TEXT NOT NULL REFERENCES regions(id),
  game_day      INTEGER NOT NULL,
  ruleset_version TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms   INTEGER NOT NULL,
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (region_id, game_day)
);

CREATE TABLE weather_records (
  region_id   TEXT NOT NULL REFERENCES regions(id),
  game_day    INTEGER NOT NULL,
  rain_mm     DOUBLE PRECISION NOT NULL,
  temp_c      DOUBLE PRECISION NOT NULL,
  event       TEXT NOT NULL,
  PRIMARY KEY (region_id, game_day)
);

-- ---------------------------------------------------------------------------
-- Companies

CREATE TABLE companies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id           TEXT NOT NULL REFERENCES regions(id),
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('human', 'ai')),
  ai_personality      TEXT CHECK (ai_personality IN ('cautious', 'expansionist', 'trader')),
  cash_paise          BIGINT NOT NULL,          -- denormalised; MUST equal ledger sum for account 'cash'
  escrow_paise        BIGINT NOT NULL DEFAULT 0 CHECK (escrow_paise >= 0),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'distressed', 'bankrupt')),
  distress_since_day  INTEGER,
  bankruptcies        INTEGER NOT NULL DEFAULT 0,
  founded_day         INTEGER NOT NULL,
  last_active_day     INTEGER,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_region_name_uq ON companies (region_id, lower(name));

CREATE TABLE company_memberships (
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'manager', 'viewer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, account_id)
);
-- MVP: an account belongs to at most one company.
CREATE UNIQUE INDEX company_memberships_account_uq ON company_memberships (account_id);

-- ---------------------------------------------------------------------------
-- Land

CREATE TABLE land_parcels (
  id                    TEXT PRIMARY KEY,       -- e.g. HV-001
  region_id             TEXT NOT NULL REFERENCES regions(id),
  geom                  geometry(Polygon, 0) NOT NULL,
  centroid_x            DOUBLE PRECISION NOT NULL,
  centroid_y            DOUBLE PRECISION NOT NULL,
  area_ha               NUMERIC(10, 3) NOT NULL CHECK (area_ha > 0),
  env                   JSONB NOT NULL,          -- ParcelEnvironment
  market_distance_km    DOUBLE PRECISION NOT NULL,
  nearest_market_id     TEXT NOT NULL,
  base_price_paise      BIGINT NOT NULL CHECK (base_price_paise > 0),
  lease_rent_paise      BIGINT NOT NULL CHECK (lease_rent_paise > 0),
  is_starter_plot       BOOLEAN NOT NULL DEFAULT false,
  owner_company_id      UUID REFERENCES companies(id),   -- NULL = state-owned
  -- for_sale: buyable (from state, or owner listed it); owned: held, not for sale;
  -- leased: a lease is active; reserved: starter plot held for a new company
  status                TEXT NOT NULL CHECK (status IN ('for_sale', 'owned', 'leased', 'reserved')),
  list_price_paise      BIGINT CHECK (list_price_paise > 0),
  version               INTEGER NOT NULL DEFAULT 1,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX land_parcels_region_idx ON land_parcels (region_id);
CREATE INDEX land_parcels_owner_idx ON land_parcels (owner_company_id);
CREATE INDEX land_parcels_geom_gix ON land_parcels USING GIST (geom);

CREATE TABLE land_ownership_history (
  id                BIGSERIAL PRIMARY KEY,
  parcel_id         TEXT NOT NULL REFERENCES land_parcels(id),
  from_company_id   UUID REFERENCES companies(id),
  to_company_id     UUID REFERENCES companies(id),
  price_paise       BIGINT NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('purchase', 'starter_grant', 'sale_to_state', 'liquidation')),
  game_day          INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX land_ownership_history_parcel_idx ON land_ownership_history (parcel_id);

CREATE TABLE land_leases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id         TEXT NOT NULL REFERENCES land_parcels(id),
  lessor_company_id UUID REFERENCES companies(id),   -- NULL = state
  lessee_company_id UUID NOT NULL REFERENCES companies(id),
  start_day         INTEGER NOT NULL,
  end_day           INTEGER NOT NULL CHECK (end_day > start_day),
  rent_paise        BIGINT NOT NULL CHECK (rent_paise > 0),
  status            TEXT NOT NULL CHECK (status IN ('active', 'ended', 'terminated')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX land_leases_one_active_uq ON land_leases (parcel_id) WHERE status = 'active';
CREATE INDEX land_leases_lessee_idx ON land_leases (lessee_company_id);

-- ---------------------------------------------------------------------------
-- Farming

CREATE TABLE crop_plots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id         TEXT NOT NULL REFERENCES land_parcels(id),
  company_id        UUID NOT NULL REFERENCES companies(id),
  crop_id           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('growing', 'ready', 'failed', 'harvested', 'cleared')),
  state             JSONB NOT NULL,            -- CropPlotState
  sown_day          INTEGER NOT NULL,
  last_tick_day     INTEGER NOT NULL,          -- last game day applied to this plot
  cost_basis_paise  BIGINT NOT NULL DEFAULT 0, -- accumulated production cost (for inventory valuation)
  ruleset_version   TEXT NOT NULL,
  harvested_kg      BIGINT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one live plot (growing/ready/failed) per parcel.
CREATE UNIQUE INDEX crop_plots_one_live_per_parcel_uq ON crop_plots (parcel_id)
  WHERE status IN ('growing', 'ready', 'failed');
CREATE INDEX crop_plots_company_idx ON crop_plots (company_id);
CREATE INDEX crop_plots_live_idx ON crop_plots (status) WHERE status IN ('growing', 'ready');

-- ---------------------------------------------------------------------------
-- Machinery / facilities

CREATE TABLE machinery_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  type              TEXT NOT NULL,
  purchase_price_paise BIGINT NOT NULL CHECK (purchase_price_paise > 0),
  book_value_paise  BIGINT NOT NULL CHECK (book_value_paise >= 0),
  purchased_day     INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'liquidated')),
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX machinery_assets_company_idx ON machinery_assets (company_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Inventory

CREATE TABLE inventory_lots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  item_id           TEXT NOT NULL,
  quantity_kg       BIGINT NOT NULL CHECK (quantity_kg >= 0),
  reserved_kg       BIGINT NOT NULL DEFAULT 0 CHECK (reserved_kg >= 0),
  quality           INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 100),
  cost_basis_paise  BIGINT NOT NULL DEFAULT 0 CHECK (cost_basis_paise >= 0),  -- for remaining quantity
  source            TEXT NOT NULL CHECK (source IN ('harvest', 'trade', 'contract')),
  source_ref        TEXT,
  produced_day      INTEGER NOT NULL,
  expires_day       INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_reserved_le_qty CHECK (reserved_kg <= quantity_kg)
);
CREATE INDEX inventory_lots_company_item_idx ON inventory_lots (company_id, item_id) WHERE quantity_kg > 0;

-- ---------------------------------------------------------------------------
-- Markets

CREATE TABLE markets (
  id            TEXT PRIMARY KEY,
  region_id     TEXT NOT NULL REFERENCES regions(id),
  name          TEXT NOT NULL,
  definition    JSONB NOT NULL      -- MarketDefinition
);

CREATE TABLE market_item_states (
  market_id           TEXT NOT NULL REFERENCES markets(id),
  item_id             TEXT NOT NULL,
  price_paise_per_kg  BIGINT NOT NULL CHECK (price_paise_per_kg > 0),
  supply_pressure_kg  BIGINT NOT NULL DEFAULT 0,
  demand_kg_per_day   BIGINT NOT NULL,
  updated_day         INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (market_id, item_id)
);

CREATE TABLE market_price_snapshots (
  market_id           TEXT NOT NULL REFERENCES markets(id),
  item_id             TEXT NOT NULL,
  game_day            INTEGER NOT NULL,
  price_paise_per_kg  BIGINT NOT NULL,
  volume_kg           BIGINT NOT NULL DEFAULT 0,   -- sold into the market that day
  PRIMARY KEY (market_id, item_id, game_day)
);

CREATE TABLE market_listings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id           TEXT NOT NULL REFERENCES regions(id),
  seller_company_id   UUID NOT NULL REFERENCES companies(id),
  item_id             TEXT NOT NULL,
  lot_id              UUID NOT NULL REFERENCES inventory_lots(id),
  quality             INTEGER NOT NULL,
  quantity_kg         BIGINT NOT NULL CHECK (quantity_kg > 0),
  remaining_kg        BIGINT NOT NULL CHECK (remaining_kg >= 0),
  unit_price_paise    BIGINT NOT NULL CHECK (unit_price_paise > 0),
  status              TEXT NOT NULL CHECK (status IN ('open', 'filled', 'cancelled', 'expired')),
  created_day         INTEGER NOT NULL,
  expires_day         INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_remaining_le_qty CHECK (remaining_kg <= quantity_kg)
);
CREATE INDEX market_listings_open_idx ON market_listings (region_id, item_id) WHERE status = 'open';
CREATE INDEX market_listings_seller_idx ON market_listings (seller_company_id);

CREATE TABLE trades (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id           TEXT NOT NULL REFERENCES regions(id),
  kind                TEXT NOT NULL CHECK (kind IN ('listing', 'contract', 'market_sale')),
  listing_id          UUID REFERENCES market_listings(id),
  contract_id         UUID,
  market_id           TEXT REFERENCES markets(id),
  buyer_company_id    UUID REFERENCES companies(id),   -- NULL = market (mandi)
  seller_company_id   UUID NOT NULL REFERENCES companies(id),
  item_id             TEXT NOT NULL,
  quantity_kg         BIGINT NOT NULL CHECK (quantity_kg > 0),
  quality             INTEGER NOT NULL,
  unit_price_paise    BIGINT NOT NULL CHECK (unit_price_paise > 0),
  gross_paise         BIGINT NOT NULL,
  fee_paise           BIGINT NOT NULL DEFAULT 0,
  transport_paise     BIGINT NOT NULL DEFAULT 0,
  game_day            INTEGER NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_seller_idx ON trades (seller_company_id, created_at DESC);
CREATE INDEX trades_buyer_idx ON trades (buyer_company_id, created_at DESC);

-- Buy contracts: buyer posts, escrows funds; one seller accepts and must deliver by deadline.
CREATE TABLE contracts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id           TEXT NOT NULL REFERENCES regions(id),
  buyer_company_id    UUID NOT NULL REFERENCES companies(id),
  seller_company_id   UUID REFERENCES companies(id),
  item_id             TEXT NOT NULL,
  quantity_kg         BIGINT NOT NULL CHECK (quantity_kg > 0),
  min_quality         INTEGER NOT NULL CHECK (min_quality BETWEEN 0 AND 100),
  unit_price_paise    BIGINT NOT NULL CHECK (unit_price_paise > 0),
  total_paise         BIGINT NOT NULL CHECK (total_paise > 0),
  escrow_paise        BIGINT NOT NULL CHECK (escrow_paise >= 0),
  delivery_by_day     INTEGER NOT NULL,
  created_day         INTEGER NOT NULL,
  accepted_day        INTEGER,
  settled_day         INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'fulfilled', 'cancelled', 'defaulted', 'expired')),
  terms_hash          TEXT NOT NULL,     -- sha256 of canonical terms; acceptance must match
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contract_parties_differ CHECK (seller_company_id IS NULL OR seller_company_id <> buyer_company_id)
);
CREATE INDEX contracts_status_idx ON contracts (region_id, status);
CREATE INDEX contracts_buyer_idx ON contracts (buyer_company_id);
CREATE INDEX contracts_seller_idx ON contracts (seller_company_id);

-- ---------------------------------------------------------------------------
-- Finance

CREATE TABLE loans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id),
  principal_paise     BIGINT NOT NULL CHECK (principal_paise > 0),
  annual_rate_bps     INTEGER NOT NULL CHECK (annual_rate_bps >= 0),
  term_months         INTEGER NOT NULL CHECK (term_months > 0),
  emi_paise           BIGINT NOT NULL CHECK (emi_paise > 0),
  outstanding_paise   BIGINT NOT NULL CHECK (outstanding_paise >= 0),
  instalments_paid    INTEGER NOT NULL DEFAULT 0,
  missed_payments     INTEGER NOT NULL DEFAULT 0,
  start_day           INTEGER NOT NULL,
  next_due_day        INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('active', 'repaid', 'written_off')),
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX loans_company_idx ON loans (company_id) WHERE status = 'active';
CREATE INDEX loans_due_idx ON loans (next_due_day) WHERE status = 'active';

-- Double-entry ledger. Every transaction's entries sum to zero.
-- company_id NULL = the world (treasury, mandi, labour market, state) — counterparty for money sources/sinks.
-- account_code values (per company): cash, escrow, inventory, land, machinery, loan_payable, equity,
--   revenue_sales, revenue_other, expense_seed, expense_labor, expense_inputs, expense_irrigation,
--   expense_transport, expense_fees, expense_rent, expense_interest, expense_tax, expense_maintenance,
--   expense_depreciation, expense_spoilage, cogs, gain_loss_assets
-- world account codes: world_treasury, world_market, world_suppliers, world_bank
CREATE TABLE ledger_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id       TEXT NOT NULL REFERENCES regions(id),
  kind            TEXT NOT NULL,
  description     TEXT NOT NULL,
  game_day        INTEGER NOT NULL,
  ref_type        TEXT,
  ref_id          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_transactions_ref_idx ON ledger_transactions (ref_type, ref_id);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES ledger_transactions(id),
  company_id      UUID REFERENCES companies(id),
  account_code    TEXT NOT NULL,
  amount_paise    BIGINT NOT NULL CHECK (amount_paise <> 0),  -- + debit, - credit
  game_day        INTEGER NOT NULL
);
CREATE INDEX ledger_entries_company_idx ON ledger_entries (company_id, account_code, game_day);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (transaction_id);

-- Enforce balanced transactions at commit time.
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger AS $$
DECLARE
  total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(amount_paise), 0) INTO total FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced by %', NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- Ledger is append-only.
CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
CREATE TRIGGER ledger_transactions_no_update BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Commands: idempotency

CREATE TABLE idempotency_keys (
  company_id      UUID NOT NULL REFERENCES companies(id),
  key             TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  command         TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response        JSONB NOT NULL,     -- the committed result (success or domain error)
  status_code     INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- Events (outbox / audit trail) and notifications

CREATE TABLE domain_events (
  seq             BIGSERIAL PRIMARY KEY,
  id              UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  region_id       TEXT NOT NULL REFERENCES regions(id),
  type            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  company_id      UUID REFERENCES companies(id),       -- NULL = public/region-wide
  actor_company_id UUID REFERENCES companies(id),
  entity_type     TEXT,
  entity_id       TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  game_day        INTEGER NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX domain_events_company_idx ON domain_events (company_id, seq);
CREATE INDEX domain_events_region_idx ON domain_events (region_id, seq);

-- Wake realtime gateways. Payload is only the seq; gateways read the row (keeps NOTIFY small).
CREATE OR REPLACE FUNCTION domain_events_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('bh_domain_events', NEW.seq::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER domain_events_notify_trg AFTER INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION domain_events_notify();

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id),
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'danger')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  dedupe_key      TEXT,
  game_day        INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (company_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_company_idx ON notifications (company_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (company_id) WHERE read_at IS NULL;
