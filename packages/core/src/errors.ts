import { ERROR_STATUS, type ErrorCode } from '@bh/contracts';

/**
 * Expected, user-facing failure of a command or query (insufficient funds, stale version, ...).
 * Anything that is not a DomainError is an internal error and must not leak details to clients.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const isDomainError = (err: unknown): err is DomainError => err instanceof DomainError;

export const notFound = (what: string, id?: string) =>
  new DomainError('NOT_FOUND', id ? `${what} ${id} not found` : `${what} not found`);
export const conflict = (message: string, details?: unknown) =>
  new DomainError('CONFLICT', message, details);
export const ruleViolation = (message: string, details?: unknown) =>
  new DomainError('RULE_VIOLATION', message, details);
export const forbidden = (message = 'You do not have access to this resource') =>
  new DomainError('FORBIDDEN', message);
export const insufficientFunds = (requiredPaise: number, availablePaise: number) =>
  new DomainError('INSUFFICIENT_FUNDS', 'Not enough cash for this action', {
    requiredPaise,
    availablePaise,
  });
export const insufficientStock = (requiredKg: number, availableKg: number) =>
  new DomainError('INSUFFICIENT_STOCK', 'Not enough available stock', { requiredKg, availableKg });
export const priceChanged = (expected: number, actual: number) =>
  new DomainError('PRICE_CHANGED', 'The price changed; review and try again', { expected, actual });
