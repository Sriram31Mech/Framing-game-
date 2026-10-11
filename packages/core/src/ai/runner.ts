/**
 * AI company scheduler. AI companies play through exactly the same validated command layer as
 * humans (`executeCommand`): no special write path, same prices, same rules, same ledger.
 *
 * Idempotency: command n of company C on day D uses the key `ai:<C>:<D>:<n>`, so retrying a day
 * can never double-act. A company that already has any key for day D has acted that day and is
 * skipped on reruns (its view changed after acting, so re-deciding would produce different
 * commands under the same keys).
 */
import {
  AI_MAX_ACTIONS_PER_DAY,
  decideAiActions,
  p2pPriceBand,
  rngFor,
  type AiIntent,
  type AiWorldView,
} from '@bh/domain';
import { computePlantingCost } from '../commands/farming';
import { executeCommand } from '../commands/execute';
import type { Actor, CommandOutcome, CoreDeps, GameCommand } from '../commands/types';
import { computeBalanceSheet, loanOfferFor } from '../companies/valuation';
import { bestMandiPricePaise } from '../world/region';
import { buildAiWorldView } from './view';

export interface AiRunResult {
  /** AI companies that acted this call. */
  companies: number;
  /** Commands submitted (successful or not). */
  commands: number;
  /** Commands rejected by the command layer or that threw. */
  failures: number;
  /** Companies skipped because they had already acted on this day. */
  skipped: number;
  /** Intents dropped before submission (e.g. price above the AI's limit). */
  dropped: number;
  /** Successful commands by type. */
  byType: Record<string, number>;
}

export interface AiRunOptions {
  maxActionsPerDay?: number;
  /** Decision policy (default: the domain's rule-based `decideAiActions`). Tests inject scripts. */
  decide?: typeof decideAiActions;
}

export function aiIdempotencyKey(companyId: string, gameDay: number, n: number): string {
  return `ai:${companyId}:${gameDay}:${n}`;
}

