import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import {
  MEDICAL_CATEGORIES,
  MEDICAL_CATEGORY_LABELS,
  MEDICAL_CLAIM_DOCUMENT_LABELS,
  MEDICAL_CLAIM_DOCUMENT_TYPES,
  MEDICAL_RELATIONSHIP_LABELS,
  splitContribution,
  type LookupOption,
  type MedicalCategory,
  type MedicalClaimDetail,
  type MedicalClaimDocumentInput,
  type MedicalClaimDocumentType,
  type MedicalDependentRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
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
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { money, todayLocal } from '@/features/employment/employment-shared';
import { MedicalClaimAssessmentPanel } from './medical-claim-assessment-panel';
import { useMedicalClaimAssessment } from './use-medical-claim-assessment';

/**
 * Submitting a medical claim, and deciding one.
 *
 * The submit form shows the server's verdict as it is filled in - what the
 * claim would settle at, what is left of the limit, and every rule it currently
 * fails. That is advisory here and authoritative on the server: `POST
 * /medical/claims` re-runs the same assessment on what actually arrived and
 * refuses on its own result, so a form that was tricked into enabling its
 * button changes nothing.
 *
 * The decision form is separate from the submit form on purpose, and not only
 * because the fields differ. Approving a claim for less than was asked for is
 * the one action in this module somebody is likely to regret, so it shows the
 * claimed amount, the amount being agreed and the split that follows from it,
 * side by side, before anything is sent.
 */

const ERROR_BOX =
  'rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive';

/** Places a server's field errors on the form, and returns whatever was left over. */
function placeFieldErrors(
  error: unknown,
  form: { setError: (name: never, value: { message: string }) => void; getValues: () => object },
): string | null {
  if (error instanceof ApiError && error.isValidation && error.details) {
    const unplaced: string[] = [];
    const values = form.getValues();
    for (const [field, messages] of Object.entries(error.details)) {
      const message = messages[0] ?? 'Invalid value.';
      if (field in values) {
        form.setError(field as never, { message });
      } else {
        unplaced.push(message);
      }
    }
    return unplaced.length > 0 ? unplaced.join(' ') : null;
  }
  return errorMessage(error);
}

// --- submitting --------------------------------------------------------------

interface SubmitFormValues {
  employeeId: string;
  category: MedicalCategory;
  dependentId: string;
  treatmentDate: string;
  providerName: string;
  requestedAmount: string;
  notes: string;
  overrideReason: string;
}

/**
 * Raising a claim.
 *
 * One dialog for both sides of the desk. A claimant gets the plain form; an
 * administrator recording a claim on somebody's behalf gets an employee
 * selector and, where the policy allows it, a reason for letting a refused
 * claim through. The difference is two fields, not two screens - and the
 * endpoint decides what the caller may actually do either way.
 */
export function MedicalClaimSubmitDialog({
  open,
  onClose,
  /** Present when an administrator is recording somebody else's claim. */
  employees,
  currency,
  /** Pre-selects and locks the employee, for a profile screen. */
  fixedEmployeeId,
}: {
  open: boolean;
  onClose: () => void;
  employees?: LookupOption[];
  currency: string;
  fixedEmployeeId?: string;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [documents, setDocuments] = React.useState<MedicalClaimDocumentInput[]>([]);

  const administrative = employees !== undefined || fixedEmployeeId !== undefined;

  const blank = React.useCallback(
    (): SubmitFormValues => ({
      employeeId: fixedEmployeeId ?? '',
      category: 'OPD',
      dependentId: '',
      treatmentDate: todayLocal(),
      providerName: '',
      requestedAmount: '',
      notes: '',
      overrideReason: '',
    }),
    [fixedEmployeeId],
  );

  const form = useForm<SubmitFormValues>({ defaultValues: blank() });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setDocuments([]);
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fixedEmployeeId]);

  const employeeId = form.watch('employeeId');
  const category = form.watch('category');
  const dependentId = form.watch('dependentId');
  const treatmentDate = form.watch('treatmentDate');
  const amountRaw = form.watch('requestedAmount');
  const amount = Number(amountRaw);

  /*
   * Whose dependents to offer. For a claimant this is their own list, which the
   * endpoint resolves from the session; for an administrator it is the selected
   * employee's, and there is nothing to ask for until one is selected.
   */
  const dependentsQuery = useQuery({
    queryKey: ['medical', 'dependents', administrative ? employeeId : 'mine'],
    queryFn: () =>
      api.get<MedicalDependentRecord[]>(
        `/medical/dependents${administrative && employeeId ? `?employeeId=${employeeId}` : ''}`,
      ),
    enabled: open && (!administrative || employeeId !== ''),
    retry: false,
  });

  const assessment = useMedicalClaimAssessment({
    employeeId: administrative && employeeId ? employeeId : undefined,
    category,
    dependentId: dependentId || null,
    treatmentDate: treatmentDate || null,
    requestedAmount: Number.isFinite(amount) && amount > 0 ? amount : undefined,
    enabled: open && (!administrative || employeeId !== ''),
  });

  const verdict = assessment.data;

  const submit = useMutation({
    mutationFn: (values: SubmitFormValues) =>
      api.post('/medical/claims', {
        employeeId: administrative && values.employeeId ? values.employeeId : undefined,
        category: values.category,
        dependentId: values.dependentId || null,
        treatmentDate: values.treatmentDate || null,
        providerName: values.providerName || null,
        requestedAmount: values.requestedAmount,
        notes: values.notes || null,
        documents,
        overrideReason: administrative && values.overrideReason ? values.overrideReason : null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success('Claim submitted', {
        description: verdict?.requiresApproval === false
          ? 'The policy settles it on arrival, so it is already agreed.'
          : 'It is waiting for a decision. Nothing is drawn from your limit until it is agreed.',
      });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form as never)),
  });

  const dependents = (dependentsQuery.data ?? []).filter((d) => d.status === 'ACTIVE');
  const errors = form.formState.errors;

  /* The document types the policy insists on and the claim does not yet carry. */
  const missingDocuments = (verdict?.requiredDocuments ?? []).filter(
    (type) => !documents.some((doc) => doc.type === type && doc.reference.trim() !== ''),
  );

  const addDocument = () =>
    setDocuments((prev) => [
      ...prev,
      { type: missingDocuments[0] ?? 'RECEIPT', reference: '', note: null },
    ]);

  const updateDocument = (index: number, patch: Partial<MedicalClaimDocumentInput>) =>
    setDocuments((prev) => prev.map((doc, i) => (i === index ? { ...doc, ...patch } : doc)));

  const removeDocument = (index: number) =>
    setDocuments((prev) => prev.filter((_, i) => i !== index));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={form.handleSubmit((values) => submit.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{administrative ? 'Record a medical claim' : 'Submit a medical claim'}</DialogTitle>
            <DialogDescription>
              {administrative
                ? 'Recorded against the policy in force today, which is what it stays measured by.'
                : 'Measured against the policy in force today. Nothing is drawn from your limit until the claim is agreed.'}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {formError ? (
              <p role="alert" className={ERROR_BOX}>
                {formError}
              </p>
            ) : null}

            {/* Above the form on purpose: a refusal is worth reading before
                filling anything in, and the balance is worth knowing before
                choosing an amount. */}
            <MedicalClaimAssessmentPanel result={verdict} loading={assessment.isPending} />

            <div className="grid gap-4 sm:grid-cols-2">
              {administrative && !fixedEmployeeId ? (
                <FormField
                  label="Employee"
                  htmlFor="claim-employee"
                  required
                  className="sm:col-span-2"
                  error={errors.employeeId?.message}
                >
                  <NativeSelect
                    id="claim-employee"
                    {...form.register('employeeId', { required: 'Choose an employee.' })}
                  >
                    <option value="">Choose an employee</option>
                    {(employees ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              ) : null}
              {fixedEmployeeId ? <input type="hidden" {...form.register('employeeId')} /> : null}

              <FormField label="What was the treatment?" htmlFor="claim-category" required>
                <NativeSelect id="claim-category" {...form.register('category')}>
                  {MEDICAL_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {MEDICAL_CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Who was treated?"
                htmlFor="claim-dependent"
                hint={
                  dependents.length === 0
                    ? 'No covered dependents are on file, so this claim is for the employee.'
                    : undefined
                }
              >
                <NativeSelect
                  id="claim-dependent"
                  disabled={dependents.length === 0}
                  {...form.register('dependentId')}
                >
                  <option value="">{administrative ? 'The employee' : 'Me'}</option>
                  {dependents.map((dependent) => (
                    <option key={dependent.id} value={dependent.id}>
                      {dependent.name} ({MEDICAL_RELATIONSHIP_LABELS[dependent.relationship]})
                      {dependent.covered ? '' : ' - not covered'}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Amount paid"
                htmlFor="claim-amount"
                required
                hint={`In ${currency}. What was actually paid, before the policy's split.`}
                error={errors.requestedAmount?.message}
              >
                <Input
                  id="claim-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  autoFocus
                  {...form.register('requestedAmount', { required: 'Enter the amount you paid.' })}
                />
              </FormField>

              <FormField
                label="Treatment date"
                htmlFor="claim-date"
                required={verdict?.requireTreatmentDate ?? false}
                error={errors.treatmentDate?.message}
              >
                <Input id="claim-date" type="date" max={todayLocal()} {...form.register('treatmentDate')} />
              </FormField>

              <FormField
                label="Hospital or clinic"
                htmlFor="claim-provider"
                required={verdict?.requireProviderName ?? false}
                className="sm:col-span-2"
                error={errors.providerName?.message}
              >
                <Input id="claim-provider" {...form.register('providerName')} />
              </FormField>

              <FormField
                label="Anything else"
                htmlFor="claim-notes"
                hint="Optional. Nothing here asks you to disclose a condition."
                className="sm:col-span-2"
                error={errors.notes?.message}
              >
                <Textarea id="claim-notes" rows={2} {...form.register('notes')} />
              </FormField>
            </div>

            {/* Documents are recorded as the number printed on the paper: this
                product has no file store, and a reference is what makes the
                policy's requirements enforceable and a payment reconcilable. */}
            <div className="space-y-2 border-t border-border pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[13px] font-medium">Supporting documents</p>
                  <p className="text-[12.5px] text-muted-foreground">
                    {missingDocuments.length > 0
                      ? `The policy requires ${missingDocuments
                          .map((type) => MEDICAL_CLAIM_DOCUMENT_LABELS[type].toLowerCase())
                          .join(', ')}. Record the number printed on each.`
                      : 'Record the number printed on each receipt or prescription. Keep the paper.'}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addDocument}>
                  <Plus className="size-4" aria-hidden />
                  Add
                </Button>
              </div>

              {documents.map((doc, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                  <NativeSelect
                    aria-label={`Document ${index + 1} type`}
                    value={doc.type}
                    onChange={(event) =>
                      updateDocument(index, {
                        type: event.target.value as MedicalClaimDocumentType,
                      })
                    }
                  >
                    {MEDICAL_CLAIM_DOCUMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {MEDICAL_CLAIM_DOCUMENT_LABELS[type]}
                      </option>
                    ))}
                  </NativeSelect>
                  <Input
                    aria-label={`Document ${index + 1} reference`}
                    placeholder="Number printed on the document"
                    value={doc.reference}
                    onChange={(event) => updateDocument(index, { reference: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove document ${index + 1}`}
                    onClick={() => removeDocument(index)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>

            {/* An override is an administrative act and is never offered to a
                claimant for their own claim: waving yourself past a rule is not
                an override, it is the absence of a rule. */}
            {administrative && verdict?.overrideAllowed && !verdict.allowed ? (
              <FormField
                label="Reason for allowing this through"
                htmlFor="claim-override"
                required={verdict.requireOverrideReason}
                hint="Recorded against the claim. The claimant never sees it."
                error={errors.overrideReason?.message}
              >
                <Textarea id="claim-override" rows={2} {...form.register('overrideReason')} />
              </FormField>
            ) : null}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submit.isPending}>
              Cancel
            </Button>
            {/*
              * Disabled while the server says no and there is no override to
              * make, and enabled while the answer is still unknown - a button
              * that stays dead because a preview request failed is worse than
              * one that submits and is refused by the endpoint, which is the
              * real gate either way.
              */}
            <Button
              type="submit"
              loading={submit.isPending}
              disabled={
                verdict
                  ? !verdict.allowed &&
                    !(administrative && verdict.overrideAllowed && form.watch('overrideReason').trim() !== '')
                  : false
              }
            >
              {administrative ? 'Record claim' : 'Submit claim'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- deciding ----------------------------------------------------------------

/**
 * Approving a claim, in full or in part.
 *
 * The amount defaults to what was claimed, so the ordinary case is one click.
 * Typing a lower figure turns it into a partial approval, and the split
 * underneath moves with it - computed with the same `splitContribution` the
 * server settles the stored figures with, so the number shown here is the
 * number that will be recorded.
 */
export function MedicalClaimDecisionDialog({
  claim,
  open,
  onClose,
  companyContributionPercent,
}: {
  claim: MedicalClaimDetail;
  open: boolean;
  onClose: () => void;
  /** From the claim's own policy version, not the live one. */
  companyContributionPercent: number;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState(String(claim.requestedAmount));
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setAmount(String(claim.requestedAmount));
      setNote('');
      setFormError(null);
    }
  }, [open, claim.requestedAmount]);

  const approve = useMutation({
    mutationFn: () =>
      api.post(`/medical/claims/${claim.id}/approve`, {
        approvedAmount: amount === '' ? undefined : amount,
        note: note || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success(partial ? 'Claim partly approved' : 'Claim approved', {
        description: 'The claimant has been told. Mark it paid once the money goes out.',
      });
      onClose();
    },
    onError: (error: unknown) => setFormError(errorMessage(error)),
  });

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed >= 0;
  const partial = valid && parsed < claim.requestedAmount;
  const split = valid ? splitContribution(parsed, companyContributionPercent) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve claim {claim.claimNumber}</DialogTitle>
          <DialogDescription>
            Measured by the policy version the claim was submitted under, not by today's.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {formError ? (
            <p role="alert" className={ERROR_BOX}>
              {formError}
            </p>
          ) : null}

          <dl className="space-y-1 rounded-lg border border-border bg-surface-muted/40 p-3 text-[13px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Claimed</dt>
              <dd className="font-medium tabular-nums">
                {money(claim.requestedAmount, claim.currency)}
              </dd>
            </div>
            {split ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">
                    Company pays ({companyContributionPercent}%)
                  </dt>
                  <dd className="font-semibold tabular-nums">
                    {money(split.companyAmount, claim.currency)}
                  </dd>
                </div>
                {split.employeeAmount > 0 ? (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">The employee's share</dt>
                    <dd className="tabular-nums">{money(split.employeeAmount, claim.currency)}</dd>
                  </div>
                ) : null}
              </>
            ) : null}
          </dl>

          <FormField
            label="Amount to approve"
            htmlFor="decision-amount"
            required
            hint={
              partial
                ? 'Lower than was claimed, so this is recorded as a partial approval.'
                : 'Leave as it is to approve the claim in full.'
            }
          >
            <Input
              id="decision-amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              max={claim.requestedAmount}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </FormField>

          <FormField
            label="Note for the claimant"
            htmlFor="decision-note"
            hint={partial ? 'Say why it was reduced. They will read this.' : 'Optional.'}
          >
            <Textarea
              id="decision-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={approve.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={approve.isPending}
            disabled={!valid}
            onClick={() => approve.mutate()}
          >
            {partial ? 'Approve in part' : 'Approve in full'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Declining a claim. The reason is mandatory and the claimant reads it. */
export function MedicalClaimRejectDialog({
  claim,
  open,
  onClose,
}: {
  claim: MedicalClaimDetail;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setFormError(null);
    }
  }, [open]);

  const reject = useMutation({
    mutationFn: () => api.post(`/medical/claims/${claim.id}/reject`, { reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success('Claim declined', { description: 'Nothing is paid and nothing is drawn from the limit.' });
      onClose();
    },
    onError: (error: unknown) => setFormError(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decline claim {claim.claimNumber}</DialogTitle>
          <DialogDescription>
            The reason is shown to the claimant, so write it for them.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {formError ? (
            <p role="alert" className={ERROR_BOX}>
              {formError}
            </p>
          ) : null}

          <FormField label="Why is it being declined?" htmlFor="reject-reason" required>
            <Textarea
              id="reject-reason"
              rows={3}
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={reject.isPending}
            disabled={reason.trim().length < 3}
            onClick={() => reject.mutate()}
          >
            Decline claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Recording that the money went out.
 *
 * A separate act from approving, and deliberately a separate permission:
 * agreeing that money is owed and recording that it was paid are two different
 * decisions, the same way a loan is approved by one person and released by
 * another.
 */
export function MedicalClaimPayDialog({
  claim,
  open,
  onClose,
}: {
  claim: MedicalClaimDetail;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reference, setReference] = React.useState('');
  const [paidAt, setPaidAt] = React.useState(todayLocal());
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setReference('');
      setPaidAt(todayLocal());
      setFormError(null);
    }
  }, [open]);

  const pay = useMutation({
    mutationFn: () =>
      api.post(`/medical/claims/${claim.id}/pay`, {
        paymentReference: reference || null,
        paidAt: paidAt || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success('Recorded as paid', {
        description: 'A medical reimbursement is not salary, so payroll is untouched.',
      });
      onClose();
    },
    onError: (error: unknown) => setFormError(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark claim {claim.claimNumber} paid</DialogTitle>
          <DialogDescription>
            {claim.companyAmount === null
              ? 'Records that the agreed amount has been paid out.'
              : `Records that ${money(claim.companyAmount, claim.currency)} has been paid out.`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {formError ? (
            <p role="alert" className={ERROR_BOX}>
              {formError}
            </p>
          ) : null}

          <FormField
            label="Payment reference"
            htmlFor="pay-reference"
            hint="The transfer or cheque number, so this can be reconciled later."
          >
            <Input
              id="pay-reference"
              autoFocus
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </FormField>

          <FormField label="Paid on" htmlFor="pay-date">
            <Input
              id="pay-date"
              type="date"
              max={todayLocal()}
              value={paidAt}
              onChange={(event) => setPaidAt(event.target.value)}
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pay.isPending}>
            Cancel
          </Button>
          <Button type="button" loading={pay.isPending} onClick={() => pay.mutate()}>
            Mark paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
