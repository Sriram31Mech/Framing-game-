import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAND_SELL_TO_STATE_FRACTION, mulPaise, SEASON_LENGTH_DAYS } from '@bh/domain';
import type { CoreDeps } from '../../src/commands/types';
import { executeCommand } from '../../src/commands/execute';
import {
  cashOf,
  expectError,
  expectLedgerReconciles,
  freeParcel,
  newPlayer,
  ok,
  run,
  setCash,
  setupWorld,
  type Player,
} from './helpers';

let deps: CoreDeps;
let a: Player;
let b: Player;

beforeAll(async () => {
  deps = await setupWorld();
  a = await newPlayer(deps, 'Alpha Agro');
  b = await newPlayer(deps, 'Beta Farms');
  // Land costs more than starting cash; fund both companies generously (ledger-consistent).
  await setCash(deps, a.companyId, 2_00_00_000_00);
  await setCash(deps, b.companyId, 2_00_00_000_00);
});
afterAll(async () => {
  await deps.pool.end();
});

describe('land purchase', () => {
  it('concurrent purchase of one parcel: exactly one wins, loser gets CONFLICT and is not charged', async () => {
    const parcel = await freeParcel(deps);
    const cashA = await cashOf(deps, a.companyId);
    const cashB = await cashOf(deps, b.companyId);
    const cmd = {
      type: 'purchase_parcel' as const,
      parcelId: parcel.id,
      expectedVersion: parcel.version,
      expectedPricePaise: parcel.price,
    };
    // Separate pool connections, fired simultaneously.
    const [ra, rb] = await Promise.all([run(deps, a, cmd), run(deps, b, cmd)]);
    const outcomes = [ra, rb];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.ok)!;
    expectError(loser, 'CONFLICT');
    if (!loser.ok) expect(loser.status).toBe(409);

    const winner = ra.ok ? a : b;
    const other = ra.ok ? b : a;
    const owner = await deps.pool.query(
      'SELECT owner_company_id, status, version FROM land_parcels WHERE id = $1',
      [parcel.id],
    );
    expect(owner.rows[0]).toEqual({
      owner_company_id: winner.companyId,
      status: 'owned',
      version: parcel.version + 1,
    });
    expect(await cashOf(deps, winner.companyId)).toBe(
      (winner === a ? cashA : cashB) - parcel.price,
    );
    expect(await cashOf(deps, other.companyId)).toBe(other === a ? cashA : cashB);
    const hist = await deps.pool.query(
      `SELECT COUNT(*)::int AS n FROM land_ownership_history WHERE parcel_id = $1 AND reason = 'purchase'`,
      [parcel.id],
    );
    expect(hist.rows[0]).toEqual({ n: 1 });
    await expectLedgerReconciles(deps);
  });

  it('rejects a forged (lower) price with PRICE_CHANGED and changes nothing', async () => {
    const parcel = await freeParcel(deps);
    const cash = await cashOf(deps, a.companyId);
    const out = await run(deps, a, {
      type: 'purchase_parcel',
      parcelId: parcel.id,
      expectedVersion: parcel.version,
      expectedPricePaise: parcel.price - 100,
    });
    expectError(out, 'PRICE_CHANGED');
    expect(await cashOf(deps, a.companyId)).toBe(cash);
    const row = await deps.pool.query(
      'SELECT owner_company_id, version FROM land_parcels WHERE id = $1',
      [parcel.id],
    );
    expect(row.rows[0]).toEqual({ owner_company_id: null, version: parcel.version });
  });

  it('rejects stale versions and purchases without funds', async () => {
    const parcel = await freeParcel(deps);
    expectError(
      await run(deps, a, {
        type: 'purchase_parcel',
        parcelId: parcel.id,
        expectedVersion: parcel.version + 5,
        expectedPricePaise: parcel.price,
      }),
      'CONFLICT',
    );
    const expensive = await deps.pool.query<{
      id: string;
      version: number;
      list_price_paise: number;
    }>(
      `SELECT id, version, list_price_paise FROM land_parcels WHERE status = 'for_sale' AND owner_company_id IS NULL
       ORDER BY list_price_paise DESC LIMIT 1`,
    );
    const e = expensive.rows[0]!;
    const poor = await newPlayer(deps);
    const cash = await cashOf(deps, poor.companyId);
    expect(e.list_price_paise).toBeGreaterThan(cash);
    expectError(
      await run(deps, poor, {
        type: 'purchase_parcel',
        parcelId: e.id,
        expectedVersion: e.version,
        expectedPricePaise: e.list_price_paise,
      }),
      'INSUFFICIENT_FUNDS',
    );
    expect(await cashOf(deps, poor.companyId)).toBe(cash);
    await expectLedgerReconciles(deps);
  });
});

