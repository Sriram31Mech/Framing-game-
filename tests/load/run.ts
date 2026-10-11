/**
 * Bharat Harvest load test: N concurrent simulated players against a running server.
 *
 *   pnpm load                                   # 16 players, 120 s, against http://localhost:8080
 *   pnpm load --players 64 --duration 300 --p95 300 --out tests/load/results/run.json
 *
 * Each virtual player logs in (dev-login when the server enables it, otherwise register + login),
 * creates a company, keeps a WebSocket open, polls world/map/overview/markets at human-like
 * intervals and issues commands (buy land, plant, harvest, sell, list, buy listings) with
 * Idempotency-Keys — occasionally replaying a command to verify idempotent responses.
 *
 * Exit code is non-zero when: any 5xx or network error, an idempotent replay differs from the
 * original, or p95 latency exceeds --p95 (overall, or for any endpoint with >= --min-samples).
 * Expected game outcomes (409 CONFLICT / PRICE_CHANGED, 422 rule violations, 429) are reported but
 * do not fail the run.
 *
 * Only Node built-ins are used (fetch, global WebSocket — Node 22+). Run with tsx.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import type {
  AuthConfigResponse,
  AuthResponse,
  CompanyOverviewResponse,
  CropsResponse,
  InventoryResponse,
  ListingsResponse,
  MarketsResponse,
  MeResponse,
  ParcelDetailResponse,
  ParcelSuitabilityResponse,
  PlotsResponse,
  RegionMapResponse,
  SaleQuoteResponse,
  WorldResponse,
} from '../../packages/contracts/src/index';

// ---------------------------------------------------------------------------------------------
// Options

const { values: argv } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    'base-url': { type: 'string', default: process.env.LOAD_BASE_URL ?? 'http://localhost:8080' },
    players: { type: 'string', default: process.env.LOAD_PLAYERS ?? '16' },
    duration: { type: 'string', default: process.env.LOAD_DURATION_S ?? '120' },
    ramp: { type: 'string', default: process.env.LOAD_RAMP_S ?? '15' },
    p95: { type: 'string', default: process.env.LOAD_P95_MS ?? '300' },
    'min-samples': { type: 'string', default: '20' },
    'think-min': { type: 'string', default: '800' },
    'think-max': { type: 'string', default: '3500' },
    auth: { type: 'string', default: 'auto' }, // auto | dev | password
    'no-ws': { type: 'boolean', default: false },
    out: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (argv.help) {
  console.log(`usage: pnpm load [--base-url URL] [--players N] [--duration S] [--ramp S] [--p95 MS]
                 [--min-samples N] [--think-min MS] [--think-max MS] [--auth auto|dev|password]
                 [--no-ws] [--out results.json] [--verbose]`);
  process.exit(0);
}

const int = (name: string, v: string | undefined): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

const opts = {
  baseUrl: (argv['base-url'] ?? 'http://localhost:8080').replace(/\/$/, ''),
  players: int('players', argv.players),
  durationMs: int('duration', argv.duration) * 1000,
  rampMs: int('ramp', argv.ramp) * 1000,
  p95Ms: int('p95', argv.p95),
  minSamples: int('min-samples', argv['min-samples']),
  thinkMinMs: int('think-min', argv['think-min']),
  thinkMaxMs: int('think-max', argv['think-max']),
  auth: argv.auth as 'auto' | 'dev' | 'password',
  ws: !argv['no-ws'],
  out: argv.out,
  verbose: argv.verbose ?? false,
};
if (!['auto', 'dev', 'password'].includes(opts.auth)) throw new Error('--auth: auto|dev|password');

const runId = Date.now().toString(36).slice(-6);
const startedAt = performance.now();
const deadline = startedAt + opts.rampMs + opts.durationMs;
const running = () => performance.now() < deadline;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)];
const think = () => sleep(opts.thinkMinMs + Math.random() * (opts.thinkMaxMs - opts.thinkMinMs));
const debug = (...args: unknown[]) => {
  if (opts.verbose) console.log(...args);
};

// ---------------------------------------------------------------------------------------------
// Metrics

interface EndpointStats {
  latencies: number[];
  statuses: Map<number, number>;
}

const endpoints = new Map<string, EndpointStats>();
const errorCodes = new Map<string, number>();
const playerStats = { loggedIn: 0, active: 0, loginMs: [] as number[] };
const wsStats = {
  attempted: 0,
  opened: 0,
  ready: 0,
  closedUnexpectedly: 0,
  errors: 0,
  readyLatencies: [] as number[],
  messages: new Map<string, number>(),
  events: new Map<string, number>(),
};
const idempotency = { replays: 0, mismatches: 0 };
let totalRequests = 0;
let serverErrors = 0;
let networkErrors = 0;

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

function record(key: string, ms: number, status: number, code?: string) {
  let s = endpoints.get(key);
  if (!s) {
    s = { latencies: [], statuses: new Map() };
    endpoints.set(key, s);
  }
  s.latencies.push(ms);
  s.statuses.set(status, (s.statuses.get(status) ?? 0) + 1);
  totalRequests++;
  if (status === 0) networkErrors++;
  if (status >= 500) serverErrors++;
  if (status === 0 || status >= 400) bump(errorCodes, `${status} ${code ?? 'UNKNOWN'}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

// ---------------------------------------------------------------------------------------------
// HTTP

interface ApiResult<T> {
  status: number;
  body: T | undefined;
  code?: string;
  details?: unknown;
  text: string;
  retryAfterMs?: number;
}

class Client {
  token: string | null = null;
  private seq = 0;
  lastCommand: {
    key: string;
    template: string;
    params: Record<string, string>;
    body: unknown;
    status: number;
  } | null = null;

  constructor(readonly player: number) {}

  newKey(): string {
    this.seq++;
    return `load-${runId}-${this.player}-${this.seq}-${randomUUID().slice(0, 8)}`;
  }

  async call<T>(
    method: 'GET' | 'POST',
    template: string,
    params: Record<string, string> = {},
    opts2: { body?: unknown; query?: Record<string, string | number>; key?: string } = {},
  ): Promise<ApiResult<T>> {
    let urlPath = template;
    for (const [k, v] of Object.entries(params))
      urlPath = urlPath.replace(`:${k}`, encodeURIComponent(v));
    const qs = opts2.query
      ? '?' + new URLSearchParams(Object.entries(opts2.query).map(([k, v]) => [k, String(v)]))
      : '';
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts2.body !== undefined) headers['content-type'] = 'application/json';
    if (opts2.key) headers['idempotency-key'] = opts2.key;

    const key = `${method} ${template}`;
    const t0 = performance.now();
    let res: Response;
    let text: string;
    try {
      res = await fetch(opts.baseUrl + urlPath + qs, {
        method,
        headers,
        body: opts2.body === undefined ? undefined : JSON.stringify(opts2.body),
        signal: AbortSignal.timeout(15_000),
      });
      text = await res.text();
    } catch (err) {
      const ms = performance.now() - t0;
      record(key, ms, 0, (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
      debug(`[p${this.player}] ${key} network error`, err);
      return { status: 0, body: undefined, code: 'NETWORK', text: '' };
    }
    const ms = performance.now() - t0;
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const err = (parsed as { error?: { code?: string; details?: unknown } } | undefined)?.error;
    record(key, ms, res.status, err?.code);
    if (res.status >= 400) debug(`[p${this.player}] ${key} -> ${res.status} ${err?.code ?? ''}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    return {
      status: res.status,
      body: res.ok ? (parsed as T) : undefined,
      code: err?.code,
      details: err?.details,
      text,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    };
  }

  /** POST command with a fresh Idempotency-Key (remembered for replay checks). */
  async command<T>(template: string, params: Record<string, string>, body: unknown) {
    const key = this.newKey();
    const res = await this.call<T>('POST', template, params, { body, key });
    this.lastCommand = { key, template, params, body, status: res.status };
    return res;
  }

  /** Replay the previous command with the same key and body; the status must be identical. */
  async replayLast() {
    const last = this.lastCommand;
    if (!last || last.status === 0 || last.status === 429 || last.status >= 500) return;
    const res = await this.call('POST', last.template, last.params, {
      body: last.body,
      key: last.key,
    });
    if (res.status === 429 || res.status === 0) return;
    idempotency.replays++;
    if (res.status !== last.status) {
      idempotency.mismatches++;
      console.error(
        `[p${this.player}] idempotency mismatch on ${last.template}: first ${last.status}, replay ${res.status}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Virtual player

interface PlayerState {
  client: Client;
  companyId: string | null;
  regionId: string;
  map: RegionMapResponse | null;
  crops: CropsResponse | null;
  markets: MarketsResponse | null;
  ws: WebSocket | null;
}

async function withRateLimitRetry<T>(fn: () => Promise<ApiResult<T>>, tries = 8) {
  let res = await fn();
  for (let i = 1; i < tries && res.status === 429 && running(); i++) {
    await sleep(res.retryAfterMs ?? 2000 * i);
    res = await fn();
  }
  return res;
}

async function login(p: PlayerState, devAuth: boolean): Promise<boolean> {
  const username = `load_${runId}_${p.client.player}`;
  let auth: ApiResult<AuthResponse>;
  if (devAuth) {
    auth = await withRateLimitRetry(() =>
      p.client.call<AuthResponse>('POST', '/api/v1/auth/dev-login', {}, { body: { username } }),
    );
  } else {
    const password = `load-test-${runId}-pw-${p.client.player}`;
    await withRateLimitRetry(() =>
      p.client.call(
        'POST',
        '/api/v1/auth/register',
        {},
        {
          body: { username, password, displayName: `Load ${p.client.player}` },
        },
      ),
    );
    auth = await withRateLimitRetry(() =>
      p.client.call<AuthResponse>(
        'POST',
        '/api/v1/auth/login',
        {},
        { body: { username, password } },
      ),
    );
  }
  if (!auth.body?.token) {
    console.error(`[p${p.client.player}] login failed: ${auth.status} ${auth.code ?? auth.text}`);
    return false;
  }
  p.client.token = auth.body.token;
  return true;
}

async function ensureCompany(p: PlayerState): Promise<boolean> {
  const me = await p.client.call<MeResponse>('GET', '/api/v1/me');
  if (!me.body) return false;
  p.regionId = me.body.regionId;
  if (me.body.company) {
    p.companyId = me.body.company.id;
    return true;
  }
  const created = await p.client.command<{ result?: { id?: string; companyId?: string } }>(
    '/api/v1/companies',
    {},
    { name: `Load ${runId} ${p.client.player}` },
  );
  const again = await p.client.call<MeResponse>('GET', '/api/v1/me');
  p.companyId = again.body?.company?.id ?? null;
  if (!p.companyId)
    console.error(`[p${p.client.player}] company creation failed: ${created.status}`);
  return p.companyId !== null;
}

function openSocket(p: PlayerState) {
  if (!opts.ws || !running()) return;
  const url = opts.baseUrl.replace(/^http/, 'ws') + '/api/v1/ws';
  const t0 = performance.now();
  let ready = false;
  wsStats.attempted++;
  const ws = new WebSocket(url);
  p.ws = ws;
  ws.addEventListener('open', () => {
    wsStats.opened++;
    ws.send(JSON.stringify({ type: 'auth', token: p.client.token }));
  });
  ws.addEventListener('message', (ev) => {
    let msg: { type?: string; event?: { type?: string } };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      bump(wsStats.messages, 'unparseable');
      return;
    }
    bump(wsStats.messages, msg.type ?? 'unknown');
    if (msg.type === 'ready' && !ready) {
      ready = true;
      wsStats.ready++;
      wsStats.readyLatencies.push(performance.now() - t0);
    }
    if (msg.type === 'event' && msg.event?.type) bump(wsStats.events, msg.event.type);
  });
  ws.addEventListener('error', () => {
    wsStats.errors++;
  });
  ws.addEventListener('close', () => {
    if (p.ws !== ws) return;
    p.ws = null;
    if (running()) {
      wsStats.closedUnexpectedly++;
      setTimeout(() => openSocket(p), 1000 + Math.random() * 2000);
    }
  });
}

// --- actions --------------------------------------------------------------------------------

const companyPath = (suffix: string) => `/api/v1/companies/:companyId/${suffix}`;

const actions: { name: string; weight: number; run: (p: PlayerState) => Promise<void> }[] = [
  {
    name: 'world',
    weight: 20,
    run: async (p) => void (await p.client.call<WorldResponse>('GET', '/api/v1/world')),
  },
  {
    name: 'overview',
    weight: 14,
    run: async (p) =>
      void (await p.client.call<CompanyOverviewResponse>('GET', companyPath('overview'), {
        companyId: p.companyId!,
      })),
  },
  {
    name: 'markets',
    weight: 10,
    run: async (p) => {
      const r = await p.client.call<MarketsResponse>('GET', '/api/v1/markets');
      if (r.body) p.markets = r.body;
    },
  },
  {
    name: 'map',
    weight: 3,
    run: async (p) => {
      const r = await p.client.call<RegionMapResponse>('GET', '/api/v1/regions/:regionId/map', {
        regionId: p.regionId,
      });
      if (r.body) p.map = r.body;
    },
  },
  {
    name: 'listings',
    weight: 6,
    run: async (p) =>
      void (await p.client.call<ListingsResponse>('GET', '/api/v1/market-listings')),
  },
  {
    name: 'notifications',
    weight: 5,
    run: async (p) =>
      void (await p.client.call('GET', companyPath('notifications'), { companyId: p.companyId! })),
  },
  {
    name: 'leaderboard',
    weight: 2,
    run: async (p) => void (await p.client.call('GET', '/api/v1/leaderboard')),
  },
  {
    name: 'parcel',
    weight: 8,
    run: async (p) => {
      const parcel = pick(p.map?.parcels ?? []);
      if (!parcel) return;
      await p.client.call<ParcelDetailResponse>('GET', '/api/v1/parcels/:parcelId', {
        parcelId: parcel.id,
      });
      if (Math.random() < 0.4) {
        await p.client.call('GET', '/api/v1/parcels/:parcelId/suitability', {
          parcelId: parcel.id,
        });
      }
    },
  },
  {
    name: 'buyParcel',
    weight: 4,
    run: async (p) => {
      const candidates = (p.map?.parcels ?? []).filter(
        (x) => x.status === 'for_sale' && x.ownerCompanyId !== p.companyId,
      );
      const target = pick(candidates);
      if (!target) return;
      const detail = await p.client.call<ParcelDetailResponse>('GET', '/api/v1/parcels/:parcelId', {
        parcelId: target.id,
      });
      const parcel = detail.body?.parcel;
      if (!parcel || !detail.body?.actions.canPurchase) return;
      await p.client.command(
        '/api/v1/parcels/:parcelId/purchase',
        { parcelId: parcel.id },
        {
          expectedVersion: parcel.version,
          expectedPricePaise: parcel.listPricePaise ?? parcel.basePricePaise,
        },
      );
    },
  },
  {
    name: 'plant',
    weight: 4,
    run: async (p) => {
      const mine = (p.map?.parcels ?? []).filter(
        (x) => x.operatorCompanyId === p.companyId && x.crop === null,
      );
      const parcel = pick(mine);
      if (!parcel || !p.crops) return;
      const suit = await p.client.call<ParcelSuitabilityResponse>(
        'GET',
        '/api/v1/parcels/:parcelId/suitability',
        { parcelId: parcel.id },
      );
      const options = (suit.body?.results ?? []).filter(
        (r) => r.sowingOpen && r.grade !== 'unsuitable',
      );
      const choice = pick(options);
      const crop = choice && p.crops.crops.find((c) => c.id === choice.cropId);
      if (!choice || !crop) return;
      const fertilize = Math.random() < 0.5;
      const irrigate = choice.irrigationAssumed;
      const perHa =
        crop.costs.seedPaisePerHa +
        crop.costs.sowingLaborPaisePerHa +
        (fertilize ? crop.costs.fertilizerPaisePerHa : 0);
      const body = {
        parcelId: parcel.id,
        cropId: crop.id,
        irrigate,
        fertilize,
        expectedCostPaise: Math.round(perHa * parcel.areaHa),
      };
      const res = await p.client.command('/api/v1/crop-plots', {}, body);
      // Our estimate ignores machinery multipliers/rounding; retry once with the server's figure.
      const actual = findNumber(res.details, [
        'actualPaise',
        'actual',
        'currentPaise',
        'costPaise',
      ]);
      if (res.code === 'PRICE_CHANGED' && actual !== undefined) {
        await p.client.command('/api/v1/crop-plots', {}, { ...body, expectedCostPaise: actual });
      }
    },
  },
  {
    name: 'harvest',
    weight: 3,
    run: async (p) => {
      const plots = await p.client.call<PlotsResponse>('GET', companyPath('plots'), {
        companyId: p.companyId!,
      });
      const ready = (plots.body?.plots ?? []).filter((x) => x.status === 'ready');
      const plot = pick(ready);
      if (plot)
        await p.client.command('/api/v1/crop-plots/:plotId/harvest', { plotId: plot.id }, {});
    },
  },
  {
    name: 'sell',
    weight: 3,
    run: async (p) => {
      const inv = await p.client.call<InventoryResponse>('GET', companyPath('inventory'), {
        companyId: p.companyId!,
      });
      const item = pick((inv.body?.totals ?? []).filter((t) => t.availableKg > 0));
      const market = pick(p.markets?.markets ?? []);
      if (!item || !market) return;
      const quantityKg = Math.min(item.availableKg, 200 + Math.floor(Math.random() * 800));
      const quote = await p.client.call<SaleQuoteResponse>(
        'GET',
        '/api/v1/markets/:marketId/quote',
        { marketId: market.id },
        { query: { itemId: item.itemId, quantityKg } },
      );
      if (!quote.body || quote.body.netPaise <= 0) return;
      await p.client.command(
        '/api/v1/markets/:marketId/sell',
        { marketId: market.id },
        {
          itemId: item.itemId,
          quantityKg,
          minNetUnitPricePaise: Math.floor((quote.body.netPaise / quantityKg) * 0.95),
        },
      );
    },
  },
  {
    name: 'createListing',
    weight: 2,
    run: async (p) => {
      const inv = await p.client.call<InventoryResponse>('GET', companyPath('inventory'), {
        companyId: p.companyId!,
      });
      const item = pick((inv.body?.totals ?? []).filter((t) => t.availableKg > 0));
      if (!item) return;
      const price = p.markets?.markets
        .flatMap((m) => m.prices)
        .find((x) => x.itemId === item.itemId)?.pricePaisePerKg;
      if (!price) return;
      await p.client.command(
        '/api/v1/market-listings',
        {},
        {
          itemId: item.itemId,
          quantityKg: Math.min(item.availableKg, 100 + Math.floor(Math.random() * 300)),
          unitPricePaise: Math.max(1, Math.round(price * (0.9 + Math.random() * 0.3))),
          durationDays: 7,
        },
      );
    },
  },
  {
    name: 'buyListing',
    weight: 3,
    run: async (p) => {
      const res = await p.client.call<ListingsResponse>('GET', '/api/v1/market-listings');
      const listing = pick(
        (res.body?.listings ?? []).filter(
          (l) => l.sellerCompanyId !== p.companyId && l.remainingKg > 0,
        ),
      );
      if (!listing) return;
      await p.client.command(
        '/api/v1/market-listings/:listingId/purchase',
        { listingId: listing.id },
        {
          quantityKg: Math.min(listing.remainingKg, 10 + Math.floor(Math.random() * 90)),
          expectedUnitPricePaise: listing.unitPricePaise,
        },
      );
    },
  },
  { name: 'replay', weight: 2, run: async (p) => p.client.replayLast() },
];
const totalWeight = actions.reduce((s, a) => s + a.weight, 0);

function chooseAction() {
  let r = Math.random() * totalWeight;
  for (const a of actions) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return actions[0]!;
}

function findNumber(details: unknown, keys: string[]): number | undefined {
  if (!details || typeof details !== 'object') return undefined;
  for (const k of keys) {
    const v = (details as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  }
  return undefined;
}

async function runPlayer(i: number, devAuth: boolean): Promise<void> {
  await sleep((opts.rampMs * i) / Math.max(1, opts.players));
  const p: PlayerState = {
    client: new Client(i),
    companyId: null,
    regionId: 'hemavati',
    map: null,
    crops: null,
    markets: null,
    ws: null,
  };
  const loginStart = performance.now();
  if (!(await login(p, devAuth))) return;
  playerStats.loggedIn++;
  playerStats.loginMs.push(performance.now() - loginStart);
  if (!(await ensureCompany(p))) return;
  if (!running()) {
    console.error(`[p${i}] logged in only after the test window ended (auth rate limit?)`);
    return;
  }
  playerStats.active++;

  // Initial load, like the client's first screen.
  await p.client.call<WorldResponse>('GET', '/api/v1/world');
  const [map, crops, markets] = await Promise.all([
    p.client.call<RegionMapResponse>('GET', '/api/v1/regions/:regionId/map', {
      regionId: p.regionId,
    }),
    p.client.call<CropsResponse>('GET', '/api/v1/crops'),
    p.client.call<MarketsResponse>('GET', '/api/v1/markets'),
  ]);
  p.map = map.body ?? null;
  p.crops = crops.body ?? null;
  p.markets = markets.body ?? null;
  openSocket(p);

  while (running()) {
    const action = chooseAction();
    try {
      await action.run(p);
    } catch (err) {
      console.error(`[p${i}] action ${action.name} threw`, err);
    }
    await think();
  }
  p.ws?.close();
  p.ws = null;
}

// ---------------------------------------------------------------------------------------------
// Main

async function main() {
  console.log(
    `Load test ${runId}: ${opts.players} players, ${opts.durationMs / 1000}s (+${opts.rampMs / 1000}s ramp) against ${opts.baseUrl}`,
  );
  const health = await fetch(`${opts.baseUrl}/healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(`server not healthy at ${opts.baseUrl}/healthz`);
    process.exit(2);
  }
  let devAuth = opts.auth === 'dev';
  if (opts.auth === 'auto') {
    const cfg = await fetch(`${opts.baseUrl}/api/v1/auth/config`)
      .then((r) => r.json() as Promise<AuthConfigResponse>)
      .catch(() => null);
    devAuth = cfg?.devAuth === true;
  }
  console.log(`auth: ${devAuth ? 'dev-login' : 'register + password login'}`);

  await Promise.all(Array.from({ length: opts.players }, (_, i) => runPlayer(i, devAuth)));
  const elapsedS = (performance.now() - startedAt) / 1000;

  // ---- report ----
  const rows = [...endpoints.entries()]
    .map(([key, s]) => {
      const sorted = [...s.latencies].sort((a, b) => a - b);
      const errors = [...s.statuses.entries()]
        .filter(([st]) => st === 0 || st >= 400)
        .reduce((n, [, c]) => n + c, 0);
      return {
        endpoint: key,
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
        errorPct: (100 * errors) / sorted.length,
        statuses: Object.fromEntries(s.statuses),
      };
    })
    .sort((a, b) => b.count - a.count);
  const all = [...endpoints.values()].flatMap((s) => s.latencies).sort((a, b) => a - b);
  const overall = {
    requests: totalRequests,
    throughputRps: totalRequests / elapsedS,
    p50: percentile(all, 50),
    p95: percentile(all, 95),
    p99: percentile(all, 99),
  };

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(
    '\nEndpoint'.padEnd(52) +
      pad('n', 7) +
      pad('p50', 8) +
      pad('p95', 8) +
      pad('p99', 8) +
      pad('max', 8) +
      pad('err%', 7),
  );
  for (const r of rows) {
    console.log(
      r.endpoint.padEnd(51) +
        pad(r.count, 7) +
        pad(r.p50.toFixed(0), 8) +
        pad(r.p95.toFixed(0), 8) +
        pad(r.p99.toFixed(0), 8) +
        pad(r.max.toFixed(0), 8) +
        pad(r.errorPct.toFixed(1), 7),
    );
  }
  console.log(
    `\nOverall: ${overall.requests} requests in ${elapsedS.toFixed(1)}s = ${overall.throughputRps.toFixed(1)} req/s; ` +
      `p50 ${overall.p50.toFixed(0)} ms, p95 ${overall.p95.toFixed(0)} ms, p99 ${overall.p99.toFixed(0)} ms`,
  );
  const loginSorted = [...playerStats.loginMs].sort((a, b) => a - b);
  console.log(
    `Players: ${playerStats.active}/${opts.players} active, ${playerStats.loggedIn} logged in; ` +
      `login time p50 ${percentile(loginSorted, 50).toFixed(0)} ms, max ${(loginSorted.at(-1) ?? 0).toFixed(0)} ms ` +
      '(auth is rate-limited per IP: widen --ramp for many players)',
  );
  console.log('Errors by status/code:', Object.fromEntries(errorCodes));
  console.log(
    `WebSocket: attempted ${wsStats.attempted}, opened ${wsStats.opened}, ready ${wsStats.ready}, unexpected closes ${wsStats.closedUnexpectedly}, errors ${wsStats.errors}, ` +
      `ready p95 ${percentile(
        [...wsStats.readyLatencies].sort((a, b) => a - b),
        95,
      ).toFixed(0)} ms`,
  );
  console.log('WebSocket messages:', Object.fromEntries(wsStats.messages));
  console.log('WebSocket events:', Object.fromEntries(wsStats.events));
  console.log(`Idempotent replays: ${idempotency.replays}, mismatches ${idempotency.mismatches}`);

  // ---- verdict ----
  const failures: string[] = [];
  if (serverErrors > 0) failures.push(`${serverErrors} HTTP 5xx response(s)`);
  if (networkErrors > 0) failures.push(`${networkErrors} network error(s)/timeout(s)`);
  if (idempotency.mismatches > 0)
    failures.push(`${idempotency.mismatches} idempotency mismatch(es)`);
  if (overall.p95 > opts.p95Ms)
    failures.push(`overall p95 ${overall.p95.toFixed(0)} ms > ${opts.p95Ms} ms`);
  for (const r of rows) {
    if (r.count >= opts.minSamples && r.p95 > opts.p95Ms) {
      failures.push(`${r.endpoint} p95 ${r.p95.toFixed(0)} ms > ${opts.p95Ms} ms`);
    }
  }
  if (totalRequests === 0) failures.push('no requests were made');
  if (playerStats.active < opts.players) {
    failures.push(`only ${playerStats.active}/${opts.players} players became active`);
  }

  if (opts.out) {
    mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    writeFileSync(
      opts.out,
      JSON.stringify(
        {
          runId,
          options: opts,
          elapsedS,
          overall,
          endpoints: rows,
          errors: Object.fromEntries(errorCodes),
          websocket: {
            ...wsStats,
            readyLatencies: undefined,
            messages: Object.fromEntries(wsStats.messages),
            events: Object.fromEntries(wsStats.events),
          },
          players: { ...playerStats, loginMs: undefined },
          idempotency,
          failures,
        },
        null,
        2,
      ),
    );
    console.log(`\nResults written to ${opts.out}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nPASS');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
