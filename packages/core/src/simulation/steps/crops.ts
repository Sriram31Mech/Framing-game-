import {
  advanceCropDay,
  getCrop,
  PEST_CONTROL_PROTECTION_DAYS,
  rngFor,
  districtWeatherOn,
  TN_DISTRICTS,
  type CropEvent,
  type DailyWeather,
  type CropId,
  type CropPlotState,
  type ParcelEnvironment,
} from '@bh/domain';
import { chunk, tickEvent, tickNotify } from '../effects';
import type { TickContext } from '../types';

const UPDATE_BATCH = 500;

export interface LivePlotRow {
  id: string;
  parcel_id: string;
  company_id: string;
  crop_id: CropId;
  status: 'growing' | 'ready';
  state: CropPlotState;
  env: ParcelEnvironment;
}

/** A plot that was being irrigated while growing during day D (charged in the irrigation step). */
export interface IrrigatedPlot {
  plotId: string;
  parcelId: string;
  companyId: string;
  state: CropPlotState;
  env: ParcelEnvironment;
}

/**
 * Step 2 — crop growth. Advances every live plot (growing/ready) in the region by one day with
 * `advanceCropDay`, seeded by rngFor(regionSeed, plotId, day) so the outcome is independent of
 * processing order and of whether the day ran live or during offline catch-up.
 * `last_tick_day < D` guards against applying a day twice to the same plot (plots sown during
 * day D with last_tick_day = D start growing on the next tick).
 */
export async function advanceCrops(ctx: TickContext): Promise<IrrigatedPlot[]> {
  const { rows } = await ctx.client.query<LivePlotRow>(
    `SELECT p.id, p.parcel_id, p.company_id, p.crop_id, p.status, p.state, lp.env
     FROM crop_plots p
     JOIN land_parcels lp ON lp.id = p.parcel_id
     WHERE lp.region_id = $1 AND p.status IN ('growing', 'ready') AND p.last_tick_day < $2
     ORDER BY p.id`,
    [ctx.regionId, ctx.day],
  );

  // Each district has its own climate and therefore its own (deterministic) daily weather.
  const districtWeather = new Map<string, DailyWeather>();
  const weatherFor = (districtId: string | undefined): DailyWeather => {
    if (!districtId || !TN_DISTRICTS[districtId]) return ctx.weather;
    let w = districtWeather.get(districtId);
    if (!w) {
      w = districtWeatherOn(ctx.regionSeed, districtId, ctx.day);
      districtWeather.set(districtId, w);
    }
    return w;
  };
  const irrigated: IrrigatedPlot[] = [];
  const updates: { id: string; state: CropPlotState; status: string }[] = [];

  for (const row of rows) {
    const crop = getCrop(row.crop_id);
    // Irrigation is charged for the day the plot spent growing with irrigation switched on.
    if (row.state.status === 'growing' && row.state.irrigated) {
      irrigated.push({
        plotId: row.id,
        parcelId: row.parcel_id,
        companyId: row.company_id,
        state: row.state,
        env: row.env,
      });
    }
    const { state, events } = advanceCropDay(row.state, {
      crop,
      env: row.env,
      weather: weatherFor(row.env.districtId),
      random: rngFor(ctx.regionSeed, row.id, ctx.day),
    });
    updates.push({ id: row.id, state, status: state.status });
    ctx.stats.plotsProcessed++;
    ctx.stats.cropEvents += events.length;
    await handleCropEvents(ctx, row, crop.name, events);
  }

  for (const batch of chunk(updates, UPDATE_BATCH)) {
    await ctx.client.query(
      `UPDATE crop_plots p
       SET state = u.state, status = u.status, last_tick_day = $1, version = p.version + 1,
           updated_at = now()
       FROM unnest($2::uuid[], $3::jsonb[], $4::text[]) AS u(id, state, status)
       WHERE p.id = u.id`,
      [
        ctx.day,
        batch.map((u) => u.id),
        batch.map((u) => JSON.stringify(u.state)),
        batch.map((u) => u.status),
      ],
    );
  }
  return irrigated;
}

