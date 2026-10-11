// OWNER: simulation agent. Public surface (signatures are binding):
//   runAiCompanies(deps, regionId, gameDay): Promise<{ companies: number; commands: number; failures: number }>
//   buildAiWorldView(db, companyId, gameDay): Promise<AiWorldView>
export {
  aiIdempotencyKey,
  intentToCommand,
  runAiCompanies,
  type AiRunOptions,
  type AiRunResult,
} from './runner';
export { buildAiWorldView } from './view';
