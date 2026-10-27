'use client';

import * as T from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export const TooltipProvider = T.Provider;

export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className="z-50 max-w-xs rounded-[4px] border border-ink-600 bg-ink-800 px-2 py-1.5 text-[11px] leading-snug text-ink-200 shadow-lg">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
