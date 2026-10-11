/**
 * Steam Web API ticket validation (ISteamUserAuth/AuthenticateUserTicket/v1). The ticket and the
 * publisher key are secrets: never log them. The HTTP call is injectable for tests.
 */
import { z } from 'zod';
import type { AppConfig } from '../config';
import { DomainError } from '../errors';

/** Identity string the client passes to GetAuthTicketForWebApi. */
export const STEAM_TICKET_IDENTITY = 'bharat-harvest';
const STEAM_AUTH_URL = 'https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/';
const STEAM_TIMEOUT_MS = 5000;

export interface SteamIdentity {
  steamId: string;
}

/** Validates a hex ticket and returns the authenticated SteamID, or throws a DomainError. */
export type SteamTicketValidator = (ticket: string) => Promise<SteamIdentity>;

const SteamResponse = z.object({
  response: z.object({
    params: z
      .object({
        result: z.string(),
        steamid: z.string().regex(/^\d{1,20}$/),
        ownersteamid: z.string().optional(),
        vacbanned: z.boolean().optional(),
        publisherbanned: z.boolean().optional(),
      })
      .optional(),
    error: z.object({ errorcode: z.number(), errordesc: z.string() }).optional(),
  }),
});

export type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createSteamValidator(
  config: AppConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): SteamTicketValidator {
  return async (ticket: string) => {
    if (!config.steam.enabled) throw new DomainError('FORBIDDEN', 'Steam sign-in is not enabled');
    const url = new URL(STEAM_AUTH_URL);
    url.searchParams.set('key', config.steam.webApiKey);
    url.searchParams.set('appid', config.steam.appId);
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('identity', STEAM_TICKET_IDENTITY);

    let body: unknown;
    try {
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(STEAM_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        throw new DomainError('SERVICE_UNAVAILABLE', 'Steam could not be reached; try again');
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof DomainError) throw err;
      // Deliberately not including err (its message could contain the request URL with secrets).
      throw new DomainError('SERVICE_UNAVAILABLE', 'Steam could not be reached; try again');
    }
    const parsed = SteamResponse.safeParse(body);
    const params = parsed.success ? parsed.data.response.params : undefined;
    if (!params || params.result !== 'OK') {
      throw new DomainError('UNAUTHENTICATED', 'Steam ticket was rejected');
    }
    if (params.publisherbanned) {
      throw new DomainError('FORBIDDEN', 'This Steam account is banned from the game');
    }
    return { steamId: params.steamid };
  };
}
