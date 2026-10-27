import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Section panel with an indexed header ("02 / PIPELINE"). */
export function Panel({ index, title, right, accent, className, bodyClassName, children, ...p }: HTMLAttributes<HTMLElement> & { index?: string; title?: ReactNode; right?: ReactNode; accent?: string; bodyClassName?: string }) {
  return (
    <section className={cn('panel flex min-w-0 flex-col', className)} {...p}>
      {title !== undefined && (
        <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-ink-700/80 px-3">
          <div className="flex min-w-0 items-center gap-2">
            {accent && <span className="h-2.5 w-[3px] rounded-full" style={{ background: accent }} />}
            {index && <span className="label text-ink-500">{index}</span>}
            <span className="label truncate !text-ink-200">{title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">{right}</div>
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, className, valueClassName }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string; valueClassName?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="label truncate">{label}</div>
      <div className={cn('num mt-1 truncate text-lg leading-none text-ink-100', valueClassName)}>{value}</div>
      {sub !== undefined && <div className="num mt-1 truncate text-[11px] text-ink-400">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-16 items-center justify-center px-4 py-6 text-center font-mono text-[11px] text-ink-500">{children}</div>;
}
