import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeftRight, Plus, UserMinus } from 'lucide-react';
import {
  TEAM_MANAGER_MAX,
  type TeamManagerRecord,
  type TeamManagerRoster,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Who runs a team.
 *
 * The screen deliberately shows three things the server is enforcing anyway,
 * because a rule the user cannot see is a rule they experience as a bug:
 *
 *   - the ceiling of three, counted on screen;
 *   - that an appointment ENDS rather than disappearing, with the people who
 *     used to run the team listed underneath;
 *   - whether each manager's login can actually SEE the team they have been
 *     put in charge of, which is a separate fact from the appointment and the
 *     one most likely to be missing.
 */
export function TeamManagersDialog({
  teamId,
  teamName,
  onClose,
}: {
  teamId: string | null;
  teamName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { lookups } = useLookups();
  const [adding, setAdding] = React.useState('');
  const [replacing, setReplacing] = React.useState<TeamManagerRecord | null>(null);
  const [replacement, setReplacement] = React.useState('');
  const [reason, setReason] = React.useState('');

  const query = useQuery({
    queryKey: ['team-managers', teamId],
    queryFn: () => api.get<TeamManagerRoster>(`/teams/${teamId}/managers`),
    enabled: teamId !== null,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['team-managers', teamId] });
    await queryClient.invalidateQueries({ queryKey: ['teams'] });
    await queryClient.invalidateQueries({ queryKey: ['org-chart'] });
    setAdding('');
    setReplacing(null);
    setReplacement('');
    setReason('');
  };

  const assign = useMutation({
    mutationFn: (employeeId: string) => api.post(`/teams/${teamId}/managers`, { employeeId }),
    onSuccess: async () => {
      toast.success('Manager appointed.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (input: { employeeId: string; reason: string }) =>
      api.post(`/teams/${teamId}/managers/${input.employeeId}/remove`, { reason: input.reason }),
    onSuccess: async () => {
      toast.success('Appointment ended.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const replace = useMutation({
    mutationFn: (input: { outgoingEmployeeId: string; incomingEmployeeId: string; reason: string }) =>
      api.post(`/teams/${teamId}/managers/replace`, input),
    onSuccess: async () => {
      toast.success('Manager replaced.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const roster = query.data;
  const managers = roster?.managers ?? [];
  const canManage = roster?.canManage ?? false;
  const atCeiling = managers.length >= TEAM_MANAGER_MAX;

  const handleRemove = async (manager: TeamManagerRecord) => {
    const last = managers.length === 1;
    const ok = await confirm({
      title: `End ${manager.employeeName}'s appointment?`,
      description: last
        ? `${teamName} will be left with no manager. Requests from this team will skip the Team Manager stage until somebody is appointed.`
        : 'They keep their history with this team; they simply stop running it.',
      confirmLabel: 'End appointment',
      tone: 'destructive',
    });
    if (ok) remove.mutate({ employeeId: manager.employeeId, reason: '' });
  };

  /** Everybody still employed, minus the people already running this team. */
  const candidates = lookups.managers.filter(
    (person) => !managers.some((m) => m.employeeId === person.id),
  );

  return (
    <Dialog open={teamId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Managers of {teamName}</DialogTitle>
          <DialogDescription>
            A team manager is an appointment, not a job title. Whoever is listed here decides this
            team&apos;s requests at the Team Manager stage - one to {TEAM_MANAGER_MAX} of them, and
            any one is enough.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {query.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <>
              {managers.length === 0 ? (
                <EmptyState
                  title="Nobody manages this team"
                  description="Requests from this team skip the Team Manager stage and go straight to HR."
                  className="py-6"
                />
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {managers.map((manager) => (
                    <li key={manager.id} className="flex items-start gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium">{manager.employeeName}</p>
                        <p className="text-[12px] text-muted-foreground">
                          {manager.designation ?? manager.employeeNumber}
                        </p>
                        {manager.hasTeamDataAccess === false ? (
                          <p className="mt-1 flex items-start gap-1.5 text-[12px] text-warning">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                            <span>
                              They can decide this team&apos;s requests, but no role they hold lets
                              them SEE the team. Give them the Team Manager role, or any role with
                              &quot;See your team as a manager&quot;.
                            </span>
                          </p>
                        ) : null}
                        {manager.hasTeamDataAccess === null ? (
                          <p className="mt-1 text-[12px] text-muted-foreground">
                            No login account, so they cannot be notified or approve anything.
                          </p>
                        ) : null}
                      </div>
                      {canManage ? (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Replace ${manager.employeeName}`}
                            onClick={() => setReplacing(manager)}
                          >
                            <ArrowLeftRight />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:bg-destructive-soft"
                            aria-label={`End ${manager.employeeName}'s appointment`}
                            onClick={() => void handleRemove(manager)}
                          >
                            <UserMinus />
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {canManage && replacing === null ? (
                <div className="space-y-2">
                  <FormField label="Appoint a manager" htmlFor="team-manager-add">
                    <NativeSelect
                      id="team-manager-add"
                      value={adding}
                      disabled={atCeiling}
                      onChange={(event) => setAdding(event.target.value)}
                    >
                      <option value="">
                        {atCeiling
                          ? `${TEAM_MANAGER_MAX} managers already - replace one instead`
                          : 'Choose an employee'}
                      </option>
                      {candidates.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.label}
                          {person.secondaryLabel ? ` - ${person.secondaryLabel}` : ''}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <Button
                    size="sm"
                    disabled={adding === '' || atCeiling}
                    loading={assign.isPending}
                    onClick={() => assign.mutate(adding)}
                  >
                    <Plus />
                    Appoint
                  </Button>
                </div>
              ) : null}

              {canManage && replacing !== null ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
                  <p className="text-[13px] font-medium">Replace {replacing.employeeName}</p>
                  <p className="text-[12px] text-muted-foreground">
                    Their appointment ends and the new manager&apos;s begins in the same move, so a
                    team already at {TEAM_MANAGER_MAX} managers can still be handed a successor.
                  </p>
                  <FormField label="New manager" htmlFor="team-manager-replacement">
                    <NativeSelect
                      id="team-manager-replacement"
                      value={replacement}
                      onChange={(event) => setReplacement(event.target.value)}
                    >
                      <option value="">Choose an employee</option>
                      {candidates.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <FormField label="Reason (optional)" htmlFor="team-manager-reason">
                    <Input
                      id="team-manager-reason"
                      value={reason}
                      placeholder="Left the company"
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </FormField>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={replacement === ''}
                      loading={replace.isPending}
                      onClick={() =>
                        replace.mutate({
                          outgoingEmployeeId: replacing.employeeId,
                          incomingEmployeeId: replacement,
                          reason,
                        })
                      }
                    >
                      Replace
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setReplacing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}

              {roster && roster.formerManagers.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                    Previously
                  </p>
                  <ul className="space-y-1">
                    {roster.formerManagers.map((manager) => (
                      <li key={manager.id} className="text-[12.5px] text-muted-foreground">
                        {manager.employeeName}
                        {manager.endReason ? ` - ${manager.endReason}` : ''}
                        {manager.endedAt ? ` (${manager.endedAt.slice(0, 10)})` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Badge variant={managers.length === 0 ? 'warning' : 'neutral'}>
            {managers.length} of {TEAM_MANAGER_MAX}
          </Badge>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
