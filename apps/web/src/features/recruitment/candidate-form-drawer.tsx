import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CandidateRecord } from '@hrms/shared';
import { api } from '@/lib/api';
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
import { FormError, placeFieldErrors } from './form-errors';
import { useInterviewers, useJobOpeningOptions, useRecruitmentAccess } from './use-recruitment-data';

/**
 * Adding or editing a candidate.
 *
 * The email address is the only required contact detail, and it is required
 * for one reason: it is what identifies a person across applications. The
 * database holds a unique index on (company, email), so the same person
 * applying for three roles is one record with three applications rather than
 * three people - and when that index refuses, the server answers with a field
 * error naming the existing candidate rather than a 500. This form shows that
 * message on the email field.
 *
 * `jobOpeningId` appears on CREATE only. Adding somebody for a specific
 * vacancy should not mean saving a person and then going to a second screen to
 * attach them, but a later edit must not silently move an application between
 * openings - applications have their own stage and their own history, so
 * attaching one is its own action.
 *
 * The salary fields are part of the RESTRICTED block: the server strips them
 * from every response to a reader without `candidate.manage`, and this form is
 * only ever opened by somebody who holds it.
 */

interface FormValues {
  fullName: string;
  email: string;
  phone: string;
  currentLocation: string;
  linkedinUrl: string;
  portfolioUrl: string;
  skills: string;
  experienceYears: string;
  currentCompany: string;
  currentTitle: string;
  currentSalary: string;
  expectedSalary: string;
  salaryCurrency: string;
  noticePeriodDays: string;
  source: string;
  recruiterId: string;
  notes: string;
  jobOpeningId: string;
}

const BLANK: FormValues = {
  fullName: '',
  email: '',
  phone: '',
  currentLocation: '',
  linkedinUrl: '',
  portfolioUrl: '',
  skills: '',
  experienceYears: '',
  currentCompany: '',
  currentTitle: '',
  currentSalary: '',
  expectedSalary: '',
  salaryCurrency: '',
  noticePeriodDays: '',
  source: '',
  recruiterId: '',
  notes: '',
  jobOpeningId: '',
};

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toForm(candidate: CandidateRecord, fallbackCurrency: string): FormValues {
  return {
    fullName: candidate.fullName,
    email: candidate.email,
    phone: candidate.phone ?? '',
    currentLocation: candidate.currentLocation ?? '',
    linkedinUrl: candidate.linkedinUrl ?? '',
    portfolioUrl: candidate.portfolioUrl ?? '',
    skills: candidate.skills ?? '',
    experienceYears: candidate.experienceYears === null ? '' : String(candidate.experienceYears),
    currentCompany: candidate.currentCompany ?? '',
    currentTitle: candidate.currentTitle ?? '',
    // The restricted block is absent - not nulled - for a reader who may not
    // see it. This form needs `candidate.manage` to open, so it is present,
    // but the optional chain is what keeps that a fact rather than an
    // assumption.
    currentSalary:
      candidate.restricted?.currentSalary === null ||
      candidate.restricted?.currentSalary === undefined
        ? ''
        : String(candidate.restricted.currentSalary),
    expectedSalary:
      candidate.restricted?.expectedSalary === null ||
      candidate.restricted?.expectedSalary === undefined
        ? ''
        : String(candidate.restricted.expectedSalary),
    salaryCurrency: candidate.restricted?.salaryCurrency ?? fallbackCurrency,
    noticePeriodDays:
      candidate.noticePeriodDays === null ? '' : String(candidate.noticePeriodDays),
    source: candidate.source ?? '',
    recruiterId: candidate.recruiter?.id ?? '',
    notes: candidate.restricted?.notes ?? '',
    jobOpeningId: '',
  };
}

