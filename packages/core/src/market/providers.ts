import type { ChainId, MarketSnapshot, PoolInfo, Quote, QuoteRequest, SecurityReport } from '../types';

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly transient = true,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

/** Token / pool discovery plus market data for a single chain. */
export interface MarketDataProvider {
  readonly name: string;
  readonly chain: ChainId;
  /** True for synthetic data sources. The UI labels everything from these as simulated. */
  readonly simulated: boolean;
  /** Advance internal state (simulators) or flush buffered stream events. */
  poll?(now: number): Promise<void>;
  /** Pools first seen after `since` (exclusive). */
  discoverPools(since: number, now: number): Promise<PoolInfo[]>;
  getSnapshot(pool: PoolInfo, now: number): Promise<MarketSnapshot>;
}

export interface QuoteProvider {
  readonly name: string;
  getQuote(req: QuoteRequest, now: number): Promise<Quote>;
}

export interface SecurityProvider {
  readonly name: string;
  assess(chain: ChainId, tokenAddress: string, pool: PoolInfo, now: number): Promise<SecurityReport>;
}

/** Combine several partial security reports. Unknown fields stay null; conflicts are flagged. */
export function mergeSecurityReports(reports: SecurityReport[], now: number): SecurityReport {
  if (reports.length === 0) throw new Error('no security reports to merge');
  const first = reports[0]!;
  const out: SecurityReport = { ...first, source: reports.map((r) => r.source).join('+'), fetchedAt: now, providerFlags: [] };
  const boolKeys = ['mintAuthorityRenounced', 'freezeAuthorityRenounced', 'sellSimulationOk', 'knownMalicious'] as const;
  for (const k of boolKeys) {
    const vals = reports.map((r) => r[k]).filter((v): v is boolean => v !== null);
    if (vals.length === 0) out[k] = null;
    else if (vals.every((v) => v === vals[0])) out[k] = vals[0]!;
    else {
      // Contradictory evidence: take the unsafe interpretation.
      out[k] = k === 'knownMalicious' ? true : false;
      out.providerFlags.push(`conflict:${k}`);
    }
  }
  const maxDec = (k: 'top10HolderPct' | 'creatorHoldingPct' | 'transferTaxPct') => {
    const vals = reports.map((r) => r[k]).filter((v): v is string => v !== null);
    return vals.length ? vals.reduce((a, b) => (Number(b) > Number(a) ? b : a)) : null;
  };
  out.top10HolderPct = maxDec('top10HolderPct');
  out.creatorHoldingPct = maxDec('creatorHoldingPct');
  out.transferTaxPct = maxDec('transferTaxPct');
  const holders = reports.map((r) => r.holderCount).filter((v): v is number => v !== null);
  out.holderCount = holders.length ? Math.min(...holders) : null;
  const prior = reports.map((r) => r.creatorPriorFlaggedTokens).filter((v): v is number => v !== null);
  out.creatorPriorFlaggedTokens = prior.length ? Math.max(...prior) : null;
  out.lpLock = reports.find((r) => r.lpLock?.verified)?.lpLock ?? reports.find((r) => r.lpLock)?.lpLock ?? null;
  for (const r of reports) out.providerFlags.push(...r.providerFlags);
  return out;
}
