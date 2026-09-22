import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ASSET_ACCESSORY_SUGGESTIONS,
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_DISPOSAL_METHODS,
  ASSET_DISPOSAL_METHOD_LABELS,
  ASSET_RETURN_OUTCOMES,
  ASSET_RETURN_OUTCOME_LABELS,
  missingAccessories,
  type AssetDetailRecord,
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
import { EmployeePicker } from './employee-picker';
import { AccessoryPicker } from './accessory-picker';

/**
 * The lifecycle dialogs: assign, return, transfer, repair, lost/damaged,
 * retire, dispose.
 *
 * One file because they are one conversation with the server - each posts to
 * one endpoint, each gets back either a record or a field error, and each
 * invalidates the same query keys. Splitting them into seven files would mean
 * seven copies of the mutation-and-field-error dance below, which is exactly
 * the sort of thing that ends up subtly different in the sixth copy.
 *
 * None of them decides anything. Which dialog a page OFFERS comes from
 * `detail.can`, computed by the server from the grant and the asset's state
 * together; what a dialog may SEND is checked again by the endpoint. A form
 * here that got its own rules wrong would produce a refusal, never a wrong
 * write.
 */

/** Today, as the `yyyy-MM-dd` every date field in this module speaks. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type FieldErrors = Record<string, string>;

/**
 * The shared half of every dialog: post it, show field errors, close on
 * success, and tell the rest of the app that this asset moved.
 */
function useAssetAction<TBody>(options: {
  assetId: string;
  path: string;
  method?: 'post' | 'patch';
  successMessage: string;
  onDone: () => void;
  setErrors: (errors: FieldErrors) => void;
  setFormError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: TBody) =>
      options.method === 'patch'
        ? api.patch<unknown>(options.path, body)
        : api.post<unknown>(options.path, body),
    onSuccess: () => {
      /*
       * Everything under `assets`, plus the employee tabs and the dashboard
       * card. A handover changes the register, the asset, the person's list and
       * the count on their profile, and a narrower invalidation would leave one
       * of those four showing yesterday.
       */
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      toast.success(options.successMessage);
      options.onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        options.setErrors(
          Object.fromEntries(
            Object.entries(error.details).map(([field, messages]) => [field, messages[0] ?? '']),
          ),
        );
        return;
      }
      options.setFormError(errorMessage(error));
    },
  });
}

