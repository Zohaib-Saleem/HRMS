import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A segmented control for choosing between two or three views of one screen.
 *
 * Deliberately not a dropdown. The whole point is that the reader can see which
 * view is live and what the alternatives are without opening anything - the
 * previous version of this control was a small pill in a page header's action
 * row, and it was reported as missing because nobody read it as a switcher.
 *
 * The active segment takes the primary colour, the same treatment as a primary
 * button, so "which one am I on" survives both themes and does not rely on a
 * one-shade-lighter background.
 *
 * Full width with 44px targets on a phone - three equal thumb-sized buttons
 * beat three small ones huddled in a corner - and content width from `sm` up.
 * `sm:self-start` matters: inside a column flex container an `inline-flex`
 * still stretches to the full row without it.
 */
export interface ViewOption<T extends string> {
  key: T;
  label: string;
  icon?: LucideIcon;
}

export function ViewSwitcher<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<ViewOption<T>>;
  /** The accessible name of the group, e.g. "Attendance view". */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'grid w-full gap-1 rounded-xl border border-border bg-surface-muted p-1 sm:inline-flex sm:w-auto sm:self-start',
        options.length === 2 ? 'grid-cols-2' : 'grid-cols-3',
        className,
      )}
    >
      {options.map((option) => {
        const selected = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.key)}
            className={cn(
              'inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[13.5px] font-medium transition-colors sm:min-h-9 sm:px-4',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              selected
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {option.icon ? <option.icon className="size-4 shrink-0" aria-hidden /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
