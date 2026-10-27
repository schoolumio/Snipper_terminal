import { z } from 'zod';
import type { ExitPolicy, StrategyId } from './types';

/** Non-negative decimal string, e.g. "2.5". */
const dec = (opts: { min?: number; max?: number } = {}) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string')
    .refine((v) => (opts.min === undefined ? true : Number(v) >= opts.min), `must be >= ${opts.min}`)
    .refine((v) => (opts.max === undefined ? true : Number(v) <= opts.max), `must be <= ${opts.max}`);

const pctField = (max = 100) => dec({ min: 0, max });

export const STRATEGY_IDS = ['new_pool_entry', 'volume_spike', 'price_breakout', 'pullback_entry', 'liquidity_momentum'] as const satisfies readonly StrategyId[];

export const ExitPolicySchema = z.object({
  version: z.number().int().min(1),
  stopLossPct: dec({ min: 0.5, max: 90 }),
  takeProfit: z
    .array(z.object({ gainPct: dec({ min: 0.1, max: 10000 }), sellFraction: dec({ min: 0.01, max: 1 }) }))
    .max(6),
  trailing: z.object({ enabled: z.boolean(), activateAtGainPct: pctField(10000), trailPct: dec({ min: 0.5, max: 90 }) }),
  breakEven: z.object({ enabled: z.boolean(), triggerGainPct: pctField(10000) }),
  maxHoldSec: z.number().int().min(10).max(7 * 24 * 3600),
  momentumReversal: z.object({ enabled: z.boolean(), m5DropPct: pctField(100), sellBuyRatio: dec({ min: 0.1, max: 100 }) }),
  liquidityDropPct: pctField(100),
}) satisfies z.ZodType<ExitPolicy>;

export const StrategyParamsSchema = z.object({
  new_pool_entry: z.object({
    minAgeSec: z.number().int().min(0),
    maxAgeSec: z.number().int().min(1),
    minBuySellRatio: dec({ min: 0 }),
    minVolume5m: dec(),
    maxChasePct: pctField(10000),
  }),
  volume_spike: z.object({ spikeMultiple: dec({ min: 1 }), minPriceChange5mPct: dec(), maxPriceChange5mPct: pctField(10000) }),
  price_breakout: z.object({ lookbackSnapshots: z.number().int().min(3).max(500), breakoutPct: pctField(1000), minVolumeRatio: dec() }),
  pullback_entry: z.object({ minRetracePct: pctField(), maxRetracePct: pctField(), minBuySellRatio: dec() }),
  liquidity_momentum: z.object({ minLiquidityGrowthPct: pctField(10000), minPriceChange5mPct: dec() }),
});
export type StrategyParams = z.infer<typeof StrategyParamsSchema>;

export const TradingConfigSchema = z.object({
  chain: z.enum(['solana', 'simnet']),
  walletId: z.string().max(128).nullable(),
  enabledStrategies: z.array(z.enum(STRATEGY_IDS)).min(0),
  strategyParams: StrategyParamsSchema,
  maxConcurrentPositions: z.number().int().min(0).max(50),
  maxTradeAllocationPct: dec({ min: 0, max: 100 }),
  minLiquidity: dec(),
  maxLiquidity: dec(),
  minPoolAgeSec: z.number().int().min(0),
  maxPoolAgeSec: z.number().int().min(1),
  maxPriceImpactPct: dec({ min: 0.01, max: 50 }),
  maxSlippagePct: dec({ min: 0.01, max: 50 }),
  maxNetworkFeeQuote: dec(),
  priorityFeeQuote: dec(),
  minScannerScore: z.number().min(0).max(100),
  minSignalScore: z.number().min(0).max(100),
  minSignalConfidence: z.number().min(0).max(1),
  entryCooldownSec: z.number().int().min(0),
  proposalTtlSec: z.number().int().min(1).max(600),
  candidateTtlSec: z.number().int().min(10),
  reevaluateEverySec: z.number().int().min(1),
  exitPolicy: ExitPolicySchema,
});
export type TradingConfig = z.infer<typeof TradingConfigSchema>;

export const RiskThresholdsSchema = z.object({
  maxTop10HolderPct: pctField(),
  maxCreatorHoldingPct: pctField(),
  maxTransferTaxPct: pctField(),
  requireMintRenounced: z.boolean(),
  requireFreezeRenounced: z.boolean(),
  requireVerifiedLpLock: z.boolean(),
  requireSellSimulation: z.boolean(),
  minLiquidityToMcapPct: pctField(),
  maxDataAgeSec: z.number().int().min(1).max(3600),
  maxVolumeToLiquidity1h: dec(),
  minHolders: z.number().int().min(0),
});