export function CandidateFormDrawer({
  open,
  candidate,
  defaultJobOpeningId,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null to add somebody new. */
  candidate: CandidateRecord | null;
  /** Preselects the vacancy when adding from an opening. */
  defaultJobOpeningId?: string;
  onClose: () => void;
  onSaved?: (saved: CandidateRecord) => void;
}) {
  const queryClient = useQueryClient();
  const { currency } = useRecruitmentAccess();
  const { interviewers } = useInterviewers(open);
  const { openings } = useJobOpeningOptions(open && !candidate);
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<FormValues>({ defaultValues: BLANK });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      candidate
        ? toForm(candidate, currency)
        : {
            ...BLANK,
            salaryCurrency: currency,
            jobOpeningId: defaultJobOpeningId ?? '',
          },
    );
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidate?.id]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const body = {
        fullName: values.fullName,
        email: values.email,
        phone: textOrNull(values.phone),
        currentLocation: textOrNull(values.currentLocation),
        linkedinUrl: textOrNull(values.linkedinUrl),
        portfolioUrl: textOrNull(values.portfolioUrl),
        skills: textOrNull(values.skills),
        experienceYears: numberOrNull(values.experienceYears),
        currentCompany: textOrNull(values.currentCompany),
        currentTitle: textOrNull(values.currentTitle),
        currentSalary: numberOrNull(values.currentSalary),
        expectedSalary: numberOrNull(values.expectedSalary),
        salaryCurrency: textOrNull(values.salaryCurrency),
        noticePeriodDays: numberOrNull(values.noticePeriodDays),
        source: textOrNull(values.source),
        recruiterId: textOrNull(values.recruiterId),
        notes: textOrNull(values.notes),
      };

      return candidate
        ? api.patch<CandidateRecord>(`/recruitment/candidates/${candidate.id}`, body)
        : api.post<CandidateRecord>('/recruitment/candidates', {
            ...body,
            jobOpeningId: textOrNull(values.jobOpeningId),
          });
    },
    onSuccess: async (saved) => {
      toast.success(candidate ? 'Candidate updated.' : `${saved.fullName} added.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onSaved?.(saved);
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>{candidate ? `Edit ${candidate.fullName}` : 'Add candidate'}</DialogTitle>
          <DialogDescription>
            {candidate
              ? 'A candidate is not an employee. Nothing here reaches the staff roster.'
              : 'One record per person. Applying for a second role adds an application, not a second candidate.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="candidate-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              setFormError(null);
              mutation.mutate(values);
            })}
          >
            <FormError message={formError} />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Full name"
                htmlFor="cand-name"
                required
                error={form.formState.errors.fullName?.message}
                className="sm:col-span-2"
              >
                <Input
                  {...form.register('fullName', { required: 'A name is required.' })}
                  placeholder="Muhammad Ali"
                />
              </FormField>

              <FormField
                label="Email"
                htmlFor="cand-email"
                required
                error={form.formState.errors.email?.message}
                hint="Identifies this person across every application they make."
              >
                <Input
                  type="email"
                  {...form.register('email', { required: 'An email address is required.' })}
                />
              </FormField>

              <FormField label="Phone" htmlFor="cand-phone">
                <Input {...form.register('phone')} />
              </FormField>

              <FormField label="Current location" htmlFor="cand-location">
                <Input {...form.register('currentLocation')} />
              </FormField>

              <FormField label="Source" htmlFor="cand-source" hint="Referral, LinkedIn, walk-in.">
                <Input {...form.register('source')} />
              </FormField>

              <FormField label="Current company" htmlFor="cand-company">
                <Input {...form.register('currentCompany')} />
              </FormField>

              <FormField label="Current title" htmlFor="cand-title">
                <Input {...form.register('currentTitle')} />
              </FormField>

              <FormField
                label="Experience (years)"
                htmlFor="cand-experience"
                error={form.formState.errors.experienceYears?.message}
              >
                <Input type="number" min={0} max={60} {...form.register('experienceYears')} />
              </FormField>

              <FormField
                label="Notice period (days)"
                htmlFor="cand-notice"
                error={form.formState.errors.noticePeriodDays?.message}
              >
                <Input type="number" min={0} max={365} {...form.register('noticePeriodDays')} />
              </FormField>

              <FormField label="LinkedIn" htmlFor="cand-linkedin">
                <Input {...form.register('linkedinUrl')} />
              </FormField>

              <FormField label="Portfolio" htmlFor="cand-portfolio">
                <Input {...form.register('portfolioUrl')} />
              </FormField>

              <FormField label="Recruiter" htmlFor="cand-recruiter">
                <NativeSelect {...form.register('recruiterId')}>
                  <option value="">Not assigned</option>
                  {interviewers.map((person) => (
                    <option key={person.employeeId} value={person.employeeId}>
                      {person.fullName}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              {candidate ? null : (
                <FormField
                  label="Apply for"
                  htmlFor="cand-opening"
                  hint="Optional. A CV can be filed without a vacancy."
                >
                  <NativeSelect {...form.register('jobOpeningId')}>
                    <option value="">No opening yet</option>
                    {openings.map((opening) => (
                      <option key={opening.id} value={opening.id}>
                        {opening.title} ({opening.reference})
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              )}
            </div>

            <FormField label="Skills" htmlFor="cand-skills" hint="Comma separated. Searchable.">
              <Input {...form.register('skills')} placeholder="Unity, C#, Multiplayer" />
            </FormField>

            {/*
              The restricted block. Grouped and labelled as such rather than
              mixed in above, because somebody filling this in should know that
              what they type here is held behind a second permission and does
              not follow the candidate onto an interview screen.
            */}
            <fieldset className="rounded-lg border border-border p-4">
              <legend className="px-1.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Confidential
              </legend>
              <p className="mb-3 text-[12.5px] text-muted-foreground">
                Only readers who can manage candidates see any of this. It never appears on an
                interview or an evaluation.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField label="Current salary" htmlFor="cand-current-salary">
                  <Input type="number" min={0} {...form.register('currentSalary')} />
                </FormField>
                <FormField label="Expected salary" htmlFor="cand-expected-salary">
                  <Input type="number" min={0} {...form.register('expectedSalary')} />
                </FormField>
                <FormField label="Currency" htmlFor="cand-currency">
                  <Input maxLength={8} {...form.register('salaryCurrency')} />
                </FormField>
              </div>
              <FormField label="Notes" htmlFor="cand-notes" className="mt-4">
                <Textarea rows={4} {...form.register('notes')} />
              </FormField>
            </fieldset>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="candidate-form" loading={mutation.isPending}>
            {candidate ? 'Save changes' : 'Add candidate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