/** The chrome every dialog shares, so they open, scroll and close alike. */
function ActionDialog({
  open,
  title,
  description,
  submitLabel,
  pending,
  formError,
  onClose,
  onSubmit,
  children,
  destructive = false,
}: {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  pending: boolean;
  formError: string | null;
  onClose: () => void;
  onSubmit: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {formError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
              {formError}
            </p>
          ) : null}
          {children}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={pending}
            className={destructive ? 'bg-destructive text-white hover:bg-destructive/90' : ''}
          >
            {pending ? 'Saving...' : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DialogProps {
  open: boolean;
  asset: AssetDetailRecord;
  onClose: () => void;
}

// ------------------------------------------------------------------ assign

export function AssignAssetDialog({ open, asset, onClose }: DialogProps) {
  const [employeeId, setEmployeeId] = React.useState('');
  const [assignedOn, setAssignedOn] = React.useState(today());
  const [condition, setCondition] = React.useState(asset.condition);
  const [accessories, setAccessories] = React.useState<string[]>([]);
  const [notes, setNotes] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setEmployeeId('');
    setAssignedOn(today());
    setCondition(asset.condition);
    setAccessories([]);
    setNotes('');
    setErrors({});
    setFormError(null);
  }, [open, asset.condition]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/assign`,
    successMessage: `${asset.assetTag} issued.`,
    onDone: onClose,
    setErrors,
    setFormError,
  });

  return (
    <ActionDialog
      open={open}
      title={`Assign ${asset.assetTag}`}
      description="Record who is taking it, what state it is in, and what goes with it."
      submitLabel="Assign asset"
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({
          employeeId,
          assignedOn,
          conditionAtAssignment: condition,
          accessories,
          notes: notes.trim() || null,
        })
      }
    >
      <FormField label="Employee" htmlFor="assign-employee" error={errors.employeeId} required>
        <EmployeePicker id="assign-employee" value={employeeId} onChange={setEmployeeId} />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Assignment date" htmlFor="assign-on" error={errors.assignedOn} required>
          <Input
            id="assign-on"
            type="date"
            value={assignedOn}
            onChange={(event) => setAssignedOn(event.target.value)}
          />
        </FormField>

        <FormField
          label="Condition at handover"
          htmlFor="assign-condition"
          hint="What it looked like when it left. Nobody can argue with this later."
          error={errors.conditionAtAssignment}
          required
        >
          <NativeSelect
            id="assign-condition"
            value={condition}
            onChange={(event) => setCondition(event.target.value as typeof condition)}
          >
            {ASSET_CONDITIONS.map((value) => (
              <option key={value} value={value}>
                {ASSET_CONDITION_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>

      <FormField label="Accessories" htmlFor="assign-accessories" error={errors.accessories}>
        <AccessoryPicker
          id="assign-accessories"
          options={ASSET_ACCESSORY_SUGGESTIONS}
          value={accessories}
          onChange={setAccessories}
        />
      </FormField>

      <FormField label="Notes" htmlFor="assign-notes" error={errors.notes}>
        <Textarea
          id="assign-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
    </ActionDialog>
  );
}

// ------------------------------------------------------------------ return

export function ReturnAssetDialog({ open, asset, onClose }: DialogProps) {
  const issued = React.useMemo(
    () => asset.assignments.find((row) => row.status === 'ACTIVE')?.accessoriesIssued ?? [],
    [asset.assignments],
  );

  const [returnedOn, setReturnedOn] = React.useState(today());
  const [condition, setCondition] = React.useState(asset.condition);
  const [returned, setReturned] = React.useState<string[]>(issued);
  const [additionalMissing, setAdditionalMissing] = React.useState<string[]>([]);
  const [damage, setDamage] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [outcome, setOutcome] = React.useState<(typeof ASSET_RETURN_OUTCOMES)[number]>('RETURNED');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setReturnedOn(today());
    setCondition(asset.condition);
    setReturned(issued);
    setAdditionalMissing([]);
    setDamage('');
    setNotes('');
    setOutcome('RETURNED');
    setErrors({});
    setFormError(null);
  }, [open, asset.condition, issued]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/return`,
    successMessage: `${asset.assetTag} taken back.`,
    onDone: onClose,
    setErrors,
    setFormError,
  });

  /*
   * Shown, not typed. The same function the server uses computes it, so the
   * line on the form and the row written in the database cannot disagree.
   */
  const missing = missingAccessories(issued, returned);

  return (
    <ActionDialog
      open={open}
      title={`Return ${asset.assetTag}`}
      description="Record what came back, what did not, and what state it is in."
      submitLabel="Record return"
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({
          returnedOn,
          conditionAtReturn: condition,
          accessoriesReturned: returned,
          additionalMissing,
          damageDescription: damage.trim() || null,
          notes: notes.trim() || null,
          outcome,
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Return date" htmlFor="return-on" error={errors.returnedOn} required>
          <Input
            id="return-on"
            type="date"
            value={returnedOn}
            onChange={(event) => setReturnedOn(event.target.value)}
          />
        </FormField>

        <FormField
          label="Condition on return"
          htmlFor="return-condition"
          error={errors.conditionAtReturn}
          required
        >
          <NativeSelect
            id="return-condition"
            value={condition}
            onChange={(event) => setCondition(event.target.value as typeof condition)}
          >
            {ASSET_CONDITIONS.map((value) => (
              <option key={value} value={value}>
                {ASSET_CONDITION_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>

      {issued.length > 0 ? (
        <FormField
          label="Accessories issued"
          htmlFor="return-accessories"
          hint="Untick anything that did not come back."
          error={errors.accessoriesReturned}
        >
          <AccessoryPicker
            id="return-accessories"
            options={issued}
            value={returned}
            onChange={setReturned}
            allowCustom={false}
          />
        </FormField>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Nothing was recorded as issued with this asset.
        </p>
      )}

      <FormField
        label="Anything else missing"
        htmlFor="return-missing"
        hint="Something that went missing but was never recorded as issued."
        error={errors.additionalMissing}
      >
        <AccessoryPicker
          id="return-missing"
          options={ASSET_ACCESSORY_SUGGESTIONS}
          value={additionalMissing}
          onChange={setAdditionalMissing}
        />
      </FormField>

      {missing.length > 0 || additionalMissing.length > 0 ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] text-warning-foreground">
          Missing: {[...missing, ...additionalMissing].join(', ')}
        </p>
      ) : null}

      <FormField label="Damage" htmlFor="return-damage" error={errors.damageDescription}>
        <Textarea
          id="return-damage"
          rows={2}
          value={damage}
          maxLength={2000}
          placeholder="What is wrong with it, in words."
          onChange={(event) => setDamage(event.target.value)}
        />
      </FormField>

      <FormField
        label="What happens to it now"
        htmlFor="return-outcome"
        hint="“Checked and back in stock” is a claim the server will refuse if something is missing or broken."
        error={errors.outcome}
      >
        <NativeSelect
          id="return-outcome"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as typeof outcome)}
        >
          {ASSET_RETURN_OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {ASSET_RETURN_OUTCOME_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <FormField label="Notes" htmlFor="return-notes" error={errors.notes}>
        <Textarea
          id="return-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
    </ActionDialog>
  );
}

// ---------------------------------------------------------------- transfer

export function TransferAssetDialog({ open, asset, onClose }: DialogProps) {
  const active = asset.assignments.find((row) => row.status === 'ACTIVE') ?? null;

  const [toEmployeeId, setToEmployeeId] = React.useState('');
  const [transferredOn, setTransferredOn] = React.useState(today());
  const [condition, setCondition] = React.useState(asset.condition);
  const [reason, setReason] = React.useState('');
  const [accessories, setAccessories] = React.useState<string[]>(active?.accessoriesIssued ?? []);
  const [notes, setNotes] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setToEmployeeId('');
    setTransferredOn(today());
    setCondition(asset.condition);
    setReason('');
    setAccessories(active?.accessoriesIssued ?? []);
    setNotes('');
    setErrors({});
    setFormError(null);
  }, [open, asset.condition, active?.accessoriesIssued]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/transfer`,
    successMessage: `${asset.assetTag} transferred.`,
    onDone: onClose,
    setErrors,
    setFormError,
  });

  return (
    <ActionDialog
      open={open}
      title={`Transfer ${asset.assetTag}`}
      description="It goes straight to somebody else. The previous handover is closed and kept, never overwritten."
      submitLabel="Transfer asset"
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({
          toEmployeeId,
          transferredOn,
          conditionAtTransfer: condition,
          reason: reason.trim(),
          accessories,
          notes: notes.trim() || null,
        })
      }
    >
      <FormField label="Currently with" htmlFor="transfer-from">
        <Input
          id="transfer-from"
          value={asset.holder?.fullName ?? 'Nobody'}
          readOnly
          disabled
        />
      </FormField>

      <FormField
        label="Transferring to"
        htmlFor="transfer-to"
        error={errors.toEmployeeId}
        required
      >
        <EmployeePicker id="transfer-to" value={toEmployeeId} onChange={setToEmployeeId} />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Transfer date"
          htmlFor="transfer-on"
          error={errors.transferredOn}
          required
        >
          <Input
            id="transfer-on"
            type="date"
            value={transferredOn}
            onChange={(event) => setTransferredOn(event.target.value)}
          />
        </FormField>

        <FormField
          label="Condition"
          htmlFor="transfer-condition"
          error={errors.conditionAtTransfer}
          required
        >
          <NativeSelect
            id="transfer-condition"
            value={condition}
            onChange={(event) => setCondition(event.target.value as typeof condition)}
          >
            {ASSET_CONDITIONS.map((value) => (
              <option key={value} value={value}>
                {ASSET_CONDITION_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>

      <FormField label="Reason" htmlFor="transfer-reason" error={errors.reason} required>
        <Input
          id="transfer-reason"
          value={reason}
          maxLength={500}
          placeholder="Moved to the support team"
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>

      <FormField
        label="Accessories going with it"
        htmlFor="transfer-accessories"
        error={errors.accessories}
      >
        <AccessoryPicker
          id="transfer-accessories"
          options={ASSET_ACCESSORY_SUGGESTIONS}
          value={accessories}
          onChange={setAccessories}
        />
      </FormField>

      <FormField label="Notes" htmlFor="transfer-notes" error={errors.notes}>
        <Textarea
          id="transfer-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
    </ActionDialog>
  );
}

// ------------------------------------------------------------------ repair

export function SendForRepairDialog({ open, asset, onClose }: DialogProps) {
  const [problem, setProblem] = React.useState('');
  const [reportedOn, setReportedOn] = React.useState(today());
  const [sentOn, setSentOn] = React.useState(today());
  const [vendor, setVendor] = React.useState('');
  const [estimatedCost, setEstimatedCost] = React.useState('');
  const [expectedReturnOn, setExpectedReturnOn] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setProblem('');
    setReportedOn(today());
    setSentOn(today());
    setVendor('');
    setEstimatedCost('');
    setExpectedReturnOn('');
    setNotes('');
    setErrors({});
    setFormError(null);
  }, [open]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/repairs`,
    successMessage: `${asset.assetTag} sent for repair.`,
    onDone: onClose,
    setErrors,
    setFormError,
  });

  return (
    <ActionDialog
      open={open}
      title={`Send ${asset.assetTag} for repair`}
      description="The asset comes back to whatever it is now when the repair ends — assigned stays assigned."
      submitLabel="Send for repair"
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({
          problem: problem.trim(),
          reportedOn,
          sentOn,
          vendor: vendor.trim() || null,
          estimatedCost: estimatedCost.trim() === '' ? null : Number(estimatedCost),
          expectedReturnOn: expectedReturnOn || null,
          notes: notes.trim() || null,
        })
      }
    >
      <FormField label="Problem" htmlFor="repair-problem" error={errors.problem} required>
        <Textarea
          id="repair-problem"
          rows={2}
          value={problem}
          maxLength={500}
          placeholder="Screen flickers on the left third"
          onChange={(event) => setProblem(event.target.value)}
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Reported date"
          htmlFor="repair-reported"
          error={errors.reportedOn}
          required
        >
          <Input
            id="repair-reported"
            type="date"
            value={reportedOn}
            onChange={(event) => setReportedOn(event.target.value)}
          />
        </FormField>

        <FormField label="Sent date" htmlFor="repair-sent" error={errors.sentOn} required>
          <Input
            id="repair-sent"
            type="date"
            value={sentOn}
            onChange={(event) => setSentOn(event.target.value)}
          />
        </FormField>

        <FormField label="Vendor / repairer" htmlFor="repair-vendor" error={errors.vendor}>
          <Input
            id="repair-vendor"
            value={vendor}
            maxLength={160}
            onChange={(event) => setVendor(event.target.value)}
          />
        </FormField>

        <FormField
          label="Estimated cost"
          htmlFor="repair-estimate"
          error={errors.estimatedCost}
        >
          <Input
            id="repair-estimate"
            type="number"
            min={0}
            step="0.01"
            value={estimatedCost}
            onChange={(event) => setEstimatedCost(event.target.value)}
          />
        </FormField>
      </div>

      <FormField
        label="Expected back"
        htmlFor="repair-expected"
        error={errors.expectedReturnOn}
      >
        <Input
          id="repair-expected"
          type="date"
          value={expectedReturnOn}
          onChange={(event) => setExpectedReturnOn(event.target.value)}
        />
      </FormField>

      <FormField label="Notes" htmlFor="repair-notes" error={errors.notes}>
        <Textarea
          id="repair-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
    </ActionDialog>
  );
}

