/**
 * Farming commands: plant, plot operations, harvest, clear.
 * docs/IMPLEMENTATION.md §4 "Planting" / "Harvest"; DESIGN.md §5 "Plant and harvest".
 *
 * Accounting: production costs are expensed when incurred (Dr expense_* / Cr cash) and also
 * accumulated on the plot's cost_basis. At harvest the plot's cost basis (+ harvest labour) is
 * capitalised into the new lot (Dr inventory / Cr cogs), so inventory is carried at cost and
 * the cost is recognised as COGS when the produce is sold (or as spoilage if it rots).
 */
import {
  canIrrigate,
  computeSuitability,
  cropDurationDays,
  estimateHarvest,
  formatInr,
  getCrop,
  harvestCostPaise,
  isSowingOpen,
  monthOfDay,
  mulPaise,
  PEST_CONTROL_PROTECTION_DAYS,
  pestControlCostPaise,
  plantingCostPaise,
  createPlotState,
  type CropDefinition,
  type CropId,
  type CropPlotState,
  climateForEnv,
} from '@bh/domain';
import type { Queryable } from '../db/pool';
import { getRegion } from '../world/region';
import { conflict, forbidden, priceChanged, ruleViolation } from '../errors';
import { emitEvent } from '../events/events';
import { postLedger } from '../ledger/ledger';
import { machineryEffectsFor } from '../companies/company';
import {
  getActiveLease,
  getLivePlotForParcel,
  getParcel,
  getPlot,
  operatorOf,
  type PlotRow,
} from '../world/parcels';
import { lockParties, type CommandContext } from './context';
import { insertLot } from './inventory';
import { emitParcelUpdated } from './land';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

export interface PlantingCost {
  totalPaise: number;
  seedPaise: number;
  laborPaise: number;
  fertilizerPaise: number;
}

/**
 * Planting cost split for ledger lines. The total is the domain's plantingCostPaise (the value
 * clients display and send back as expectedCostPaise); labour takes the remainder so the lines
 * always sum to the total.
 */
export function plantingCostBreakdown(
  crop: CropDefinition,
  areaHa: number,
  fertilize: boolean,
  sowingLaborMultiplier: number,
): PlantingCost {
  const total = plantingCostPaise(crop, areaHa, { fertilize, sowingLaborMultiplier });
  const seed = Math.min(total, mulPaise(crop.costs.seedPaisePerHa, areaHa));
  const fert = fertilize
    ? Math.min(total - seed, mulPaise(crop.costs.fertilizerPaisePerHa, areaHa))
    : 0;
  return {
    totalPaise: total,
    seedPaise: seed,
    fertilizerPaise: fert,
    laborPaise: total - seed - fert,
  };
}

/**
 * The exact planting cost the `plant` command will charge (and require as expectedCostPaise)
 * for this company, parcel and crop: parcel area from the DB, the company's machinery effects.
 * The AI scheduler and clients should use this (or the same inputs) so guards always match.
 */
export async function computePlantingCost(
  db: Queryable,
  input: {
    companyId: string;
    regionId: string;
    parcelId: string;
    cropId: CropId;
    fertilize: boolean;
  },
): Promise<PlantingCost> {
  const parcel = await getParcel(db, input.regionId, input.parcelId);
  const effects = await machineryEffectsFor(db, input.companyId);
  return plantingCostBreakdown(
    getCrop(input.cropId),
    parcel.areaHa,
    input.fertilize,
    effects.sowingLaborMultiplier,
  );
}

/** Days of growth already completed by a plot. */
export function elapsedGrowthDays(state: CropPlotState, crop: CropDefinition): number {
  let days = 0;
  for (let i = 0; i < Math.min(state.stageIndex, crop.stages.length); i++) {
    days += crop.stages[i]!.days;
  }
  return days + (state.stageIndex < crop.stages.length ? state.stageDay : 0);
}

