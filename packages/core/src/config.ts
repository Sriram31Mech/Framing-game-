import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_CLIENT_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  SESSION_SECRET: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .default(720),
  ENABLE_DEV_AUTH: bool,
  ENABLE_DEV_ADMIN: bool,
  ENABLE_PASSWORD_AUTH: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => v === undefined || v === '' || v === 'true' || v === '1'),
  STEAM_APP_ID: z.string().optional().default(''),
  STEAM_WEB_API_KEY: z.string().optional().default(''),
  REGION_ID: z.string().default('hemavati'),
  REAL_SECONDS_PER_GAME_DAY: z.coerce.number().int().min(1).max(86_400).default(120),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
  MAX_CATCHUP_DAYS_PER_BATCH: z.coerce.number().int().min(1).max(1000).default(30),
  AI_COMPANY_COUNT: z.coerce.number().int().min(0).max(10).default(3),
  SERVE_CLIENT_DIR: z.string().optional().default(''),
  TRUST_PROXY: bool,
});

export interface AppConfig {
  appEnv: 'development' | 'test' | 'staging' | 'production';
  isProduction: boolean;
  logLevel: string;
  port: number;
  host: string;
  publicClientUrl: string;
  databaseUrl: string;
  databasePoolMax: number;
  sessionSecret: string;
  sessionTtlHours: number;
  devAuthEnabled: boolean;
  devAdminEnabled: boolean;
  passwordAuthEnabled: boolean;
  steam: { appId: string; webApiKey: string; enabled: boolean };
  regionId: string;
  realSecondsPerGameDay: number;
  workerPollMs: number;
  maxCatchupDaysPerBatch: number;
  aiCompanyCount: number;
  serveClientDir: string;
  trustProxy: boolean;
}

const INSECURE_SECRETS = new Set([
  'dev-only-insecure-session-secret-change-me',
  'changeme',
  'secret',
]);

/**
 * Parse and validate environment configuration. Fails fast on unsafe production settings:
 * dev auth / dev admin can never be enabled in production, and the session secret must be strong.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.APP_ENV === 'production';
  const strict = e.APP_ENV === 'production' || e.APP_ENV === 'staging';

  if (isProduction && (e.ENABLE_DEV_AUTH || e.ENABLE_DEV_ADMIN)) {
    throw new Error(
      'ENABLE_DEV_AUTH / ENABLE_DEV_ADMIN must not be enabled when APP_ENV=production',
    );
  }
  if (strict && (e.SESSION_SECRET.length < 32 || INSECURE_SECRETS.has(e.SESSION_SECRET))) {
    throw new Error(
      'SESSION_SECRET must be at least 32 characters and not a placeholder outside development',
    );
  }

  return {
    appEnv: e.APP_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
    host: e.HOST,
    publicClientUrl: e.PUBLIC_CLIENT_URL,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    sessionSecret: e.SESSION_SECRET,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    devAuthEnabled: !isProduction && e.ENABLE_DEV_AUTH,
    devAdminEnabled: !isProduction && e.ENABLE_DEV_ADMIN,
    passwordAuthEnabled: e.ENABLE_PASSWORD_AUTH,
    steam: {
      appId: e.STEAM_APP_ID,
      webApiKey: e.STEAM_WEB_API_KEY,
      enabled: e.STEAM_APP_ID !== '' && e.STEAM_WEB_API_KEY !== '',
    },
    regionId: e.REGION_ID,
    realSecondsPerGameDay: e.REAL_SECONDS_PER_GAME_DAY,
    workerPollMs: e.WORKER_POLL_MS,
    maxCatchupDaysPerBatch: e.MAX_CATCHUP_DAYS_PER_BATCH,
    aiCompanyCount: e.AI_COMPANY_COUNT,
    serveClientDir: e.SERVE_CLIENT_DIR,
    trustProxy: e.TRUST_PROXY,
  };
}
