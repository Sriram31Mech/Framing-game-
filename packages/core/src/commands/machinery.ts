/**
 * Machinery purchase and sale. Machinery is carried at book value in the `machinery` ledger
 * account; the daily tick depreciates it (Dr expense_depreciation / Cr machinery).
 * Cost multipliers apply once per type (a second tractor adds nothing) while warehouse storage
 * stacks, so owning several units is allowed.
 */
import { getMachinery } from '@bh/domain';
import { conflict, forbidden, notFound, priceChanged, ruleViolation } from '../errors';
import { postLedger } from '../ledger/ledger';
import { lockParties, type CommandContext } from './context';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

export async function buyMachinery(ctx: CommandContext, cmd: Cmd<'buy_machinery'>) {
  const me = ctx.actor.companyId;
  const def = getMachinery(cmd.machineryType);
  if (def.pricePaise !== cmd.expectedPricePaise) {
    throw priceChanged(cmd.expectedPricePaise, def.pricePaise);
  }
  await lockParties(ctx);
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO machinery_assets (company_id, type, purchase_price_paise, book_value_paise, purchased_day)
     VALUES ($1, $2, $3, $3, $4) RETURNING id`,
    [me, def.type, def.pricePaise, ctx.day],
  );
  const assetId = rows[0]!.id;
  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'machinery_purchase',
    description: `Purchase of ${def.name}`,
    gameDay: ctx.day,
    refType: 'machinery',
    refId: assetId,
    entries: [
      { companyId: me, account: 'machinery', amountPaise: def.pricePaise },
      { companyId: me, account: 'cash', amountPaise: -def.pricePaise },
    ],
  });
  return { assetId, type: def.type, name: def.name, pricePaise: def.pricePaise };
}

/** Machinery is sold back to dealers at its current book value. */
export async function sellMachinery(ctx: CommandContext, cmd: Cmd<'sell_machinery'>) {
  const me = ctx.actor.companyId;
  const { rows } = await ctx.client.query<{
    id: string;
    company_id: string;
    type: Cmd<'buy_machinery'>['machineryType'];
    book_value_paise: number;
    status: string;
  }>(
    'SELECT id, company_id, type, book_value_paise, status FROM machinery_assets WHERE id = $1 FOR UPDATE',
    [cmd.assetId],
  );
  const asset = rows[0];
  if (!asset) throw notFound('Machinery', cmd.assetId);
  if (asset.company_id !== me) throw forbidden('This is not your machinery');
  if (asset.status !== 'active') throw conflict('This machinery has already been sold');
  await lockParties(ctx);

  if (asset.type === 'pump_set') {
    // Without a pump, dry parcels cannot be irrigated; make the player switch off first
    // (unless another pump set remains).
    const dry = await ctx.client.query(
      `SELECT 1 FROM crop_plots cp JOIN land_parcels p ON p.id = cp.parcel_id
       WHERE cp.company_id = $1 AND cp.status = 'growing' AND (cp.state->>'irrigated')::boolean
         AND p.env->>'waterAccess' = 'none'
         AND NOT EXISTS (SELECT 1 FROM machinery_assets m WHERE m.company_id = $1 AND m.type = 'pump_set'
                         AND m.status = 'active' AND m.id <> $2)`,
      [me, asset.id],
    );
    if ((dry.rowCount ?? 0) > 0) {
      throw ruleViolation(
        'Turn off irrigation on parcels without water access before selling the pump set',
      );
    }
  }

  const price = asset.book_value_paise;
  if (price > 0) {
    await postLedger(ctx.client, {
      regionId: ctx.regionId,
      kind: 'machinery_sale',
      description: `Sale of ${getMachinery(asset.type).name}`,
      gameDay: ctx.day,
      refType: 'machinery',
      refId: asset.id,
      entries: [
        { companyId: me, account: 'cash', amountPaise: price },
        { companyId: me, account: 'machinery', amountPaise: -price },
      ],
    });
  }
  await ctx.client.query(
    `UPDATE machinery_assets SET status = 'sold', book_value_paise = 0, version = version + 1 WHERE id = $1`,
    [asset.id],
  );
  return { assetId: asset.id, type: asset.type, pricePaise: price };
}
