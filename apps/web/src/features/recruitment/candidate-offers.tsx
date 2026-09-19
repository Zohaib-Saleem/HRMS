import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileSignature, Plus, Send } from 'lucide-react';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_DESCRIPTIONS,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  OFFER_STATUS_DESCRIPTIONS,
  OFFER_STATUS_LABELS,
  OFFER_STATUS_TRANSITIONS,
  type CandidateApplicationRecord,
  type EmploymentStatus,
  type EmploymentType,
  type OfferRecord,
  type OfferStatus,
  type Paginated,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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
import { ListSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { FormError, placeFieldErrors } from './form-errors';
import { OFFER_STATUS_TONE, money } from './recruitment-shared';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * Offers, deliberately kept small.
 *
 * An offer here is a RECORD OF WHAT WAS PROMISED and nothing more: a
 * designation, a number, a type, a start date and a status. It is not a
 * contract, it is not a salary structure, and accepting one writes no salary
 * row, no payroll profile and no employee. Everything downstream of "they said
 * yes" is the conversion action, which a person performs and reviews.
 *
 * The employment status defaults to PROBATION because that is what a new hire
 * starts on unless somebody says otherwise - and it is a DEFAULT, not a rule:
 * the field is on the form and HR picks Permanent or Internee when that is the
 * deal. The same three canonical values the employee record uses, so nothing
 * is translated on the way across.
 *
 * An answered offer is finished. Nothing moves out of ACCEPTED, DECLINED or
 * EXPIRED, because changing the terms after somebody has answered is a NEW
 * offer - which keeps the first one, and what it promised, on the record.
 */
export function CandidateOffers({
  candidateId,
  candidateName,
  applications,
}: {
  candidateId: string;
  candidateName: string;
  applications: CandidateApplicationRecord[];
}) {
  const { canManageOffers } = useRecruitmentAccess();
  const [creating, setCreating] = React.useState(false);
  const [answering, setAnswering] = React.useState<OfferRecord | null>(null);

  const query = useQuery({
    queryKey: ['recruitment', 'offers', { candidateId }],
    queryFn: () =>
      api.getPage<OfferRecord>('/recruitment/offers', { query: { candidateId, limit: 50 } }),
  });

  const offers = (query.data as Paginated<OfferRecord> | undefined)?.data ?? [];

  return (
    <>
      <Card>
        <CardHeader bordered className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Offers</CardTitle>
            <CardDescription>
              What was proposed, and what they said. No salary or payroll record is created here.
            </CardDescription>
          </div>
          {canManageOffers ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New offer
            </Button>
          ) : null}
        </CardHeader>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <ListSkeleton rows={2} />
        ) : offers.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title="No offers"
            description={
              canManageOffers
                ? 'Draft one when this candidate is selected. Nothing is promised until it is sent.'
                : 'No offer has been made to this candidate.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {offers.map((offer) => (
              <li key={offer.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium">
                      {offer.proposedTitle ?? offer.designation?.name ?? offer.jobTitle ?? 'Offer'}
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      {EMPLOYMENT_TYPE_LABELS[offer.employmentType as EmploymentType] ??
                        offer.employmentType}
                      {offer.employmentStatus
                        ? ` · ${EMPLOYMENT_STATUS_LABELS[offer.employmentStatus as EmploymentStatus]}`
                        : ''}
                    </p>
                  </div>
                  <Badge variant={OFFER_STATUS_TONE[offer.status]}>
                    {OFFER_STATUS_LABELS[offer.status]}
                  </Badge>
                </div>

                <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-3">
                  <Pair
                    label="Proposed salary"
                    value={money(offer.proposedSalary, offer.salaryCurrency)}
                  />
                  <Pair
                    label="Expected joining"
                    value={
                      offer.expectedJoiningDate ? formatDate(offer.expectedJoiningDate) : 'Not set'
                    }
                  />
                  <Pair
                    label={offer.respondedAt ? 'Answered' : offer.sentAt ? 'Sent' : 'Drafted'}
                    value={formatDate(offer.respondedAt ?? offer.sentAt ?? offer.createdAt)}
                  />
                </dl>

                {offer.notes ? (
                  <p className="mt-2 whitespace-pre-wrap text-[13px] text-muted-foreground">
                    {offer.notes}
                  </p>
                ) : null}

                {canManageOffers && OFFER_STATUS_TRANSITIONS[offer.status].length > 0 ? (
                  <div className="mt-3">
                    <Button variant="outline" size="sm" onClick={() => setAnswering(offer)}>
                      <Send />
                      {offer.status === 'DRAFT' ? 'Send offer' : 'Record the answer'}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManageOffers ? (
        <>
          <OfferFormDialog
            open={creating}
            candidateId={candidateId}
            candidateName={candidateName}
            applications={applications}
            onClose={() => setCreating(false)}
          />
          <OfferStatusDialog
            open={answering !== null}
            offer={answering}
            onClose={() => setAnswering(null)}
          />
        </>
      ) : null}
    </>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11.5px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular text-[13px]">{value}</dd>
    </div>
  );
}

interface OfferFormValues {
  applicationId: string;
  jobOpeningId: string;
  designationId: string;
  proposedTitle: string;
  employmentType: string;
  employmentStatus: string;
  proposedSalary: string;
  salaryCurrency: string;
  expectedJoiningDate: string;
  expiresAt: string;
  notes: string;
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function OfferFormDialog({
  open,
  candidateId,
  candidateName,
  applications,
  onClose,
}: {
  open: boolean;
  candidateId: string;
  candidateName: string;
  applications: CandidateApplicationRecord[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { lookups } = useLookups();
  const { currency } = useRecruitmentAccess();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<OfferFormValues>({
    defaultValues: {
      applicationId: '',
      jobOpeningId: '',
      designationId: '',
      proposedTitle: '',
      employmentType: 'FULL_TIME',
      employmentStatus: 'PROBATION',
      proposedSalary: '',
      salaryCurrency: currency,
      expectedJoiningDate: '',
      expiresAt: '',
      notes: '',
    },
  });

  React.useEffect(() => {
    if (!open) return;
    const first = applications[0];
    form.reset({
      applicationId: first?.id ?? '',
      jobOpeningId: first?.jobOpeningId ?? '',
      designationId: '',
      proposedTitle: first?.jobTitle ?? '',
      employmentType: 'FULL_TIME',
      employmentStatus: 'PROBATION',
      proposedSalary: '',
      salaryCurrency: currency,
      expectedJoiningDate: '',
      expiresAt: '',
      notes: '',
    });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidateId]);

  const employmentStatus = form.watch('employmentStatus') as EmploymentStatus;

  const mutation = useMutation({
    mutationFn: (values: OfferFormValues) =>
      api.post<OfferRecord>('/recruitment/offers', {
        candidateId,
        jobOpeningId: textOrNull(values.jobOpeningId),
        applicationId: textOrNull(values.applicationId),
        designationId: textOrNull(values.designationId),
        proposedTitle: textOrNull(values.proposedTitle),
        employmentType: values.employmentType,
        employmentStatus: values.employmentStatus,
        proposedSalary:
          values.proposedSalary.trim() === '' ? null : Number(values.proposedSalary),
        salaryCurrency: textOrNull(values.salaryCurrency),
        expectedJoiningDate: textOrNull(values.expectedJoiningDate),
        expiresAt: textOrNull(values.expiresAt),
        notes: textOrNull(values.notes),
      }),
    onSuccess: async () => {
      toast.success('Offer drafted. Nothing has been sent yet.');
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>Offer to {candidateName}</DialogTitle>
          <DialogDescription>
            Drafted, not sent. Sending it is the next step and is recorded separately.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="offer-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              setFormError(null);
              mutation.mutate(values);
            })}
          >
            <FormError message={formError} />

            <FormField label="For which application" htmlFor="offer-application">
              <NativeSelect
                value={form.watch('applicationId')}
                onChange={(event) => {
                  const application = applications.find((entry) => entry.id === event.target.value);
                  form.setValue('applicationId', application?.id ?? '');
                  form.setValue('jobOpeningId', application?.jobOpeningId ?? '');
                }}
              >
                <option value="">No specific opening</option>
                {applications.map((application) => (
                  <option key={application.id} value={application.id}>
                    {application.jobTitle} ({application.jobReference})
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Proposed designation" htmlFor="offer-designation">
                <NativeSelect {...form.register('designationId')}>
                  <option value="">Not stated</option>
                  {lookups.designations.map((designation) => (
                    <option key={designation.id} value={designation.id}>
                      {designation.label}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Job title on the offer"
                htmlFor="offer-title"
                hint="What the letter will say."
              >
                <Input {...form.register('proposedTitle')} />
              </FormField>

              <FormField label="Employment type" htmlFor="offer-type">
                <NativeSelect {...form.register('employmentType')}>
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {EMPLOYMENT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Employment status"
                htmlFor="offer-status"
                hint={EMPLOYMENT_STATUS_DESCRIPTIONS[employmentStatus]}
              >
                <NativeSelect {...form.register('employmentStatus')}>
                  {EMPLOYMENT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {EMPLOYMENT_STATUS_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Proposed salary"
                htmlFor="offer-salary"
                error={form.formState.errors.proposedSalary?.message}
              >
                <Input type="number" min={0} {...form.register('proposedSalary')} />
              </FormField>

              <FormField label="Currency" htmlFor="offer-currency">
                <Input maxLength={8} {...form.register('salaryCurrency')} />
              </FormField>

              <FormField label="Expected joining date" htmlFor="offer-joining">
                <Input type="date" {...form.register('expectedJoiningDate')} />
              </FormField>

              <FormField
                label="Offer expires"
                htmlFor="offer-expires"
                hint="Optional. Recorded, never enforced automatically."
              >
                <Input type="date" {...form.register('expiresAt')} />
              </FormField>
            </div>

            <FormField label="Notes" htmlFor="offer-notes">
              <Textarea rows={4} {...form.register('notes')} />
            </FormField>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="offer-form" loading={mutation.isPending}>
            Draft offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OfferStatusDialog({
  open,
  offer,
  onClose,
}: {
  open: boolean;
  offer: OfferRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm<{ status: OfferStatus; reason: string }>({
    defaultValues: { status: 'SENT', reason: '' },
  });

  const options = offer ? OFFER_STATUS_TRANSITIONS[offer.status] : [];

  React.useEffect(() => {
    if (!open || !offer) return;
    form.reset({ status: options[0] ?? 'SENT', reason: '' });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offer?.id]);

  const status = form.watch('status');

  const mutation = useMutation({
    mutationFn: (values: { status: OfferStatus; reason: string }) =>
      api.post<OfferRecord>(`/recruitment/offers/${offer?.id}/status`, {
        status: values.status,
        reason: values.reason.trim() || null,
      }),
    onSuccess: async (saved) => {
      toast.success(`Offer marked ${OFFER_STATUS_LABELS[saved.status].toLowerCase()}.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  if (!offer) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Update offer</DialogTitle>
          <DialogDescription>
            {offer.candidateName} - currently {OFFER_STATUS_LABELS[offer.status].toLowerCase()}.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="offer-status-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              setFormError(null);
              mutation.mutate(values);
            })}
          >
            <FormError message={formError} />

            <FormField label="Mark as" htmlFor="ofs-status" hint={OFFER_STATUS_DESCRIPTIONS[status]}>
              <NativeSelect {...form.register('status')}>
                {options.map((value) => (
                  <option key={value} value={value}>
                    {OFFER_STATUS_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Note" htmlFor="ofs-reason" hint="Optional. Kept with the offer.">
              <Textarea rows={3} {...form.register('reason')} />
            </FormField>

            {status === 'ACCEPTED' ? (
              <p className="rounded-md border border-border bg-surface-muted px-3 py-2.5 text-[13px] text-muted-foreground">
                Accepting an offer records their answer. It creates no employee record and no
                salary - converting them is a separate action on their profile.
              </p>
            ) : null}
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="offer-status-form" loading={mutation.isPending}>
            Update offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
