import * as React from 'react';
import { AlertOctagon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface State {
  error: Error | null;
}

/**
 * Last line of defence. A render crash shows a readable panel instead of a
 * blank white page, and keeps the stack visible in development.
 */
export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Unhandled render error:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-dvh place-items-center bg-background p-6">
        <div className="w-full max-w-lg rounded-xl border border-border bg-card p-7 text-center shadow-sm">
          <span className="mx-auto mb-4 grid size-11 place-items-center rounded-full bg-destructive-soft text-destructive">
            <AlertOctagon className="size-5" aria-hidden />
          </span>
          <h1 className="text-lg font-semibold">Something broke</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            The screen failed to render. Reloading usually clears it.
          </p>

          {import.meta.env.DEV ? (
            <pre className="mt-4 max-h-52 overflow-auto rounded-lg bg-muted p-3 text-left font-mono text-[11.5px] leading-relaxed">
              {error.stack ?? error.message}
            </pre>
          ) : null}

          <div className="mt-5 flex justify-center gap-2">
            <Button variant="outline" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload the app</Button>
          </div>
        </div>
      </div>
    );
  }
}
