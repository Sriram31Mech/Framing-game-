/**
 * POST command endpoints. Each request: auth → Idempotency-Key → validation → company → command.
 * The acting company always comes from the session, never from the request.
 */
import {
  AcceptContractRequest,
  BuyListingRequest,
  BuyMachineryRequest,
  CreateCompanyRequest,
  CreateContractRequest,
  CreateListingRequest,
  LeaseParcelRequest,
  ListParcelRequest,
  MarkNotificationsReadRequest,
  PlantRequest,
  PlotOperationRequest,
  PurchaseParcelRequest,
  RepayLoanRequest,
  SellParcelToStateRequest,
  SellToMarketRequest,
  TakeLoanRequest,
} from '@bh/contracts';
import {
  createCompany,
  executeCommand,
  findCompany,
  getCurrentGameDay,
  type AuthContext,
  type GameCommand,
} from '@bh/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  getAuth,
  groupRateLimit,
  parseInput,
  rateLimitKey,
  requireAuth,
  requireCompanyId,
  requireIdempotencyKey,
} from '../http';
import type { RouteEnv } from './env';

const Empty = z.object({}).strict();
const ParcelParams = z.object({ parcelId: z.string().min(1).max(32) });
const id = (name: string) => z.object({ [name]: z.uuid() });
const MarketParams = z.object({ marketId: z.string().min(1).max(64) });

interface CommandRoute<P extends z.ZodType, B extends z.ZodType> {
  url: string;
  params: P;
  body: B;
  toCommand(params: z.infer<P>, body: z.infer<B>): GameCommand;
}

const route = <P extends z.ZodType, B extends z.ZodType>(r: CommandRoute<P, B>) => r;

/** Every gameplay command endpoint and how it maps to a GameCommand. */
export const COMMAND_ROUTES = [
  route({
    url: '/api/v1/parcels/:parcelId/purchase',
    params: ParcelParams,
    body: PurchaseParcelRequest,
    toCommand: (p, b) => ({ type: 'purchase_parcel', parcelId: p.parcelId, ...b }),
  }),
  route({
    url: '/api/v1/parcels/:parcelId/lease',
    params: ParcelParams,
    body: LeaseParcelRequest,
    toCommand: (p, b) => ({ type: 'lease_parcel', parcelId: p.parcelId, ...b }),
  }),
  route({
    url: '/api/v1/parcels/:parcelId/list',
    params: ParcelParams,
    body: ListParcelRequest,
    toCommand: (p, b) => ({ type: 'list_parcel', parcelId: p.parcelId, pricePaise: b.pricePaise }),
  }),
  route({
    url: '/api/v1/parcels/:parcelId/delist',
    params: ParcelParams,
    body: Empty,
    toCommand: (p) => ({ type: 'delist_parcel', parcelId: p.parcelId }),
  }),
  route({
    url: '/api/v1/parcels/:parcelId/sell-to-state',
    params: ParcelParams,
    body: SellParcelToStateRequest,
    toCommand: (p, b) => ({ type: 'sell_parcel_to_state', parcelId: p.parcelId, ...b }),
  }),
  route({
    url: '/api/v1/crop-plots',
    params: Empty,
    body: PlantRequest,
    toCommand: (_p, b) => ({ type: 'plant', ...b }),
  }),
  route({
    url: '/api/v1/crop-plots/:plotId/operations',
    params: id('plotId'),
    body: PlotOperationRequest,
    toCommand: (p, b) => ({ type: 'plot_operation', plotId: String(p.plotId), op: b.op }),
  }),
  route({
    url: '/api/v1/crop-plots/:plotId/harvest',
    params: id('plotId'),
    body: Empty,
    toCommand: (p) => ({ type: 'harvest', plotId: String(p.plotId) }),
  }),
  route({
    url: '/api/v1/crop-plots/:plotId/clear',
    params: id('plotId'),
    body: Empty,
    toCommand: (p) => ({ type: 'clear_plot', plotId: String(p.plotId) }),
  }),
  route({
    url: '/api/v1/markets/:marketId/sell',
    params: MarketParams,
    body: SellToMarketRequest,
    toCommand: (p, b) => ({ type: 'sell_to_market', marketId: p.marketId, ...b }),
  }),
  route({
    url: '/api/v1/market-listings',
    params: Empty,
    body: CreateListingRequest,
    toCommand: (_p, b) => ({ type: 'create_listing', ...b }),
  }),
  route({
    url: '/api/v1/market-listings/:listingId/purchase',
    params: id('listingId'),
    body: BuyListingRequest,
    toCommand: (p, b) => ({ type: 'buy_listing', listingId: String(p.listingId), ...b }),
  }),
  route({
    url: '/api/v1/market-listings/:listingId/cancel',
    params: id('listingId'),
    body: Empty,
    toCommand: (p) => ({ type: 'cancel_listing', listingId: String(p.listingId) }),
  }),
  route({
    url: '/api/v1/contracts',
    params: Empty,
    body: CreateContractRequest,
    toCommand: (_p, b) => ({ type: 'create_contract', ...b }),
  }),
  route({
    url: '/api/v1/contracts/:contractId/accept',
    params: id('contractId'),
    body: AcceptContractRequest,
    toCommand: (p, b) => ({ type: 'accept_contract', contractId: String(p.contractId), ...b }),
  }),
  route({
    url: '/api/v1/contracts/:contractId/deliver',
    params: id('contractId'),
    body: Empty,
    toCommand: (p) => ({ type: 'deliver_contract', contractId: String(p.contractId) }),
  }),
  route({
    url: '/api/v1/contracts/:contractId/cancel',
    params: id('contractId'),
    body: Empty,
    toCommand: (p) => ({ type: 'cancel_contract', contractId: String(p.contractId) }),
  }),
  route({
    url: '/api/v1/loans',
    params: Empty,
    body: TakeLoanRequest,
    toCommand: (_p, b) => ({ type: 'take_loan', ...b }),
  }),
  route({
    url: '/api/v1/loans/:loanId/repay',
    params: id('loanId'),
    body: RepayLoanRequest,
    toCommand: (p, b) => ({
      type: 'repay_loan',
      loanId: String(p.loanId),
      amountPaise: b.amountPaise,
    }),
  }),
  route({
    url: '/api/v1/machinery',
    params: Empty,
    body: BuyMachineryRequest,
    toCommand: (_p, b) => ({
      type: 'buy_machinery',
      machineryType: b.type,
      expectedPricePaise: b.expectedPricePaise,
    }),
  }),
  route({
    url: '/api/v1/machinery/:assetId/sell',
    params: id('assetId'),
    body: Empty,
    toCommand: (p) => ({ type: 'sell_machinery', assetId: String(p.assetId) }),
  }),
  route({
    url: '/api/v1/notifications/read',
    params: Empty,
    body: MarkNotificationsReadRequest,
    toCommand: (_p, b) => ({ type: 'mark_notifications_read', ids: b.ids, all: b.all }),
  }),
];