describe('idempotency', () => {
  it('replays the same key with an identical response and a single effect', async () => {
    const parcel = await freeParcel(deps);
    const cash = await cashOf(deps, b.companyId);
    const cmd = {
      type: 'purchase_parcel' as const,
      parcelId: parcel.id,
      expectedVersion: parcel.version,
      expectedPricePaise: parcel.price,
    };
    const first = await run(deps, b, cmd, 'idem-key-purchase-1');
    const second = await run(deps, b, cmd, 'idem-key-purchase-1');
    expect(first.ok).toBe(true);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect({ ...second, replayed: false }).toEqual(first);
    expect(await cashOf(deps, b.companyId)).toBe(cash - parcel.price);
    const tx = await deps.pool.query(
      `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'land_purchase' AND ref_id = $1`,
      [parcel.id],
    );
    expect(tx.rows[0]).toEqual({ n: 1 });
    await expectLedgerReconciles(deps);
  });

  it('concurrent requests with the same key apply once', async () => {
    const parcel = await freeParcel(deps);
    const cmd = {
      type: 'purchase_parcel' as const,
      parcelId: parcel.id,
      expectedVersion: parcel.version,
      expectedPricePaise: parcel.price,
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => run(deps, b, cmd, 'idem-key-concurrent')),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const tx = await deps.pool.query(
      `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'land_purchase' AND ref_id = $1`,
      [parcel.id],
    );
    expect(tx.rows[0]).toEqual({ n: 1 });
  });

  it('rejects the same key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    const parcel = await freeParcel(deps);
    const cmd = {
      type: 'purchase_parcel' as const,
      parcelId: parcel.id,
      expectedVersion: parcel.version,
      expectedPricePaise: parcel.price + 1,
    };
    const first = await run(deps, a, cmd, 'idem-key-reuse-1');
    expectError(first, 'PRICE_CHANGED');
    const reused = await run(
      deps,
      a,
      { ...cmd, expectedPricePaise: parcel.price },
      'idem-key-reuse-1',
    );
    expectError(reused, 'IDEMPOTENCY_KEY_REUSED');
    if (!reused.ok) expect(reused.status).toBe(422);
    // The stored domain error is replayed for an identical retry.
    const retry = await run(deps, a, cmd, 'idem-key-reuse-1');
    expect(retry).toEqual({ ...first, replayed: true });
    const row = await deps.pool.query('SELECT owner_company_id FROM land_parcels WHERE id = $1', [
      parcel.id,
    ]);
    expect(row.rows[0]).toEqual({ owner_company_id: null });
  });

  it('keys are scoped per company', async () => {
    const out = await executeCommand(
      deps,
      a.actor,
      { type: 'mark_notifications_read', all: true },
      { idempotencyKey: 'shared-key-123' },
    );
    const outB = await executeCommand(
      deps,
      b.actor,
      { type: 'mark_notifications_read', all: true },
      { idempotencyKey: 'shared-key-123' },
    );
    expect(out.replayed).toBe(false);
    expect(outB.replayed).toBe(false);
  });
});

