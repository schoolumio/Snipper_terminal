'use client';

import * as S from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

export function Switch({ checked, onCheckedChange, disabled, className, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; className?: string; id?: string }) {
  return (
    <S.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className={cn('relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border border-ink-600 bg-ink-800 transition-colors data-[state=checked]:border-exec/60 data-[state=checked]:bg-exec/25 disabled:opacity-40', className)}>
      <S.Thumb className="block h-3 w-3 translate-x-[2px] rounded-full bg-ink-400 transition-transform data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-exec" />
    </S.Root>
  );
}