export async function plant(ctx: CommandContext, cmd: Cmd<'plant'>) {
  const me = ctx.actor.companyId;
  const parcel = await getParcel(ctx.client, ctx.regionId, cmd.parcelId, { forUpdate: true });
  const lease = await getActiveLease(ctx.client, parcel.id);
  if (operatorOf(parcel, lease) !== me) {
    throw ruleViolation('You can only plant on land you own or lease');
  }
  if (parcel.status === 'for_sale') {
    throw ruleViolation('This parcel is listed for sale; delist it before planting');
  }
  if (await getLivePlotForParcel(ctx.client, parcel.id)) {
    throw conflict('This parcel already has a crop');
  }

  const crop = getCrop(cmd.cropId);
  const month = monthOfDay(ctx.day);
  if (!isSowingOpen(crop, month)) {
    throw ruleViolation(`${crop.name} cannot be sown this month`, {
      sowingMonths: crop.sowingMonths,
    });
  }
  // The lease's end_day is its last usable day and a live crop is forfeited in that day's tick,
  // so the crop must be ready (and harvestable) strictly before it.
  if (lease && ctx.day + cropDurationDays(crop) >= lease.endDay) {
    throw ruleViolation(`${crop.name} would not mature before your lease ends`, {
      leaseEndDay: lease.endDay,
    });
  }
  const effects = await machineryEffectsFor(ctx.client, me);
  if (cmd.irrigate && !canIrrigate(parcel.env, effects.enablesDryIrrigation)) {
    throw ruleViolation('This parcel has no water access; a pump set is needed to irrigate');
  }

  const cost = plantingCostBreakdown(
    crop,
    parcel.areaHa,
    cmd.fertilize,
    effects.sowingLaborMultiplier,
  );
  if (cost.totalPaise !== cmd.expectedCostPaise) {
    throw priceChanged(cmd.expectedCostPaise, cost.totalPaise);
  }

  const region = await getRegion(ctx.client, ctx.regionId);
  const suitability = computeSuitability(
    crop,
    parcel.env,
    climateForEnv(parcel.env, region.climate),
    {
      sowingDay: ctx.day,
      irrigated: cmd.irrigate,
    },
  );
  const state = createPlotState({
    cropId: crop.id,
    sownDay: ctx.day,
    areaHa: parcel.areaHa,
    expectedYield: suitability.yieldKgPerHa,
    irrigated: cmd.irrigate,
    fertilized: cmd.fertilize,
  });

  await lockParties(ctx);
  // last_tick_day = today: growth starts with the tick that ends tomorrow (simulation convention).
  const { rows } = await ctx.client.query<{ id: string; version: number }>(
    `INSERT INTO crop_plots (parcel_id, company_id, crop_id, status, state, sown_day, last_tick_day,
       cost_basis_paise, ruleset_version)
     VALUES ($1, $2, $3, 'growing', $4, $5, $5, $6,
       (SELECT ruleset_version FROM world_clock WHERE region_id = $7))
     RETURNING id, version`,
    [parcel.id, me, crop.id, JSON.stringify(state), ctx.day, cost.totalPaise, ctx.regionId],
  );
  const plotId = rows[0]!.id;
  if (cost.totalPaise > 0) {
    await postLedger(ctx.client, {
      regionId: ctx.regionId,
      kind: 'planting',
      description: `Planting ${crop.name} on ${parcel.id}`,
      gameDay: ctx.day,
      refType: 'crop_plot',
      refId: plotId,
      entries: [
        { companyId: me, account: 'expense_seed', amountPaise: cost.seedPaise },
        { companyId: me, account: 'expense_labor', amountPaise: cost.laborPaise },
        { companyId: me, account: 'expense_inputs', amountPaise: cost.fertilizerPaise },
        { companyId: me, account: 'cash', amountPaise: -cost.totalPaise },
      ],
    });
  }
  await emitParcelUpdated(ctx, parcel.id);
  return {
    plotId,
    parcelId: parcel.id,
    cropId: crop.id,
    costPaise: cost.totalPaise,
    expectedYieldKgPerHa: suitability.yieldKgPerHa,
    readyDay: ctx.day + cropDurationDays(crop),
    version: rows[0]!.version,
  };
}