async function handleCropEvents(
  ctx: TickContext,
  plot: LivePlotRow,
  cropName: string,
  events: CropEvent[],
): Promise<void> {
  const base = { plotId: plot.id, parcelId: plot.parcel_id };
  const owner = plot.company_id;
  for (const ev of events) {
    switch (ev.type) {
      case 'stage_changed':
        await tickEvent(ctx, {
          type: 'crop.stage_changed',
          companyId: owner,
          entityType: 'crop_plot',
          entityId: plot.id,
          payload: { ...base, stage: ev.stage },
        });
        break;
      case 'ready':
        ctx.stats.cropsReady++;
        await tickEvent(ctx, {
          type: 'crop.harvest_ready',
          companyId: owner,
          entityType: 'crop_plot',
          entityId: plot.id,
          payload: base,
        });
        await tickEvent(ctx, {
          type: 'parcel.updated',
          companyId: null,
          entityType: 'parcel',
          entityId: plot.parcel_id,
          payload: { parcelId: plot.parcel_id },
        });
        await tickNotify(ctx, {
          companyId: owner,
          type: 'crop_ready',
          severity: 'success',
          title: `${cropName} ready to harvest`,
          body: `Your ${cropName} on parcel ${plot.parcel_id} is mature. Harvest soon to avoid overripe losses.`,
          entityType: 'crop_plot',
          entityId: plot.id,
          dedupeKey: `crop-ready:${plot.id}`,
        });
        break;
      case 'failed':
        ctx.stats.cropsFailed++;
        await tickEvent(ctx, {
          type: 'crop.failed',
          companyId: owner,
          entityType: 'crop_plot',
          entityId: plot.id,
          payload: { ...base, reason: ev.reason },
        });
        await tickEvent(ctx, {
          type: 'parcel.updated',
          companyId: null,
          entityType: 'parcel',
          entityId: plot.parcel_id,
          payload: { parcelId: plot.parcel_id },
        });
        await tickNotify(ctx, {
          companyId: owner,
          type: 'crop_failed',
          severity: 'danger',
          title: `${cropName} crop failed`,
          body: `The ${cropName} on parcel ${plot.parcel_id} failed (${ev.reason}). Clear the plot to replant.`,
          entityType: 'crop_plot',
          entityId: plot.id,
          dedupeKey: `crop-failed:${plot.id}`,
        });
        break;
      case 'pest_alert':
        await tickNotify(ctx, {
          companyId: owner,
          type: 'pest_alert',
          severity: 'warning',
          title: `Pest pressure on ${cropName}`,
          body: `Pest pressure on parcel ${plot.parcel_id} is ${Math.round(ev.pressure * 100)}%. Consider pest control.`,
          entityType: 'crop_plot',
          entityId: plot.id,
          dedupeKey: `pest-alert:${plot.id}:${Math.floor(ctx.day / PEST_CONTROL_PROTECTION_DAYS)}`,
        });
        break;
      case 'water_stress':
        await tickNotify(ctx, {
          companyId: owner,
          type: 'water_stress',
          severity: 'warning',
          title: `${cropName} is water-stressed`,
          body: `Water stress on parcel ${plot.parcel_id} is ${Math.round(ev.stress * 100)}%. Irrigation would help.`,
          entityType: 'crop_plot',
          entityId: plot.id,
          dedupeKey: `water-stress:${plot.id}:${Math.floor(ctx.day / 30)}`,
        });
        break;
      case 'yield_loss':
        if (ev.reason === 'overripe') {
          await tickNotify(ctx, {
            companyId: owner,
            type: 'crop_overripe',
            severity: 'warning',
            title: `${cropName} is overripe`,
            body: `The ${cropName} on parcel ${plot.parcel_id} is past its harvest window and losing yield.`,
            entityType: 'crop_plot',
            entityId: plot.id,
            dedupeKey: `crop-overripe:${plot.id}`,
          });
        }
        break;
    }
  }
}
