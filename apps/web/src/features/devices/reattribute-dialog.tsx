import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, MoonStar, Search } from 'lucide-react';
import type { ReattributeRangeResult } from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/field';
import { EmptyState } from '@/components/feedback/states';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Going back over history for the day that ends after midnight.
 *
 * Punches imported before the overnight rule existed were read on the wrong
 * side of midnight and scored that way. This is how those days are revisited.
 *
 * Deliberately two steps. The preview is not politeness - it is the whole
 * safety story: this rewrites days that have already been reported on and may
 * already have been paid, so the list of what will change is shown, with names
 * and dates, before anything is written. Nothing is applied until somebody has
 * looked at that list.
 *
 * What it will NOT offer is "recalculate the range". Re-scoring every day in a
 * window re-reads days nothing was wrong with under today's rules and restates
 * them - a much larger change than the one being asked for, and one that hides
 * inside a number that looks like success.
 */

const firstOfMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

export function ReattributeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [from, setFrom] = React.useState(firstOfMonth);
  const [to, setTo] = React.useState(today);
  const [preview, setPreview] = React.useState<ReattributeRangeResult | null>(null);

  // A preview belongs to the range it was taken of. Editing either date makes
  // it stale, and a stale preview is the one thing worse than none.
  const setRange = (patch: { from?: string; to?: string }) => {
    if (patch.from !== undefined) setFrom(patch.from);
    if (patch.to !== undefined) setTo(patch.to);
    setPreview(null);
  };

  const run = (dryRun: boolean) =>
    api.post<ReattributeRangeResult>('/attendance/punches/reattribute-range', {
      from,
      to,
      dryRun,
    });

  const scan = useMutation({
    mutationFn: () => run(true),
    onSuccess: (result) => setPreview(result),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const apply = useMutation({
    mutationFn: () => run(false),
    onSuccess: async (result) => {
      toast.success(
        `${result.moved.length} day(s) re-attributed, ${result.daysRecalculated} day(s) rescored.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['punches'] });
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  React.useEffect(() => {
    if (!open) setPreview(null);
  }, [open]);

  const busy = scan.isPending || apply.isPending;
  const nothingToDo = preview !== null && preview.moved.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Re-attribute overnight punches</DialogTitle>
          <DialogDescription>
            Finds punches after midnight that close the previous day and gives them back to it.
            Only the days that actually change are rescored - nothing else in the range is touched.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="From" htmlFor="reattribute-from">
              <Input
                id="reattribute-from"
                type="date"
                value={from}
                onChange={(e) => setRange({ from: e.target.value })}
              />
            </FormField>
            <FormField label="To" htmlFor="reattribute-to">
              <Input
                id="reattribute-to"
                type="date"
                value={to}
                onChange={(e) => setRange({ to: e.target.value })}
              />
            </FormField>
          </div>

          {preview === null ? (
            <p className="text-sm text-muted-foreground">
              Preview first. Nothing is written until you have seen what would move.
            </p>
          ) : nothingToDo ? (
            <EmptyState
              icon={MoonStar}
              title="Nothing to move"
              description={`Scanned ${preview.daysScanned} day(s) across ${preview.employeesScanned} employee(s). Every punch is already on the day it belongs to.`}
            />
          ) : (
            <>
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <span>
                  {preview.moved.length} day(s) will change, and both sides of each move are
                  rescored. Days with an admin correction are left as they are.
                </span>
              </div>

              <TableWrapper className="max-h-72 overflow-y-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Employee</TH>
                      <TH>Punched on</TH>
                      <TH>Closes</TH>
                      <TH className="text-right">Punches</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {preview.moved.map((move) => (
                      <TR key={`${move.employeeId}:${move.fromDayKey}`}>
                        <TD>{move.employeeName ?? move.employeeId}</TD>
                        <TD>{move.fromDayKey}</TD>
                        <TD>{move.toDayKey}</TD>
                        <TD className="text-right tabular-nums">{move.punchesMoved}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrapper>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="outline" loading={scan.isPending} onClick={() => scan.mutate()}>
            <Search />
            Preview
          </Button>
          <Button
            loading={apply.isPending}
            disabled={preview === null || nothingToDo || busy}
            onClick={() => apply.mutate()}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
