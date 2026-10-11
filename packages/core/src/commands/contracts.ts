/**
 * Buy-side forward contracts. docs/IMPLEMENTATION.md §4 "Contracts".
 * open (buyer escrowed total) → accepted (seller committed; same version + terms hash) →
 * fulfilled (delivered; escrow → seller less fee). Buyers may cancel while open.
 * Expiry/default are handled by the daily tick.
 */
import { randomUUID } from 'node:crypto';
import { applyBps, formatInr, getCrop, P2P_TRADE_FEE_BPS, type ItemId } from '@bh/domain';
import { conflict, DomainError, forbidden, notFound, ruleViolation } from '../errors';
import { emitEvent, notify } from '../events/events';
import { postLedger } from '../ledger/ledger';
import {
  assertVersion,
  canonicalJson,
  lockParties,
  safeMul,
  sha256Hex,
  weightedQuality,
  type CommandContext,
} from './context';
import { applyTakes, insertLot, lockAvailableLots, planTakes } from './inventory';
import { assertP2pPrice } from './listings';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

/** Anti-spam cap on simultaneously open (unaccepted) contracts posted by one company. */
export const MAX_OPEN_CONTRACTS_PER_COMPANY = 10;

export interface ContractTerms {
  id: string;
  buyerCompanyId: string;
  itemId: ItemId;
  quantityKg: number;
  minQuality: number;
  unitPricePaise: number;
  totalPaise: number;
  deliveryByDay: number;
}

/** sha256 of the canonical terms; a seller accepts exactly these terms. */
export function contractTermsHash(terms: ContractTerms): string {
  return sha256Hex(canonicalJson(terms));
}

interface ContractRow {
  id: string;
  buyer_company_id: string;
  seller_company_id: string | null;
  item_id: ItemId;
  quantity_kg: number;
  min_quality: number;
  unit_price_paise: number;
  total_paise: number;
  escrow_paise: number;
  delivery_by_day: number;
  status: 'open' | 'accepted' | 'fulfilled' | 'cancelled' | 'defaulted' | 'expired';
  terms_hash: string;
  version: number;
}

async function lockContract(ctx: CommandContext, contractId: string): Promise<ContractRow> {
  const { rows } = await ctx.client.query<ContractRow>(
    `SELECT id, buyer_company_id, seller_company_id, item_id, quantity_kg, min_quality, unit_price_paise,
            total_paise, escrow_paise, delivery_by_day, status, terms_hash, version
     FROM contracts WHERE id = $1 AND region_id = $2 FOR UPDATE`,
    [contractId, ctx.regionId],
  );
  const r = rows[0];
  if (!r) throw notFound('Contract', contractId);
  return r;
}

async function emitContractUpdated(ctx: CommandContext, id: string, status: string): Promise<void> {
  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'contract.updated',
    gameDay: ctx.day,
    companyId: null,
    actorCompanyId: ctx.actor.companyId,
    entityType: 'contract',
    entityId: id,
    payload: { contractId: id, status },
  });
}

async function bumpContract(
  ctx: CommandContext,
  id: string,
  sql: string,
  params: unknown[],
): Promise<number> {
  const { rows } = await ctx.client.query<{ version: number }>(
    `UPDATE contracts SET ${sql}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
    [id, ...params],
  );
  return rows[0]!.version;
}

export async function createContract(ctx: CommandContext, cmd: Cmd<'create_contract'>) {
  const me = ctx.actor.companyId;
  await assertP2pPrice(ctx, cmd.itemId, cmd.unitPricePaise);
  const total = safeMul(cmd.unitPricePaise, cmd.quantityKg, 'Contract value');
  await lockParties(ctx);
  const open = await ctx.client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM contracts WHERE buyer_company_id = $1 AND status = 'open'`,
    [me],
  );
  if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_CONTRACTS_PER_COMPANY) {
    throw new DomainError(
      'LIMIT_EXCEEDED',
      `At most ${MAX_OPEN_CONTRACTS_PER_COMPANY} open contracts`,
    );
  }

  const terms: ContractTerms = {
    id: randomUUID(),
    buyerCompanyId: me,
    itemId: cmd.itemId,
    quantityKg: cmd.quantityKg,
    minQuality: cmd.minQuality,
    unitPricePaise: cmd.unitPricePaise,
    totalPaise: total,
    deliveryByDay: ctx.day + cmd.deliveryWithinDays,
  };
  const termsHash = contractTermsHash(terms);
  const { rows } = await ctx.client.query<{ version: number }>(
    `INSERT INTO contracts (id, region_id, buyer_company_id, item_id, quantity_kg, min_quality, unit_price_paise,
       total_paise, escrow_paise, delivery_by_day, created_day, status, terms_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, 'open', $11) RETURNING version`,
    [
      terms.id,
      ctx.regionId,
      me,
      cmd.itemId,
      cmd.quantityKg,
      cmd.minQuality,
      cmd.unitPricePaise,
      total,
      terms.deliveryByDay,
      ctx.day,
      termsHash,
    ],
  );
  // Escrow the full value: Dr escrow / Cr cash (INSUFFICIENT_FUNDS rolls the insert back).
  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'contract_escrow',
    description: `Escrow for contract to buy ${cmd.quantityKg} kg ${cmd.itemId}`,
    gameDay: ctx.day,
    refType: 'contract',
    refId: terms.id,
    entries: [
      { companyId: me, account: 'escrow', amountPaise: total },
      { companyId: me, account: 'cash', amountPaise: -total },
    ],
  });
  await emitContractUpdated(ctx, terms.id, 'open');
  return {
    contractId: terms.id,
    totalPaise: total,
    deliveryByDay: terms.deliveryByDay,
    termsHash,
    version: rows[0]!.version,
  };
}

