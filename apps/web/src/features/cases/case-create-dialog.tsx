import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Paperclip, X } from 'lucide-react';
import {
  CASE_ATTACHMENT_MAX_BYTES,
  CASE_ATTACHMENT_MAX_PER_CASE,
  CASE_ATTACHMENT_TOO_LARGE_MESSAGE,
  CASE_ATTACHMENT_TYPE_LABELS,
  CASE_PRIORITIES,
  CASE_PRIORITY_DESCRIPTIONS,
  CASE_PRIORITY_LABELS,
  DEFAULT_CASE_PRIORITY,
  safeAttachmentName,
  type CaseRecord,
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
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Skeleton } from '@/components/ui/skeleton';
import { fileSize } from './case-shared';
import { useCaseCatalogue } from './use-case-catalogue';

/**
 * Raising a case.
 *
 * The department control is a SELECT over the company's own departments and
 * there is no free-text alternative anywhere on this form - an employee cannot
 * invent "IT Support (new)" and have it land in a queue nobody reads. Category
 * cascades from it and subcategory cascades from that, so the three controls
 * can only ever produce a combination the catalogue actually contains; the
 * endpoint re-reads all three regardless, which is the gate that counts.
 *
 * Attachments are uploaded AFTER the case exists, one request each, because the
 * upload endpoint needs a case id to scope its object key and its permission
 * check to. That ordering has a consequence worth being honest about: a case
 * whose files fail to upload is still a raised case. It is reported that way -
 * the case is created, the person is told which files did not make it, and they
 * are on the case's own page where they can try again - rather than pretending
 * the whole thing failed and leaving a case behind anyway.
 */

interface FormValues {
  departmentId: string;
  categoryId: string;
  subcategoryId: string;
  subject: string;
  description: string;
  priority: (typeof CASE_PRIORITIES)[number];
}

const BLANK: FormValues = {
  departmentId: '',
  categoryId: '',
  subcategoryId: '',
  subject: '',
  description: '',
  priority: DEFAULT_CASE_PRIORITY,
};

const ERROR_BOX =
  'rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive';

/** Places the server's field errors on the form, returning what was left over. */
function placeFieldErrors(
  error: unknown,
  form: { setError: (name: never, value: { message: string }) => void; getValues: () => object },
): string | null {
  if (error instanceof ApiError && error.isValidation && error.details) {
    const unplaced: string[] = [];
    const values = form.getValues();
    for (const [field, messages] of Object.entries(error.details)) {
      const message = messages[0] ?? 'Invalid value.';
      if (field in values) form.setError(field as never, { message });
      else unplaced.push(message);
    }
    return unplaced.length > 0 ? unplaced.join(' ') : null;
  }
  return errorMessage(error);
}

