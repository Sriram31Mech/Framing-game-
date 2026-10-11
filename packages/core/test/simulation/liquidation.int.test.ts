/**
 * Full bankruptcy liquidation of a company with produce, an open listing, an accepted contract
 * and a lease: everything is unwound with balanced ledger postings and the company restarts.
 */
import {
  BANKRUPTCY_RESTART_GRANT_PAISE,
  cropDurationDays,
  DISTRESS_GRACE_DAYS,
  getCrop,
  type CropId,
  type ItemId,
} from '@bh/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '../../src/commands/types';
import { runReconciliation } from '../../src/simulation/reconcile';
import {
  assertInvariants,
  cashOf,
  createHuman,
  execOk,
  ledgerBalance,
  plantBest,
  postLoss,
  REGION,
  setupWorld,
  starterParcel,
  tickDays,
} from './helpers';

const quickest = (crops: CropId[]) =>
  [...crops].sort((a, b) => cropDurationDays(getCrop(a)) - cropDurationDays(getCrop(b)))[0]!;

describe('bankruptcy liquidation', () => {
  let deps: CoreDeps;
  let debtor: string;
  let buyer: string;
  let itemId: ItemId;
  let listingId: string;
  let contractId: string;
  let leaseId: string;
  let leasedParcel: string;

  beforeAll(async () => {
    deps = await setupWorld();
    debtor = await createHuman(deps, 'Overextended Farms');
    buyer = await createHuman(deps, 'Patient Buyer Co');
    const plot = await plantBest(deps, debtor, (await starterParcel(deps, debtor)).id, {
      pick: quickest,
    });
    itemId = plot.cropId;
    for (let i = 0; i < cropDurationDays(getCrop(itemId)) + 10; i++) {
      const { rows } = await deps.pool.query<{ status: string }>(
        'SELECT status FROM crop_plots WHERE id = $1',
        [plot.plotId],
      );
      if (rows[0]!.status === 'ready') break;
      await tickDays(deps, 1);
    }
    const harvest = await execOk<{ lotId: string; quantityKg: number }>(deps, debtor, {
      type: 'harvest',
      plotId: plot.plotId,
    });
    const { rows: price } = await deps.pool.query<{ best: number }>(
      'SELECT MAX(price_paise_per_kg)::bigint AS best FROM market_item_states WHERE item_id = $1',
      [itemId],
    );
    const unit = Number(price[0]!.best);
    listingId = (
      await execOk<{ listingId: string }>(deps, debtor, {
        type: 'create_listing',
        itemId,
        quantityKg: Math.floor(harvest.quantityKg / 4),
        unitPricePaise: unit,
        durationDays: 60,
        lotId: harvest.lotId,
      })
    ).listingId;
    const contract = await execOk<{ contractId: string; version: number; termsHash: string }>(
      deps,
      buyer,
      {
        type: 'create_contract',
        itemId,
        quantityKg: 10,
        minQuality: 0,
        unitPricePaise: unit,
        deliveryWithinDays: 90,
      },
    );
    contractId = contract.contractId;
    await execOk(deps, debtor, {
      type: 'accept_contract',
      contractId,
      expectedVersion: contract.version,
      termsHash: contract.termsHash,
    });
    const { rows: parcels } = await deps.pool.query<{
      id: string;
      version: number;
      lease_rent_paise: number;
    }>(
      `SELECT id, version, lease_rent_paise FROM land_parcels
       WHERE region_id = $1 AND status = 'for_sale' AND owner_company_id IS NULL
       ORDER BY lease_rent_paise, id LIMIT 1`,
      [REGION],
    );
    leasedParcel = parcels[0]!.id;
    leaseId = (
      await execOk<{ leaseId: string }>(deps, debtor, {
        type: 'lease_parcel',
        parcelId: leasedParcel,
        expectedVersion: parcels[0]!.version,
        seasons: 3,
        expectedRentPaise: parcels[0]!.lease_rent_paise * 3,
      })
    ).leaseId;
  }, 300_000);
  afterAll(async () => {
    await deps.pool.end();
  });

  it('liquidates everything and restarts the company with the grant', async () => {
    expect(await ledgerBalance(deps, debtor, 'inventory')).toBeGreaterThan(0);
    await postLoss(deps, debtor, (await cashOf(deps, debtor)) + 50_000_000_00);
    const buyerCashBefore = await cashOf(deps, buyer);

    for (let i = 0; i < DISTRESS_GRACE_DAYS + 3; i++) {
      await tickDays(deps, 1);
      const { rows } = await deps.pool.query<{ bankruptcies: number }>(
        'SELECT bankruptcies FROM companies WHERE id = $1',
        [debtor],
      );
      if (rows[0]!.bankruptcies === 1) break;
    }

    const { rows: co } = await deps.pool.query<{
      status: string;
      bankruptcies: number;
      cash_paise: number;
      escrow_paise: number;
    }>('SELECT status, bankruptcies, cash_paise, escrow_paise FROM companies WHERE id = $1', [
      debtor,
    ]);
    expect(co[0]).toMatchObject({ status: 'active', bankruptcies: 1, escrow_paise: 0 });
    // The deficit was far larger than the liquidation proceeds: exactly the grant remains.
    expect(co[0]!.cash_paise).toBe(BANKRUPTCY_RESTART_GRANT_PAISE);

    const { rows: listing } = await deps.pool.query<{ status: string }>(
      'SELECT status FROM market_listings WHERE id = $1',
      [listingId],
    );
    expect(listing[0]!.status).toBe('cancelled');
    const { rows: contract } = await deps.pool.query<{ status: string; escrow_paise: number }>(
      'SELECT status, escrow_paise FROM contracts WHERE id = $1',
      [contractId],
    );
    expect(contract[0]).toEqual({ status: 'defaulted', escrow_paise: 0 });
    // The buyer got the escrow back plus the default penalty.
    expect(await cashOf(deps, buyer)).toBeGreaterThan(buyerCashBefore);

    const { rows: lease } = await deps.pool.query<{ status: string }>(
      'SELECT status FROM land_leases WHERE id = $1',
      [leaseId],
    );
    expect(lease[0]!.status).toBe('terminated');
    const { rows: parcels } = await deps.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM land_parcels WHERE owner_company_id = $1 OR id = $2`,
      [debtor, leasedParcel],
    );
    expect(parcels).toEqual([{ id: leasedParcel, status: 'for_sale' }]);

    const { rows: lots } = await deps.pool.query<{ total: number }>(
      'SELECT COALESCE(SUM(quantity_kg), 0)::bigint AS total FROM inventory_lots WHERE company_id = $1',
      [debtor],
    );
    expect(Number(lots[0]!.total)).toBe(0);
    const { rows: sale } = await deps.pool.query(
      `SELECT 1 FROM trades WHERE seller_company_id = $1 AND kind = 'market_sale'`,
      [debtor],
    );
    expect(sale.length).toBeGreaterThan(0);
    for (const account of ['inventory', 'land', 'machinery', 'loan_payable', 'escrow']) {
      expect(await ledgerBalance(deps, debtor, account)).toBe(0);
    }
    await assertInvariants(deps.pool);
    expect((await runReconciliation(deps, REGION)).issues).toEqual([]);
  });
});