export function CompleteRepairDialog({
  open,
  asset,
  repairId,
  onClose,
}: DialogProps & { repairId: string }) {
  const [status, setStatus] = React.useState<'COMPLETED' | 'CANCELLED'>('COMPLETED');
  const [returnedOn, setReturnedOn] = React.useState(today());
  const [actualCost, setActualCost] = React.useState('');
  const [condition, setCondition] = React.useState<string>('');
  const [completionNotes, setCompletionNotes] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setStatus('COMPLETED');
    setReturnedOn(today());
    setActualCost('');
    setCondition('');
    setCompletionNotes('');
    setErrors({});
    setFormError(null);
  }, [open]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/repairs/${repairId}`,
    method: 'patch',
    successMessage: `${asset.assetTag} is back.`,
    onDone: onClose,
    setErrors,
    setFormError,
  });

  return (
    <ActionDialog
      open={open}
      title="Record the repair"
      description="Whatever happened, the asset goes back to the status it had before it left."
      submitLabel="Save"
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({
          status,
          returnedOn,
          actualCost: actualCost.trim() === '' ? null : Number(actualCost),
          condition: condition === '' ? undefined : condition,
          completionNotes: completionNotes.trim() || null,
        })
      }
    >
      <FormField label="Outcome" htmlFor="repair-outcome" error={errors.status} required>
        <NativeSelect
          id="repair-outcome"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="COMPLETED">Repaired and back</option>
          <option value="CANCELLED">Repair called off</option>
        </NativeSelect>
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Returned date"
          htmlFor="repair-returned"
          error={errors.returnedOn}
          required
        >
          <Input
            id="repair-returned"
            type="date"
            value={returnedOn}
            onChange={(event) => setReturnedOn(event.target.value)}
          />
        </FormField>

        <FormField label="Actual cost" htmlFor="repair-actual" error={errors.actualCost}>
          <Input
            id="repair-actual"
            type="number"
            min={0}
            step="0.01"
            value={actualCost}
            onChange={(event) => setActualCost(event.target.value)}
          />
        </FormField>
      </div>

      <FormField
        label="Condition now"
        htmlFor="repair-condition"
        hint="Leave blank to keep what the register already says."
        error={errors.condition}
      >
        <NativeSelect
          id="repair-condition"
          value={condition}
          onChange={(event) => setCondition(event.target.value)}
        >
          <option value="">Unchanged</option>
          {ASSET_CONDITIONS.map((value) => (
            <option key={value} value={value}>
              {ASSET_CONDITION_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <FormField label="Repair notes" htmlFor="repair-outcome-notes" error={errors.completionNotes}>
        <Textarea
          id="repair-outcome-notes"
          rows={2}
          value={completionNotes}
          maxLength={2000}
          onChange={(event) => setCompletionNotes(event.target.value)}
        />
      </FormField>
    </ActionDialog>
  );
}

// ---------------------------------------------------------- lost / damaged

export function ReportIncidentDialog({
  open,
  asset,
  kind,
  onClose,
}: DialogProps & { kind: 'LOST' | 'DAMAGED' }) {
  const [occurredOn, setOccurredOn] = React.useState(today());
  const [reason, setReason] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setOccurredOn(today());
    setReason('');
    setDescription('');
    setNotes('');
    setErrors({});
    setFormError(null);
  }, [open, kind]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/incidents`,
    successMessage: kind === 'LOST' ? 'Recorded as lost.' : 'Recorded as damaged.',
    onDone: onClose,
    setErrors,
    setFormError,
  });

  return (
    <ActionDialog
      open={open}
      title={kind === 'LOST' ? `Report ${asset.assetTag} lost` : `Report ${asset.assetTag} damaged`}
      description="The asset stays on the register. Nothing here deletes it, and the handover it happened on stays open."
      submitLabel="Record it"
      destructive
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({
          kind,
          occurredOn,
          reason: reason.trim(),
          description: description.trim() || null,
          notes: notes.trim() || null,
        })
      }
    >
      <FormField label="Date" htmlFor="incident-on" error={errors.occurredOn} required>
        <Input
          id="incident-on"
          type="date"
          value={occurredOn}
          onChange={(event) => setOccurredOn(event.target.value)}
        />
      </FormField>

      <FormField label="Reason" htmlFor="incident-reason" error={errors.reason} required>
        <Input
          id="incident-reason"
          value={reason}
          maxLength={200}
          placeholder={kind === 'LOST' ? 'Left on a train' : 'Dropped, screen cracked'}
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>

      <FormField label="Description" htmlFor="incident-description" error={errors.description}>
        <Textarea
          id="incident-description"
          rows={3}
          value={description}
          maxLength={4000}
          onChange={(event) => setDescription(event.target.value)}
        />
      </FormField>

      <FormField label="Notes" htmlFor="incident-notes" error={errors.notes}>
        <Textarea
          id="incident-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>

      {asset.holder ? (
        <p className="text-[13px] text-muted-foreground">
          {asset.holder.fullName} still has this on paper. Recording it here does not close their
          handover — take it back when the matter is settled.
        </p>
      ) : null}
    </ActionDialog>
  );
}