export function CaseCreateDialog({
  open,
  onClose,
  /** Navigates to the new case once it exists. Off for the dashboard card. */
  openOnCreate = true,
}: {
  open: boolean;
  onClose: () => void;
  openOnCreate?: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [files, setFiles] = React.useState<File[]>([]);
  const fileInput = React.useRef<HTMLInputElement>(null);

  // Only fetched while the dialog is open: it is the form's vocabulary, not
  // the page's, and a closed dialog has no form.
  const { catalogue, isLoading, isError, error } = useCaseCatalogue(open);

  const form = useForm<FormValues>({ defaultValues: BLANK });

  React.useEffect(() => {
    if (!open) return;
    form.reset(BLANK);
    setFiles([]);
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const departmentId = form.watch('departmentId');
  const categoryId = form.watch('categoryId');
  const priority = form.watch('priority');

  const department = catalogue.find((d) => d.departmentId === departmentId) ?? null;
  const category = department?.categories.find((c) => c.id === categoryId) ?? null;

  /*
   * A department or category that is no longer selectable cannot be left
   * selected. Without this, changing the department keeps the previous
   * category id in the form and the server refuses a combination the user can
   * see is wrong on screen.
   */
  React.useEffect(() => {
    if (categoryId && !department?.categories.some((c) => c.id === categoryId)) {
      form.setValue('categoryId', '');
      form.setValue('subcategoryId', '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId]);

  React.useEffect(() => {
    form.setValue('subcategoryId', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  const addFiles = (chosen: FileList | null) => {
    if (!chosen) return;
    const next = [...files];
    for (const file of Array.from(chosen)) {
      if (next.length >= CASE_ATTACHMENT_MAX_PER_CASE) break;
      // Refused here as well as on the server, so somebody is told before they
      // have waited for a 10 MB upload to be rejected.
      if (file.size > CASE_ATTACHMENT_MAX_BYTES) {
        toast.error(`${file.name}: ${CASE_ATTACHMENT_TOO_LARGE_MESSAGE}`);
        continue;
      }
      next.push(file);
    }
    setFiles(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const created = await api.post<CaseRecord>('/cases', {
        departmentId: values.departmentId,
        categoryId: values.categoryId,
        subcategoryId: values.subcategoryId || null,
        subject: values.subject,
        description: values.description,
        priority: values.priority,
      });

      /*
       * The files, now that there is a case to hang them on. Failures are
       * collected rather than thrown: the case exists, and losing it because
       * one attachment was refused would be the worse outcome.
       */
      const failed: string[] = [];
      for (const file of files) {
        try {
          await api.upload(
            `/cases/${created.id}/attachments?filename=${encodeURIComponent(safeAttachmentName(file.name))}`,
            file,
          );
        } catch (uploadError) {
          failed.push(`${file.name} (${errorMessage(uploadError)})`);
        }
      }

      return { created, failed };
    },
    onSuccess: ({ created, failed }) => {
      void queryClient.invalidateQueries({ queryKey: ['cases'] });

      if (failed.length > 0) {
        toast.warning(`Case ${created.caseNumber} was raised, but some files were not attached.`, {
          description: failed.join(' · '),
        });
      } else {
        toast.success(`Case ${created.caseNumber} raised.`);
      }

      onClose();
      if (openOnCreate) navigate(`/cases/${created.id}`);
    },
    onError: (mutationError: unknown) => {
      setFormError(placeFieldErrors(mutationError, form));
    },
  });

  const submit = form.handleSubmit((values) => {
    setFormError(null);
    mutation.mutate(values);
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Raise a case</DialogTitle>
          <DialogDescription>
            Tell us what is wrong and who it is for. You will get a case number, and everything
            said about it stays on the case.
          </DialogDescription>
        </DialogHeader>

        {/* `contents`, so DialogBody and DialogFooter stay children of the
            dialog's column as far as layout goes. A plain form box grew with
            its fields: once a category added the subcategory field it was
            taller than the height-capped dialog, which clipped the footer -
            and the Raise case button with it - off the bottom. */}
        <form onSubmit={submit} className="contents" noValidate>
          <DialogBody className="space-y-4">
            {formError ? <p className={ERROR_BOX}>{formError}</p> : null}

            {isError ? (
              <ErrorState error={error} />
            ) : isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-9.5 w-full" />
                <Skeleton className="h-9.5 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : catalogue.length === 0 ? (
              <EmptyState
                title="No case categories yet"
                description="Nobody has set up the helpdesk queues for your company. An administrator needs to do that before cases can be raised."
              />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label="Department"
                    htmlFor="case-department"
                    required
                    error={form.formState.errors.departmentId?.message}
                    hint="Who should deal with it."
                  >
                    {/* A select over the company's real departments. There is
                        deliberately no "other" and no free-text alternative. */}
                    <NativeSelect
                      {...form.register('departmentId', {
                        required: 'Choose which department this is for.',
                      })}
                    >
                      <option value="">Choose a department</option>
                      {catalogue.map((entry) => (
                        <option key={entry.departmentId} value={entry.departmentId}>
                          {entry.departmentName}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>

                  <FormField
                    label="Category"
                    htmlFor="case-category"
                    required
                    error={form.formState.errors.categoryId?.message}
                    hint={department ? category?.description ?? 'What it is about.' : 'Choose a department first.'}
                  >
                    <NativeSelect
                      disabled={!department}
                      {...form.register('categoryId', {
                        required: 'Choose what this is about.',
                      })}
                    >
                      <option value="">Choose a category</option>
                      {(department?.categories ?? []).map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                </div>

                {/* Absent entirely when the chosen category has none, rather
                    than shown empty and disabled - a control with nothing in it
                    reads as something the user failed to fill in. */}
                {category && category.subcategories.length > 0 ? (
                  <FormField
                    label="Subcategory"
                    htmlFor="case-subcategory"
                    hint="Optional, but it gets the case to the right person faster."
                    error={form.formState.errors.subcategoryId?.message}
                  >
                    <NativeSelect {...form.register('subcategoryId')}>
                      <option value="">Not sure / none of these</option>
                      {category.subcategories.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                ) : null}

                <FormField
                  label="Subject"
                  htmlFor="case-subject"
                  required
                  error={form.formState.errors.subject?.message}
                  hint="One line, the way you would say it to a colleague."
                >
                  <Input
                    placeholder="Laptop will not start"
                    {...form.register('subject', {
                      required: 'Give it a short subject line.',
                      minLength: { value: 3, message: 'Give it a short subject line.' },
                    })}
                  />
                </FormField>

                <FormField
                  label="Description"
                  htmlFor="case-description"
                  required
                  error={form.formState.errors.description?.message}
                  hint="What happened, when it started, and anything you have already tried."
                >
                  <Textarea
                    rows={5}
                    placeholder="Since this morning the machine shows a black screen after the login sound. I have tried restarting it twice."
                    {...form.register('description', {
                      required: 'Describe what is happening.',
                      minLength: {
                        value: 10,
                        message: 'A sentence or two, so somebody can act on it.',
                      },
                    })}
                  />
                </FormField>

                <FormField
                  label="Priority"
                  htmlFor="case-priority"
                  hint={CASE_PRIORITY_DESCRIPTIONS[priority]}
                >
                  <NativeSelect {...form.register('priority')}>
                    {CASE_PRIORITIES.map((value) => (
                      <option key={value} value={value}>
                        {CASE_PRIORITY_LABELS[value]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[13px] font-medium">Attachments</p>
                    <p className="text-[12px] text-muted-foreground">
                      {CASE_ATTACHMENT_TYPE_LABELS}, up to {fileSize(CASE_ATTACHMENT_MAX_BYTES)}{' '}
                      each
                    </p>
                  </div>

                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label="Choose files to attach"
                    onChange={(event) => addFiles(event.target.files)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={files.length >= CASE_ATTACHMENT_MAX_PER_CASE}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Paperclip className="size-4" aria-hidden />
                    Attach a file
                  </Button>

                  {files.length > 0 ? (
                    <ul className="divide-y divide-border rounded-md border border-border">
                      {files.map((file, index) => (
                        <li
                          key={`${file.name}-${index}`}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <span className="min-w-0 truncate text-[13px]">{file.name}</span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="tabular text-[12px] text-muted-foreground">
                              {fileSize(file.size)}
                            </span>
                            <button
                              type="button"
                              aria-label={`Remove ${file.name}`}
                              className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
                              onClick={() => setFiles(files.filter((_, i) => i !== index))}
                            >
                              <X className="size-3.5" />
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </>
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || catalogue.length === 0}>
              {mutation.isPending ? 'Raising...' : 'Raise case'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
