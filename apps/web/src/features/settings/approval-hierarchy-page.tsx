import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDown, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  APPROVAL_STAGES,
  APPROVAL_STAGE_DESCRIPTIONS,
  APPROVAL_STAGE_LABELS,
  APPROVAL_STAGE_MODES,
  APPROVAL_STAGE_MODE_DESCRIPTIONS,
  APPROVAL_STAGE_MODE_LABELS,
  PERMISSIONS,
  type ApprovalHierarchySettings,
  type ApprovalStage,
  type ApprovalStageMode,
  type ApprovalWorkflowRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';

/**
 * The approval hierarchy: which rungs a request climbs, and who fills them.
 *
 * Two halves, and the split is the point of the whole feature:
 *
 *   THE CHAIN is configuration - Team Manager, then HR Manager, then CEO -
 *   and each rung carries a mode saying whether one approver is enough.
 *
 *   THE PEOPLE are named for the two company-wide rungs only. The Team
 *   Manager rung is NOT configurable here, because who manages a team lives on
 *   the Teams screen, and a second answer to that question here is exactly the
 *   ambiguity this feature was built to remove. The card below says so rather
 *   than leaving somebody hunting for the control.
 */
export function ApprovalHierarchyPage() {
  const { has } = usePermissions();
  const query = useQuery({
    queryKey: ['approval-hierarchy'],
    queryFn: () => api.get<ApprovalHierarchySettings>('/approvals/hierarchy'),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const settings = query.data;
  if (!settings) return null;

  const canManage = settings.canManage && has(PERMISSIONS.APPROVAL_WORKFLOW_MANAGE);

  return (
    <div className="space-y-5">
      {settings.warnings.length > 0 ? (
        <Card className="border-warning/40 bg-warning-soft/30">
          <CardContent className="space-y-1.5 py-4">
            {settings.warnings.map((warning) => (
              <p key={warning} className="flex items-start gap-2 text-[13px]">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                {warning}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <StageAssignees settings={settings} canManage={canManage} />

      {settings.workflows.map((workflow) => (
        <WorkflowCard key={workflow.subjectType} workflow={workflow} canManage={canManage} />
      ))}
    </div>
  );
}

/** Who fills the HR Manager and CEO rungs. */
function StageAssignees({
  settings,
  canManage,
}: {
  settings: ApprovalHierarchySettings;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { lookups } = useLookups();
  const [stage, setStage] = React.useState<'HR_MANAGER' | 'CEO'>('HR_MANAGER');
  const [employeeId, setEmployeeId] = React.useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['approval-hierarchy'] });

  const add = useMutation({
    mutationFn: () => api.post('/approvals/hierarchy/assignees', { stage, employeeId }),
    onSuccess: async () => {
      toast.success('Named on the approval hierarchy.');
      setEmployeeId('');
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['org-chart'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/approvals/hierarchy/assignees/${id}`),
    onSuccess: async () => {
      toast.success('Removed from the approval hierarchy.');
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['org-chart'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const active = settings.assignees.filter((a) => a.isActive);

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Who fills each stage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 py-4">
        <p className="text-[13px] text-muted-foreground">
          The <strong>Team Manager</strong> stage is answered by the team roster - appoint managers
          on the Teams screen, not here. A request is never routed by job title, designation or role
          name.
        </p>

        {(['HR_MANAGER', 'CEO'] as const).map((key) => {
          const people = active.filter((a) => a.stage === key);
          return (
            <div key={key}>
              <p className="text-[12.5px] font-medium uppercase tracking-wide text-muted-foreground">
                {APPROVAL_STAGE_LABELS[key]}
              </p>
              {people.length === 0 ? (
                <p className="text-[13px] text-warning">
                  Nobody named - this stage is skipped on every request.
                </p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {people.map((person) => (
                    <li key={person.id} className="flex items-center gap-2 text-[13px]">
                      <span className={person.isEmployed ? '' : 'text-muted-foreground line-through'}>
                        {person.employeeName}
                      </span>
                      {person.designation ? (
                        <span className="text-[12px] text-muted-foreground">
                          {person.designation}
                        </span>
                      ) : null}
                      {!person.isEmployed ? <Badge variant="warning">Has left</Badge> : null}
                      {canManage ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${person.employeeName}`}
                          className="text-destructive hover:bg-destructive-soft"
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Remove ${person.employeeName}?`,
                              description:
                                'Requests already in flight keep them as an approver; new ones will not.',
                              confirmLabel: 'Remove',
                              tone: 'destructive',
                            });
                            if (ok) remove.mutate(person.id);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        {canManage ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <FormField label="Stage" htmlFor="assignee-stage" className="w-40">
              <NativeSelect
                id="assignee-stage"
                value={stage}
                onChange={(event) => setStage(event.target.value as 'HR_MANAGER' | 'CEO')}
              >
                <option value="HR_MANAGER">{APPROVAL_STAGE_LABELS.HR_MANAGER}</option>
                <option value="CEO">{APPROVAL_STAGE_LABELS.CEO}</option>
              </NativeSelect>
            </FormField>
            <FormField label="Employee" htmlFor="assignee-employee" className="min-w-56 flex-1">
              <NativeSelect
                id="assignee-employee"
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
              >
                <option value="">Choose an employee</option>
                {lookups.managers.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <Button disabled={employeeId === ''} loading={add.isPending} onClick={() => add.mutate()}>
              <Plus />
              Name them
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One chain: the rungs a kind of request climbs, in order. */
function WorkflowCard({
  workflow,
  canManage,
}: {
  workflow: ApprovalWorkflowRecord;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = React.useState<Array<{ stage: ApprovalStage; mode: ApprovalStageMode }>>(
    workflow.stages.map((s) => ({ stage: s.stage, mode: s.mode })),
  );
  const [dirty, setDirty] = React.useState(false);

  const save = useMutation({
    mutationFn: (stages: Array<{ stage: ApprovalStage; mode: ApprovalStageMode }>) =>
      api.put('/approvals/hierarchy', { subjectType: workflow.subjectType, stages }),
    onSuccess: async () => {
      toast.success('Approval chain saved.');
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['approval-hierarchy'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const update = (next: Array<{ stage: ApprovalStage; mode: ApprovalStageMode }>) => {
    setDraft(next);
    setDirty(true);
  };

  const unused = APPROVAL_STAGES.filter((stage) => !draft.some((s) => s.stage === stage));

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>{workflow.subjectLabel}</span>
          {workflow.isDefault ? <Badge variant="neutral">Default chain</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 py-4">
        {draft.length === 0 ? (
          <p className="text-[13px] text-warning">
            No stages. Requests of this kind fall back to the reporting manager.
          </p>
        ) : (
          <ol className="space-y-2">
            {draft.map((entry, index) => (
              <li key={entry.stage} className="flex flex-wrap items-center gap-2">
                <span className="tabular grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium">{APPROVAL_STAGE_LABELS[entry.stage]}</p>
                  <p className="text-[12px] text-muted-foreground">
                    {APPROVAL_STAGE_DESCRIPTIONS[entry.stage]}
                  </p>
                </div>
                <NativeSelect
                  aria-label={`${APPROVAL_STAGE_LABELS[entry.stage]} mode`}
                  className="w-44"
                  disabled={!canManage}
                  value={entry.mode}
                  onChange={(event) =>
                    update(
                      draft.map((s, i) =>
                        i === index ? { ...s, mode: event.target.value as ApprovalStageMode } : s,
                      ),
                    )
                  }
                  title={APPROVAL_STAGE_MODE_DESCRIPTIONS[entry.mode]}
                >
                  {APPROVAL_STAGE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {APPROVAL_STAGE_MODE_LABELS[mode]}
                    </option>
                  ))}
                </NativeSelect>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove the ${APPROVAL_STAGE_LABELS[entry.stage]} stage`}
                    className="text-destructive hover:bg-destructive-soft"
                    onClick={() => update(draft.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
                {index < draft.length - 1 ? (
                  <ArrowDown className="size-3.5 w-full text-muted-foreground" aria-hidden />
                ) : null}
              </li>
            ))}
          </ol>
        )}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {unused.length > 0 ? (
              <NativeSelect
                aria-label="Add a stage"
                className="w-52"
                value=""
                onChange={(event) => {
                  const stage = event.target.value as ApprovalStage;
                  if (stage) update([...draft, { stage, mode: 'ANY_ONE' }]);
                }}
              >
                <option value="">Add a stage...</option>
                {unused.map((stage) => (
                  <option key={stage} value={stage}>
                    {APPROVAL_STAGE_LABELS[stage]}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
              Save chain
            </Button>
            {!workflow.isDefault ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Reset to the default chain?',
                    description:
                      'This company stops overriding the built-in chain for this kind of request.',
                    confirmLabel: 'Reset',
                  });
                  if (ok) save.mutate([]);
                }}
              >
                <RotateCcw />
                Reset to default
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
