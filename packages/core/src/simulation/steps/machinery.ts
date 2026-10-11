import {
  combinedMachineryEffects,
  dailyDepreciationPaise,
  getMachinery,
  mulPaise,
  type MachineryDefinition,
  type MachineryType,
} from '@bh/domain';
import type { Queryable } from '../../db/pool';
import { chunk, tickPost } from '../effects';
import { chargeExpense } from '../postings';
import type { TickContext } from '../types';

export type MachineryEffects = Required<MachineryDefinition['effects']>;

/** Combined machinery effects for every company in the region that owns active machinery. */
export async function loadMachineryEffects(
  db: Queryable,
  regionId: string,
): Promise<Map<string, MachineryEffects>> {
  const { rows } = await db.query<{ company_id: string; types: MachineryType[] }>(
    `SELECT m.company_id, array_agg(m.type ORDER BY m.type) AS types
     FROM machinery_assets m JOIN companies c ON c.id = m.company_id
     WHERE c.region_id = $1 AND m.status = 'active'
     GROUP BY m.company_id`,
    [regionId],
  );
  return new Map(rows.map((r) => [r.company_id, combinedMachineryEffects(r.types)]));
}

interface AssetRow {
  id: string;
  company_id: string;
  type: MachineryType;
  purchase_price_paise: number;
  book_value_paise: number;
}

/**
 * Step 10 — machinery depreciation (non-cash: Dr expense_depreciation / Cr machinery, never
 * below salvage value) and daily maintenance (cash, scheduled obligation). One ledger
 * transaction per company per kind keeps the ledger compact.
 */
export async function depreciateAndMaintainMachinery(ctx: TickContext): Promise<void> {
  const { rows } = await ctx.client.query<AssetRow>(
    `SELECT m.id, m.company_id, m.type, m.purchase_price_paise, m.book_value_paise
     FROM machinery_assets m JOIN companies c ON c.id = m.company_id
     WHERE c.region_id = $1 AND m.status = 'active'
     ORDER BY m.company_id, m.id`,
    [ctx.regionId],
  );
  if (rows.length === 0) return;

  const depByCompany = new Map<string, number>();
  const maintByCompany = new Map<string, number>();
  const bookUpdates: { id: string; book: number }[] = [];

  for (const a of rows) {
    const def = getMachinery(a.type);
    const salvage = mulPaise(a.purchase_price_paise, def.salvageFraction);
    const daily = dailyDepreciationPaise(
      a.purchase_price_paise,
      def.salvageFraction,
      def.usefulLifeDays,
    );
    const dep = Math.max(0, Math.min(daily, a.book_value_paise - salvage));
    if (dep > 0) {
      depByCompany.set(a.company_id, (depByCompany.get(a.company_id) ?? 0) + dep);
      bookUpdates.push({ id: a.id, book: a.book_value_paise - dep });
      ctx.stats.machineryDepreciated++;
    }
    if (def.maintenancePaisePerDay > 0) {
      maintByCompany.set(
        a.company_id,
        (maintByCompany.get(a.company_id) ?? 0) + def.maintenancePaisePerDay,
      );
    }
  }

  for (const batch of chunk(bookUpdates, 500)) {
    await ctx.client.query(
      `UPDATE machinery_assets m SET book_value_paise = u.book, version = m.version + 1
       FROM unnest($1::uuid[], $2::bigint[]) AS u(id, book) WHERE m.id = u.id`,
      [batch.map((b) => b.id), batch.map((b) => b.book)],
    );
  }

  for (const [companyId, dep] of [...depByCompany].sort(([a], [b]) => a.localeCompare(b))) {
    await tickPost(ctx, {
      kind: 'depreciation',
      description: 'Daily machinery depreciation',
      refType: 'company',
      refId: companyId,
      entries: [
        { companyId, account: 'expense_depreciation', amountPaise: dep },
        { companyId, account: 'machinery', amountPaise: -dep },
      ],
    });
  }
  for (const [companyId, cost] of [...maintByCompany].sort(([a], [b]) => a.localeCompare(b))) {
    await chargeExpense(ctx, {
      companyId,
      account: 'expense_maintenance',
      amountPaise: cost,
      kind: 'maintenance',
      description: 'Daily machinery maintenance',
      refType: 'company',
      refId: companyId,
    });
  }
}
