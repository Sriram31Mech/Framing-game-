// OWNER: backend agent. Barrel for commands/execute, queries, auth, world bootstrap, companies.
// Public surface (signatures are binding):
//   executeCommand(deps, actor, command, opts): Promise<CommandOutcome>   (commands/execute.ts)
//   bootstrapWorld(deps, opts?: { regionId?: string; seed?: number }): Promise<{ created: boolean }>  (world/bootstrap.ts)
//   createCompany(deps, input): Promise<{ companyId: string }>   (companies/create.ts)
export {
  executeCommand,
  commandRequestHash,
  DISTRESSED_ALLOWED_COMMANDS,
} from './commands/execute';
export { canonicalJson } from './commands/context';
export { contractTermsHash, type ContractTerms } from './commands/contracts';
export {
  computePlantingCost,
  plantingCostBreakdown,
  elapsedGrowthDays,
  type PlantingCost,
} from './commands/farming';
export { askingPricePaise, stateBuybackPricePaise, parcelListPriceBand } from './commands/land';
export { computeMarketSale, type MarketSaleCalc } from './commands/market';
export { MAX_OPEN_LISTINGS_PER_COMPANY } from './commands/listings';
export { MAX_OPEN_CONTRACTS_PER_COMPANY } from './commands/contracts';
export { MAX_ACTIVE_LOANS } from './commands/finance';

export {
  bootstrapWorld,
  polygonWkt,
  type BootstrapOptions,
  type BootstrapResult,
} from './world/bootstrap';
export * from './world/region';
export * from './world/parcels';

export {
  createCompany,
  createCompanyInTx,
  type CreateCompanyInput,
  type CreateCompanyResult,
} from './companies/create';
export * from './companies/company';
export * from './companies/valuation';

export * from './auth/password';
export * from './auth/sessions';
export * from './auth/steam';
export * from './auth/accounts';

export { assertCompanyAccess, requireCompany, toPlotDto } from './queries/common';
export * from './queries/world';
export * from './queries/company';
export * from './queries/markets';
