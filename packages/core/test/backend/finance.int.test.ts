import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getMachinery } from '@bh/domain';
import type { CoreDeps } from '../../src/commands/types';
import { getCompanyLoans, getCompanyMachinery } from '../../src/queries/company';
import {
  cashOf,
  expectError,
  expectLedgerReconciles,
  newPlayer,
  ok,
  run,
  setCash,
  setupWorld,
  type Player,
} from './helpers';

let deps: CoreDeps;
let p: Player;

beforeAll(async () => {
  deps = await setupWorld();
  p = await newPlayer(deps, 'Finance Farms');
});
afterAll(async () => {
  await deps.pool.end();
});

describe('loans', () => {
  it('takes a loan at the offered rate, within the limit', async () => {
    const { offer } = await getCompanyLoans(deps, p.auth, p.companyId);
    expect(offer.maxPrincipalPaise).toBeGreaterThan(0);
    expectError(
      await run(deps, p, {
        type: 'take_loan',
        principalPaise: 100_000_00,
        termMonths: 12,
        expectedRateBps: offer.annualRateBps - 1,
      }),
      'PRICE_CHANGED',
    );
    expectError(
      await run(deps, p, {
        type: 'take_loan',
        principalPaise: offer.maxPrincipalPaise + 1,
        termMonths: 12,
        expectedRateBps: offer.annualRateBps,
      }),
      'LIMIT_EXCEEDED',
    );
    const cash = await cashOf(deps, p.companyId);
    const res = ok<{ loanId: string; emiPaise: number; nextDueDay: number }>(
      await run(deps, p, {
        type: 'take_loan',
        principalPaise: 100_000_00,
        termMonths: 12,
        expectedRateBps: offer.annualRateBps,
      }),
    );
    expect(res.emiPaise).toBeGreaterThan(100_000_00 / 12);
    expect(res.nextDueDay).toBe(30);
    expect(await cashOf(deps, p.companyId)).toBe(cash + 100_000_00);
    const loans = await getCompanyLoans(deps, p.auth, p.companyId);
    expect(loans.loans).toHaveLength(1);
    expect(loans.loans[0]).toMatchObject({ outstandingPaise: 100_000_00, status: 'active' });
    await expectLedgerReconciles(deps);
  });

  it('repays early (partial then full, overpayment capped)', async () => {
    const { loans } = await getCompanyLoans(deps, p.auth, p.companyId);
    const loanId = loans[0]!.id;
    const cash = await cashOf(deps, p.companyId);
    const part = ok<{ outstandingPaise: number; status: string }>(
      await run(deps, p, { type: 'repay_loan', loanId, amountPaise: 40_000_00 }),
    );
    expect(part).toMatchObject({ outstandingPaise: 60_000_00, status: 'active' });
    const full = ok<{ paidPaise: number; status: string }>(
      await run(deps, p, { type: 'repay_loan', loanId, amountPaise: 1_000_000_00 }),
    );
    expect(full).toMatchObject({ paidPaise: 60_000_00, status: 'repaid' });
    expect(await cashOf(deps, p.companyId)).toBe(cash - 100_000_00);
    expectError(
      await run(deps, p, { type: 'repay_loan', loanId, amountPaise: 1 }),
      'RULE_VIOLATION',
    );
    const liability = await deps.pool.query<{ total: number }>(
      `SELECT SUM(amount_paise)::bigint AS total FROM ledger_entries WHERE company_id = $1 AND account_code = 'loan_payable'`,
      [p.companyId],
    );
    expect(Number(liability.rows[0]!.total)).toBe(0);
    await expectLedgerReconciles(deps);
  });
});

describe('machinery', () => {
  it('buys at the catalogue price (forged price rejected) and sells back at book value', async () => {
    const tractor = getMachinery('tractor');
    await setCash(deps, p.companyId, tractor.pricePaise * 2);
    expectError(
      await run(deps, p, {
        type: 'buy_machinery',
        machineryType: 'tractor',
        expectedPricePaise: tractor.pricePaise - 1,
      }),
      'PRICE_CHANGED',
    );
    const cash = await cashOf(deps, p.companyId);
    const res = ok<{ assetId: string }>(
      await run(deps, p, {
        type: 'buy_machinery',
        machineryType: 'tractor',
        expectedPricePaise: tractor.pricePaise,
      }),
    );
    expect(await cashOf(deps, p.companyId)).toBe(cash - tractor.pricePaise);
    const view = await getCompanyMachinery(deps, p.auth, p.companyId);
    expect(view.owned.map((m) => m.type)).toEqual(['tractor']);
    expect(view.catalog.length).toBeGreaterThan(0);

    // Simulate some depreciation, then sell at book.
    await deps.pool.query('UPDATE machinery_assets SET book_value_paise = $2 WHERE id = $1', [
      res.assetId,
      tractor.pricePaise - 1_000_00,
    ]);
    const other = await newPlayer(deps);
    expectError(
      await run(deps, other, { type: 'sell_machinery', assetId: res.assetId }),
      'FORBIDDEN',
    );
    const sold = ok<{ pricePaise: number }>(
      await run(deps, p, { type: 'sell_machinery', assetId: res.assetId }),
    );
    expect(sold.pricePaise).toBe(tractor.pricePaise - 1_000_00);
    expect(await cashOf(deps, p.companyId)).toBe(cash - 1_000_00);
    expectError(await run(deps, p, { type: 'sell_machinery', assetId: res.assetId }), 'CONFLICT');
    await expectLedgerReconciles(deps);
  });

  it('cannot buy machinery without the cash', async () => {
    const poor = await newPlayer(deps);
    const harvester = getMachinery('harvester');
    await setCash(deps, poor.companyId, harvester.pricePaise - 1);
    expectError(
      await run(deps, poor, {
        type: 'buy_machinery',
        machineryType: 'harvester',
        expectedPricePaise: harvester.pricePaise,
      }),
      'INSUFFICIENT_FUNDS',
    );
    expect(await cashOf(deps, poor.companyId)).toBe(harvester.pricePaise - 1);
  });
});

describe('company status rules', () => {
  it('a distressed company may only sell/repay/delist; a bankrupt one cannot act', async () => {
    const d = await newPlayer(deps);
    await deps.pool.query(
      `UPDATE companies SET status = 'distressed', distress_since_day = 0 WHERE id = $1`,
      [d.companyId],
    );
    expectError(
      await run(deps, d, {
        type: 'buy_machinery',
        machineryType: 'truck',
        expectedPricePaise: getMachinery('truck').pricePaise,
      }),
      'RULE_VIOLATION',
    );
    ok(await run(deps, d, { type: 'mark_notifications_read', all: true }));
    await deps.pool.query(`UPDATE companies SET status = 'bankrupt' WHERE id = $1`, [d.companyId]);
    expectError(
      await run(deps, d, {
        type: 'sell_parcel_to_state',
        parcelId: d.starterParcelId!,
        expectedVersion: 2,
        expectedPricePaise: 1,
      }),
      'RULE_VIOLATION',
    );
  });

  it('marks notifications read', async () => {
    const unread = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE company_id = $1 AND read_at IS NULL',
      [p.companyId],
    );
    expect(unread.rows[0]!.n).toBeGreaterThan(0);
    const res = ok<{ updated: number }>(
      await run(deps, p, { type: 'mark_notifications_read', all: true }),
    );
    expect(res.updated).toBe(unread.rows[0]!.n);
  });
});
