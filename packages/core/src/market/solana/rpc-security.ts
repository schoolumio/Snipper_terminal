import { d, s } from '../../decimal';
import type { ChainId, PoolInfo, SecurityReport } from '../../types';
import { ProviderError, type SecurityProvider } from '../providers';

/**
 * Solana JSON-RPC security signals using standard RPC methods only
 * (getAccountInfo jsonParsed, getTokenSupply, getTokenLargestAccounts).
 *
 * Provides: mint / freeze authority status, Token-2022 transfer-fee config and
 * top-holder concentration. It cannot determine sellability, LP locks, deployer
 * history or malicious-actor lists — those fields are returned as null
 * (unknown) and the risk guard treats them accordingly. Combine with a
 * dedicated security provider for those signals.
 *
 * Note: the largest token accounts usually include the pool's own vault, so
 * concentration is over-estimated rather than under-estimated (fail-safe).
 */
export class SolanaRpcSecurityProvider implements SecurityProvider {
  readonly name = 'solana-rpc';
  private id = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 8000,
  ) {
    if (!/^https?:\/\//.test(rpcUrl)) throw new Error('SOLANA_RPC_URL must be an http(s) URL');
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(this.name, `${method}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new ProviderError(this.name, `${method}: HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new ProviderError(this.name, `${method}: ${body.error.message ?? 'rpc error'}`);
    if (body.result === undefined) throw new ProviderError(this.name, `${method}: empty result`);
    return body.result;
  }

  async assess(chain: ChainId, tokenAddress: string, _pool: PoolInfo, now: number): Promise<SecurityReport> {
    if (chain !== 'solana') throw new ProviderError(this.name, `unsupported chain ${chain}`, false);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress)) throw new ProviderError(this.name, 'invalid mint address', false);
    type ParsedMint = { value: { owner?: string; data?: { parsed?: { type?: string; info?: Record<string, unknown> } } } | null };
    const acct = await this.rpc<ParsedMint>('getAccountInfo', [tokenAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const info = acct.value?.data?.parsed?.info;
    if (!acct.value || acct.value.data?.parsed?.type !== 'mint' || !info) throw new ProviderError(this.name, 'account is not a parsed SPL mint', false);
    const flags: string[] = [];
    const mintAuthority = info.mintAuthority;
    const freezeAuthority = info.freezeAuthority;
    let transferTaxPct: string | null = '0';
    const ext = Array.isArray(info.extensions) ? (info.extensions as { extension?: string; state?: Record<string, unknown> }[]) : [];
    for (const e of ext) {
      if (e.extension === 'transferFeeConfig') {
        const newer = (e.state?.newerTransferFee as { transferFeeBasisPoints?: number } | undefined)?.transferFeeBasisPoints;
        transferTaxPct = typeof newer === 'number' ? s(d(newer).div(100), 4) : null;
      } else if (e.extension === 'permanentDelegate' || e.extension === 'transferHook' || e.extension === 'nonTransferable' || e.extension === 'defaultAccountState') {
        flags.push(`token2022:${e.extension}`);
      }
    }
    let top10HolderPct: string | null = null;
    try {
      const [supply, largest] = await Promise.all([
        this.rpc<{ value: { amount: string } }>('getTokenSupply', [tokenAddress, { commitment: 'confirmed' }]),
        this.rpc<{ value: { amount: string }[] }>('getTokenLargestAccounts', [tokenAddress, { commitment: 'confirmed' }]),
      ]);
      const total = d(supply.value.amount);
      if (total.gt(0)) {
        const top = largest.value.slice(0, 10).reduce((a, x) => a.plus(x.amount), d(0));
        top10HolderPct = s(top.div(total).times(100), 4);
        flags.push('top_holders_include_pool_vault');
      }
    } catch (e) {
      flags.push(`holders_unavailable`);
      if (!(e instanceof ProviderError)) throw e;
    }
    return {
      chain,
      tokenAddress,
      source: this.name,
      fetchedAt: now,
      mintAuthorityRenounced: mintAuthority === null ? true : typeof mintAuthority === 'string' ? false : null,
      freezeAuthorityRenounced: freezeAuthority === null ? true : typeof freezeAuthority === 'string' ? false : null,
      top10HolderPct,
      creatorHoldingPct: null,
      holderCount: null,
      lpLock: null,
      sellSimulationOk: null,
      transferTaxPct,
      creatorPriorFlaggedTokens: null,
      knownMalicious: null,
      providerFlags: flags.filter((f) => f.startsWith('token2022:')),
    };
  }
}
