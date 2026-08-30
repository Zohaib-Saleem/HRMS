import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import type { PayslipRecord } from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { money } from './payroll-shared';

/**
 * Payslips.
 *
 * The same screen for everybody: what differs is what comes back. A member of
 * staff holds `payslip.read` with an OWN data scope and sees their own; an
 * administrator with a company-wide scope sees everyone's. The narrowing
 * happens on the server, so this page does not need to know which it is talking
 * to - and could not widen it if it tried.
 */

export function PayslipsPage() {
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');

  const query = useQuery({
    queryKey: ['payslips', page],
    queryFn: () => api.getPage<PayslipRecord>('/payslips', { query: { page, limit: 25 } }),
    placeholderData: keepPreviousData,
  });

  const term = search.trim().toLowerCase();
  const rows = (query.data?.data ?? []).filter(
    (slip) =>
      term === '' ||
      slip.employeeName.toLowerCase().includes(term) ||
      slip.number.toLowerCase().includes(term) ||
      slip.periodName.toLowerCase().includes(term),
  );

  return (
    <>
      <PageHeader
        title="Payslips"
        description="Issued when a payroll run is finalized. Open one to print it or save it as a PDF."
      />

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by employee, period or payslip number"
            className="w-full sm:w-80"
            aria-label="Search payslips"
          />
        </div>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="w-36">Payslip</TH>
                    <TH>Employee</TH>
                    <TH className="w-44">Pay period</TH>
                    <TH className="w-32 text-right">Gross</TH>
                    <TH className="w-32 text-right">Deductions</TH>
                    <TH className="w-32 text-right">Net</TH>
                    <TH className="w-28 text-right">Issued</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={7} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={7} className="p-0">
                        <EmptyState
                          icon={Receipt}
                          title={term ? 'Nothing matches that search' : 'No payslips yet'}
                          description={
                            term
                              ? 'Try a different employee, period or number.'
                              : 'A payslip appears here once a payroll run has been finalized.'
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((slip) => (
                      <TR key={slip.id}>
                        <TD className="tabular text-[13px]">
                          <Link className="font-medium hover:underline" to={`/payslips/${slip.id}`}>
                            {slip.number}
                          </Link>
                        </TD>
                        <TD className="text-[13px]">
                          {slip.employeeName}
                          <span className="tabular block text-[12px] text-muted-foreground">
                            {slip.employeeNumber}
                          </span>
                        </TD>
                        <TD className="text-[13px]">
                          {slip.periodName}
                          <span className="tabular block text-[12px] text-muted-foreground">
                            {formatDate(slip.periodStart)} – {formatDate(slip.periodEnd)}
                          </span>
                        </TD>
                        <TD className="tabular text-right text-[13px]">
                          {money(slip.line.grossAmount, slip.currency)}
                        </TD>
                        <TD className="tabular text-right text-[13px]">
                          {money(slip.line.deductionsTotal, slip.currency)}
                        </TD>
                        <TD className="tabular text-right text-[13px] font-semibold">
                          {money(slip.line.netAmount, slip.currency)}
                        </TD>
                        <TD className="tabular text-right text-[12.5px] text-muted-foreground">
                          {formatDate(slip.issuedAt)}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {query.data ? (
              <Pagination
                meta={query.data.meta}
                disabled={query.isFetching}
                onPageChange={setPage}
              />
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
