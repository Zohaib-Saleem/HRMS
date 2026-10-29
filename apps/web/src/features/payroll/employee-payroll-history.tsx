import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { PERMISSIONS, type PayrollLineRecord, type PayslipRecord } from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { usePermissions } from '@/features/auth/session-context';
import { PayrollLineDrawer } from './payroll-line-drawer';
import { money } from './payroll-shared';

/**
 * What this employee has actually been paid, month by month.
 *
 * Every figure is read off the payslips the payroll runs produced - nothing on
 * this screen re-prices anything. Overtime in particular is the amount the run
 * calculated from the company's own configured overtime rate; this table has no
 * rate of its own and no opinion about how overtime is valued.
 *
 * The deduction columns GROUP the payslip's own deduction lines so a month fits
 * on a row - see `bucket` below for exactly which line kinds land in which
 * column. The grouping is presentation only: "Open" beside each row shows the
 * run's full reconciliation, line by line, which is the authoritative view.
 */
export function EmployeePayrollHistory({ employeeId }: { employeeId: string }) {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.PAYSLIP_READ);
  // The reconciliation drawer is a payroll-administration view, so the drill-in
  // is offered only to callers who could open it anyway.
  const canDrillIn = has(PERMISSIONS.PAYROLL_READ);
  const [openLineId, setOpenLineId] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ['payslips', { employeeId }],
    queryFn: () =>
      api.getPage<PayslipRecord>('/payslips', { query: { employeeId, limit: 60 } }),
    enabled: canRead && employeeId !== '',
  });

  if (!canRead) return null;

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  if (query.isLoading) {
    return (
      <Card>
        <CardHeader bordered>
          <CardTitle className="text-base">Payroll history</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    );
  }

  const rows = query.data?.data ?? [];
  const currency = rows[0]?.currency ?? 'USD';

  return (
    <>
      <Card>
        <CardHeader bordered>
          <CardTitle className="text-base">Payroll history</CardTitle>
        </CardHeader>

        {rows.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No payslips yet"
            description="Months appear here once a payroll run covering this employee is finalized."
          />
        ) : (
          <CardContent className="p-0">
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Period</TH>
                    <TH className="text-right">Gross</TH>
                    <TH className="text-right">Overtime</TH>
                    <TH className="text-right">Leave</TH>
                    <TH className="text-right">Working hours</TH>
                    <TH className="text-right">Loan</TH>
                    <TH className="text-right">Advance repayment</TH>
                    <TH className="text-right">Other</TH>
                    <TH className="text-right">Net</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => {
                    const cut = bucket(row.line);
                    return (
                      <TR key={row.id}>
                        <TD className="whitespace-nowrap font-medium">
                          {row.periodName}
                          {row.publishedAt === null ? (
                            <Badge variant="warning" className="ml-2">
                              Unpublished
                            </Badge>
                          ) : null}
                        </TD>
                        <TD className="tabular text-right">
                          {money(row.line.grossAmount, row.currency)}
                        </TD>
                        <TD className="tabular text-right">
                          {row.line.overtimeAmount === 0
                            ? '—'
                            : money(row.line.overtimeAmount, row.currency)}
                        </TD>
                        <TD className="tabular text-right text-muted-foreground">
                          {cut.leave === 0 ? '—' : `-${money(cut.leave, row.currency)}`}
                        </TD>
                        <TD className="tabular text-right text-muted-foreground">
                          {cut.hours === 0 ? '—' : `-${money(cut.hours, row.currency)}`}
                        </TD>
                        <TD className="tabular text-right text-muted-foreground">
                          {cut.loan === 0 ? '—' : `-${money(cut.loan, row.currency)}`}
                        </TD>
                        <TD className="tabular text-right text-muted-foreground">
                          {cut.advance === 0 ? '—' : `-${money(cut.advance, row.currency)}`}
                        </TD>
                        <TD className="tabular text-right text-muted-foreground">
                          {cut.other === 0 ? '—' : `-${money(cut.other, row.currency)}`}
                        </TD>
                        <TD className="tabular text-right font-medium">
                          {money(row.line.netAmount, row.currency)}
                        </TD>
                        <TD className="text-right">
                          {canDrillIn ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setOpenLineId(row.line.id)}
                            >
                              Open
                            </Button>
                          ) : null}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrapper>
            <p className="border-t border-border px-5 py-3 text-[12px] text-muted-foreground">
              Deductions are grouped for the table. Leave covers absence and leave
              days, working hours covers late, early leaving and short hours. Open a
              row for the run's own line-by-line calculation, in {currency}.
            </p>
          </CardContent>
        )}
      </Card>

      {openLineId ? (
        <PayrollLineDrawer lineId={openLineId} onClose={() => setOpenLineId(null)} />
      ) : null}
    </>
  );
}

/**
 * Groups a payslip's deduction lines into the table's four columns.
 *
 * The kinds are the payroll engine's own, set when the run priced the line:
 * ABSENCE, UNPAID_LEAVE and PAID_LEAVE are days not worked; LATE, EARLY_LEAVE
 * and SHORT_HOURS are hours not worked; LOAN is a repayment instalment;
 * everything else is a configured component or an adjustment. An unrecognised
 * kind falls into "other" rather than being dropped, so the columns always add
 * up to what was actually deducted.
 */
function bucket(line: PayrollLineRecord): {
  leave: number;
  hours: number;
  loan: number;
  advance: number;
  other: number;
} {
  const out = { leave: 0, hours: 0, loan: 0, advance: 0, other: 0 };
  for (const d of line.deductions) {
    if (d.kind === 'ABSENCE' || d.kind === 'UNPAID_LEAVE' || d.kind === 'PAID_LEAVE') {
      out.leave += d.amount;
    } else if (d.kind === 'LATE' || d.kind === 'EARLY_LEAVE' || d.kind === 'SHORT_HOURS') {
      out.hours += d.amount;
    } else if (d.kind === 'LOAN') {
      out.loan += d.amount;
    } else if (d.kind === 'ADVANCE') {
      out.advance += d.amount;
    } else {
      out.other += d.amount;
    }
  }
  return out;
}