export async function acceptContract(ctx: CommandContext, cmd: Cmd<'accept_contract'>) {
  const me = ctx.actor.companyId;
  const contract = await lockContract(ctx, cmd.contractId);
  if (contract.status !== 'open') throw conflict('This contract is no longer open');
  assertVersion('Contract', cmd.expectedVersion, contract.version);
  if (cmd.termsHash !== contract.terms_hash) {
    throw conflict('The contract terms differ from what you reviewed; refresh and retry');
  }
  if (contract.buyer_company_id === me) throw ruleViolation('You cannot accept your own contract');
  if (contract.delivery_by_day <= ctx.day)
    throw ruleViolation('This contract is past its deadline');
  await lockParties(ctx, [contract.buyer_company_id]);
  const version = await bumpContract(
    ctx,
    contract.id,
    `seller_company_id = $2, status = 'accepted', accepted_day = $3`,
    [me, ctx.day],
  );
  await emitContractUpdated(ctx, contract.id, 'accepted');
  const crop = getCrop(contract.item_id);
  await notify(ctx.client, {
    regionId: ctx.regionId,
    companyId: contract.buyer_company_id,
    type: 'contract_accepted',
    severity: 'info',
    title: `${crop.name} contract accepted`,
    body: `A seller accepted your contract for ${contract.quantity_kg.toLocaleString('en-IN')} kg of ${crop.name}; delivery is due by day ${contract.delivery_by_day}.`,
    gameDay: ctx.day,
    entityType: 'contract',
    entityId: contract.id,
  });
  return {
    contractId: contract.id,
    status: 'accepted' as const,
    deliveryByDay: contract.delivery_by_day,
    version,
  };
}

