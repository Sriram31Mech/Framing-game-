// OWNER: simulation agent. Public surface (signatures are binding):
//   advanceDay(deps, regionId): Promise<AdvanceDayResult>
//   catchUp(deps, regionId, opts?: { now?: Date; maxDays?: number }): Promise<{ daysAdvanced: number; gameDay: number }>
//   runReconciliation(deps, regionId): Promise<ReconciliationReport>
export { advanceDay, TICK_LOCK_CLASS } from './tick';
export { catchUp, type CatchUpOptions, type CatchUpResult } from './catchup';
export {
  runReconciliation,
  type ReconciliationIssue,
  type ReconciliationReport,
} from './reconcile';
export type { AdvanceDayOptions, AdvanceDayResult, TickStats } from './types';