export async function runAiCompanies(
  deps: CoreDeps,
  regionId: string,
  gameDay: number,
  opts: AiRunOptions = {},
): Promise<AiRunResult> {
  const result: AiRunResult = {
    companies: 0,
    commands: 0,
    failures: 0,
    skipped: 0,
    dropped: 0,
    byType: {},
  };
  const maxActions = opts.maxActionsPerDay ?? AI_MAX_ACTIONS_PER_DAY;
  const { rows: region } = await deps.pool.query<{ seed: number }>(
    'SELECT seed FROM regions WHERE id = $1',
    [regionId],
  );
  const seed = region[0]?.seed;
  if (seed === undefined) throw new Error(`region ${regionId} not found`);

  const { rows: companies } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM companies
     WHERE region_id = $1 AND kind = 'ai' AND status IN ('active', 'distressed')
     ORDER BY id`,
    [regionId],
  );

  for (const { id: companyId } of companies) {
    try {
      const acted = await deps.pool.query(
        'SELECT 1 FROM idempotency_keys WHERE company_id = $1 AND key LIKE $2 LIMIT 1',
        [companyId, `ai:${companyId}:${gameDay}:%`],
      );
      if ((acted.rowCount ?? 0) > 0) {
        result.skipped++;
        continue;
      }
      result.companies++;
      const view = await buildAiWorldView(deps.pool, companyId, gameDay);
      const decide = opts.decide ?? decideAiActions;
      const intents = decide(view, rngFor(seed, 'ai', companyId, gameDay), maxActions);
      const actor: Actor = { companyId, accountId: null, kind: 'ai', regionId };

      for (const [n, intent] of intents.slice(0, maxActions).entries()) {
        let command: GameCommand | null;
        let outcome: CommandOutcome;
        try {
          command = await intentToCommand(deps, regionId, view, intent);
          if (!command) {
            result.dropped++;
            continue;
          }
          result.commands++;
          outcome = await executeCommand(deps, actor, command, {
            idempotencyKey: aiIdempotencyKey(companyId, gameDay, n),
          });
        } catch (err) {
          result.failures++;
          deps.logger.warn(
            { err, companyId, gameDay, intent: intent.kind },
            'AI command threw an internal error',
          );
          continue;
        }
        if (outcome.ok) {
          result.byType[command.type] = (result.byType[command.type] ?? 0) + 1;
        } else {
          result.failures++;
          deps.logger.debug(
            { companyId, gameDay, command, error: outcome.error },
            'AI command rejected',
          );
        }
      }
    } catch (err) {
      result.failures++;
      deps.logger.warn({ err, companyId, gameDay }, 'AI company turn failed');
    }
  }
  return result;
}

/**
 * Translate a domain intent into a concrete command with the server-side expectations a client
 * would send (current price/version/cost/rate). Returns null when the intent should be dropped.
 */
export async function intentToCommand(
  deps: CoreDeps,
  regionId: string,
  view: AiWorldView,
  intent: AiIntent,
): Promise<GameCommand | null> {
  switch (intent.kind) {
    case 'buy_parcel': {
      const { rows } = await deps.pool.query<{ price: number; version: number; status: string }>(
        `SELECT COALESCE(list_price_paise, base_price_paise) AS price, version, status
         FROM land_parcels WHERE id = $1 AND region_id = $2`,
        [intent.parcelId, regionId],
      );
      const parcel = rows[0];
      if (!parcel || parcel.status !== 'for_sale') return null;
      const price = Number(parcel.price);
      if (price > intent.maxPricePaise) return null;
      return {
        type: 'purchase_parcel',
        parcelId: intent.parcelId,
        expectedVersion: intent.expectedVersion,
        expectedPricePaise: price,
      };
    }
    case 'plant': {
      // The exact computation the plant command validates expectedCostPaise against.
      const cost = await computePlantingCost(deps.pool, {
        companyId: view.companyId,
        regionId,
        parcelId: intent.parcelId,
        cropId: intent.cropId,
        fertilize: intent.fertilize,
      }).catch(() => null);
      if (!cost) return null;
      return {
        type: 'plant',
        parcelId: intent.parcelId,
        cropId: intent.cropId,
        irrigate: intent.irrigate,
        fertilize: intent.fertilize,
        expectedCostPaise: cost.totalPaise,
      };
    }
    case 'harvest':
      return { type: 'harvest', plotId: intent.plotId };
    case 'clear_plot':
      return { type: 'clear_plot', plotId: intent.plotId };
    case 'pest_control':
      return { type: 'plot_operation', plotId: intent.plotId, op: 'pest_control' };
    case 'sell_market':
      if (intent.quantityKg <= 0) return null;
      return {
        type: 'sell_to_market',
        marketId: intent.marketId,
        itemId: intent.itemId,
        quantityKg: Math.floor(intent.quantityKg),
        // The AI decided on the current quote; any positive net price is acceptable.
        minNetUnitPricePaise: 0,
      };
    case 'create_listing': {
      if (intent.quantityKg <= 0) return null;
      // Keep the asking price inside the anti-manipulation band the command enforces.
      const [floor, ceiling] = p2pPriceBand(
        await bestMandiPricePaise(deps.pool, regionId, intent.itemId),
      );
      return {
        type: 'create_listing',
        itemId: intent.itemId,
        quantityKg: Math.floor(intent.quantityKg),
        unitPricePaise: Math.min(ceiling, Math.max(floor, Math.round(intent.unitPricePaise))),
        durationDays: intent.durationDays,
      };
    }
    case 'take_loan': {
      const sheet = await computeBalanceSheet(deps.pool, regionId, view.companyId);
      const offer = loanOfferFor(sheet);
      const principal = Math.min(intent.principalPaise, offer.maxPrincipalPaise);
      if (principal <= 0) return null;
      return {
        type: 'take_loan',
        principalPaise: principal,
        termMonths: Math.min(intent.termMonths, offer.maxTermMonths),
        expectedRateBps: offer.annualRateBps,
      };
    }
  }
}