async function loadOwnPlot(ctx: CommandContext, plotId: string): Promise<PlotRow> {
  const plot = await getPlot(ctx.client, plotId, { forUpdate: true });
  if (plot.companyId !== ctx.actor.companyId) throw forbidden('This is not your crop');
  return plot;
}

async function savePlot(
  ctx: CommandContext,
  plot: PlotRow,
  patch: { state?: CropPlotState; status?: string; addCostPaise?: number; harvestedKg?: number },
): Promise<number> {
  const { rows } = await ctx.client.query<{ version: number }>(
    `UPDATE crop_plots SET state = COALESCE($2::jsonb, state), status = COALESCE($3, status),
       cost_basis_paise = cost_basis_paise + $4, harvested_kg = COALESCE($5, harvested_kg),
       version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING version`,
    [
      plot.id,
      patch.state ? JSON.stringify(patch.state) : null,
      patch.status ?? null,
      patch.addCostPaise ?? 0,
      patch.harvestedKg ?? null,
    ],
  );
  return rows[0]!.version;
}

export async function plotOperation(ctx: CommandContext, cmd: Cmd<'plot_operation'>) {
  const me = ctx.actor.companyId;
  const plot = await loadOwnPlot(ctx, cmd.plotId);
  if (plot.status !== 'growing')
    throw ruleViolation('Operations are only possible while the crop is growing');
  const crop = getCrop(plot.cropId);
  const parcel = await getParcel(ctx.client, ctx.regionId, plot.parcelId);
  const state: CropPlotState = { ...plot.state };
  let costPaise = 0;
  let account: 'expense_inputs' | null = null;

  switch (cmd.op) {
    case 'irrigation_on': {
      if (state.irrigated) throw ruleViolation('Irrigation is already on');
      const effects = await machineryEffectsFor(ctx.client, me);
      if (!canIrrigate(parcel.env, effects.enablesDryIrrigation)) {
        throw ruleViolation('This parcel has no water access; a pump set is needed to irrigate');
      }
      state.irrigated = true;
      break;
    }
    case 'irrigation_off':
      if (!state.irrigated) throw ruleViolation('Irrigation is already off');
      state.irrigated = false;
      break;
    case 'fertilize':
      if (state.fertilized) throw ruleViolation('This crop has already been fertilised');
      state.fertilized = true;
      costPaise = mulPaise(crop.costs.fertilizerPaisePerHa, plot.state.areaHa);
      account = 'expense_inputs';
      break;
    case 'pest_control':
      if (
        state.pestControlDay !== null &&
        ctx.day < state.pestControlDay + PEST_CONTROL_PROTECTION_DAYS
      ) {
        throw ruleViolation('This crop is still protected by the last pest control', {
          protectedUntilDay: state.pestControlDay + PEST_CONTROL_PROTECTION_DAYS,
        });
      }
      state.pestControlDay = ctx.day;
      costPaise = pestControlCostPaise(crop, plot.state.areaHa);
      account = 'expense_inputs';
      break;
  }

  await lockParties(ctx);
  if (account && costPaise > 0) {
    await postLedger(ctx.client, {
      regionId: ctx.regionId,
      kind: cmd.op,
      description: `${cmd.op === 'fertilize' ? 'Fertiliser' : 'Pest control'} for ${crop.name} on ${plot.parcelId}`,
      gameDay: ctx.day,
      refType: 'crop_plot',
      refId: plot.id,
      entries: [
        { companyId: me, account, amountPaise: costPaise },
        { companyId: me, account: 'cash', amountPaise: -costPaise },
      ],
    });
  }
  const version = await savePlot(ctx, plot, { state, addCostPaise: costPaise });
  return { plotId: plot.id, op: cmd.op, costPaise, version };
}

