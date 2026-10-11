import { isApiError, type ClientErrorCode } from './http';

const TITLES: Partial<Record<ClientErrorCode, string>> = {
  CONFLICT: 'Someone got there first',
  PRICE_CHANGED: 'The price changed',
  INSUFFICIENT_FUNDS: 'Not enough cash',
  INSUFFICIENT_STOCK: 'Not enough stock',
  RULE_VIOLATION: 'Not allowed right now',
  LIMIT_EXCEEDED: 'Limit reached',
  RATE_LIMITED: 'Slow down a little',
  VALIDATION_FAILED: 'Please check the form',
  NOT_FOUND: 'Not found',
  FORBIDDEN: 'Not permitted',
  COMPANY_REQUIRED: 'Create a company first',
  UNAUTHENTICATED: 'Signed out',
  SERVICE_UNAVAILABLE: 'Server is busy',
  NETWORK_ERROR: 'Connection problem',
  INTERNAL: 'Something went wrong',
  BAD_RESPONSE: 'Unexpected response',
};

export interface DescribedError {
  title: string;
  message: string;
  code: ClientErrorCode | 'UNKNOWN';
}

export function describeError(err: unknown): DescribedError {
  if (isApiError(err)) {
    let message = err.message;
    if (err.code === 'CONFLICT') {
      message = `${err.message} The latest state has been reloaded — review it and try again.`;
    } else if (err.code === 'PRICE_CHANGED') {
      message = `${err.message} Updated figures have been loaded; please review before confirming again.`;
    }
    return { title: TITLES[err.code] ?? 'Request failed', message, code: err.code };
  }
  return {
    title: 'Something went wrong',
    message: err instanceof Error ? err.message : 'Unknown error',
    code: 'UNKNOWN',
  };
}

/** Errors after which the displayed state is known to be outdated. */
export function isStaleStateError(err: unknown): boolean {
  return isApiError(err) && (err.code === 'CONFLICT' || err.code === 'PRICE_CHANGED');
}
