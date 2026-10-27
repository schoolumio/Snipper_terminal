import type { Alert, Engine } from '@sniper/core';

export interface Notifier {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

const NOTIFY_KINDS = new Set(['trade_entry', 'trade_exit', 'take_profit', 'stop_loss', 'unsellable', 'reconciliation', 'live_enabled', 'emergency_pause', 'approval_required']);

/** Which alerts are forwarded to external channels. */
export function shouldNotify(a: Alert): boolean {
  return a.level !== 'info' || NOTIFY_KINDS.has(a.kind);
}

/** Message text: always labelled with the trading mode; never contains secrets. */
export function formatAlert(a: Alert): string {
  const tag = a.mode === 'live' ? '[LIVE]' : '[PAPER · simulated]';
  const icon = a.level === 'critical' ? '🛑' : a.level === 'warning' ? '⚠️' : 'ℹ️';
  return `${icon} ${tag} ${a.title}\n${a.message}`.slice(0, 3500);
}

/** Telegram Bot API (sendMessage). Optional; enabled by TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. */
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(alert: Alert): Promise<void> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: formatAlert(alert), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
  }
}

/** Fan-out with a simple per-minute rate limit so a burst cannot flood channels. */
export function attachNotifiers(engine: Engine, notifiers: Notifier[], log: { warn: (o: object, m: string) => void }, perMinute = 20): void {
  if (!notifiers.length) return;
  let window = Date.now();
  let sent = 0;
  engine.onEvent((e) => {
    if (e.type !== 'alert' || !shouldNotify(e.data)) return;
    const now = Date.now();
    if (now - window > 60_000) {
      window = now;
      sent = 0;
    }
    if (++sent > perMinute) return;
    for (const n of notifiers) n.send(e.data).catch((err: unknown) => log.warn({ notifier: n.name, err: String(err) }, 'notification failed'));
  });
}
