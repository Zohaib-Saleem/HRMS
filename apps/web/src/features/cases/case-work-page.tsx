import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Headset, Lock, Paperclip, Send, Shuffle, UserCheck, X } from 'lucide-react';
import {
  CASE_ATTACHMENT_MAX_BYTES,
  CASE_ATTACHMENT_MAX_PER_CASE,
  CASE_ATTACHMENT_TOO_LARGE_MESSAGE,
  CASE_ATTACHMENT_TYPE_LABELS,
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUS_DESCRIPTIONS,
  CASE_STATUS_LABELS,
  safeAttachmentName,
  type CaseAgentOption,
  type CaseAttachmentRecord,
  type CaseDeskDetail,
  type CaseStatus,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, NativeSelect, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useAuthenticatedSession } from '@/features/auth/session-context';
import { CASE_PRIORITY_TONE, CASE_STATUS_TONE, caseDay, caseTimestamp, fileSize } from './case-shared';
import { useCaseCatalogue } from './use-case-catalogue';

/**
 * Working one case.
 *
 * The requester's own view of this case lives at `/cases/:id` and shows a
 * strict subset: no internal notes, no controls, and none of the queue
 * mechanics. This screen is not that one with extra buttons - it is a different
 * route against different endpoints, and the only reason both exist is that
 * they are genuinely two jobs.
 *
 * What may be done here comes from `abilities` on the record, which the server
 * derived from the caller's grants and the case's own status - `nextStatuses`
 * included, so the workflow is never restated in the browser. Every control
 * re-checks on the server: these flags decide what is DRAWN, and nothing else.
 *
 * The one piece of interface design worth defending is the reply box. A reply
 * and an internal note are written in the same place about the same case, and
 * the mistake worth engineering against is somebody meaning one and sending the
 * other. So the choice is a pair of tabs rather than a checkbox, the note tab
 * repaints the box, and the button says which of the two it is about to do.
 */