// --------------------------------------------------------- retire, dispose

export function RetireAssetDialog({ open, asset, onClose }: DialogProps) {
  const [retiredOn, setRetiredOn] = React.useState(today());
  const [reason, setReason] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setRetiredOn(today());
    setReason('');
    setNotes('');
    setErrors({});
    setFormError(null);
  }, [open]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/retire`,
    successMessage: `${asset.assetTag} retired.`,
    onDone: onClose,
    setErrors,
    setFormError,
  });

  return (
    <ActionDialog
      open={open}
      title={`Retire ${asset.assetTag}`}
      description="Taken out of service, still the company’s. It cannot be issued again."
      submitLabel="Retire asset"
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({ retiredOn, reason: reason.trim(), notes: notes.trim() || null })
      }
    >
      <FormField label="Retirement date" htmlFor="retire-on" error={errors.retiredOn} required>
        <Input
          id="retire-on"
          type="date"
          value={retiredOn}
          onChange={(event) => setRetiredOn(event.target.value)}
        />
      </FormField>

      <FormField label="Reason" htmlFor="retire-reason" error={errors.reason} required>
        <Input
          id="retire-reason"
          value={reason}
          maxLength={500}
          placeholder="End of life, replaced"
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>

      <FormField label="Notes" htmlFor="retire-notes" error={errors.notes}>
        <Textarea
          id="retire-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
    </ActionDialog>
  );
}

export function DisposeAssetDialog({ open, asset, onClose }: DialogProps) {
  const [disposedOn, setDisposedOn] = React.useState(today());
  const [method, setMethod] = React.useState<(typeof ASSET_DISPOSAL_METHODS)[number]>('SCRAPPED');
  const [reason, setReason] = React.useState('');
  const [finalValue, setFinalValue] = React.useState('');
  const [approvedBy, setApprovedBy] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDisposedOn(today());
    setMethod('SCRAPPED');
    setReason('');
    setFinalValue('');
    setApprovedBy('');
    setNotes('');
    setErrors({});
    setFormError(null);
  }, [open]);

  const save = useAssetAction({
    assetId: asset.id,
    path: `/assets/${asset.id}/dispose`,
    successMessage: `${asset.assetTag} disposed of.`,
    onDone: onClose,
    setErrors,
    setFormError,
  });

  return (
    <ActionDialog
      open={open}
      title={`Dispose of ${asset.assetTag}`}
      description="The end of the record. Nothing comes back from this, and the asset can never be issued again."
      submitLabel="Dispose of asset"
      destructive
      pending={save.isPending}
      formError={formError}
      onClose={onClose}
      onSubmit={() =>
        save.mutate({
          disposedOn,
          method,
          reason: reason.trim(),
          finalValue: finalValue.trim() === '' ? null : Number(finalValue),
          approvedByEmployeeId: approvedBy || null,
          notes: notes.trim() || null,
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Disposal date" htmlFor="dispose-on" error={errors.disposedOn} required>
          <Input
            id="dispose-on"
            type="date"
            value={disposedOn}
            onChange={(event) => setDisposedOn(event.target.value)}
          />
        </FormField>

        <FormField label="Method" htmlFor="dispose-method" error={errors.method} required>
          <NativeSelect
            id="dispose-method"
            value={method}
            onChange={(event) => setMethod(event.target.value as typeof method)}
          >
            {ASSET_DISPOSAL_METHODS.map((value) => (
              <option key={value} value={value}>
                {ASSET_DISPOSAL_METHOD_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>

      <FormField label="Reason" htmlFor="dispose-reason" error={errors.reason} required>
        <Input
          id="dispose-reason"
          value={reason}
          maxLength={500}
          placeholder="Beyond economic repair"
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Final value"
          htmlFor="dispose-value"
          hint="What it fetched. Blank means not stated; zero is a real answer."
          error={errors.finalValue}
        >
          <Input
            id="dispose-value"
            type="number"
            min={0}
            step="0.01"
            value={finalValue}
            onChange={(event) => setFinalValue(event.target.value)}
          />
        </FormField>

        <FormField
          label="Approved by"
          htmlFor="dispose-approver"
          error={errors.approvedByEmployeeId}
        >
          {/*
            * Leavers included here, and only here.
            *
            * The other two pickers - assign and transfer - are choosing
            * somebody to HAND a machine to, and the endpoints behind them
            * already refuse an employee who has left, so listing them would
            * only offer a choice that 422s. This field is different: it records
            * WHO SIGNED OFF a write-off, which is a historical fact, and the
            * manager who approved one last quarter may well have moved on
            * since.
            */}
          <EmployeePicker
            id="dispose-approver"
            value={approvedBy}
            onChange={setApprovedBy}
            placeholder="Nobody recorded"
            includeInactive
          />
        </FormField>
      </div>

      <FormField label="Notes" htmlFor="dispose-notes" error={errors.notes}>
        <Textarea
          id="dispose-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
    </ActionDialog>
  );
}