export const RiskConfigSchema = z.object({
  maxDailyLossPct: pctField(),
  maxDrawdownPct: pctField(),
  maxTokenExposurePct: pctField(),
  maxTotalExposurePct: pctField(),
  maxNewLaunchExposurePct: pctField(),
  maxPositionSizeQuote: dec(),
  minTradeSizeQuote: dec(),
  minFeeReserveQuote: dec(),
  riskPerTradePct: pctField(),
  maxLiquidityParticipationPct: pctField(),
  consecutiveLossLimit: z.number().int().min(1).max(100),
  consecutiveLossCooldownSec: z.number().int().min(0),
  maxExecutionErrors: z.number().int().min(1).max(100),
  executionErrorWindowSec: z.number().int().min(10),
  killSwitchPolicy: z.enum(['block_all', 'exits_only', 'close_all']),
  reviewPolicy: z.enum(['reject', 'strict', 'manual']),
  reviewSizeMultiplier: dec({ min: 0, max: 1 }),
  reviewMinSignalScore: z.number().min(0).max(100),
  maxRiskScore: z.number().min(0).max(100),
  reviewRiskScore: z.number().min(0).max(100),
  minRiskConfidence: z.number().min(0).max(1),
  requireManualApprovalLive: z.boolean(),
  thresholds: RiskThresholdsSchema,
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

export const EngineConfigSchema = z.object({
  trading: TradingConfigSchema,
  risk: RiskConfigSchema,
});
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

/**
 * Hard limits come from the server environment and cannot be relaxed through
 * the settings UI or API. Config updates that exceed them are rejected and the
 * engine additionally clamps every computation against them.
 */
export interface HardLimits {
  maxPositionSizeQuote: string;
  maxTradeAllocationPct: string;
  maxTotalExposurePct: string;
  maxDailyLossPct: string;
  maxDrawdownPct: string;
  maxSlippagePct: string;
  maxPriceImpactPct: string;
  maxConcurrentPositions: number;
}

export const DEFAULT_HARD_LIMITS: HardLimits = {
  maxPositionSizeQuote: '250',
  maxTradeAllocationPct: '10',
  maxTotalExposurePct: '60',
  maxDailyLossPct: '20',
  maxDrawdownPct: '40',
  maxSlippagePct: '8',
  maxPriceImpactPct: '8',
  maxConcurrentPositions: 10,
};

export const DEFAULT_EXIT_POLICY: ExitPolicy = {
  version: 1,
  stopLossPct: '12',
  takeProfit: [
    { gainPct: '25', sellFraction: '0.5' },
    { gainPct: '60', sellFraction: '1' },
  ],
  trailing: { enabled: true, activateAtGainPct: '15', trailPct: '10' },
  breakEven: { enabled: true, triggerGainPct: '10' },
  maxHoldSec: 20 * 60,
  momentumReversal: { enabled: true, m5DropPct: '15', sellBuyRatio: '2' },
  liquidityDropPct: '35',
};

export const DEFAULT_CONFIG: EngineConfig = {
  trading: {
    chain: 'simnet',
    walletId: null,
    enabledStrategies: ['new_pool_entry', 'volume_spike', 'price_breakout', 'pullback_entry', 'liquidity_momentum'],
    strategyParams: {
      new_pool_entry: { minAgeSec: 60, maxAgeSec: 15 * 60, minBuySellRatio: '1.3', minVolume5m: '1500', maxChasePct: '60' },
      volume_spike: { spikeMultiple: '2.5', minPriceChange5mPct: '2', maxPriceChange5mPct: '80' },
      price_breakout: { lookbackSnapshots: 20, breakoutPct: '3', minVolumeRatio: '1.3' },
      pullback_entry: { minRetracePct: '12', maxRetracePct: '35', minBuySellRatio: '1.1' },
      liquidity_momentum: { minLiquidityGrowthPct: '15', minPriceChange5mPct: '3' },
    },
    maxConcurrentPositions: 4,
    maxTradeAllocationPct: '4',
    minLiquidity: '8000',
    maxLiquidity: '5000000',
    minPoolAgeSec: 45,
    maxPoolAgeSec: 6 * 3600,
    maxPriceImpactPct: '2.5',
    maxSlippagePct: '3',
    maxNetworkFeeQuote: '0.05',
    priorityFeeQuote: '0.002',
    minScannerScore: 35,
    minSignalScore: 55,
    minSignalConfidence: 0.5,
    entryCooldownSec: 20,
    proposalTtlSec: 20,
    candidateTtlSec: 30 * 60,
    reevaluateEverySec: 10,
    exitPolicy: DEFAULT_EXIT_POLICY,
  },
  risk: {
    maxDailyLossPct: '8',
    maxDrawdownPct: '20',
    maxTokenExposurePct: '6',
    maxTotalExposurePct: '30',
    maxNewLaunchExposurePct: '25',
    maxPositionSizeQuote: '100',
    minTradeSizeQuote: '5',
    minFeeReserveQuote: '5',
    riskPerTradePct: '0.75',
    maxLiquidityParticipationPct: '1.5',
    consecutiveLossLimit: 5,
    consecutiveLossCooldownSec: 15 * 60,
    maxExecutionErrors: 5,
    executionErrorWindowSec: 300,
    killSwitchPolicy: 'exits_only',
    reviewPolicy: 'strict',
    reviewSizeMultiplier: '0.5',
    reviewMinSignalScore: 70,
    maxRiskScore: 60,
    reviewRiskScore: 30,
    minRiskConfidence: 0.6,
    requireManualApprovalLive: true,
    thresholds: {
      maxTop10HolderPct: '45',
      maxCreatorHoldingPct: '10',
      maxTransferTaxPct: '0',
      requireMintRenounced: true,
      requireFreezeRenounced: true,
      requireVerifiedLpLock: false,
      requireSellSimulation: true,
      minLiquidityToMcapPct: '4',
      maxDataAgeSec: 30,
      maxVolumeToLiquidity1h: '40',
      minHolders: 40,
    },
  },
};

export interface ConfigViolation {
  path: string;
  message: string;
}

/** Returns hard-limit violations for a proposed configuration. */
export function checkHardLimits(cfg: EngineConfig, hard: HardLimits): ConfigViolation[] {
  const v: ConfigViolation[] = [];
  const gt = (a: string, b: string) => Number(a) > Number(b);
  if (gt(cfg.risk.maxPositionSizeQuote, hard.maxPositionSizeQuote))
    v.push({ path: 'risk.maxPositionSizeQuote', message: `exceeds hard limit ${hard.maxPositionSizeQuote}` });
  if (gt(cfg.trading.maxTradeAllocationPct, hard.maxTradeAllocationPct))
    v.push({ path: 'trading.maxTradeAllocationPct', message: `exceeds hard limit ${hard.maxTradeAllocationPct}%` });
  if (gt(cfg.risk.maxTotalExposurePct, hard.maxTotalExposurePct))
    v.push({ path: 'risk.maxTotalExposurePct', message: `exceeds hard limit ${hard.maxTotalExposurePct}%` });
  if (gt(cfg.risk.maxDailyLossPct, hard.maxDailyLossPct))
    v.push({ path: 'risk.maxDailyLossPct', message: `exceeds hard limit ${hard.maxDailyLossPct}%` });
  if (gt(cfg.risk.maxDrawdownPct, hard.maxDrawdownPct))
    v.push({ path: 'risk.maxDrawdownPct', message: `exceeds hard limit ${hard.maxDrawdownPct}%` });
  if (gt(cfg.trading.maxSlippagePct, hard.maxSlippagePct))
    v.push({ path: 'trading.maxSlippagePct', message: `exceeds hard limit ${hard.maxSlippagePct}%` });
  if (gt(cfg.trading.maxPriceImpactPct, hard.maxPriceImpactPct))
    v.push({ path: 'trading.maxPriceImpactPct', message: `exceeds hard limit ${hard.maxPriceImpactPct}%` });
  if (cfg.trading.maxConcurrentPositions > hard.maxConcurrentPositions)
    v.push({ path: 'trading.maxConcurrentPositions', message: `exceeds hard limit ${hard.maxConcurrentPositions}` });
  if (Number(cfg.trading.minLiquidity) > Number(cfg.trading.maxLiquidity))
    v.push({ path: 'trading.minLiquidity', message: 'must not exceed maxLiquidity' });
  if (cfg.trading.minPoolAgeSec > cfg.trading.maxPoolAgeSec)
    v.push({ path: 'trading.minPoolAgeSec', message: 'must not exceed maxPoolAgeSec' });
  if (cfg.risk.reviewRiskScore > cfg.risk.maxRiskScore)
    v.push({ path: 'risk.reviewRiskScore', message: 'must not exceed maxRiskScore' });
  const pb = cfg.trading.strategyParams.pullback_entry;
  if (Number(pb.minRetracePct) > Number(pb.maxRetracePct))
    v.push({ path: 'trading.strategyParams.pullback_entry.minRetracePct', message: 'must not exceed maxRetracePct' });
  return v;
}

export function parseConfig(input: unknown): EngineConfig {
  return EngineConfigSchema.parse(input);
}
