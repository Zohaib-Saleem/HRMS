import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Upload } from 'lucide-react';
import {
  ASSET_DOCUMENT_TYPES,
  ASSET_DOCUMENT_TYPE_LABELS,
  type AssetDocumentRecord,
  type AssetDocumentType,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';

/**
 * The paperwork: invoices, warranties, repair receipts, signed handovers.
 *
 * Uploads go to the SAME object store the case attachments and candidate
 * documents use - one file as the raw request body, the server sniffing the
 * bytes and naming the object itself. Nothing in this component knows where a
 * file lives, which is the whole point of section 13: no second storage system
 * was built for assets.
 */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AssetDocuments({
  assetId,
  canManage,
}: {
  assetId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [type, setType] = React.useState<AssetDocumentType>('INVOICE');

  const query = useQuery({
    queryKey: ['assets', 'documents', assetId],
    queryFn: () => api.get<AssetDocumentRecord[]>(`/assets/${assetId}/documents`),
  });

  const upload = useMutation({
    mutationFn: (file: File) =>
      api.upload<AssetDocumentRecord>(
        `/assets/${assetId}/documents?type=${type}&filename=${encodeURIComponent(file.name)}`,
        file,
      ),
    onSuccess: (document) => {
      void queryClient.invalidateQueries({ queryKey: ['assets', 'documents', assetId] });
      toast.success(`${document.fileName} attached.`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (document: AssetDocumentRecord) =>
      api.delete<void>(`/assets/${assetId}/documents/${document.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets', 'documents', assetId] });
      toast.success('Document removed.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const documents = query.data ?? [];

  const handleDelete = async (document: AssetDocumentRecord) => {
    const ok = await confirm({
      title: `Remove ${document.fileName}?`,
      description: 'The file is deleted from the store. This cannot be undone.',
      confirmLabel: 'Remove',
      tone: 'destructive',
    });
    if (ok) remove.mutate(document);
  };

  return (
    <Card>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3.5">
          <NativeSelect
            aria-label="Document type"
            value={type}
            className="sm:w-48"
            onChange={(event) => setType(event.target.value as AssetDocumentType)}
          >
            {ASSET_DOCUMENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {ASSET_DOCUMENT_TYPE_LABELS[value]}
              </option>
            ))}
          </NativeSelect>

          <input
            ref={fileInput}
            type="file"
            className="hidden"
            aria-label="Choose a file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
              event.target.value = '';
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            <Upload />
            {upload.isPending ? 'Uploading...' : 'Attach a file'}
          </Button>
          <span className="text-[12.5px] text-muted-foreground">
            JPEG, PNG, WebP, PDF, TXT or CSV, up to 10 MB.
          </span>
        </div>
      ) : null}

      <TableWrapper>
        <Table>
          <THead>
            <TR>
              <TH>File</TH>
              <TH>Type</TH>
              <TH className="text-right">Size</TH>
              <TH>Added by</TH>
              {canManage ? <TH className="text-right">Actions</TH> : null}
            </TR>
          </THead>
          <TBody>
            {query.isLoading ? (
              <TableSkeleton rows={3} columns={canManage ? 5 : 4} />
            ) : query.isError ? (
              <TR>
                <TD colSpan={5}>
                  <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                </TD>
              </TR>
            ) : documents.length === 0 ? (
              <TR>
                <TD colSpan={5}>
                  <EmptyState
                    icon={FileText}
                    title="No paperwork yet"
                    description="Attach the invoice, the warranty or a repair receipt."
                  />
                </TD>
              </TR>
            ) : (
              documents.map((document) => (
                <TR key={document.id}>
                  <TD className="text-[13px]">
                    <a
                      href={`/api/v1/assets/${assetId}/documents/${document.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      {document.fileName}
                    </a>
                  </TD>
                  <TD className="text-[13px]">{ASSET_DOCUMENT_TYPE_LABELS[document.type]}</TD>
                  <TD className="tabular text-right text-[13px]">
                    {humanSize(document.sizeBytes)}
                  </TD>
                  <TD className="text-[13px]">
                    {document.uploadedByName ?? <span className="text-muted-foreground">--</span>}
                  </TD>
                  {canManage ? (
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() => void handleDelete(document)}
                      >
                        Remove
                      </Button>
                    </TD>
                  ) : null}
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </TableWrapper>
    </Card>
  );
}
