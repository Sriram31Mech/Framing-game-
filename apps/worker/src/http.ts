import { createServer, type Server } from 'node:http';
import type { WorkerMetrics } from './metrics';
import type { WorkerStatus } from './worker';

/**
 * Metrics + health endpoint (WORKER_METRICS_PORT, default 9464):
 *  - GET /metrics  Prometheus exposition
 *  - GET /healthz  { status, leader, gameDay, targetDay, lagDays, ... }; 503 when the loop has
 *    stalled (no iteration completed for a while) so orchestrators can restart the process.
 */
export function startHttpServer(opts: {
  port: number;
  host?: string;
  metrics: WorkerMetrics;
  status: () => WorkerStatus;
  stallAfterMs: number;
}): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url === '/metrics') {
      opts.metrics.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': opts.metrics.registry.contentType }).end(body);
        })
        .catch(() => res.writeHead(500).end());
      return;
    }
    if (url === '/healthz') {
      const s = opts.status();
      const last = s.lastLoopAt ? Date.parse(s.lastLoopAt) : null;
      const stalled = last !== null && Date.now() - last > opts.stallAfterMs;
      const body = JSON.stringify({ status: stalled ? 'stalled' : 'ok', ...s });
      res.writeHead(stalled ? 503 : 200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve(server));
  });
}
