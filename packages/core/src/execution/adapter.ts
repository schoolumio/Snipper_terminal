import type { ChainId, Dec, Side, TradingMode } from '../types';

export interface SwapRequest {
  idempotencyKey: string;
  chain: ChainId;
  poolAddress: string;
  tokenAddress: string;
  side: Side;
  amountIn: Dec;
  minOut: Dec;
  priorityFeeQuote: Dec;
}

export interface SubmitResult {
  /** Transaction signature / simulated id. */
  txId: string;
  submittedAt: number;
}

export type SwapStatus =
  | { state: 'pending' }
  | {
      state: 'confirmed';
      amountIn: Dec;
      amountOut: Dec;
      networkFeeQuote: Dec;
      confirmedAt: number;
    }
  | { state: 'failed'; error: string; networkFeeQuote: Dec; failedAt: number }
  | { state: 'unknown'; error: string };

export interface SimulationResult {
  ok: boolean;
  expectedOut: Dec | null;
  error: string | null;
}

/**
 * Chain-specific execution. Only the Executor agent holds a reference to an
 * adapter. Implementations must be idempotent on `idempotencyKey`.
 */
export interface ExecutionAdapter {
  readonly name: string;
  readonly mode: TradingMode;
  readonly chain: ChainId;
  /** Address (or label for paper) of the trading wallet. Never secret material. */
  readonly walletLabel: string;
  simulate(req: SwapRequest, now: number): Promise<SimulationResult>;
  submit(req: SwapRequest, now: number): Promise<SubmitResult>;
  getStatus(txId: string, now: number): Promise<SwapStatus>;
  /** Look up by idempotency key for reconciliation after an uncertain outcome. */
  findByIdempotencyKey(key: string, now: number): Promise<{ txId: string; status: SwapStatus } | null>;
  /** Wallet balance of the quote asset, if the adapter can observe one. */
  getQuoteBalance?(now: number): Promise<Dec | null>;
  explorerUrl?(txId: string): string | null;
}