export async function deliverContract(ctx: CommandContext, cmd: Cmd<'deliver_contract'>) {
  const me = ctx.actor.companyId;
  const contract = await lockContract(ctx, cmd.contractId);
  if (contract.seller_company_id !== me) throw forbidden('You are not the seller on this contract');
  if (contract.status !== 'accepted') throw conflict('This contract is not awaiting delivery');
  if (ctx.day > contract.delivery_by_day) throw ruleViolation('The delivery deadline has passed');

  const buyer = contract.buyer_company_id;
  await lockParties(ctx, [buyer]);
  const lots = await lockAvailableLots(ctx, me, contract.item_id, 'contract', contract.min_quality);
  const takes = planTakes(lots, contract.quantity_kg);
  await applyTakes(ctx, takes);
  const costRelieved = takes.reduce((s, t) => s + t.costPaise, 0);

  const total = contract.total_paise;
  const fee = applyBps(total, P2P_TRADE_FEE_BPS);
  const quality = weightedQuality(takes.map((t) => ({ quality: t.lot.quality, kg: t.kg })));
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO trades (region_id, kind, contract_id, buyer_company_id, seller_company_id, item_id,
       quantity_kg, quality, unit_price_paise, gross_paise, fee_paise, game_day)
     VALUES ($1, 'contract', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      ctx.regionId,
      contract.id,
      buyer,
      me,
      contract.item_id,
      contract.quantity_kg,
      quality,
      contract.unit_price_paise,
      total,
      fee,
      ctx.day,
    ],
  );
  const tradeId = rows[0]!.id;

  // Buyer receives one lot per source lot (quality and expiry preserved); cost split pro rata.
  let allocated = 0;
  for (const [i, t] of takes.entries()) {
    const share =
      i === takes.length - 1
        ? total - allocated
        : Math.round((total * t.kg) / contract.quantity_kg);
    allocated += share;
    await insertLot(ctx, {
      companyId: buyer,
      itemId: contract.item_id,
      quantityKg: t.kg,
      quality: t.lot.quality,
      costBasisPaise: share,
      source: 'contract',
      sourceRef: contract.id,
      producedDay: t.lot.producedDay,
      expiresDay: t.lot.expiresDay,
    });
  }

  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'contract_settlement',
    description: `Delivery of ${contract.quantity_kg} kg ${contract.item_id} under contract`,
    gameDay: ctx.day,
    refType: 'contract',
    refId: contract.id,
    entries: [
      { companyId: buyer, account: 'inventory', amountPaise: total },
      { companyId: buyer, account: 'escrow', amountPaise: -total },
      { companyId: me, account: 'cash', amountPaise: total - fee },
      { companyId: me, account: 'expense_fees', amountPaise: fee },
      { companyId: me, account: 'revenue_sales', amountPaise: -total },
      { companyId: me, account: 'cogs', amountPaise: costRelieved },
      { companyId: me, account: 'inventory', amountPaise: -costRelieved },
    ],
  });
  const version = await bumpContract(
    ctx,
    contract.id,
    `status = 'fulfilled', settled_day = $2, escrow_paise = 0`,
    [ctx.day],
  );

  await emitContractUpdated(ctx, contract.id, 'fulfilled');
  for (const [companyId, role, amount] of [
    [buyer, 'buyer', total],
    [me, 'seller', total - fee],
  ] as const) {
    await emitEvent(ctx.client, {
      regionId: ctx.regionId,
      type: 'trade.completed',
      gameDay: ctx.day,
      companyId,
      actorCompanyId: me,
      entityType: 'trade',
      entityId: tradeId,
      payload: {
        tradeId,
        itemId: contract.item_id,
        quantityKg: contract.quantity_kg,
        totalPaise: amount,
        role,
        contractId: contract.id,
      },
    });
  }
  const crop = getCrop(contract.item_id);
  await notify(ctx.client, {
    regionId: ctx.regionId,
    companyId: buyer,
    type: 'contract_delivered',
    severity: 'success',
    title: `${crop.name} contract delivered`,
    body: `${contract.quantity_kg.toLocaleString('en-IN')} kg of ${crop.name} (avg quality ${quality}) was delivered; ${formatInr(total)} was released from escrow.`,
    gameDay: ctx.day,
    entityType: 'contract',
    entityId: contract.id,
  });
  return {
    contractId: contract.id,
    tradeId,
    quantityKg: contract.quantity_kg,
    quality,
    totalPaise: total,
    feePaise: fee,
    netPaise: total - fee,
    version,
  };
}

export async function cancelContract(ctx: CommandContext, cmd: Cmd<'cancel_contract'>) {
  const me = ctx.actor.companyId;
  const contract = await lockContract(ctx, cmd.contractId);
  if (contract.buyer_company_id !== me) throw forbidden('Only the buyer can cancel this contract');
  if (contract.status !== 'open')
    throw conflict('Only open (unaccepted) contracts can be cancelled');
  await lockParties(ctx);
  if (contract.escrow_paise > 0) {
    await postLedger(ctx.client, {
      regionId: ctx.regionId,
      kind: 'contract_refund',
      description: 'Escrow refunded on contract cancellation',
      gameDay: ctx.day,
      refType: 'contract',
      refId: contract.id,
      entries: [
        { companyId: me, account: 'cash', amountPaise: contract.escrow_paise },
        { companyId: me, account: 'escrow', amountPaise: -contract.escrow_paise },
      ],
    });
  }
  const version = await bumpContract(
    ctx,
    contract.id,
    `status = 'cancelled', settled_day = $2, escrow_paise = 0`,
    [ctx.day],
  );
  await emitContractUpdated(ctx, contract.id, 'cancelled');
  return { contractId: contract.id, refundedPaise: contract.escrow_paise, version };
}
