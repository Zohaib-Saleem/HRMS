import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Check, HandCoins, X } from 'lucide-react';
import {
  LOAN_INSTALLMENT_DISPLAY_LABELS,
  LOAN_KIND_LABELS,
  LOAN_STATUS_DESCRIPTIONS,
  LOAN_TRANSACTION_LABELS,
  PERMISSIONS,
  type LoanDetail,
  type LoanInstallmentDisplayStatus,
  type LoanInstallmentRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';
import {
  LOAN_STATUS_TONE,
  isoMonth,
  money,
} from '@/features/employment/employment-shared';
import { formatDateTime } from '@/lib/utils';

/**
 * One loan in full: the terms, what is left, and every installment.
 *
 * The repayment table is the payment history and the schedule at once, because
 * they are the same rows read at different times. Splitting them into a
 * "schedule" and a "history" would mean maintaining two views of one truth,
 * and they would eventually disagree.
 */
export function LoanDetailPanel({ loanId }: { loanId: string }) {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const canManage = has(PERMISSIONS.LOAN_MANAGE);

  const query = useQuery({
    queryKey: ['loans', loanId],
    queryFn: () => api.get<LoanDetail>(`/loans/${loanId}`),
    enabled: loanId !== '',
  });

  // "Loan" or "Salary advance", for the toasts and headings. A salary advance
  // is a one-installment loan, so everything else on this panel holds as is.
  const noun = LOAN_KIND_LABELS[query.data?.kind ?? 'LOAN'];
  const isAdvance = query.data?.kind === 'SALARY_ADVANCE';

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['loans'] });
  };

  const approve = useMutation({
    mutationFn: (activate: boolean) => api.post(`/loans/${loanId}/approve`, { activate }),
    onSuccess: async (_data, activate) => {
      await invalidate();
      toast.success(activate ? `${noun} approved and released` : `${noun} approved`, {
        description: activate
          ? isAdvance
            ? 'Payroll will recover it in full from the chosen payslip.'
            : 'Payroll will collect the installment due in each period.'
          : 'Release it when the money is handed over; nothing is deducted until then.',
      });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reject = useMutation({
    mutationFn: (reason: string) => api.post(`/loans/${loanId}/reject`, { reason }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Application declined');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const activate = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/activate`),
    onSuccess: async () => {
      await invalidate();
      toast.success(`${noun} released`, {
        description: isAdvance
          ? 'Payroll recovers it from the chosen payslip.'
          : 'Repayment starts from the first deduction month.',
      });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const cancel = useMutation({
    mutationFn: (reason: string | null) => api.post(`/loans/${loanId}/cancel`, { reason }),
    onSuccess: async () => {
      await invalidate();
      toast.success(`${noun} cancelled`, {
        description: 'Installments already collected are unchanged; nothing further is deducted.',
      });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  // Which installment correction is open, if any.
  const [correcting, setCorrecting] = React.useState<
    | { kind: 'RECORD_PAYMENT' | 'REVERSE_PAYMENT' | 'WAIVE'; installment: LoanInstallmentRecord }
    | { kind: 'RESCHEDULE' }
    | null
  >(null);

  if (query.isLoading) return <Skeleton className="h-64" />;

  const loan = query.data;
  if (!loan) return null;

  const collecting = loan.installments.find((row) => row.status === 'PENDING_PAYROLL') ?? null;
  const hasActions = loan.installments.some((row) => row.actions.length > 0);

  const repaidPercent =
    loan.principalAmount > 0
      ? Math.min(100, Math.round((loan.paidAmount / loan.principalAmount) * 100))
      : 0;

  const handleReject = async () => {
    const reason = window.prompt('Why is the application being declined?');
    if (reason && reason.trim().length >= 3) reject.mutate(reason.trim());
  };

  const handleCancel = async () => {
    const ok = await confirm({
      title: `Cancel this ${noun.toLowerCase()}?`,
      description:
        'Future deductions stop. Installments already collected are kept exactly as they are.',
      confirmLabel: `Cancel ${noun.toLowerCase()}`,
      tone: 'destructive',
    });
    if (ok) cancel.mutate(null);
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <HandCoins className="size-4" aria-hidden />
            {loan.employeeName}
            {isAdvance ? <Badge variant="outline">{noun}</Badge> : null}
            <Badge variant={LOAN_STATUS_TONE[loan.status]}>{loan.statusLabel}</Badge>
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            {loan.canApprove ? (
              <>
                <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate(true)}>
                  <Check className="size-4" aria-hidden />
                  Approve and release
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate(false)}
                >
                  Approve only
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  loading={reject.isPending}
                  onClick={() => void handleReject()}
                >
                  <X className="size-4" aria-hidden />
                  Decline
                </Button>
              </>
            ) : null}
            {canManage && loan.status === 'APPROVED' ? (
              <Button size="sm" loading={activate.isPending} onClick={() => activate.mutate()}>
                Release
              </Button>
            ) : null}
            {loan.canCorrect &&
            ['PENDING', 'APPROVED', 'ACTIVE'].includes(loan.status) &&
            loan.installments.some((row) => row.status === 'SCHEDULED') ? (
              <Button size="sm" variant="outline" onClick={() => setCorrecting({ kind: 'RESCHEDULE' })}>
                Change deduction month
              </Button>
            ) : null}
            {loan.canCancel ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                loading={cancel.isPending}
                onClick={() => void handleCancel()}
              >
                <Ban className="size-4" aria-hidden />
                {loan.status === 'PENDING' ? 'Withdraw' : 'Cancel'}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-[12.5px] text-muted-foreground">
            {LOAN_STATUS_DESCRIPTIONS[loan.status]}
          </p>

          {collecting ? (
            <p className="rounded-md bg-accent/50 px-3 py-2 text-[12.5px]">
              Installment {collecting.sequence} of {loan.installmentCount} (
              {money(collecting.amount, loan.currency)}) is in an unfinalized payroll run for{' '}
              {isoMonth(collecting.dueMonth)}. It counts as repaid once that run is finalized.
            </p>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {isAdvance ? 'Advance amount' : 'Loan amount'}
              </dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.principalAmount, loan.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Repaid</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.paidAmount, loan.currency)}
              </dd>
              <dd className="text-[11px] text-muted-foreground">
                {loan.paidInstallments} of {loan.installmentCount} installments ·{' '}
                {loan.installmentCount - loan.paidInstallments} left
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Remaining</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.remainingAmount, loan.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Monthly deduction
              </dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.monthlyDeduction, loan.currency)}
              </dd>
              <dd className="text-[11px] text-muted-foreground">
                {loan.nextDueMonth ? `Next due ${isoMonth(loan.nextDueMonth)}` : 'Nothing outstanding'}
              </dd>
            </div>
          </dl>

          <div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={repaidPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Repayment progress"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${repaidPercent}%` }} />
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">{repaidPercent}% repaid</p>
          </div>

          <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {isAdvance ? 'Recovered from' : 'First deduction'}
              </dt>
              <dd className="text-sm font-medium">{isoMonth(loan.startMonth)}</dd>
            </div>
            {loan.activatedAt ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Released</dt>
                <dd className="text-sm">{formatDateTime(loan.activatedAt)}</dd>
              </div>
            ) : null}
            {loan.reference ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Reference</dt>
                <dd className="font-mono text-sm">{loan.reference}</dd>
              </div>
            ) : null}
            {loan.purpose ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Purpose</dt>
                <dd className="text-sm">{loan.purpose}</dd>
              </div>
            ) : null}
            {loan.approvedAt ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Approved</dt>
                <dd className="text-sm">{formatDateTime(loan.approvedAt)}</dd>
              </div>
            ) : null}
            {loan.rejectionReason ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Declined</dt>
                <dd className="text-sm">{loan.rejectionReason}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Repayment schedule and history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  <TH>#</TH>
                  <TH>Due</TH>
                  <TH>Amount</TH>
                  <TH>Status</TH>
                  <TH>Settled</TH>
                  <TH>Note</TH>
                  {hasActions ? <TH className="text-right">Actions</TH> : null}
                </TR>
              </THead>
              <TBody>
                {loan.installments.map((row) => (
                  <TR key={row.id}>
                    <TD className="tabular-nums text-muted-foreground">{row.sequence}</TD>
                    <TD className="whitespace-nowrap font-medium">{isoMonth(row.dueMonth)}</TD>
                    <TD className="tabular-nums">{money(row.amount, loan.currency)}</TD>
                    <TD>
                      <Badge variant={DISPLAY_TONE[row.displayStatus]}>
                        {LOAN_INSTALLMENT_DISPLAY_LABELS[row.displayStatus]}
                      </Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {row.paidAt ? (
                        <>
                          {formatDateTime(row.paidAt)}
                          {row.settledBy ? (
                            <span className="block text-[11.5px]">
                              {LOAN_TRANSACTION_LABELS[row.settledBy]}
                            </span>
                          ) : null}
                        </>
                      ) : row.status === 'WAIVED' ? (
                        LOAN_TRANSACTION_LABELS.WAIVER
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD className="max-w-[16rem] truncate text-muted-foreground" title={row.note ?? ''}>
                      {row.note ?? '—'}
                    </TD>
                    {hasActions ? (
                      <TD className="whitespace-nowrap text-right">
                        {row.actions.includes('RECORD_PAYMENT') ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCorrecting({ kind: 'RECORD_PAYMENT', installment: row })}
                          >
                            Record payment
                          </Button>
                        ) : null}
                        {row.actions.includes('REVERSE_PAYMENT') ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCorrecting({ kind: 'REVERSE_PAYMENT', installment: row })}
                          >
                            Correct payment
                          </Button>
                        ) : null}
                        {row.actions.includes('WAIVE') ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground"
                            onClick={() => setCorrecting({ kind: 'WAIVE', installment: row })}
                          >
                            Waive…
                          </Button>
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrapper>
        </CardContent>
      </Card>

      {loan.transactions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ledger</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Entry</TH>
                    <TH>#</TH>
                    <TH>Amount</TH>
                    <TH>Reason / reference</TH>
                    <TH>By</TH>
                  </TR>
                </THead>
                <TBody>
                  {loan.transactions.map((t) => (
                    <TR key={t.id} className={t.reversed ? 'text-muted-foreground line-through' : ''}>
                      <TD className="whitespace-nowrap">{t.effectiveDate}</TD>
                      <TD>{LOAN_TRANSACTION_LABELS[t.type]}</TD>
                      <TD className="tabular-nums">{t.installmentSequence ?? '—'}</TD>
                      <TD className="tabular-nums">
                        {t.type === 'SCHEDULE_CORRECTION' ? '—' : money(t.amount, loan.currency)}
                      </TD>
                      <TD className="max-w-[20rem] text-[12.5px]">
                        {t.reason ?? '—'}
                        {t.reference ? (
                          <span className="block text-muted-foreground">Ref: {t.reference}</span>
                        ) : null}
                      </TD>
                      <TD className="whitespace-nowrap text-[12.5px] text-muted-foreground">
                        {t.createdByName ?? (t.type === 'PAYROLL_DEDUCTION' ? 'Payroll' : '—')}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          </CardContent>
        </Card>
      ) : null}

      <CorrectionDialog
        loan={loan}
        correcting={correcting}
        onClose={() => setCorrecting(null)}
        onDone={invalidate}
      />
    </div>
  );
}

const DISPLAY_TONE: Record<
  LoanInstallmentDisplayStatus,
  'neutral' | 'warning' | 'success' | 'destructive' | 'primary'
> = {
  NOT_STARTED: 'neutral',
  UPCOMING: 'neutral',
  DUE: 'primary',
  OVERDUE: 'destructive',
  IN_PAYROLL: 'primary',
  PAID: 'success',
  WAIVED: 'warning',
  NOT_COLLECTED: 'neutral',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The audited corrections, one dialog.
 *
 * Every one asks for a reason, because every one changes what an employee is
 * recorded as owing, and the ledger keeps it next to the entry.
 */
function CorrectionDialog({
  loan,
  correcting,
  onClose,
  onDone,
}: {
  loan: LoanDetail;
  correcting:
    | { kind: 'RECORD_PAYMENT' | 'REVERSE_PAYMENT' | 'WAIVE'; installment: LoanInstallmentRecord }
    | { kind: 'RESCHEDULE' }
    | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  const [paidOn, setPaidOn] = React.useState(today());
  const [reference, setReference] = React.useState('');
  const [startMonth, setStartMonth] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!correcting) return;
    setReason('');
    setReference('');
    setError(null);
    setPaidOn(today());
    const firstScheduled = loan.installments.find((row) => row.status === 'SCHEDULED');
    setStartMonth((firstScheduled?.dueMonth ?? loan.startMonth).slice(0, 7));
  }, [correcting, loan]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!correcting) return null;
      if (correcting.kind === 'RESCHEDULE') {
        return api.post(`/loans/${loan.id}/reschedule`, { startMonth, reason });
      }
      const base = `/loans/${loan.id}/installments/${correcting.installment.id}`;
      if (correcting.kind === 'RECORD_PAYMENT') {
        return api.post<{ runNeedsRecalculation: string | null }>(`${base}/record-payment`, {
          paidOn,
          reference: reference || null,
          reason,
        });
      }
      if (correcting.kind === 'REVERSE_PAYMENT') {
        return api.post(`${base}/reverse-payment`, { reason });
      }
      return api.post(`${base}/waive`, { reason });
    },
    onSuccess: async (result) => {
      await onDone();
      const needsRecalc =
        result && typeof result === 'object' && 'runNeedsRecalculation' in result
          ? (result as { runNeedsRecalculation: string | null }).runNeedsRecalculation
          : null;
      toast.success(TITLES[correcting!.kind].done, {
        description: needsRecalc
          ? 'It was in a payroll run that is not finalized yet. Recalculate that run before approving it.'
          : undefined,
      });
      onClose();
    },
    onError: (e: unknown) => setError(errorMessage(e)),
  });

  if (!correcting) return null;
  const title = TITLES[correcting.kind];
  const installment = correcting.kind === 'RESCHEDULE' ? null : correcting.installment;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title.title}</DialogTitle>
            <DialogDescription>
              {installment
                ? `Installment ${installment.sequence} - ${isoMonth(installment.dueMonth)}, ${money(installment.amount, loan.currency)}. ${title.explain}`
                : title.explain}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
            {correcting.kind === 'RECORD_PAYMENT' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Paid on" htmlFor="correction-paid-on" required>
                  <Input
                    id="correction-paid-on"
                    type="date"
                    max={today()}
                    value={paidOn}
                    onChange={(e) => setPaidOn(e.target.value)}
                  />
                </FormField>
                <FormField label="Receipt or bank reference" htmlFor="correction-reference">
                  <Input
                    id="correction-reference"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </FormField>
              </div>
            ) : null}
            {correcting.kind === 'RESCHEDULE' ? (
              <FormField
                label={loan.kind === 'SALARY_ADVANCE' ? 'Recover from (payslip month)' : 'First remaining deduction month'}
                htmlFor="correction-month"
                hint="Every installment still scheduled moves, keeping its order. A month whose payroll is finalized is refused."
                required
              >
                <Input
                  id="correction-month"
                  type="month"
                  value={startMonth}
                  onChange={(e) => setStartMonth(e.target.value)}
                />
              </FormField>
            ) : null}
            <FormField label="Reason" htmlFor="correction-reason" hint="Kept on the loan ledger and the audit trail." required>
              <Textarea
                id="correction-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submit.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={correcting.kind === 'WAIVE' ? 'destructive' : 'primary'}
              loading={submit.isPending}
              disabled={reason.trim().length < 3}
            >
              {title.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const TITLES: Record<
  'RECORD_PAYMENT' | 'REVERSE_PAYMENT' | 'WAIVE' | 'RESCHEDULE',
  { title: string; explain: string; action: string; done: string }
> = {
  RECORD_PAYMENT: {
    title: 'Record a payment made outside payroll',
    explain: 'For money already repaid - cash, transfer, or before the loan was entered in HRMS. Payroll will not collect it again.',
    action: 'Record payment',
    done: 'Payment recorded',
  },
  REVERSE_PAYMENT: {
    title: 'Correct a recorded payment',
    explain: 'Takes back a manual payment entered in error. The installment is owed again; both entries stay on the ledger.',
    action: 'Reverse payment',
    done: 'Payment reversed',
  },
  WAIVE: {
    title: 'Waive this installment',
    explain: 'Forgives it: it will not be collected, and it is recorded as waived - not as paid.',
    action: 'Waive installment',
    done: 'Installment waived',
  },
  RESCHEDULE: {
    title: 'Change the deduction month',
    explain: 'Moves every installment still scheduled. The employee is told the new month.',
    action: 'Move schedule',
    done: 'Schedule moved',
  },
};
