import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, Globe, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  COMPANY_LINK_KINDS,
  COMPANY_LINK_KIND_LABELS,
  PERMISSIONS,
  companyLinkSchema,
  type CompanyLinkInput,
  type CompanyLinkRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';

/**
 * The company's official online platforms.
 *
 * A list an administrator fills in, with nothing seeded and no address
 * guessed - a link that points at the wrong company's LinkedIn page is worse
 * than an empty list, and there is no way to know the right one from here.
 *
 * Deliberately outside the main company form: these are separate rows with
 * their own lifecycle, and folding them into a form that saves as one unit
 * would mean a typo in a URL blocking a timezone change.
 */
const blankToNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

function LinkDialog({
  open,
  existing,
  onClose,
}: {
  open: boolean;
  existing: CompanyLinkRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = existing !== null;
  const [formError, setFormError] = React.useState<string | null>(null);

  const blank = React.useCallback(
    (): CompanyLinkInput =>
      existing
        ? {
            kind: existing.kind,
            label: existing.label,
            url: existing.url,
            description: existing.description,
            displayOrder: existing.displayOrder,
            isActive: existing.isActive,
          }
        : {
            kind: 'OTHER',
            label: '',
            url: '',
            description: null,
            displayOrder: 0,
            isActive: true,
          },
    [existing],
  );

  const form = useForm<CompanyLinkInput>({
    resolver: zodResolver(companyLinkSchema),
    defaultValues: blank(),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const save = useMutation({
    mutationFn: (values: CompanyLinkInput) =>
      isEdit ? api.patch(`/company/links/${existing.id}`, values) : api.post('/company/links', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['company', 'links'] });
      toast.success(isEdit ? 'Link updated' : 'Link added');
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof CompanyLinkInput, { message });
          } else {
            unplaced.push(message);
          }
        }
        if (unplaced.length > 0) setFormError(unplaced.join(' '));
        return;
      }
      setFormError(errorMessage(error));
    },
  });

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit link' : 'Add a platform'}</DialogTitle>
            <DialogDescription>
              Anyone signed in can see active links. Nothing is filled in for you - paste the
              address you want people to reach.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {formError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive"
              >
                {formError}
              </p>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Platform" htmlFor="link-kind" error={errors.kind?.message}>
                <NativeSelect id="link-kind" {...form.register('kind')}>
                  {COMPANY_LINK_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {COMPANY_LINK_KIND_LABELS[kind]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Name"
                htmlFor="link-label"
                required
                hint="What this link is called in the app."
                error={errors.label?.message}
              >
                <Input id="link-label" autoFocus {...form.register('label')} />
              </FormField>

              <FormField
                label="Address"
                htmlFor="link-url"
                required
                className="sm:col-span-2"
                error={errors.url?.message}
              >
                <Input id="link-url" placeholder="https://" {...form.register('url')} />
              </FormField>

              <FormField
                label="Description"
                htmlFor="link-description"
                className="sm:col-span-2"
                error={errors.description?.message}
              >
                <Input
                  id="link-description"
                  {...form.register('description', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Order"
                htmlFor="link-order"
                hint="Lower appears first."
                error={errors.displayOrder?.message}
              >
                <Input id="link-order" type="number" min={0} {...form.register('displayOrder')} />
              </FormField>

              <label className="flex cursor-pointer items-center gap-2.5 self-end pb-2 text-[13px]">
                <input type="checkbox" className="size-4 accent-primary" {...form.register('isActive')} />
                Shown to everyone
              </label>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {isEdit ? 'Save changes' : 'Add link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CompanyLinksCard() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.COMPANY_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<CompanyLinkRecord | null>(null);

  const query = useQuery({
    queryKey: ['company', 'links'],
    queryFn: () => api.get<CompanyLinkRecord[]>('/company/links'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/company/links/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['company', 'links'] });
      toast.success('Link removed');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleRemove = async (link: CompanyLinkRecord) => {
    const ok = await confirm({
      title: `Remove the ${link.label} link?`,
      description:
        'A link carries no history, so this is a genuine delete. Switch it off instead if you only want to hide it for now.',
      confirmLabel: 'Remove',
      tone: 'destructive',
    });
    if (ok) remove.mutate(link.id);
  };

  const links = query.data ?? [];

  return (
    <Card>
      <CardHeader bordered className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Online platforms</CardTitle>
          <CardDescription>
            Official company links - the website, LinkedIn, and anywhere else your company
            officially is.
          </CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {query.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : links.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No platforms configured"
            description={
              canManage
                ? 'Add your company website, LinkedIn page and any other official platform. Nothing is filled in automatically.'
                : 'Nobody has configured any company links yet.'
            }
            action={
              canManage ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden />
                  Add a platform
                </Button>
              ) : null
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {links.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-[13.5px] font-medium text-primary hover:underline"
                    >
                      {link.label}
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                    <Badge variant="neutral">{COMPANY_LINK_KIND_LABELS[link.kind]}</Badge>
                    {link.isActive ? null : <Badge variant="warning">Hidden</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{link.url}</p>
                  {link.description ? (
                    <p className="text-[12px] text-muted-foreground">{link.description}</p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${link.label}`}
                      onClick={() => setEditing(link)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${link.label}`}
                      className="text-destructive"
                      onClick={() => void handleRemove(link)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <LinkDialog
        open={creating || editing !== null}
        existing={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </Card>
  );
}
