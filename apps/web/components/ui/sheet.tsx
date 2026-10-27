'use client';

import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Sheet({ open, onOpenChange, title, subtitle, accent, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; subtitle?: ReactNode; accent?: string; children: ReactNode; wide?: boolean }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <D.Content className={cn('fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-ink-700 bg-ink-900 shadow-2xl outline-none', wide ? 'max-w-3xl' : 'max-w-xl')}>
          <div className="h-[2px] w-full" style={{ background: accent ?? 'var(--color-exec)' }} />
          <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
            <div className="min-w-0">
              <D.Title className="truncate text-base font-semibold text-ink-100">{title}</D.Title>
              {subtitle ? <D.Description className="mt-0.5 text-xs text-ink-400">{subtitle}</D.Description> : <D.Description className="sr-only">details</D.Description>}
            </div>
            <D.Close className="rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label="Close">
              <X size={16} />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Modal({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; children: ReactNode }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <D.Content className="panel fixed left-1/2 top-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none">
          <D.Title className="mb-3 text-sm font-semibold">{title}</D.Title>
          <D.Description className="sr-only">confirmation</D.Description>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