export async function harvest(ctx: CommandContext, cmd: Cmd<'harvest'>) {
  const me = ctx.actor.companyId;
  const plot = await loadOwnPlot(ctx, cmd.plotId);
  if (plot.status !== 'ready') {
    throw ruleViolation(
      plot.status === 'growing'
        ? 'This crop is not ready to harvest yet'
        : 'This crop cannot be harvested',
    );
  }
  const crop = getCrop(plot.cropId);
  const effects = await machineryEffectsFor(ctx.client, me);
  const estimate = estimateHarvest(plot.state, crop);
  const labour = harvestCostPaise(crop, plot.state.areaHa, effects.harvestLaborMultiplier);

  await lockParties(ctx);
  if (labour > 0) {
    await postLedger(ctx.client, {
      regionId: ctx.regionId,
      kind: 'harvest_labor',
      description: `Harvest labour for ${crop.name} on ${plot.parcelId}`,
      gameDay: ctx.day,
      refType: 'crop_plot',
      refId: plot.id,
      entries: [
        { companyId: me, account: 'expense_labor', amountPaise: labour },
        { companyId: me, account: 'cash', amountPaise: -labour },
      ],
    });
  }

  let lotId: string | null = null;
  const costBasis = plot.costBasisPaise + labour;
  if (estimate.quantityKg > 0) {
    const shelfLife = Math.max(1, Math.floor(crop.shelfLifeDays * effects.shelfLifeMultiplier));
    lotId = await insertLot(ctx, {
      companyId: me,
      itemId: crop.id,
      quantityKg: estimate.quantityKg,
      quality: estimate.quality,
      costBasisPaise: costBasis,
      source: 'harvest',
      sourceRef: plot.id,
      producedDay: ctx.day,
      expiresDay: ctx.day + shelfLife,
    });
    if (costBasis > 0) {
      // Capitalise accumulated production cost into inventory (relieved as COGS on sale).
      await postLedger(ctx.client, {
        regionId: ctx.regionId,
        kind: 'harvest_capitalisation',
        description: `${crop.name} harvest from ${plot.parcelId} taken into inventory at cost`,
        gameDay: ctx.day,
        refType: 'inventory_lot',
        refId: lotId,
        entries: [
          { companyId: me, account: 'inventory', amountPaise: costBasis },
          { companyId: me, account: 'cogs', amountPaise: -costBasis },
        ],
      });
    }
  }

  const harvestedState: CropPlotState = { ...plot.state, status: 'harvested' };
  const version = await savePlot(ctx, plot, {
    state: harvestedState,
    status: 'harvested',
    addCostPaise: labour,
    harvestedKg: estimate.quantityKg,
  });
  await emitParcelUpdated(ctx, plot.parcelId);
  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'crop.stage_changed',
    gameDay: ctx.day,
    companyId: me,
    actorCompanyId: me,
    entityType: 'crop_plot',
    entityId: plot.id,
    payload: { plotId: plot.id, parcelId: plot.parcelId, stage: 'harvested' },
  });
  return {
    plotId: plot.id,
    lotId,
    itemId: crop.id,
    quantityKg: estimate.quantityKg,
    quality: estimate.quality,
    harvestLaborPaise: labour,
    costBasisPaise: costBasis,
    summary: `${estimate.quantityKg.toLocaleString('en-IN')} kg of ${crop.name} (quality ${estimate.quality}) for ${formatInr(labour)} labour`,
    version,
  };
}

/** Clear a failed crop, or abandon a live one. Sunk costs stay expensed. */
export async function clearPlot(ctx: CommandContext, cmd: Cmd<'clear_plot'>) {
  const plot = await loadOwnPlot(ctx, cmd.plotId);
  if (plot.status !== 'growing' && plot.status !== 'ready' && plot.status !== 'failed') {
    throw ruleViolation('This plot has already been cleared or harvested');
  }
  await lockParties(ctx);
  const version = await savePlot(ctx, plot, { status: 'cleared' });
  await emitParcelUpdated(ctx, plot.parcelId);
  return { plotId: plot.id, parcelId: plot.parcelId, previousStatus: plot.status, version };
}
