import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[4px] font-mono text-[11px] uppercase tracking-[0.08em] transition-colors disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'border border-ink-600 bg-ink-800 text-ink-100 hover:border-ink-500 hover:bg-ink-750',
        primary: 'border border-exec/60 bg-exec/10 text-exec hover:bg-exec/20',
        danger: 'border border-risk/60 bg-risk/10 text-risk hover:bg-risk/20',
        success: 'border border-equity/50 bg-equity/10 text-equity hover:bg-equity/20',
        ghost: 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
      },
      size: { sm: 'h-7 px-2.5', md: 'h-8 px-3', icon: 'h-7 w-7' },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
