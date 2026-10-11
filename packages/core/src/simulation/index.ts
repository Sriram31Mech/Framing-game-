// OWNER: simulation agent. Public surface (signatures are binding):
//   advanceDay(deps, regionId): Promise<AdvanceDayResult>
//   catchUp(deps, regionId, opts?: { now?: Date; maxDays?: number }): Promise<{ daysAdvanced: number; gameDay: number }>
//   runReconciliation(deps, regionId): Promise<ReconciliationReport>
export {};