function actorOf(auth: AuthContext) {
  return {
    companyId: requireCompanyId(auth),
    accountId: auth.accountId,
    kind: 'human' as const,
    regionId: auth.regionId,
  };
}

export function registerCommandRoutes(app: FastifyInstance, env: RouteEnv): void {
  const { deps, metrics } = env;
  const opts = {
    onRequest: groupRateLimit(app, {
      name: 'commands',
      max: env.rateLimits.commands,
      keyGenerator: rateLimitKey,
    }),
    preHandler: requireAuth(deps),
  };

  for (const r of COMMAND_ROUTES) {
    app.post(r.url, opts, async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const key = requireIdempotencyKey(req);
      const params = parseInput(r.params, req.params, 'params');
      const body = parseInput(r.body, req.body, 'body');
      const actor = actorOf(auth);
      // Each route's toCommand matches its own schemas; the union erases that pairing.
      const command = (r.toCommand as (p: unknown, b: unknown) => GameCommand)(params, body);
      const outcome = await executeCommand(deps, actor, command, { idempotencyKey: key });
      metrics.commandOutcomes.inc({
        type: command.type,
        result: outcome.ok ? (outcome.replayed ? 'replayed' : 'ok') : outcome.error.code,
      });
      if (outcome.replayed) void reply.header('idempotent-replayed', 'true');
      if (outcome.ok) {
        return reply
          .status(200)
          .send({ ok: true, gameDay: outcome.gameDay, result: outcome.result });
      }
      return reply.status(outcome.status).send({ error: outcome.error });
    });
  }

  // Founding a company is not a GameCommand (there is no company yet); it is idempotent per
  // account: retrying with the same name returns the existing company.
  app.post('/api/v1/companies', opts, async (req, reply) => {
    const auth = getAuth(req);
    requireIdempotencyKey(req);
    const body = parseInput(CreateCompanyRequest, req.body, 'body');
    const res = await createCompany(deps, {
      accountId: auth.accountId,
      name: body.name,
      kind: 'human',
      regionId: auth.regionId,
    });
    const company = await findCompany(deps.pool, res.companyId);
    const gameDay = await getCurrentGameDay(deps.pool, auth.regionId);
    metrics.commandOutcomes.inc({
      type: 'create_company',
      result: res.existing ? 'replayed' : 'ok',
    });
    if (res.existing) void reply.header('idempotent-replayed', 'true');
    return reply.status(res.existing ? 200 : 201).send({
      ok: true,
      gameDay,
      result: {
        company: company && {
          id: company.id,
          name: company.name,
          kind: company.kind,
          status: company.status,
          cashPaise: company.cashPaise,
          aiPersonality: company.aiPersonality,
        },
        starterParcelId: res.starterParcelId,
      },
    });
  });
}
