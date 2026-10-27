'use client';

import * as T from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;
export const TabsContent = T.Content;

export function TabsList({ className, ...p }: T.TabsListProps) {
  return <T.List className={cn('inline-flex items-center gap-0.5 rounded-[5px] border border-ink-700 bg-ink-900 p-0.5', className)} {...p} />;
}

export function TabsTrigger({ className, ...p }: T.TabsTriggerProps) {
  return <T.Trigger className={cn('rounded-[3px] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400 transition-colors hover:text-ink-200 data-[state=active]:bg-ink-750 data-[state=active]:text-ink-100', className)} {...p} />;
}
