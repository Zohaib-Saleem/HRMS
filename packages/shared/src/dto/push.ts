import { z } from 'zod';

/**
 * Browser push notifications.
 *
 * A second delivery channel for the in-app notifications, never a replacement
 * for them: every push is about a notification row that already exists, and
 * the bell shows that row whether or not the push arrived.
 */

/**
 * What a person can switch off for push. Muting one never touches the in-app
 * inbox - the notification is still written and still shows in the bell.
 */
export const PUSH_CATEGORIES = [
  'CASES',
  'ATTENDANCE',
  'LEAVE',
  'ASSETS',
  'PAYROLL',
  'GENERAL',
] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export const PUSH_CATEGORY_LABELS: Record<PushCategory, string> = {
  CASES: 'Cases and IT issues',
  ATTENDANCE: 'Attendance and corrections',
  LEAVE: 'Leave and approvals',
  ASSETS: 'Assets',
  PAYROLL: 'Payroll and salary advances',
  GENERAL: 'Everything else',
};

export const PUSH_SUBSCRIPTION_STATUSES = ['ACTIVE', 'DISABLED', 'EXPIRED'] as const;
export type PushSubscriptionStatus = (typeof PUSH_SUBSCRIPTION_STATUSES)[number];

/**
 * What the browser hands over from `PushSubscription.toJSON()`.
 *
 * The endpoint must be https: every real push service is, and refusing
 * anything else keeps the server from being pointed at an internal address.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith('https://'), 'A push endpoint must use https.'),
  keys: z.object({
    p256dh: z.string().min(16).max(256),
    auth: z.string().min(8).max(256),
  }),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
});
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>;

export const pushPreferencesSchema = z.object({
  mutedCategories: z.array(z.enum(PUSH_CATEGORIES)).max(PUSH_CATEGORIES.length),
});
export type PushPreferencesInput = z.infer<typeof pushPreferencesSchema>;

/** One browser the person has turned push on in. Never carries the keys. */
export interface PushDeviceRecord {
  id: string;
  /** "Chrome on Windows". Derived from the user agent at registration. */
  label: string;
  status: PushSubscriptionStatus;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** A bare code - an HTTP status or `NETWORK` - never a response body. */
  lastErrorCode: string | null;
  /** True for the browser asking, matched on its endpoint. */
  isCurrent: boolean;
}

export interface PushSettingsRecord {
  /** False when the server has no VAPID keys: push is off for everybody. */
  configured: boolean;
  /** The VAPID public key, base64url. Public by design; null when not configured. */
  publicKey: string | null;
  devices: PushDeviceRecord[];
  mutedCategories: PushCategory[];
}

export interface PushTestResult {
  /** Browsers the test was queued for. Queued, not delivered. */
  queued: number;
}
