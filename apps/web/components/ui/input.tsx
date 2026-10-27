import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn('h-8 w-full rounded-[4px] border border-ink-600 bg-ink-900 px-2.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-exec/60 focus:outline-none', className)} {...p} />
));
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} className={cn('h-8 rounded-[4px] border border-ink-600 bg-ink-900 px-2 font-mono text-xs text-ink-100 focus:border-exec/60 focus:outline-none', className)} {...p}>
    {children}
  </select>
));
Select.displayName = 'Select';
