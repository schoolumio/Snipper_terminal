/**
 * Display formatting only. Values arrive as exact decimal strings from the
 * server; conversion to number here is lossy and never fed back into logic.
 */

const usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Sub-dollar amounts (fees) keep up to 4 decimals so $0.003 does not read as $0.00.
const usdSmallFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  return typeof v === 'number' ? v : Number(v);
}

export function usd(v: string | number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v === null || v === undefined) return '—';
  const n = toNum(v);
  const s = (Math.abs(n) < 1 ? usdSmallFmt : usdFmt).format(Math.abs(n));
  const sign = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${sign}$${s}`;
}

export function compact(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return compactFmt.format(toNum(v));
}

export function pct(v: string | number | null | undefined, opts: { sign?: boolean; dp?: number } = {}): string {
  if (v === null || v === undefined) return '—';
  const n = toNum(v);
  const dp = opts.dp ?? (Math.abs(n) < 10 ? 2 : 1);
  const sign = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${sign}${Math.abs(n).toFixed(dp)}%`;
}

const SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/** Tiny token prices: 0.00001234 → 0.0₄1234 */
export function price(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = toNum(v);
  if (n === 0) return '0';
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const s = n.toFixed(20);
  const m = /^0\.(0*)(\d{1,4})/.exec(s);
  if (!m) return n.toPrecision(4);
  const zeros = m[1]!.length;
  if (zeros < 3) return n.toPrecision(4);
  const sub = String(zeros)
    .split('')
    .map((c) => SUB[Number(c)])
    .join('');
  return `0.0${sub}${m[2]}`;
}

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  return age(sec * 1000);
}

export function short(addr: string | null | undefined, n = 4): string {
  if (!addr) return '—';
  return addr.length > n * 2 + 1 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}

export function signClass(v: string | number | null | undefined): string {
  const n = toNum(v);
  return n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-ink-300';
}
