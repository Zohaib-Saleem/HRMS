import * as React from 'react';
import { Search } from 'lucide-react';
import type { InterviewerOption } from '@hrms/shared';
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Choosing a panel.
 *
 * A list of checkboxes rather than a multi-select, because a panel is usually
 * two or three people picked out of three hundred and a native multiple select
 * is famously the worst control in HTML for that - ctrl-click to add, and one
 * stray click wipes the selection.
 *
 * `hasLogin` is surfaced on the row rather than discovered afterwards. A
 * panellist with no login account gets no in-app notification and no email,
 * and the person booking should know that BEFORE they book, not when nobody
 * turns up. The interview is still perfectly bookable - plenty of interviewers
 * are told in person - so this is a note, not a block.
 */
export function InterviewerPicker({
  interviewers,
  selected,
  onChange,
  loading = false,
  error,
}: {
  interviewers: InterviewerOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  error?: string;
}) {
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return interviewers;
    return interviewers.filter(
      (person) =>
        person.fullName.toLowerCase().includes(term) ||
        (person.jobTitle ?? '').toLowerCase().includes(term) ||
        (person.departmentName ?? '').toLowerCase().includes(term),
    );
  }, [interviewers, search]);

  const toggle = (employeeId: string) => {
    onChange(
      selected.includes(employeeId)
        ? selected.filter((id) => id !== employeeId)
        : [...selected, employeeId],
    );
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search people"
          aria-label="Search interviewers"
          className="pl-9"
        />
      </div>

      <div
        className={cn(
          'max-h-56 overflow-y-auto rounded-md border border-input',
          error && 'border-destructive',
        )}
        role="group"
        aria-label="Interviewers"
      >
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-8" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
            Nobody matches that.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((person) => (
              <li key={person.employeeId}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/45">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--color-primary)]"
                    checked={selected.includes(person.employeeId)}
                    onChange={() => toggle(person.employeeId)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px]">{person.fullName}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {[person.jobTitle, person.departmentName].filter(Boolean).join(' · ') ||
                        'No title'}
                    </span>
                  </span>
                  {person.hasLogin ? null : (
                    <span className="shrink-0 text-[11px] text-warning-foreground">No login</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[12.5px] text-muted-foreground">
        {selected.length === 0
          ? 'Nobody chosen yet.'
          : `${selected.length} on the panel. Anybody marked "No login" will not be notified by the system.`}
      </p>
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}
