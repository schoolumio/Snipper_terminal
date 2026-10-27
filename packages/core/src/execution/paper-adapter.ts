import { d, s } from '../decimal';
import { ProviderError, type QuoteProvider } from '../market/providers';
import type { ChainId, QuoteRequest } from '../types';
import { newId } from '../util/ids';
import { Rng } from '../util/rng';
import type { ExecutionAdapter, SimulationResult, SubmitResult, SwapRequest, SwapStatus } from './adapter';

/** A venue that can actually apply simulated swaps (the simulated market). */
export interface SwapVenue {
  executeSwap(req: QuoteRequest & { minOut: string }, now: number): { amountOut: string };
  simulateSwap(req: QuoteRequest & { minOut: string }, now: number): { ok: boolean; expectedOut: string | null; error: string | null };
}

export interface PaperAdapterOptions {
  chain: ChainId;
  quotes: QuoteProvider;
  venue?: SwapVenue;
  seed?: number;
  latencyMs?: [number, number];
  failureRate?: number;
  networkFeeQuote?: string;
}

interface PaperTx {
  txId: string;
  req: SwapRequest;
  submittedAt: number;
  fillAt: number;
  status: SwapStatus;
}

/**
 * SIMULATED EXECUTION — no transaction is ever sent to a blockchain.
 *
 * Models latency between signal and fill (the price can move in between),
 * random transaction failures (network fee still charged, as on Solana),
 * minimum-output enforcement, liquidity-based price impact via fresh quotes,
 * and sell restrictions when backed by the simulated market venue.
 * AMM swaps are all-or-nothing, so partial fills are not modelled.
 */
export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly name = 'paper';
  readonly mode = 'paper' as const;
  readonly chain: ChainId;
  readonly walletLabel = 'paper-ledger (simulated)';
  private txs = new Map<string, PaperTx>();
  private byKey = new Map<string, string>();
  private rng: Rng;
  private readonly quotes: QuoteProvider;
  private readonly venue: SwapVenue | undefined;
  private readonly latency: [number, number];
  failureRate: number;
  private readonly networkFee: string;

  constructor(opts: PaperAdapterOptions) {
    this.chain = opts.chain;
    this.quotes = opts.quotes;
    this.venue = opts.venue;
    this.rng = new Rng(opts.seed ?? 7);
    this.latency = opts.latencyMs ?? [400, 2500];
    this.failureRate = opts.failureRate ?? 0.03;
    this.networkFee = opts.networkFeeQuote ?? '0.001';
  }

  private fee(req: SwapRequest): string {
    return s(d(this.networkFee).plus(req.priorityFeeQuote), 10);
  }

  async simulate(req: SwapRequest, now: number): Promise<SimulationResult> {
    if (this.venue) return this.venue.simulateSwap({ ...req, minOut: req.minOut }, now);
    const q = await this.quotes.getQuote(req, now);
    const ok = d(q.expectedOut).gte(req.minOut);
    return { ok, expectedOut: q.expectedOut, error: ok ? null : 'slippage exceeded' };
  }

  async submit(req: SwapRequest, now: number): Promise<SubmitResult> {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) {
      const tx = this.txs.get(existing)!;
      return { txId: tx.txId, submittedAt: tx.submittedAt };
    }
    if (d(req.amountIn).lte(0)) throw new ProviderError(this.name, 'amountIn must be positive', false);
    const txId = newId('papertx', now);
    const tx: PaperTx = {
      txId,
      req,
      submittedAt: now,
      fillAt: now + Math.round(this.rng.range(this.latency[0], this.latency[1])),
      status: { state: 'pending' },
    };
    this.txs.set(txId, tx);
    this.byKey.set(req.idempotencyKey, txId);
    return { txId, submittedAt: now };
  }

  async getStatus(txId: string, now: number): Promise<SwapStatus> {
    const tx = this.txs.get(txId);
    if (!tx) return { state: 'unknown', error: 'transaction not found in paper venue (engine restarted?)' };
    if (tx.status.state !== 'pending' || now < tx.fillAt) return tx.status;
    const fee = this.fee(tx.req);
    if (this.rng.chance(this.failureRate)) {
      tx.status = { state: 'failed', error: 'simulated network failure: transaction dropped', networkFeeQuote: fee, failedAt: now };
      return tx.status;
    }
    try {
      let out: string;
      if (this.venue) {
        out = this.venue.executeSwap({ ...tx.req, minOut: tx.req.minOut }, now).amountOut;
      } else {
        const q = await this.quotes.getQuote(tx.req, now);
        if (d(q.expectedOut).lt(tx.req.minOut)) throw new ProviderError(this.name, `slippage exceeded: out ${q.expectedOut} < min ${tx.req.minOut}`, false);
        out = q.expectedOut;
      }
      tx.status = { state: 'confirmed', amountIn: tx.req.amountIn, amountOut: out, networkFeeQuote: fee, confirmedAt: now };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ProviderError && e.transient) {
        // Venue unreachable at fill time: leave pending and try again next poll.
        tx.fillAt = now + 1000;
        return tx.status;
      }
      tx.status = { state: 'failed', error: msg, networkFeeQuote: fee, failedAt: now };
    }
    return tx.status;
  }

  async findByIdempotencyKey(key: string, now: number): Promise<{ txId: string; status: SwapStatus } | null> {
    const txId = this.byKey.get(key);
    if (!txId) return null;
    return { txId, status: await this.getStatus(txId, now) };
  }

  explorerUrl(): string | null {
    return null;
  }
}
