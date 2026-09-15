import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MOMENT_GREETING_MAX_LENGTH,
  MOMENT_GREETING_SUGGESTIONS,
  type CompanyMomentPerson,
  type MomentGreetingResult,
  type MomentOccasion,
} from '@hrms/shared';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Saying something to the colleague on the card.
 *
 * The suggestions are the whole point of this dialog, and they are not
 * decoration. An empty box is the reason most people send nothing: writing a
 * birthday wish from scratch is a small task, easily deferred, and a birthday
 * is over by the evening. A tap fills the box with a real sentence, and the
 * sender can send it as it stands or type over it - which is why the
 * suggestions write INTO the textarea rather than being options that submit
 * themselves. What goes to the colleague is always what the sender saw.
 *
 * The wording comes from `@hrms/shared`, so the server measures a greeting
 * against the same lines the employee was offered and a future mobile client
 * cannot drift into a second set.
 */

const titleFor = (occasion: MomentOccasion, name: string): string => {
  if (occasion === 'BIRTHDAY') return `Wish ${name} a happy birthday`;
  if (occasion === 'ANNIVERSARY') return `Congratulate ${name}`;
  return `Welcome ${name}`;
};

const describe = (occasion: MomentOccasion): string => {
  if (occasion === 'BIRTHDAY') return 'It is their birthday today.';
  if (occasion === 'ANNIVERSARY') return 'They are celebrating a year with the company today.';
  return 'They have just joined the team.';
};

export function GreetDialog({
  person,
  occasion,
  open,
  onOpenChange,
}: {
  person: CompanyMomentPerson;
  occasion: MomentOccasion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const suggestions = MOMENT_GREETING_SUGGESTIONS[occasion];
  const [message, setMessage] = React.useState('');

  /**
   * A fresh dialog starts on the first suggestion rather than empty.
   *
   * Opening onto a pre-filled, sendable greeting means the shortest path to
   * greeting somebody is two taps. Reset on open, not on close, so a sender who
   * dismissed the dialog by accident does not come back to last time's draft
   * addressed to somebody else.
   */
  React.useEffect(() => {
    if (open) setMessage(suggestions[0] ?? '');
  }, [open, suggestions]);

  const mutation = useMutation({
    mutationFn: (text: string) =>
      api.post<MomentGreetingResult>('/me/company-moments/greetings', {
        employeeId: person.employeeId,
        occasion,
        message: text,
      }),
    onSuccess: async () => {
      toast.success(`Your greeting has been sent to ${person.fullName}.`);
      onOpenChange(false);
      // The cards carry the count and the greeted state, so they are what has
      // to change - the dashboard's other queries are untouched by this.
      await queryClient.invalidateQueries({ queryKey: ['me', 'company-moments'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const trimmed = message.trim();
  const tooLong = trimmed.length > MOMENT_GREETING_MAX_LENGTH;
  const canSend = trimmed.length > 0 && !tooLong && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{titleFor(occasion, person.fullName)}</DialogTitle>
          <DialogDescription>{describe(occasion)}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar
              name={person.fullName}
              photoUrl={person.photoUrl}
              colorKey={person.employeeId}
              size="lg"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{person.fullName}</p>
              {person.designationName ? (
                <p className="truncate text-[12.5px] text-muted-foreground">
                  {person.designationName}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-[12.5px] font-medium text-muted-foreground">
              Pick one, or write your own
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setMessage(suggestion)}
                  aria-pressed={message === suggestion}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-left text-[12.5px] transition-colors',
                    message === suggestion
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Textarea
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              aria-label="Your greeting"
              placeholder="Write a greeting..."
            />
            <p
              className={cn(
                'text-right text-[11.5px]',
                tooLong ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {trimmed.length}/{MOMENT_GREETING_MAX_LENGTH}
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate(trimmed)}
            disabled={!canSend}
            loading={mutation.isPending}
          >
            Send greeting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
