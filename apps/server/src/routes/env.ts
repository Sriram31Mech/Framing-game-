import type { CoreDeps, SteamTicketValidator } from '@bh/core';
import type { Metrics } from '../metrics';

/** Requests per minute (docs/IMPLEMENTATION.md §5). */
export interface RateLimits {
  /** Per IP on /auth/*. */
  auth: number;
  /** Per session (or IP) on POST commands. */
  commands: number;
  /** Per session (or IP) on GET queries. */
  queries: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { auth: 10, commands: 120, queries: 600 };

/** Everything route modules need. */
export interface RouteEnv {
  deps: CoreDeps;
  metrics: Metrics;
  rateLimits: RateLimits;
  steamValidator: SteamTicketValidator;
}
