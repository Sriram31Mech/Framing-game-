// OWNER: backend agent. Barrel for commands/execute, queries, auth, world bootstrap, companies.
// Public surface (signatures are binding):
//   executeCommand(deps, actor, command, opts): Promise<CommandOutcome>   (commands/execute.ts)
//   bootstrapWorld(deps, opts?: { regionId?: string; seed?: number }): Promise<{ created: boolean }>  (world/bootstrap.ts)
//   createCompany(deps, input): Promise<{ companyId: string }>   (commands/company.ts)
export {};
