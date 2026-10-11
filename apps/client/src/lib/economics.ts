/**
 * Client-side previews built on the shared domain rules. These only EXPLAIN costs before a
 * command; the server recomputes everything and rejects stale guards with PRICE_CHANGED.
 */
import type {
  CompanyOverviewResponse,
  CropInfoDto,
  CropPlotDto,
  MachineryResponse,
} from '@bh/contracts';
import {
  combinedMachineryEffects,
  computeLoanTerms,
  getCrop,
  mulPaise,
  plantingCostPaise,
  type CropId,
  type LoanTerms,
  type MachineryType,
} from '@bh/domain';

/** Run a domain helper, falling back if it is unavailable or throws on odd input. */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export interface MachineryEffects {
  sowingLaborMultiplier: number;
  harvestLaborMultiplier: number;
  transportCostMultiplier: number;
  irrigationCostMultiplier: number;
  enablesDryIrrigation: boolean;
  shelfLifeMultiplier: number;
  storageCapacityKg: number;
}

const NO_EFFECTS: MachineryEffects = {
  sowingLaborMultiplier: 1,
  harvestLaborMultiplier: 1,
  transportCostMultiplier: 1,
  irrigationCostMultiplier: 1,
  enablesDryIrrigation: false,
  shelfLifeMultiplier: 1,
  storageCapacityKg: 0,
};

export function machineryEffects(owned: readonly MachineryType[]): MachineryEffects {
  return safe(() => ({ ...NO_EFFECTS, ...combinedMachineryEffects([...owned]) }), NO_EFFECTS);
}

export interface PlantingQuote {
  seedPaise: number;
  sowingLaborPaise: number;
  fertilizerPaise: number;
  /** Exactly what the server will charge (domain rule) — sent as `expectedCostPaise`. */
  totalPaise: number;
  dailyIrrigationPaise: number;
  pestControlPaise: number;
  harvestLaborPaise: number;
}

export function plantingQuote(
  info: CropInfoDto,
  areaHa: number,
  opts: { fertilize: boolean; irrigate: boolean; effects: MachineryEffects },
): PlantingQuote {
  const c = info.costs;
  const seedPaise = mulPaise(c.seedPaisePerHa, areaHa);
  const sowingLaborPaise = mulPaise(
    c.sowingLaborPaisePerHa,
    areaHa * opts.effects.sowingLaborMultiplier,
  );
  const fertilizerPaise = opts.fertilize ? mulPaise(c.fertilizerPaisePerHa, areaHa) : 0;
  const fallbackTotal = seedPaise + sowingLaborPaise + fertilizerPaise;
  const totalPaise = safe(
    () =>
      plantingCostPaise(getCrop(info.id as CropId), areaHa, {
        fertilize: opts.fertilize,
        sowingLaborMultiplier: opts.effects.sowingLaborMultiplier,
      }),
    fallbackTotal,
  );
  return {
    seedPaise,
    sowingLaborPaise,
    fertilizerPaise,
    totalPaise,
    dailyIrrigationPaise: opts.irrigate
      ? mulPaise(c.irrigationPaisePerHaPerDay, areaHa * opts.effects.irrigationCostMultiplier)
      : 0,
    pestControlPaise: mulPaise(c.pestControlPaisePerHa, areaHa),
    harvestLaborPaise: mulPaise(
      c.harvestLaborPaisePerHa,
      areaHa * opts.effects.harvestLaborMultiplier,
    ),
  };
}

/**
 * Estimated recurring obligations for the next 30 days: loan EMIs and land tax from the
 * server's `upcoming` list, irrigation of live plots, machinery maintenance.
 */
export function monthlyObligationsPaise(
  overview: CompanyOverviewResponse | undefined,
  plots: readonly CropPlotDto[] | undefined,
  machinery: MachineryResponse | undefined,
): number {
  if (!overview) return 0;
  const today = overview.cashSeries.at(-1)?.day ?? 0;
  let total = 0;
  for (const u of overview.upcoming) {
    if (
      u.amountPaise &&
      u.amountPaise > 0 &&
      u.day - today <= 30 &&
      (u.kind === 'loan_due' || u.kind === 'land_tax')
    ) {
      total += u.amountPaise;
    }
  }
  for (const p of plots ?? []) {
    if (p.status === 'growing' && p.irrigated) total += p.dailyIrrigationCostPaise * 30;
  }
  if (machinery) {
    const byType = new Map(machinery.catalog.map((c) => [c.type, c.maintenancePaisePerDay]));
    for (const m of machinery.owned) total += (byType.get(m.type) ?? 0) * 30;
  }
  return total;
}

export function loanPreview(
  principalPaise: number,
  rateBps: number,
  termMonths: number,
): LoanTerms | null {
  if (!Number.isSafeInteger(principalPaise) || principalPaise <= 0 || termMonths < 1) return null;
  return safe(() => computeLoanTerms(principalPaise, rateBps, termMonths), null);
}

/** Rupee input string → paise (integer), or null if invalid. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** Integer kg input → number, or null. */
export function parseKg(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}
