import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AtSign, Lock, X } from 'lucide-react';
import {
  CASE_MENTION_MAX,
  caseMentionToken,
  type CaseMentionCandidate,
  type CaseMessageMentionRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/field';

/**
 * Tagging people in a case message.
 *
 * What makes a tag real is the id, never the text. Picking somebody from the
 * dropdown writes `@Name` into the box AND remembers their id; the id list is
 * what is sent, and the server re-reads every one of them. Typing "@Name" by
 * hand writes text and nothing else, and deleting a tag's text from the box
 * drops the id with it - so what is sent is always what is on screen.
 *
 * The dropdown is a plain absolutely-positioned list rather than a popover
 * primitive: it has to follow a caret inside a textarea, keep focus in the
 * textarea while it is open, and it is short enough not to need portalling.
 */

export interface PickedMention {
  userId: string;
  name: string;
}

/** The `@query` immediately before the caret, if the caret is in one. */
export function mentionTrigger(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  // `@` at the start or after whitespace, then up to three words of a name.
  const match = /(^|\s)@([^\s@]*(?: [^\s@]*){0,2})$/.exec(before);
  if (!match) return null;
  const start = before.length - match[2]!.length - 1;
  return { start, query: match[2]! };
}

/** Keeps only the tags whose `@Name` is still in the text. */
export function pruneMentions(text: string, picked: readonly PickedMention[]): PickedMention[] {
  return picked.filter((m) => text.includes(caseMentionToken(m.name)));
}

function candidateDetail(c: CaseMentionCandidate): string {
  return [c.jobTitle, c.departmentName, ...c.roleNames].filter(Boolean).join(' · ');
}

export function MentionTextarea({
  caseId,
  internal,
  value,
  onChange,
  mentions,
  onMentionsChange,
  className,
  ...textareaProps
}: {
  caseId: string;
  internal: boolean;
  value: string;
  onChange: (value: string) => void;
  mentions: PickedMention[];
  onMentionsChange: (mentions: PickedMention[]) => void;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const listId = React.useId();
  const [trigger, setTrigger] = React.useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = React.useState(0);
  const query = React.useDeferredValue(trigger?.query ?? '');

  const candidates = useQuery({
    queryKey: ['cases', 'queue', 'mention-candidates', caseId, internal, query],
    queryFn: () =>
      api.get<CaseMentionCandidate[]>(`/cases/queue/${encodeURIComponent(caseId)}/mention-candidates`, {
        query: { q: query, internal: internal ? 'true' : 'false' },
      }),
    enabled: trigger !== null,
    staleTime: 30_000,
  });

  const options = Array.isArray(candidates.data) ? candidates.data : [];
  // A trigger that has run on into a sentence nobody's name matches closes.
  const open = trigger !== null && !(options.length === 0 && trigger.query.includes(' ') && !candidates.isFetching);
  const full = mentions.length >= CASE_MENTION_MAX;

  React.useEffect(() => setActive(0), [query]);

  const readTrigger = (text: string, caret: number | null) => {
    setTrigger(caret === null ? null : mentionTrigger(text, caret));
  };

  const choose = (candidate: CaseMentionCandidate) => {
    if (!trigger || !candidate.canAccess || full) return;
    const token = `${caseMentionToken(candidate.name)} `;
    const caret = ref.current?.selectionStart ?? value.length;
    const next = value.slice(0, trigger.start) + token + value.slice(caret);
    onChange(next);
    if (!mentions.some((m) => m.userId === candidate.userId)) {
      onMentionsChange([...mentions, { userId: candidate.userId, name: candidate.name }]);
    }
    setTrigger(null);
    const at = trigger.start + token.length;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || options.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const candidate = options[active];
      if (!candidate) return;
      event.preventDefault();
      choose(candidate);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setTrigger(null);
    }
  };

  const activeOption = open ? options[active] : undefined;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Textarea
          {...textareaProps}
          ref={ref}
          className={className}
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeOption ? `${listId}-${activeOption.userId}` : undefined}
          onChange={(event) => {
            const text = event.target.value;
            onChange(text);
            onMentionsChange(pruneMentions(text, mentions));
            readTrigger(text, event.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(event) => readTrigger(value, event.currentTarget.selectionStart)}
          onBlur={() => setTrigger(null)}
        />

        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="People you can tag"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
          >
            {candidates.isLoading ? (
              <li className="px-3 py-2 text-[12.5px] text-muted-foreground">Searching…</li>
            ) : options.length === 0 ? (
              <li className="px-3 py-2 text-[12.5px] text-muted-foreground">Nobody matches.</li>
            ) : (
              options.map((candidate, index) => (
                <li
                  key={candidate.userId}
                  id={`${listId}-${candidate.userId}`}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={!candidate.canAccess || full}
                  // Keeps focus (and the caret) in the textarea.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(candidate)}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    'rounded px-3 py-1.5 text-[13px]',
                    index === active && 'bg-accent',
                    candidate.canAccess && !full ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                  )}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {candidate.canAccess ? null : <Lock className="size-3" aria-hidden />}
                    {candidate.name}
                  </div>
                  {candidateDetail(candidate) ? (
                    <div className="text-[11.5px] text-muted-foreground">{candidateDetail(candidate)}</div>
                  ) : null}
                  {candidate.reason ? (
                    <div className="text-[11.5px] text-warning-foreground">{candidate.reason}</div>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>

      {mentions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-muted-foreground">Tagged:</span>
          {mentions.map((m) => (
            <span
              key={m.userId}
              className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary"
            >
              <AtSign className="size-3" aria-hidden />
              {m.name}
              <button
                type="button"
                aria-label={`Untag ${m.name}`}
                className="grid size-4 place-items-center rounded hover:bg-primary/15"
                onClick={() => onMentionsChange(mentions.filter((x) => x.userId !== m.userId))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A message's text with its real tags drawn as tags.
 *
 * Only the names the server recorded are highlighted; anything else that
 * happens to start with `@` stays plain text. Rendered as text nodes, never as
 * markup. A tag whose name no longer appears verbatim - the person was renamed
 * since - is listed underneath rather than lost.
 */
export function MessageText({
  text,
  mentions,
  profileLinks = false,
  className,
}: {
  text: string;
  mentions: readonly CaseMessageMentionRecord[] | undefined;
  /** Link tags to the employee profile. Only where the reader can open one. */
  profileLinks?: boolean;
  className?: string;
}) {
  const tagged = Array.isArray(mentions) ? mentions : [];
  const present = tagged.filter((m) => text.includes(caseMentionToken(m.name)));
  const missing = tagged.filter((m) => !present.includes(m));

  let parts: React.ReactNode[] = [text];
  if (present.length > 0) {
    const byToken = new Map(present.map((m) => [caseMentionToken(m.name), m]));
    const pattern = new RegExp(
      `(${[...byToken.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`,
      'g',
    );
    parts = text.split(pattern).map((part, index) => {
      const mention = byToken.get(part);
      if (!mention) return part;
      return <MentionChip key={index} mention={mention} link={profileLinks} />;
    });
  }

  return (
    <>
      <p className={cn('whitespace-pre-wrap text-[13.5px] leading-relaxed', className)}>{parts}</p>
      {missing.length > 0 ? (
        <p className="mt-1 text-[12px] text-muted-foreground">
          Tagged:{' '}
          {missing.map((m, index) => (
            <React.Fragment key={m.userId}>
              {index > 0 ? ', ' : null}
              <MentionChip mention={m} link={profileLinks} />
            </React.Fragment>
          ))}
        </p>
      ) : null}
    </>
  );
}

function MentionChip({ mention, link }: { mention: CaseMessageMentionRecord; link: boolean }) {
  const className = 'rounded bg-primary/10 px-1 font-medium text-primary';
  const label = caseMentionToken(mention.name);
  if (link && mention.employeeId) {
    return (
      <Link
        to={`/people/${encodeURIComponent(mention.employeeId)}`}
        className={cn(className, 'hover:underline')}
        data-mention={mention.userId}
      >
        {label}
      </Link>
    );
  }
  return (
    <span className={className} data-mention={mention.userId}>
      {label}
    </span>
  );
}
