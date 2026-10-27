import { DEFAULT_HARD_LIMITS, type HardLimits } from '@sniper/core';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');
const decStr = z.string().regex(/^\d+(\.\d+)?$/);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  APP_NAME: z.string().default('Sniper Terminal'),
  APP_VERSION: z.string().default('0.1.0'),
  /** Comma-separated origins allowed to open WebSockets / call the API cross-origin. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  VIEWER_USERNAME: z.string().optional(),
  VIEWER_PASSWORD: z.string().optional(),
  COOKIE_SECURE: bool,

  MARKET_PROVIDER: z.enum(['simulated']).default('simulated'),
  SIM_SEED: z.coerce.number().int().default(1337),
  SIM_LAUNCH_EVERY_SEC: z.coerce.number().positive().default(25),
  PAPER_STARTING_EQUITY: decStr.default('1000'),
  PAPER_TX_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.03),
  TICK_MS: z.coerce.number().int().min(100).default(1000),

  SOLANA_RPC_URL: z.string().url().optional(),

  LIVE_TRADING_ENABLED: bool,

  HARD_MAX_POSITION_QUOTE: decStr.default(DEFAULT_HARD_LIMITS.maxPositionSizeQuote),
  HARD_MAX_TRADE_ALLOCATION_PCT: decStr.default(DEFAULT_HARD_LIMITS.maxTradeAllocationPct),
  HARD_MAX_TOTAL_EXPOSURE_PCT: decStr.default(DEFAULT_HARD_LIMITS.maxTotalExposurePct),
  HARD_MAX_DAILY_LOSS_PCT: decStr.default(DEFAULT_HARD_LIMITS.maxDailyLossPct),
  HARD_MAX_DRAWDOWN_PCT: decStr.default(DEFAULT_HARD_LIMITS.maxDrawdownPct),
  HARD_MAX_SLIPPAGE_PCT: decStr.default(DEFAULT_HARD_LIMITS.maxSlippagePct),
  HARD_MAX_PRICE_IMPACT_PCT: decStr.default(DEFAULT_HARD_LIMITS.maxPriceImpactPct),
  HARD_MAX_CONCURRENT_POSITIONS: z.coerce.number().int().min(0).default(DEFAULT_HARD_LIMITS.maxConcurrentPositions),

  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof EnvSchema> & { hardLimits: HardLimits; corsOrigins: string[] };

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  // Empty values in .env files mean "unset".
  const cleaned = Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    if (!e.SESSION_SECRET) throw new Error('SESSION_SECRET is required in production');
    if (!e.ADMIN_PASSWORD || e.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD (≥12 chars) is required in production');
  }
  return {
    ...e,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    hardLimits: {
      maxPositionSizeQuote: e.HARD_MAX_POSITION_QUOTE,
      maxTradeAllocationPct: e.HARD_MAX_TRADE_ALLOCATION_PCT,
      maxTotalExposurePct: e.HARD_MAX_TOTAL_EXPOSURE_PCT,
      maxDailyLossPct: e.HARD_MAX_DAILY_LOSS_PCT,
      maxDrawdownPct: e.HARD_MAX_DRAWDOWN_PCT,
      maxSlippagePct: e.HARD_MAX_SLIPPAGE_PCT,
      maxPriceImpactPct: e.HARD_MAX_PRICE_IMPACT_PCT,
      maxConcurrentPositions: e.HARD_MAX_CONCURRENT_POSITIONS,
    },
  };
}
