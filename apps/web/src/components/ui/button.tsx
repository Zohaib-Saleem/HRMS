import * as React from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent border border-border',
        outline: 'border border-border bg-surface hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-9.5 px-4',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'h-9.5 w-9.5',
        'icon-sm': 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner and blocks interaction. */
  loading?: boolean;
}

/**
 * Development-only contract check.
 *
 * Radix's Slot requires exactly one element to merge onto. When that contract
 * is broken it throws from inside Slot, so the stack points at Radix internals
 * and says nothing about which call site is at fault - which makes the failure
 * expensive to track down, especially when the offending child is conditional
 * and the crash therefore only happens sometimes.
 *
 * This logs the culprit first. It does not swallow anything: Radix still throws
 * and the error boundary still catches, the console just names the component.
 */
function warnOnBadAsChild(children: React.ReactNode): void {
  if (!import.meta.env.DEV) return;

  const count = React.Children.count(children);
  if (count === 1 && React.isValidElement(children)) return;

  // eslint-disable-next-line no-console
  console.error(
    `<Button asChild> expects exactly one React element child, received ${
      count === 0 ? 'none' : count > 1 ? `${count} children` : 'a non-element child'
    }. Radix Slot cannot merge onto that. Wrap the content in a single element, ` +
      'or drop asChild.',
    children,
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    if (asChild) warnOnBadAsChild(children);
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {/*
          Slottable is required, not cosmetic. With `asChild`, Radix's Slot
          merges props onto a single child element - but the spinner slot above
          means this component always passes two children, so Slot cannot tell
          which one to merge onto and throws. Slottable marks `children` as the
          element to merge into, letting the spinner render beside it. Outside a
          Slot it is a transparent passthrough, so the plain <button> path is
          unaffected.
        */}
        <Slottable>{children}</Slottable>
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
