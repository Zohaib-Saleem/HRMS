import * as React from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, LifeBuoy, Paperclip, RotateCcw, Send, X } from 'lucide-react';
import {
  CASE_ATTACHMENT_MAX_BYTES,
  CASE_ATTACHMENT_MAX_PER_CASE,
  CASE_ATTACHMENT_TOO_LARGE_MESSAGE,
  CASE_ATTACHMENT_TYPE_LABELS,
  CASE_PRIORITY_LABELS,
  CASE_STATUS_DESCRIPTIONS,
  CASE_STATUS_LABELS,
  PERMISSIONS,
  caseAttachmentUrl,
  safeAttachmentName,
  type CaseAttachmentRecord,
  type CaseDetail,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { usePermissions } from '@/features/auth/session-context';
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
import { FormField, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { CASE_PRIORITY_TONE, CASE_STATUS_TONE, caseDay, caseTimestamp, fileSize } from './case-shared';

/**
 * One case, and the conversation on it.
 *
 * Its own route rather than a drawer over the list, which is a departure from
 * how loans and medical claims are read - and is the right one here. A case is
 * a THREAD: it is opened repeatedly over days, its URL gets pasted into chat
 * messages, and it wants the full width for a conversation that grows. A drawer
 * gives none of that.
 *
 * What the caller may do comes from the record - `canReply`, `canReopen`,
 * `canAttach` - which the server derived from their permissions and the case's
 * status. Those flags decide what is DRAWN; every endpoint behind a control
 * re-checks the same thing on what actually arrived, so a flag flipped in a
 * debugger buys nothing.
 *
 * Nothing here can reach a case that is not the caller's. The endpoint answers
 * 404 for anybody else's id, so the failure mode of a guessed URL is this
 * screen's "not found" state rather than a leak.
 */

export function CaseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { has } = usePermissions();
  const onDesk = has(PERMISSIONS.CASE_READ_DEPARTMENT) || has(PERMISSIONS.CASE_READ_ALL);

  const [reply, setReply] = React.useState('');
  const [files, setFiles] = React.useState<File[]>([]);
  const [reopening, setReopening] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ['cases', 'detail', id],
    queryFn: () => api.get<CaseDetail>(`/cases/${id}`),
    enabled: id !== '',
    retry: false,
  });

  const detail = query.data ?? null;

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
   * Sending a reply, with whatever was attached to it.
   *
   * The message first, then its files against the id it came back with, so a
   * file uploaded here belongs to THIS reply rather than to the case at large.
   * A file that fails is reported by name; the reply itself has already landed
   * and is not rolled back, because losing what somebody typed is worse than
   * losing a screenshot they can add again.
   */
  const replyMutation = useMutation({
    mutationFn: async () => {
      const message = await api.post<{ id: string }>(`/cases/${id}/messages`, {
        message: reply.trim(),
      });

      const failed: string[] = [];
      for (const file of files) {
        try {
          await api.upload(
            `/cases/${id}/attachments?messageId=${encodeURIComponent(message.id)}&filename=${encodeURIComponent(safeAttachmentName(file.name))}`,
            file,
          );
        } catch (error) {
          failed.push(`${file.name} (${errorMessage(error)})`);
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      setReply('');
      setFiles([]);
      refresh();
      if (failed.length > 0) {
        toast.warning('Your reply was sent, but some files were not attached.', {
          description: failed.join(' · '),
        });
      }
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reopenMutation = useMutation({
    mutationFn: (reason: string) => api.post(`/cases/${id}/reopen`, { reason }),
    onSuccess: () => {
      setReopening(false);
      refresh();
      toast.success('Case reopened.');
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

  /*
   * Not the caller's own case, but they staff a desk: the case may be one they
   * were assigned. "Assigned to you" notifications written before they carried
   * the desk's link point here, so they are sent on to the desk's view, which
   * makes its own decision about whether this caller may read it.
   */
  if (query.error instanceof ApiError && query.error.status === 404 && onDesk) {
    return <Navigate to={`/case-queue/${encodeURIComponent(id)}`} replace />;
  }

  if (query.isError || !detail) {
    return (
      <>
        <PageHeader title="Case" />
        <Card>
          {/*
            A case that is not the caller's answers 404, so this is what somebody
            changing an id in the URL sees. It says nothing about whether that
            case exists, because the server said nothing either.
          */}
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          <div className="pb-8 text-center">
            <Button variant="outline" size="sm" asChild>
              <Link to="/cases">Back to my cases</Link>
            </Button>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={detail.subject}
        description={`${detail.caseNumber} · ${detail.departmentName} · ${detail.categoryName}${
          detail.subcategoryName ? ` · ${detail.subcategoryName}` : ''
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/cases">
                <ArrowLeft className="size-4" aria-hidden />
                My cases
              </Link>
            </Button>
            {detail.canReopen ? (
              <Button variant="outline" size="sm" onClick={() => setReopening(true)}>
                <RotateCcw className="size-4" aria-hidden />
                Reopen
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
                <LifeBuoy className="size-4" aria-hidden />
                What you asked
              </CardTitle>
              <span className="text-[12px] text-muted-foreground">
                Raised {caseTimestamp(detail.createdAt)}
              </span>
            </CardHeader>
            <CardContent>
              {/* `whitespace-pre-wrap` and nothing else: the description is
                  somebody's own text and is rendered as text, never as markup. */}
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">
                {detail.description}
              </p>

              {detail.attachments.length > 0 ? (
                <AttachmentList caseId={detail.id} attachments={detail.attachments} className="mt-4" />
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
                  description="Replies from you and from whoever picks this up will appear here."
                />
              ) : (
                <ul className="space-y-3">
                  {detail.messages.map((message) => (
                    <li
                      key={message.id}
                      className={cn(
                        'rounded-lg border px-4 py-3',
                        message.fromRequester
                          ? 'border-border bg-surface-muted/40'
                          : 'border-primary/20 bg-primary-soft/40',
                      )}
                    >
                      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[13px] font-medium">
                          {message.fromRequester ? 'You' : (message.senderName ?? 'The team')}
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
              <CardTitle>Reply</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.canReply ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (reply.trim().length === 0) return;
                    replyMutation.mutate();
                  }}
                >
                  <Textarea
                    rows={4}
                    aria-label="Your reply"
                    placeholder="Add anything new - what changed, what you have tried, or an answer to a question you were asked."
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                  />

                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label="Choose files to attach to your reply"
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
                    {detail.canAttach ? (
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
                    ) : (
                      <span />
                    )}
                    <Button
                      type="submit"
                      size="sm"
                      disabled={replyMutation.isPending || reply.trim().length === 0}
                    >
                      <Send className="size-4" aria-hidden />
                      {replyMutation.isPending ? 'Sending...' : 'Send reply'}
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
                      : 'You cannot reply to this case'
                  }
                  description={
                    detail.status === 'CLOSED'
                      ? 'Reopen it if there is still something wrong, and the conversation carries on where it left off.'
                      : 'Ask an administrator if you think you should be able to.'
                  }
                  action={
                    detail.canReopen ? (
                      <Button variant="outline" size="sm" onClick={() => setReopening(true)}>
                        Reopen this case
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-[13px]">
              <Detail label="Case number">
                <span className="font-mono">{detail.caseNumber}</span>
              </Detail>
              <Detail label="Status">
                <Badge variant={CASE_STATUS_TONE[detail.status]}>
                  {CASE_STATUS_LABELS[detail.status]}
                </Badge>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {CASE_STATUS_DESCRIPTIONS[detail.status]}
                </p>
              </Detail>
              <Detail label="Priority">
                <Badge variant={CASE_PRIORITY_TONE[detail.priority]}>
                  {CASE_PRIORITY_LABELS[detail.priority]}
                </Badge>
              </Detail>
              <Detail label="Department">{detail.departmentName}</Detail>
              <Detail label="Category">
                {detail.categoryName}
                {detail.subcategoryName ? ` · ${detail.subcategoryName}` : ''}
              </Detail>
              <Detail label="Raised">{caseDay(detail.createdAt)}</Detail>
              <Detail label="Last activity">
                {caseDay(detail.lastMessageAt ?? detail.updatedAt)}
              </Detail>
              {detail.resolvedAt ? (
                <Detail label="Resolved">{caseDay(detail.resolvedAt)}</Detail>
              ) : null}
              {detail.closedAt ? <Detail label="Closed">{caseDay(detail.closedAt)}</Detail> : null}
              <Detail label="Assigned to">{detail.assignedToName ?? 'Not yet picked up'}</Detail>
            </dl>
          </CardContent>
        </Card>
      </div>

      <ReopenDialog
        open={reopening}
        onClose={() => setReopening(false)}
        pending={reopenMutation.isPending}
        onConfirm={(reason) => reopenMutation.mutate(reason)}
      />
    </>
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
 * The files on a case or on one reply.
 *
 * Every link goes through the API, never to a storage path - the browser is
 * never told where a file lives, and the endpoint it does hit re-checks the
 * case against the caller. `caseAttachmentUrl` builds it so no screen
 * assembles that path by hand and drops the case id out of it.
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
            href={caseAttachmentUrl(caseId, attachment.id)}
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
 * Reopening.
 *
 * The reason is mandatory and becomes the first message of the reopened
 * conversation, so somebody picking the case up again is told what is still
 * wrong rather than finding a case that silently came back.
 */
function ReopenDialog({
  open,
  onClose,
  pending,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (open) setReason('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen this case</DialogTitle>
          <DialogDescription>
            It goes back on the queue with everything already said on it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim().length < 3) return;
            onConfirm(reason.trim());
          }}
        >
          <DialogBody>
            <FormField
              label="What is still wrong?"
              htmlFor="reopen-reason"
              required
              hint="This becomes the next message on the case."
            >
              <Textarea
                rows={4}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="The mailbox locked again overnight, exactly as before."
              />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || reason.trim().length < 3}>
              {pending ? 'Reopening...' : 'Reopen case'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
