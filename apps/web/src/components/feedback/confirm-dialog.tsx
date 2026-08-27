import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'destructive';
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve?: (value: boolean) => void;
}

const ConfirmContext = React.createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(
  null,
);

/**
 * Promise-based confirmation.
 *
 *   if (await confirm({ title: 'Discard changes?' })) { ... }
 *
 * Keeps call sites linear instead of scattering open/close state through every
 * screen that needs a guard rail.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ConfirmState>({ open: false, title: '' });

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...options, open: true, resolve });
      }),
    [],
  );

  const settle = React.useCallback(
    (result: boolean) => {
      state.resolve?.(result);
      setState((prev) => ({ ...prev, open: false, resolve: undefined }));
    },
    [state],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state.open} onOpenChange={(open) => (open ? null : settle(false))}>
        <DialogContent size="sm" showClose={false}>
          <DialogHeader className="pr-5">
            <div className="flex items-start gap-3">
              {state.tone === 'destructive' ? (
                <span
                  className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-destructive-soft text-destructive"
                  aria-hidden
                >
                  <AlertTriangle className="size-4" />
                </span>
              ) : null}
              <div className="space-y-1">
                <DialogTitle>{state.title}</DialogTitle>
                {state.description ? (
                  <DialogDescription>{state.description}</DialogDescription>
                ) : null}
              </div>
            </div>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              {state.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              variant={state.tone === 'destructive' ? 'destructive' : 'primary'}
              onClick={() => settle(true)}
              autoFocus
            >
              {state.confirmLabel ?? 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = React.useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used inside <ConfirmProvider>.');
  return context;
}
