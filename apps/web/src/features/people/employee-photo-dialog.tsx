import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ImageUp, Trash2 } from 'lucide-react';
import {
  EMPLOYEE_PHOTO_ACCEPT,
  EMPLOYEE_PHOTO_MAX_BYTES,
  EMPLOYEE_PHOTO_TOO_LARGE_MESSAGE,
  EMPLOYEE_PHOTO_UNSUPPORTED_MESSAGE,
  normaliseEmployeePhotoContentType,
  type EmployeePhotoResult,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
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
import { SESSION_QUERY_KEY } from '@/features/auth/session-context';
import { prepareEmployeePhoto } from './employee-photo-resize';

/**
 * Managing one employee's profile photo.
 *
 * Opened from the avatar on the profile header. Everything the user can do with
 * a photo is here and nowhere else: see the one on file, put a different one
 * up, take it down, or leave without changing anything.
 *
 * The picked file is previewed before it is sent, because "upload" and "see
 * what you uploaded" happening in one step is how people end up with a
 * thumbnail of their thumb. Nothing reaches the server until Save.
 *
 * The two checks made here - format and size - are the same two the API makes
 * against the bytes it receives. They are repeated in the browser so a 12 MB
 * photo is refused instantly instead of after a minute of uploading, not
 * because the server relies on them. It does not.
 */

interface EmployeePhotoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  employeeName: string;
  /** What the avatar currently renders, uploaded photo or typed link. */
  photoUrl: string | null;
  /** True when an uploaded photo is what there is to remove. */
  hasPhoto: boolean;
}

export function EmployeePhotoDialog({
  open,
  onOpenChange,
  employeeId,
  employeeName,
  photoUrl,
  hasPhoto,
}: EmployeePhotoDialogProps) {
  const queryClient = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [picked, setPicked] = React.useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /** Object URLs are a resource, not a string: revoked when they go out of use. */
  React.useEffect(() => {
    if (!picked) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(picked);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  /** Every open starts from what is actually on the record. */
  React.useEffect(() => {
    if (!open) return;
    setPicked(null);
    setError(null);
  }, [open]);

  /**
   * Everything that renders this person is now stale.
   *
   * Refetching by employee id alone would leave the people list, the org chart
   * and the session's own avatar showing the previous photo until something
   * else happened to refresh them.
   */
  const refreshEverythingShowingThisPerson = async () => {
    await Promise.all([
      // Every employee query is keyed under this prefix - the detail record,
      // the paged list, the org chart, the profile summary - so one
      // invalidation reaches all of them.
      queryClient.invalidateQueries({ queryKey: ['employees'] }),
      // And the session, which carries the signed-in user's own avatar.
      queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
    ]);
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // Scaled in the browser where there is an image pipeline to do it with.
      // Falls back to the original file if the runtime cannot.
      const blob = await prepareEmployeePhoto(file);
      return api.upload<EmployeePhotoResult>(`/employees/${employeeId}/photo`, blob);
    },
    onSuccess: async () => {
      await refreshEverythingShowingThisPerson();
      toast.success('Profile photo updated.');
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<EmployeePhotoResult>(`/employees/${employeeId}/photo`),
    onSuccess: async () => {
      await refreshEverythingShowingThisPerson();
      toast.success('Profile photo removed.');
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const busy = upload.isPending || remove.isPending;

  const choose = (file: File | null | undefined) => {
    setError(null);
    if (!file) return;

    // The browser's own idea of the type, which is a guess from the extension
    // as often as not - hence the server sniffing the header regardless.
    if (normaliseEmployeePhotoContentType(file.type) === null) {
      setPicked(null);
      setError(EMPLOYEE_PHOTO_UNSUPPORTED_MESSAGE);
      return;
    }
    if (file.size > EMPLOYEE_PHOTO_MAX_BYTES) {
      setPicked(null);
      setError(EMPLOYEE_PHOTO_TOO_LARGE_MESSAGE);
      return;
    }

    setPicked(file);
  };

  const shown = previewUrl ?? photoUrl;

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent size="sm" aria-label="Profile photo">
        <DialogHeader>
          <DialogTitle>Profile photo</DialogTitle>
          <DialogDescription>
            {employeeName} · JPG, PNG or WebP, up to 5 MB.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col items-center gap-4">
          <Avatar
            name={employeeName}
            photoUrl={shown}
            colorKey={employeeId}
            size="xl"
            className="size-32 text-3xl"
          />

          <p className="text-center text-[13px] text-muted-foreground">
            {picked
              ? 'This is a preview. Nothing is saved until you choose Save.'
              : shown
                ? 'The photo currently on this profile.'
                : 'No photo yet, so their initials are shown instead.'}
          </p>

          <input
            ref={inputRef}
            type="file"
            accept={EMPLOYEE_PHOTO_ACCEPT}
            className="sr-only"
            // Reset between picks so choosing the same file twice still fires.
            onChange={(event) => {
              choose(event.target.files?.[0]);
              event.target.value = '';
            }}
            data-testid="employee-photo-input"
          />

          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <ImageUp />
              {shown ? 'Change photo' : 'Upload photo'}
            </Button>

            {hasPhoto && !picked ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive"
                loading={remove.isPending}
                disabled={busy}
                onClick={() => remove.mutate()}
              >
                <Trash2 />
                Remove photo
              </Button>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-center text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            loading={upload.isPending}
            disabled={!picked || busy}
            onClick={() => picked && upload.mutate(picked)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
