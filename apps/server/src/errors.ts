/**
 * Central error handling: every error leaves the server as { error: { code, message, details? } }.
 * Domain errors carry their own status; framework 4xx errors are mapped; everything else is a
 * logged 500 INTERNAL with no internals (stack, SQL, messages) sent to the client.
 */
import type { ErrorCode } from '@bh/contracts';
import { isDomainError } from '@bh/core';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function send(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  return reply
    .status(status)
    .send({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

const FRAMEWORK_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_FAILED',
  415: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (isDomainError(err)) {
      if (err.status >= 500) req.log.warn({ code: err.code }, err.message);
      return send(reply, err.status, err.code, err.message, err.details);
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const code = FRAMEWORK_CODES[status] ?? 'VALIDATION_FAILED';
      const message =
        status === 413
          ? 'Request body is too large'
          : status === 415
            ? 'Unsupported content type'
            : code === 'VALIDATION_FAILED'
              ? 'Malformed request'
              : err.message;
      return send(reply, status, code, message);
    }
    req.log.error({ err, reqId: req.id }, 'unhandled error');
    return send(reply, 500, 'INTERNAL', `Something went wrong (request ${req.id})`);
  });
}

export function notFoundBody(path: string) {
  return { error: { code: 'NOT_FOUND' as const, message: `Route ${path} not found` } };
}
