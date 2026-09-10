import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One Radix dialog, two presentations:
 *  - `variant="modal"`  centred, for short confirmations and small forms
 *  - `variant="drawer"` right-hand panel, for longer record forms
 *
 * Both are a column: DialogHeader, then DialogBody, then DialogFooter. The
 * body is the only part that scrolls, so a form taller than the viewport
 * still keeps its title and buttons in view. Put form fields inside
 * DialogBody - as a direct child of DialogContent they cannot shrink, and
 * they push the footer off the bottom of the screen instead.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const Overlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'hrms-overlay fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]',
      className,
    )}
    {...props}
  />
));
Overlay.displayName = 'DialogOverlay';

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  variant?: 'modal' | 'drawer';
  size?: 'sm' | 'md' | 'lg';
  showClose?: boolean;
}

const MODAL_SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };
const DRAWER_SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-xl' };

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(
  (
    {
      className,
      children,
      variant = 'modal',
      size = 'md',
      showClose = true,
      onOpenAutoFocus,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    /**
     * Where focus goes back to when the dialog closes.
     *
     * Radix returns focus to its DialogTrigger. Screens here open dialogs from
     * ordinary buttons driven by `open` state, so there is no trigger and focus
     * would otherwise be dropped on <body>. The element focused at the moment
     * the dialog opens is remembered instead - the button that was clicked or
     * activated - and focused again on close, provided it is still in the page.
     */
    const openerRef = React.useRef<HTMLElement | null>(null);

    return (
      <DialogPrimitive.Portal>
        <Overlay />
        <DialogPrimitive.Content
          ref={ref}
          onOpenAutoFocus={(event) => {
            openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            onOpenAutoFocus?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            const opener = openerRef.current;
            if (opener && opener.isConnected) {
              event.preventDefault();
              opener.focus();
            }
          }}
          className={cn(
            'fixed z-50 flex flex-col border border-border bg-popover text-popover-foreground shadow-xl',
            'focus:outline-none',
            variant === 'modal' && [
              // Centred by the `translate` property; index.css caps the height to
              // the viewport (safe areas included) and hrms-modal-in only scales.
              'hrms-modal left-1/2 top-1/2 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
              'overflow-hidden',
              MODAL_SIZES[size],
            ],
            variant === 'drawer' && [
              'hrms-drawer inset-y-0 right-0 h-full w-full border-y-0 border-r-0',
              DRAWER_SIZES[size],
            ],
            className,
          )}
          {...props}
        >
          {children}
          {showClose ? (
            <DialogPrimitive.Close
              className="absolute right-3.5 top-3.5 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);
DialogContent.displayName = 'DialogContent';

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('shrink-0 space-y-1 border-b border-border px-5 py-4 pr-12', className)}
      {...props}
    />
  );
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col-reverse gap-2 border-t border-border px-5 py-3.5 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-semibold tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-[13px] text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';