export function CaseWorkPage() {
  const { id = '' } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const session = useAuthenticatedSession();

  const [draft, setDraft] = React.useState('');
  const [internal, setInternal] = React.useState(false);
  const [files, setFiles] = React.useState<File[]>([]);
  const [routing, setRouting] = React.useState(false);
  const [pendingStatus, setPendingStatus] = React.useState<CaseStatus | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ['cases', 'queue', 'detail', id],
    queryFn: () => api.get<CaseDeskDetail>(`/cases/queue/${id}`),
    enabled: id !== '',
    retry: false,
  });

  const detail = query.data ?? null;
  const abilities = detail?.abilities;

  const agents = useQuery({
    queryKey: ['cases', 'queue', 'agents'],
    queryFn: () => api.get<CaseAgentOption[]>('/cases/queue/agents'),
    enabled: Boolean(abilities?.canAssign),
    staleTime: 5 * 60_000,
  });

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['cases'] });
  }, [queryClient]);

  const addFiles = (chosen: FileList | null) => {
    if (!chosen) return;
    const next = [...files];
    for (const file of Array.from(chosen)) {
      if (next.length >= CASE_ATTACHMENT_MAX_PER_CASE) break;
      if (file.size > CASE_ATTACHMENT_MAX_BYTES) {
        toast.error(`${file.name}: ${CASE_ATTACHMENT_TOO_LARGE_MESSAGE}`);
        continue;
      }
      next.push(file);
    }
    setFiles(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  /**
   * Sending, whichever of the two this is.
   *
   * The message first, then its files against the id it came back with, and the
   * files carry the same internal flag as the message they belong to - so a
   * file on a note is as invisible to the requester as the note is. A file that
   * fails is named; the message itself has already landed and is not rolled
   * back, because losing what somebody typed is worse than losing an upload
   * they can repeat.
   */
  const sendMutation = useMutation({
    mutationFn: async () => {
      const message = await api.post<{ id: string }>(`/cases/queue/${id}/messages`, {
        message: draft.trim(),
        internal,
      });

      const failed: string[] = [];
      for (const file of files) {
        try {
          await api.upload(
            `/cases/queue/${id}/attachments?messageId=${encodeURIComponent(message.id)}&internal=${internal ? 'true' : 'false'}&filename=${encodeURIComponent(safeAttachmentName(file.name))}`,
            file,
          );
        } catch (error) {
          failed.push(`${file.name} (${errorMessage(error)})`);
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      setDraft('');
      setFiles([]);
      refresh();
      toast.success(internal ? 'Note saved for the desk.' : 'Reply sent to the requester.');
      if (failed.length > 0) {
        toast.warning('Some files were not attached.', { description: failed.join(' · ') });
      }
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const statusMutation = useMutation({
    mutationFn: (body: { status: CaseStatus; note?: string; internal: boolean }) =>
      api.post(`/cases/queue/${id}/status`, body),
    onSuccess: (_data, body) => {
      setPendingStatus(null);
      refresh();
      toast.success(`Moved to ${CASE_STATUS_LABELS[body.status].toLowerCase()}.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const priorityMutation = useMutation({
    mutationFn: (priority: string) => api.post(`/cases/queue/${id}/priority`, { priority }),
    onSuccess: () => {
      refresh();
      toast.success('Priority updated.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const assignMutation = useMutation({
    mutationFn: (assignedUserId: string | null) =>
      api.post(`/cases/queue/${id}/assign`, { assignedUserId }),
    onSuccess: () => {
      refresh();
      toast.success('Assignment updated.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const routeMutation = useMutation({
    mutationFn: (body: {
      departmentId: string;
      categoryId: string;
      subcategoryId: string | null;
      note?: string;
    }) => api.post(`/cases/queue/${id}/route`, body),
    onSuccess: () => {
      setRouting(false);
      refresh();
      toast.success('Case re-routed.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (query.isLoading) {
    return (
      <>
        <PageHeader title="Case" />
        <Card>
          <CardContent className="space-y-3 py-6">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </>
    );
  }

  if (query.isError || !detail || !abilities) {
    return (
      <>
        <PageHeader title="Case" />
        <Card>
          {/* A case outside the caller's queues answers 404, so this is what
              changing an id in the URL produces. It says nothing about whether
              that case exists, because the server said nothing either. */}
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          <div className="pb-8 text-center">
            <Button variant="outline" size="sm" asChild>
              <Link to="/case-queue">Back to the queue</Link>
            </Button>
          </div>
        </Card>
      </>
    );
  }

  const canWrite = abilities.canRespond || abilities.canNote;

  return (
    <>
      <PageHeader
        title={detail.subject}
        description={`${detail.caseNumber} · raised by ${detail.requesterName} · ${detail.departmentName} · ${detail.categoryName}${
          detail.subcategoryName ? ` · ${detail.subcategoryName}` : ''
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/case-queue">
                <ArrowLeft className="size-4" aria-hidden />
                Queue
              </Link>
            </Button>
            {abilities.canAssign && detail.assignedUserId === null ? (
              <Button
                size="sm"
                variant="outline"
                disabled={assignMutation.isPending}
                onClick={() => assignMutation.mutate(session.user.id)}
              >
                <UserCheck className="size-4" aria-hidden />
                Take it
              </Button>
            ) : null}
            {abilities.canRoute ? (
              <Button variant="outline" size="sm" onClick={() => setRouting(true)}>
                <Shuffle className="size-4" aria-hidden />
                Re-route
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <Headset className="size-4" aria-hidden />
                What was asked
              </CardTitle>
              <span className="text-[12px] text-muted-foreground">
                Raised {caseTimestamp(detail.createdAt)}
              </span>
            </CardHeader>
            <CardContent>
              {/* Somebody's own words, rendered as text and never as markup. */}
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">
                {detail.description}
              </p>
              {detail.attachments.length > 0 ? (
                <AttachmentList
                  caseId={detail.id}
                  attachments={detail.attachments}
                  className="mt-4"
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Conversation</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.messages.length === 0 ? (
                <EmptyState
                  icon={Send}
                  title="Nothing said yet"
                  description="Replies, notes and anything the case does by itself appear here."
                />
              ) : (
                <ul className="space-y-3">
                  {detail.messages.map((message) => (
                    <li
                      key={message.id}
                      className={cn(
                        'rounded-lg border px-4 py-3',
                        message.internal
                          ? 'border-warning/40 bg-warning-soft/30'
                          : message.fromRequester
                            ? 'border-border bg-surface-muted/40'
                            : 'border-primary/20 bg-primary-soft/40',
                      )}
                    >
                      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-[13px] font-medium">
                          {message.senderName ??
                            (message.senderUserId === null ? 'This case' : 'The desk')}
                          {message.internal ? (
                            <span className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-warning-foreground">
                              <Lock className="size-3" aria-hidden />
                              Internal
                            </span>
                          ) : null}
                          {message.fromRequester ? (
                            <span className="text-[11.5px] font-normal text-muted-foreground">
                              requester
                            </span>
                          ) : null}
                        </span>
                        <span className="text-[11.5px] text-muted-foreground">
                          {caseTimestamp(message.createdAt)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">
                        {message.message}
                      </p>
                      {message.attachments.length > 0 ? (
                        <AttachmentList
                          caseId={detail.id}
                          attachments={message.attachments}
                          className="mt-3"
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{internal ? 'Internal note' : 'Reply to the requester'}</CardTitle>
            </CardHeader>
            <CardContent>
              {canWrite ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.trim().length === 0) return;
                    sendMutation.mutate();
                  }}
                >
                  {/*
                    Two tabs rather than a checkbox. Which of the two acts this
                    is about to be is the single thing worth being unmissable on
                    this screen, so it is a choice made before typing and it
                    changes what the box looks like.
                  */}
                  <div
                    role="tablist"
                    aria-label="What to write"
                    className="inline-flex rounded-lg border border-border p-0.5"
                  >
                    <TabButton
                      selected={!internal}
                      disabled={!abilities.canRespond}
                      onClick={() => setInternal(false)}
                    >
                      Reply to requester
                    </TabButton>
                    <TabButton
                      selected={internal}
                      disabled={!abilities.canNote}
                      onClick={() => setInternal(true)}
                    >
                      <Lock className="size-3.5" aria-hidden />
                      Internal note
                    </TabButton>
                  </div>

                  <Textarea
                    rows={4}
                    aria-label={internal ? 'Internal note' : 'Reply to the requester'}
                    className={internal ? 'border-warning/50 bg-warning-soft/20' : undefined}
                    placeholder={
                      internal
                        ? 'For the desk only. What you found, what you tried, what the next person needs to know.'
                        : 'What has happened, what you need from them, or that it is done.'
                    }
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />

                  <p className="text-[12px] text-muted-foreground">
                    {internal
                      ? `${detail.requesterName} will never see this, and is not notified about it.`
                      : `${detail.requesterName} sees this on their case and is notified.`}
                  </p>

                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label="Choose files to attach"
                    onChange={(event) => addFiles(event.target.files)}
                  />

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

                  <div className="flex flex-wrap items-center justify-between gap-2">
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
                    <Button
                      type="submit"
                      size="sm"
                      disabled={sendMutation.isPending || draft.trim().length === 0}
                    >
                      <Send className="size-4" aria-hidden />
                      {sendMutation.isPending
                        ? 'Sending...'
                        : internal
                          ? 'Save internal note'
                          : 'Send reply'}
                    </Button>
                  </div>
                  <p className="text-[12px] text-muted-foreground">
                    {CASE_ATTACHMENT_TYPE_LABELS}, up to {fileSize(CASE_ATTACHMENT_MAX_BYTES)} each.
                  </p>
                </form>
              ) : (
                <EmptyState
                  title={
                    detail.status === 'CLOSED'
                      ? 'This case is closed'
                      : 'You cannot write on this case'
                  }
                  description={
                    detail.status === 'CLOSED'
                      ? 'Reopen it to carry the conversation on where it left off.'
                      : 'Ask an administrator if you think you should be able to.'
                  }
                />
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Working it</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Status
                </p>
                <Badge variant={CASE_STATUS_TONE[detail.status]}>
                  {CASE_STATUS_LABELS[detail.status]}
                </Badge>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {CASE_STATUS_DESCRIPTIONS[detail.status]}
                </p>
                {abilities.nextStatuses.length > 0 ? (
                  <NativeSelect
                    aria-label="Move this case to"
                    className="mt-2"
                    value=""
                    disabled={statusMutation.isPending}
                    onChange={(event) => {
                      const next = event.target.value as CaseStatus | '';
                      if (next) setPendingStatus(next);
                    }}
                  >
                    <option value="">Move it to...</option>
                    {abilities.nextStatuses.map((status) => (
                      <option key={status} value={status}>
                        {CASE_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </NativeSelect>
                ) : null}
              </div>

              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Priority
                </p>
                {abilities.canUpdate ? (
                  <NativeSelect
                    aria-label="Priority"
                    value={detail.priority}
                    disabled={priorityMutation.isPending}
                    onChange={(event) => priorityMutation.mutate(event.target.value)}
                  >
                    {CASE_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {CASE_PRIORITY_LABELS[priority]}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Badge variant={CASE_PRIORITY_TONE[detail.priority]}>
                    {CASE_PRIORITY_LABELS[detail.priority]}
                  </Badge>
                )}
              </div>

              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Assigned to
                </p>
                {abilities.canAssign ? (
                  <NativeSelect
                    aria-label="Assigned to"
                    value={detail.assignedUserId ?? ''}
                    disabled={assignMutation.isPending}
                    onChange={(event) => assignMutation.mutate(event.target.value || null)}
                  >
                    <option value="">Nobody</option>
                    {(agents.data ?? []).map((agent) => (
                      <option key={agent.userId} value={agent.userId}>
                        {agent.userId === session.user.id ? `${agent.name} (you)` : agent.name}
                        {agent.departmentName ? ` · ${agent.departmentName}` : ''}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <p className="text-[13px] font-medium">
                    {detail.assignedToName ?? 'Not yet picked up'}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Who raised it</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-[13px]">
                <Detail label="Name">{detail.requesterName}</Detail>
                <Detail label="Employee number">
                  <span className="font-mono">{detail.requesterEmployeeNumber}</span>
                </Detail>
                <Detail label="Department">{detail.requesterDepartmentName ?? '—'}</Detail>
                <Detail label="Email">
                  {detail.requesterEmail ? (
                    <a className="text-primary hover:underline" href={`mailto:${detail.requesterEmail}`}>
                      {detail.requesterEmail}
                    </a>
                  ) : (
                    '—'
                  )}
                </Detail>
                <Detail label="Raised">{caseDay(detail.createdAt)}</Detail>
                <Detail label="Last activity">
                  {caseDay(detail.lastMessageAt ?? detail.updatedAt)}
                </Detail>
                {detail.resolvedAt ? (
                  <Detail label="Resolved">{caseDay(detail.resolvedAt)}</Detail>
                ) : null}
                {detail.closedAt ? <Detail label="Closed">{caseDay(detail.closedAt)}</Detail> : null}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <StatusDialog
        status={pendingStatus}
        canNote={abilities.canNote}
        requesterName={detail.requesterName}
        pending={statusMutation.isPending}
        onClose={() => setPendingStatus(null)}
        onConfirm={(note, noteInternal) =>
          pendingStatus &&
          statusMutation.mutate({
            status: pendingStatus,
            note: note || undefined,
            internal: noteInternal,
          })
        }
      />

      <RouteDialog
        open={routing}
        current={{
          departmentId: detail.departmentId,
          categoryId: detail.categoryId,
          subcategoryId: detail.subcategoryId,
        }}
        pending={routeMutation.isPending}
        onClose={() => setRouting(false)}
        onConfirm={(selection) => routeMutation.mutate(selection)}
      />
    </>
  );
}

function TabButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        selected ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

/**
 * The files on a case or on one message.
 *
 * Every link goes through the desk's own download endpoint, which re-checks the
 * case against the caller's queues. The browser is never told where a file
 * lives.
 */
function AttachmentList({
  caseId,
  attachments,
  className,
}: {
  caseId: string;
  attachments: CaseAttachmentRecord[];
  className?: string;
}) {
  return (
    <ul className={cn('divide-y divide-border rounded-md border border-border', className)}>
      {attachments.map((attachment) => (
        <li key={attachment.id} className="flex items-center justify-between gap-3 px-3 py-2">
          <a
            href={`/api/v1/cases/queue/${encodeURIComponent(caseId)}/attachments/${encodeURIComponent(attachment.id)}`}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-2 text-[13px] text-primary hover:underline"
          >
            <Paperclip className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{attachment.fileName}</span>
          </a>
          <span className="tabular shrink-0 text-[12px] text-muted-foreground">
            {fileSize(attachment.sizeBytes)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Moving the case, with a sentence about why.
 *
 * The note is optional and the dialog says so, because forcing one produces
 * "done" and nothing else. What it does insist on is being clear about who will
 * read it: the requester is named in the text, and marking it internal is a
 * deliberate second action rather than a remembered default.
 */
function StatusDialog({
  status,
  canNote,
  requesterName,
  pending,
  onClose,
  onConfirm,
}: {
  status: CaseStatus | null;
  canNote: boolean;
  requesterName: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (note: string, internal: boolean) => void;
}) {
  const [note, setNote] = React.useState('');
  const [internal, setInternal] = React.useState(false);

  React.useEffect(() => {
    if (status) {
      setNote('');
      setInternal(false);
    }
  }, [status]);

  return (
    <Dialog open={status !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Move this case to {status ? CASE_STATUS_LABELS[status].toLowerCase() : ''}
          </DialogTitle>
          <DialogDescription>
            {status ? CASE_STATUS_DESCRIPTIONS[status] : ''}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(note.trim(), internal);
          }}
        >
          <DialogBody className="space-y-3">
            <FormField
              label="Say why (optional)"
              htmlFor="status-note"
              hint={
                internal
                  ? `${requesterName} will not see this.`
                  : `${requesterName} sees this on their case and is notified.`
              }
            >
              <Textarea
                id="status-note"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Waiting on the replacement battery - the supplier says Thursday."
              />
            </FormField>
            {canNote && note.trim().length > 0 ? (
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(event) => setInternal(event.target.checked)}
                />
                Keep this note internal
              </label>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Moving...' : 'Move it'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sending a misfiled case where it belongs.
 *
 * The same cascading selects as the create form, drawn from the same catalogue
 * endpoint, because the destination has to be somewhere a case could have been
 * filed in the first place - and the server checks exactly that.
 */
function RouteDialog({
  open,
  current,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  current: { departmentId: string; categoryId: string; subcategoryId: string | null };
  pending: boolean;
  onClose: () => void;
  onConfirm: (selection: {
    departmentId: string;
    categoryId: string;
    subcategoryId: string | null;
    note?: string;
  }) => void;
}) {
  const { catalogue, isLoading } = useCaseCatalogue(open);
  const [departmentId, setDepartmentId] = React.useState(current.departmentId);
  const [categoryId, setCategoryId] = React.useState(current.categoryId);
  const [subcategoryId, setSubcategoryId] = React.useState(current.subcategoryId ?? '');
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setDepartmentId(current.departmentId);
    setCategoryId(current.categoryId);
    setSubcategoryId(current.subcategoryId ?? '');
    setNote('');
  }, [open, current.departmentId, current.categoryId, current.subcategoryId]);

  const department = catalogue.find((entry) => entry.departmentId === departmentId);
  const category = department?.categories.find((entry) => entry.id === categoryId);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-route this case</DialogTitle>
          <DialogDescription>
            It moves to the new queue with the whole conversation, and goes back to nobody so the
            new desk can pick it up.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!departmentId || !categoryId) return;
            onConfirm({
              departmentId,
              categoryId,
              subcategoryId: subcategoryId || null,
              note: note.trim() || undefined,
            });
          }}
        >
          <DialogBody className="space-y-3">
            <FormField label="Department" htmlFor="route-department" required>
              <NativeSelect
                id="route-department"
                value={departmentId}
                disabled={isLoading}
                onChange={(event) => {
                  setDepartmentId(event.target.value);
                  setCategoryId('');
                  setSubcategoryId('');
                }}
              >
                <option value="">Choose a department</option>
                {catalogue.map((entry) => (
                  <option key={entry.departmentId} value={entry.departmentId}>
                    {entry.departmentName}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Category" htmlFor="route-category" required>
              <NativeSelect
                id="route-category"
                value={categoryId}
                disabled={!department}
                onChange={(event) => {
                  setCategoryId(event.target.value);
                  setSubcategoryId('');
                }}
              >
                <option value="">Choose a category</option>
                {(department?.categories ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            {category && category.subcategories.length > 0 ? (
              <FormField label="Subcategory" htmlFor="route-subcategory">
                <NativeSelect
                  id="route-subcategory"
                  value={subcategoryId}
                  onChange={(event) => setSubcategoryId(event.target.value)}
                >
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
              label="Say why (optional)"
              htmlFor="route-note"
              hint="The requester sees this, so they know where their case went."
            >
              <Textarea
                id="route-note"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="This is a payroll question rather than an IT one - Finance will pick it up."
              />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !departmentId || !categoryId}>
              {pending ? 'Moving...' : 'Re-route it'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
