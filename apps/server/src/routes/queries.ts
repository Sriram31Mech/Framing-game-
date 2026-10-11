/**
 * GET query endpoints (authenticated, 600/min per session).
 */
import {
  ContractsQuery,
  LedgerQuery,
  ListingsQuery,
  NotificationsQuery,
  PriceHistoryQuery,
  SaleQuoteQuery,
} from '@bh/contracts';
import {
  getAwaySummary,
  getCompanyInventory,
  getCompanyLedger,
  getCompanyLoans,
  getCompanyMachinery,
  getCompanyNotifications,
  getCompanyOverview,
  getCompanyPlots,
  getContracts,
  getCrops,
  getLeaderboard,
  getListings,
  getMarkets,
  getMe,
  getParcelDetail,
  getParcelSuitability,
  getPriceHistory,
  getRegionMap,
  getSaleQuote,
  getWorld,
} from '@bh/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAuth, groupRateLimit, parseInput, rateLimitKey, requireAuth } from '../http';
import type { RouteEnv } from './env';

const ParcelParams = z.object({ parcelId: z.string().min(1).max(32) });
const CompanyParams = z.object({ companyId: z.uuid() });
const MarketParams = z.object({ marketId: z.string().min(1).max(64) });
const RegionParams = z.object({ regionId: z.string().min(1).max(64) });
const AwayQuery = z.object({ since: z.coerce.number().int().min(0).optional() });

export function registerQueryRoutes(app: FastifyInstance, env: RouteEnv): void {
  const { deps } = env;
  const opts = {
    onRequest: groupRateLimit(app, {
      name: 'queries',
      max: env.rateLimits.queries,
      keyGenerator: rateLimitKey,
    }),
    preHandler: requireAuth(deps),
  };

  app.get('/api/v1/me', opts, async (req) => getMe(deps, getAuth(req)));
  app.get('/api/v1/world', opts, async (req) => getWorld(deps, getAuth(req)));
  app.get('/api/v1/regions/:regionId/map', opts, async (req) => {
    const { regionId } = parseInput(RegionParams, req.params, 'params');
    return getRegionMap(deps, regionId);
  });
  app.get('/api/v1/parcels/:parcelId', opts, async (req) => {
    const { parcelId } = parseInput(ParcelParams, req.params, 'params');
    return getParcelDetail(deps, getAuth(req), parcelId);
  });
  app.get('/api/v1/parcels/:parcelId/suitability', opts, async (req) => {
    const { parcelId } = parseInput(ParcelParams, req.params, 'params');
    return getParcelSuitability(deps, getAuth(req), parcelId);
  });
  app.get('/api/v1/crops', opts, async (req) => getCrops(deps, getAuth(req)));

  app.get('/api/v1/companies/:companyId/overview', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    return getCompanyOverview(deps, getAuth(req), companyId);
  });
  app.get('/api/v1/companies/:companyId/ledger', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    const query = parseInput(LedgerQuery, req.query, 'query');
    return getCompanyLedger(deps, getAuth(req), companyId, query);
  });
  app.get('/api/v1/companies/:companyId/inventory', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    return getCompanyInventory(deps, getAuth(req), companyId);
  });
  app.get('/api/v1/companies/:companyId/plots', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    return getCompanyPlots(deps, getAuth(req), companyId);
  });
  app.get('/api/v1/companies/:companyId/loans', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    return getCompanyLoans(deps, getAuth(req), companyId);
  });
  app.get('/api/v1/companies/:companyId/machinery', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    return getCompanyMachinery(deps, getAuth(req), companyId);
  });
  app.get('/api/v1/companies/:companyId/notifications', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    const query = parseInput(NotificationsQuery, req.query, 'query');
    return getCompanyNotifications(deps, getAuth(req), companyId, query);
  });
  app.get('/api/v1/companies/:companyId/away-summary', opts, async (req) => {
    const { companyId } = parseInput(CompanyParams, req.params, 'params');
    const query = parseInput(AwayQuery, req.query, 'query');
    return getAwaySummary(deps, getAuth(req), companyId, query);
  });

  app.get('/api/v1/markets', opts, async (req) => getMarkets(deps, getAuth(req)));
  app.get('/api/v1/markets/:marketId/prices', opts, async (req) => {
    const { marketId } = parseInput(MarketParams, req.params, 'params');
    const query = parseInput(PriceHistoryQuery, req.query, 'query');
    return getPriceHistory(deps, getAuth(req), marketId, query);
  });
  app.get('/api/v1/markets/:marketId/quote', opts, async (req) => {
    const { marketId } = parseInput(MarketParams, req.params, 'params');
    const query = parseInput(SaleQuoteQuery, req.query, 'query');
    return getSaleQuote(deps, getAuth(req), marketId, query);
  });
  app.get('/api/v1/market-listings', opts, async (req) => {
    const query = parseInput(ListingsQuery, req.query, 'query');
    return getListings(deps, getAuth(req), query);
  });
  app.get('/api/v1/contracts', opts, async (req) => {
    const query = parseInput(ContractsQuery, req.query, 'query');
    return getContracts(deps, getAuth(req), query);
  });
  app.get('/api/v1/leaderboard', opts, async (req) => getLeaderboard(deps, getAuth(req)));
}
