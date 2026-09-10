import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, ExternalLink, ScrollText } from 'lucide-react';
import {
  POLICY_ACKNOWLEDGEMENT_LABELS,
  PERMISSIONS,
  type PolicyAssignmentRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { usePermissions } from '@/features/auth/session-context';
import { POLICY_STATUS_TONE, isoDay } from './employment-shared';
import { formatDateTime } from '@/lib/utils';

/**
 * The policies one employee holds, and what they said about each.
 *
 * Every version they were ever given is listed, not just the current one:
 * "did they accept the 2025 handbook?" is exactly the question this record
 * exists to answer, and it stops being answerable the moment old rows are
 * hidden. Acknowledging is offered only to the employee themselves, because an
 * acknowledgement made on somebody's behalf records nothing worth having.
 */
export function EmployeePolicies({ employeeId }: { employeeId: string }) {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.POLICY_READ);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['policy-assignments', { employeeId }],
    queryFn: () =>
      api.getPage<PolicyAssignmentRecord>('/policy-assignments', {
        query: { employeeId, limit: 100 },
      }),
    enabled: canRead && employeeId !== '',
  });

  const acknowledge = useMutation({
    mutationFn: (input: { id: string; status: 'ACKNOWLEDGED' | 'DECLINED' }) =>
      api.post(`/policy-assignments/${input.id}/acknowledge`, { status: input.status }),
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: ['policy-assignments'] });
      toast.success(input.status === 'ACKNOWLEDGED' ? 'Policy acknowledged' : 'Response recorded');
    },
    onError: (error: unknown) =>
      toast.error('Could not record that', { description: errorMessage(error) }),
  });

  if (!canRead) return null;

  if (query.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Policies</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    );
  }

  const rows = query.data?.data ?? [];
  const pending = rows.filter((row) => row.status === 'PENDING');

  return (
    <div className="space-y-5">
      {pending.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="size-4" aria-hidden /> Awaiting acknowledgement
              <Badge variant="warning">{pending.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pending.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-3 rounded-lg border border-border p-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium">
                    {row.policyName}{' '}
                    <span className="font-normal text-muted-foreground">v{row.policyVersion}</span>
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    Effective {isoDay(row.effectiveDate)}
                    {row.dueDate ? ` · due ${isoDay(row.dueDate)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {row.documentUrl ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={row.documentUrl} target="_blank" rel="noreferrer noopener">
                        Read
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    </Button>
                  ) : null}
                  {row.canAcknowledge ? (
                    <>
                      <Button
                        size="sm"
                        loading={acknowledge.isPending}
                        onClick={() =>
                          acknowledge.mutate({ id: row.id, status: 'ACKNOWLEDGED' })
                        }
                      >
                        <CheckCircle2 className="size-4" aria-hidden />
                        Acknowledge
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acknowledge.isPending}
                        onClick={() => acknowledge.mutate({ id: row.id, status: 'DECLINED' })}
                      >
                        Decline
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Policy history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="No policies assigned"
              description="Policies assigned to this employee appear here, with what they said about each version."
            />
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Policy</TH>
                    <TH>Version</TH>
                    <TH>Effective</TH>
                    <TH>Assigned</TH>
                    <TH>Status</TH>
                    <TH>Responded</TH>
                    <TH>Document</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="font-medium">{row.policyName}</TD>
                      <TD className="font-mono text-[12.5px]">{row.policyVersion}</TD>
                      <TD className="whitespace-nowrap">{isoDay(row.effectiveDate)}</TD>
                      <TD className="whitespace-nowrap text-muted-foreground">
                        {isoDay(row.assignedAt.slice(0, 10))}
                      </TD>
                      <TD>
                        <Badge variant={POLICY_STATUS_TONE[row.status]}>
                          {POLICY_ACKNOWLEDGEMENT_LABELS[row.status]}
                        </Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-muted-foreground">
                        {row.acknowledgedAt ? formatDateTime(row.acknowledgedAt) : '—'}
                      </TD>
                      <TD>
                        {row.documentUrl ? (
                          <a
                            href={row.documentUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            {row.documentName ?? 'Open'}
                            <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