describe('lease, list, delist, sell to state', () => {
  it('leases state land for seasons with rent paid upfront', async () => {
    const parcel = await freeParcel(deps);
    const cash = await cashOf(deps, a.companyId);
    expectError(
      await run(deps, a, {
        type: 'lease_parcel',
        parcelId: parcel.id,
        expectedVersion: parcel.version,
        seasons: 2,
        expectedRentPaise: parcel.rent,
      }),
      'PRICE_CHANGED',
    );
    const res = ok<{ leaseId: string; endDay: number; rentPaise: number }>(
      await run(deps, a, {
        type: 'lease_parcel',
        parcelId: parcel.id,
        expectedVersion: parcel.version,
        seasons: 2,
        expectedRentPaise: parcel.rent * 2,
      }),
    );
    expect(res.endDay).toBe(2 * SEASON_LENGTH_DAYS);
    expect(await cashOf(deps, a.companyId)).toBe(cash - parcel.rent * 2);
    const row = await deps.pool.query(
      'SELECT status, owner_company_id FROM land_parcels WHERE id = $1',
      [parcel.id],
    );
    expect(row.rows[0]).toEqual({ status: 'leased', owner_company_id: null });
    // Nobody can buy leased land.
    expectError(
      await run(deps, b, {
        type: 'purchase_parcel',
        parcelId: parcel.id,
        expectedVersion: parcel.version + 1,
        expectedPricePaise: parcel.price,
      }),
      'CONFLICT',
    );
    await expectLedgerReconciles(deps);
  });

  it('owner lists, another company buys at the list price, seller is credited and notified', async () => {
    const parcel = await freeParcel(deps);
    ok(
      await run(deps, a, {
        type: 'purchase_parcel',
        parcelId: parcel.id,
        expectedVersion: parcel.version,
        expectedPricePaise: parcel.price,
      }),
    );
    expectError(
      await run(deps, b, { type: 'list_parcel', parcelId: parcel.id, pricePaise: parcel.price }),
      'FORBIDDEN',
    );
    expectError(
      await run(deps, a, {
        type: 'list_parcel',
        parcelId: parcel.id,
        pricePaise: parcel.price * 100,
      }),
      'RULE_VIOLATION',
    );
    const listPrice = Math.round(parcel.price * 1.5);
    const listed = ok<{ version: number }>(
      await run(deps, a, { type: 'list_parcel', parcelId: parcel.id, pricePaise: listPrice }),
    );
    const cashA = await cashOf(deps, a.companyId);
    const cashB = await cashOf(deps, b.companyId);
    ok(
      await run(deps, b, {
        type: 'purchase_parcel',
        parcelId: parcel.id,
        expectedVersion: listed.version,
        expectedPricePaise: listPrice,
      }),
    );
    expect(await cashOf(deps, a.companyId)).toBe(cashA + listPrice);
    expect(await cashOf(deps, b.companyId)).toBe(cashB - listPrice);
    const note = await deps.pool.query(
      `SELECT type FROM notifications WHERE company_id = $1 AND type = 'parcel_sold'`,
      [a.companyId],
    );
    expect(note.rowCount).toBe(1);
    // Seller recognises a gain over the acquisition price.
    const gain = await deps.pool.query<{ total: number }>(
      `SELECT SUM(amount_paise)::bigint AS total FROM ledger_entries WHERE company_id = $1 AND account_code = 'gain_loss_assets'`,
      [a.companyId],
    );
    expect(Number(gain.rows[0]!.total)).toBe(-(listPrice - parcel.price));
    await expectLedgerReconciles(deps);
  });

  it('delists and sells back to the state at the buyback fraction', async () => {
    const parcel = await freeParcel(deps);
    const bought = ok<{ version: number }>(
      await run(deps, a, {
        type: 'purchase_parcel',
        parcelId: parcel.id,
        expectedVersion: parcel.version,
        expectedPricePaise: parcel.price,
      }),
    );
    const listed = ok<{ version: number }>(
      await run(deps, a, { type: 'list_parcel', parcelId: parcel.id, pricePaise: parcel.price }),
    );
    expect(listed.version).toBe(bought.version + 1);
    const delisted = ok<{ version: number }>(
      await run(deps, a, { type: 'delist_parcel', parcelId: parcel.id }),
    );
    const base = await deps.pool.query<{ base_price_paise: number }>(
      'SELECT base_price_paise FROM land_parcels WHERE id = $1',
      [parcel.id],
    );
    const price = mulPaise(base.rows[0]!.base_price_paise, LAND_SELL_TO_STATE_FRACTION);
    const cash = await cashOf(deps, a.companyId);
    ok(
      await run(deps, a, {
        type: 'sell_parcel_to_state',
        parcelId: parcel.id,
        expectedVersion: delisted.version,
        expectedPricePaise: price,
      }),
    );
    expect(await cashOf(deps, a.companyId)).toBe(cash + price);
    const row = await deps.pool.query(
      'SELECT owner_company_id, status, list_price_paise FROM land_parcels WHERE id = $1',
      [parcel.id],
    );
    expect(row.rows[0]).toEqual({
      owner_company_id: null,
      status: 'for_sale',
      list_price_paise: base.rows[0]!.base_price_paise,
    });
    await expectLedgerReconciles(deps);
  });
});
