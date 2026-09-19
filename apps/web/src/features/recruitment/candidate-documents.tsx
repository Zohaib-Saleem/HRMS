import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileText, Lock, Trash2, Upload } from 'lucide-react';
import {
  CANDIDATE_DOCUMENT_MAX_BYTES,
  CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE,
  CANDIDATE_DOCUMENT_TOO_LARGE_MESSAGE,
  CANDIDATE_DOCUMENT_TOO_MANY_MESSAGE,
  CANDIDATE_DOCUMENT_TYPES,
  CANDIDATE_DOCUMENT_TYPE_LABELS,
  safeAttachmentName,
  type CandidateDocumentRecord,
  type CandidateDocumentType,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ListSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { fileSize } from './recruitment-shared';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * A candidate's documents.
 *
 * The SAME storage the rest of the product uses - the object store behind
 * employee photos and case attachments - reached through the candidate's own
 * endpoints. There is no second upload mechanism here, no third-party link
 * field standing in for a file, and nothing written to disk by this screen.
 *
 * CONFIDENTIAL files are excluded by the server's WHERE clause for a reader
 * without `candidate.manage`, which means they are ABSENT rather than hidden:
 * the count matches the list, and holding the id of one buys nothing. So this
 * component does no filtering of its own - what it is given is what the reader
 * may see.
 *
 * Downloads are plain links rather than fetches. The session cookie travels
 * with a same-origin navigation, the server sets `Content-Disposition`, and
 * the browser does what it is good at - which also means a PDF opens in a tab
 * instead of being reassembled in memory.
 */
export function CandidateDocuments({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { canManageCandidates } = useRecruitmentAccess();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [type, setType] = React.useState<CandidateDocumentType>('RESUME');
  const [confidential, setConfidential] = React.useState(false);

  const query = useQuery({
    queryKey: ['recruitment', 'candidates', candidateId, 'documents'],
    queryFn: () =>
      api.get<CandidateDocumentRecord[]>(`/recruitment/candidates/${candidateId}/documents`),
  });

  const documents = query.data ?? [];

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const params = new URLSearchParams({
        filename: safeAttachmentName(file.name),
        type,
        confidential: confidential ? 'true' : 'false',
      });
      return api.upload<CandidateDocumentRecord>(
        `/recruitment/candidates/${candidateId}/documents?${params.toString()}`,
        file,
      );
    },
    onSuccess: async (saved) => {
      toast.success(`${saved.fileName} uploaded.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment', 'candidates', candidateId] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (documentId: string) =>
      api.delete(`/recruitment/candidates/${candidateId}/documents/${documentId}`),
    onSuccess: async () => {
      toast.success('Document removed.');
      await queryClient.invalidateQueries({ queryKey: ['recruitment', 'candidates', candidateId] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const choose = (files: FileList | null) => {
    const file = files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;

    // Refused here as well as on the server, so nobody waits for a 10 MB
    // upload to be rejected at the end of it.
    if (file.size > CANDIDATE_DOCUMENT_MAX_BYTES) {
      toast.error(`${file.name}: ${CANDIDATE_DOCUMENT_TOO_LARGE_MESSAGE}`);
      return;
    }
    if (documents.length >= CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE) {
      toast.error(CANDIDATE_DOCUMENT_TOO_MANY_MESSAGE);
      return;
    }
    upload.mutate(file);
  };

  const handleRemove = async (document: CandidateDocumentRecord) => {
    const ok = await confirm({
      title: `Remove ${document.fileName}?`,
      description: 'It will no longer be available to anybody working on this candidate.',
      confirmLabel: 'Remove',
      tone: 'destructive',
    });
    if (ok) remove.mutate(document.id);
  };

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Documents</CardTitle>
        <CardDescription>
          CVs, cover letters, portfolios and certificates. Up to{' '}
          {CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE} files, {fileSize(CANDIDATE_DOCUMENT_MAX_BYTES)}{' '}
          each.
        </CardDescription>
      </CardHeader>

      {canManageCandidates ? (
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3.5 sm:flex-row sm:items-end">
          <label className="flex-1 space-y-1.5">
            <span className="text-[13px] font-medium">Document type</span>
            <NativeSelect
              value={type}
              onChange={(event) => setType(event.target.value as CandidateDocumentType)}
            >
              {CANDIDATE_DOCUMENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {CANDIDATE_DOCUMENT_TYPE_LABELS[value]}
                </option>
              ))}
            </NativeSelect>
          </label>

          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <input
              type="checkbox"
              className="size-4"
              checked={confidential}
              onChange={(event) => setConfidential(event.target.checked)}
            />
            {/* What the flag actually does, said plainly: it is not a label on
                a file, it is who can retrieve it. */}
            <span>Confidential - only readers who can manage candidates will see it</span>
          </label>

          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={(event) => choose(event.target.files)}
          />
          <Button
            variant="outline"
            onClick={() => fileInput.current?.click()}
            loading={upload.isPending}
          >
            <Upload />
            Upload
          </Button>
        </div>
      ) : null}

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <ListSkeleton rows={3} />
      ) : documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents"
          description={
            canManageCandidates
              ? 'Upload a CV, a cover letter or anything else this candidate has sent.'
              : 'Nothing has been filed for this candidate that you can see.'
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
                  aria-hidden
                >
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium">{document.fileName}</p>
                  <p className="text-[11.5px] text-muted-foreground">
                    {CANDIDATE_DOCUMENT_TYPE_LABELS[document.type]} · {fileSize(document.sizeBytes)}{' '}
                    · {formatDate(document.createdAt)}
                    {document.uploadedByName ? ` · ${document.uploadedByName}` : ''}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {document.isConfidential ? (
                  <Badge variant="warning">
                    <Lock className="size-3" aria-hidden />
                    Confidential
                  </Badge>
                ) : null}
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={`/api/v1/recruitment/candidates/${candidateId}/documents/${document.id}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <Download />
                    Open
                  </a>
                </Button>
                {canManageCandidates ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${document.fileName}`}
                    className="text-destructive"
                    onClick={() => void handleRemove(document)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
