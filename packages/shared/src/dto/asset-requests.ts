import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/**
 * Asking the company for equipment.
 *
 * THE ONE DISTINCTION THIS MODULE EXISTS TO MAKE: approving a request and
 * fulfilling it are different acts, done by different people, at different
 * times, and recorded separately.
 *
 * The chain - team manager, HR, CEO - decides whether the company agrees to
 * give somebody a laptop. The asset manager then decides WHICH laptop and
 * hands it over. Neither can do the other's half: an approver cannot issue
 * kit, and no amount of `asset.request.fulfil` advances a request by one
 * stage. That is why `APPROVED` and `FULFILLED` are two statuses rather than
 * one, and why a request sits in the first of them for as long as the
 * storeroom takes.
 */

export const ASSET_REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'FULFILLED',
] as const;

export type AssetRequestStatus = (typeof ASSET_REQUEST_STATUSES)[number];

export const ASSET_REQUEST_STATUS_LABELS: Record<AssetRequestStatus, string> = {
  PENDING: 'Awaiting approval',
  APPROVED: 'Approved - awaiting IT',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn',
  FULFILLED: 'Delivered',
};

export const ASSET_REQUEST_STATUS_DESCRIPTIONS: Record<AssetRequestStatus, string> = {
  PENDING: 'Somewhere in the approval chain. The stages show who has it now.',
  APPROVED:
    'The company has agreed to this. It is with the asset manager, who chooses the equipment and hands it over.',
  REJECTED: 'Refused at one of the stages. The comment says which and why.',
  CANCELLED: 'Withdrawn by the person who raised it, before anybody decided.',
  FULFILLED: 'Every line has been issued or answered. Nothing outstanding.',
};

// ------------------------------------------------------------------ payloads

const itemSchema = z.object({
  categoryId: z.string().trim().min(1, 'Choose what you need.'),
  quantity: z.coerce
    .number()
    .int('Whole items only.')
    .min(1, 'At least one.')
    .max(20, 'More than twenty of one thing is a purchase order, not a request.')
    .default(1),
  notes: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

export const assetRequestCreateSchema = z.object({
  /**
   * Compulsory, and the shortest field in the product with the strongest
   * reason to be required. Three people are being asked to decide this, and
   * "laptop" is not a thing anybody can decide.
   */
  justification: z
    .string()
    .trim()
    .min(10, 'Say what you need it for - the people approving this have only what you write here.')
    .max(2000),
  neededBy: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date.')
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value)),
  items: z
    .array(itemSchema)
    .min(1, 'Add at least one item.')
    .max(10, 'Ten lines is enough for one request.')
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (seen.has(item.categoryId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'categoryId'],
            message: 'That is already on this request. Raise the quantity instead.',
          });
        }
        seen.add(item.categoryId);
      }
    }),
});

export type AssetRequestCreateInput = z.infer<typeof assetRequestCreateSchema>;

export const assetRequestCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

export type AssetRequestCancelInput = z.infer<typeof assetRequestCancelSchema>;

/** Issuing one asset against one approved line. */
export const assetRequestFulfilSchema = z.object({
  itemId: z.string().trim().min(1),
  assetId: z.string().trim().min(1, 'Choose the asset being issued.'),
  conditionAtAssignment: z.enum(['NEW', 'GOOD', 'FAIR', 'DAMAGED', 'CRITICAL']),
  assignedOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date.'),
  accessories: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  notes: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

export type AssetRequestFulfilInput = z.infer<typeof assetRequestFulfilSchema>;

/** Answering a line the company cannot supply. A reason is compulsory. */
export const assetRequestDeclineItemSchema = z.object({
  itemId: z.string().trim().min(1),
  reason: z
    .string()
    .trim()
    .min(5, 'Say why. "No spare monitors until April" is an answer; silence is not.')
    .max(500),
});

export type AssetRequestDeclineItemInput = z.infer<typeof assetRequestDeclineItemSchema>;

export const assetRequestQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ASSET_REQUEST_STATUSES).optional(),
  employeeId: z.string().trim().max(64).optional(),
  /**
   * `mine` is the employee's own list, `queue` is everything approved and not
   * yet fully delivered - the asset manager's screen. `queue` needs
   * `asset.request.read.all`; without it the server serves the caller's scope
   * regardless of what the query asked for.
   */
  view: z.enum(['all', 'mine', 'queue']).default('all'),
  q: z.string().trim().max(120).optional(),
});

export type AssetRequestQuery = z.infer<typeof assetRequestQuerySchema>;

// ------------------------------------------------------------------- records

export interface AssetRequestItemRecord {
  id: string;
  categoryId: string;
  categoryName: string;
  quantity: number;
  notes: string | null;
  /** How many units have actually been handed over. Counted from assignments. */
  fulfilledCount: number;
  declinedAt: string | null;
  declineReason: string | null;
  /** The assets issued against this line, so far. */
  issuedAssets: Array<{ assetId: string; assetTag: string; name: string; assignedAt: string }>;
  /** True when this line needs nothing further: delivered in full, or declined. */
  isSettled: boolean;
}

export interface AssetRequestListItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  teamName: string | null;
  status: AssetRequestStatus;
  justification: string;
  neededBy: string | null;
  itemCount: number;
  /** "2 of 4 delivered", computed server-side so two screens cannot disagree. */
  fulfilledCount: number;
  requestedCount: number;
  approvalRequestId: string | null;
  /** Which rung it is sitting on, in words. Null once it is decided. */
  currentStageLabel: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** True when this caller is on the step that is waiting right now. */
  awaitingMyDecision: boolean;
}

export interface AssetRequestDetail extends AssetRequestListItem {
  items: AssetRequestItemRecord[];
  cancelledAt: string | null;
  fulfilledAt: string | null;
  /** Only the requester, and only while nobody has decided. */
  canCancel: boolean;
  /**
   * True when this caller may issue kit against this request - which needs the
   * request to be APPROVED and the caller to hold the fulfilment grants. It is
   * never true while the chain is still running, whatever the caller holds.
   */
  canFulfil: boolean;
}
