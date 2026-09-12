import type { BadgeProps } from '@/components/ui/badge';
import type { ContractExpiryState, ContractStatus, PolicyAcknowledgementStatus } from '@hrms/shared';
import type { LoanInstallmentStatus, LoanStatus, MedicalClaimStatus } from '@hrms/shared';

/**
 * Shared vocabulary for contracts, policies, loans and medical claims.
 *
 * The tone of a badge is a judgement about the record, and the same record has
 * to look the same on the list screen and on the employee's profile. Keeping
 * the mapping here rather than repeating a ternary in four files is what stops
 * a contract reading "expiring" in amber on one screen and grey on another.
 */

type Tone = NonNullable<BadgeProps['variant']>;

export const CONTRACT_STATUS_TONE: Record<ContractStatus, Tone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  EXPIRED: 'warning',
  TERMINATED: 'destructive',
  RENEWED: 'primary',
};

export const CONTRACT_EXPIRY_TONE: Record<ContractExpiryState, Tone> = {
  OPEN_ENDED: 'neutral',
  ACTIVE: 'success',
  EXPIRING_SOON: 'warning',
  EXPIRED: 'destructive',
};

/**
 * What the expiry badge says.
 *
 * The number of days is the useful part - "expires in 12 days" is actionable
 * and "expiring soon" is not - so the label carries it whenever there is one.
 */
export function expiryLabel(state: ContractExpiryState, daysRemaining: number | null): string {
  switch (state) {
    case 'OPEN_ENDED':
      return 'Open-ended';
    case 'EXPIRED':
      return daysRemaining === null
        ? 'Expired'
        : `Expired ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? '' : 's'} ago`;
    case 'EXPIRING_SOON':
      return daysRemaining === 0
        ? 'Expires today'
        : `Expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
    default:
      return 'In force';
  }
}

export const POLICY_STATUS_TONE: Record<PolicyAcknowledgementStatus, Tone> = {
  PENDING: 'warning',
  ACKNOWLEDGED: 'success',
  DECLINED: 'destructive',
};

export const LOAN_STATUS_TONE: Record<LoanStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'primary',
  REJECTED: 'destructive',
  ACTIVE: 'success',
  COMPLETED: 'neutral',
  CANCELLED: 'neutral',
};

export const LOAN_INSTALLMENT_TONE: Record<LoanInstallmentStatus, Tone> = {
  SCHEDULED: 'neutral',
  PENDING_PAYROLL: 'primary',
  PAID: 'success',
  WAIVED: 'warning',
  SKIPPED: 'neutral',
};

/**
 * A medical claim's status, as a badge tone.
 *
 * PARTIALLY_APPROVED is amber rather than green on purpose: it reads as "agreed,
 * but not for what was asked", which is the part the claimant has to notice.
 * PAID is the only settled-and-done state, so it is the only plain one.
 */
export const MEDICAL_CLAIM_STATUS_TONE: Record<MedicalClaimStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  PARTIALLY_APPROVED: 'warning',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
  PAID: 'primary',
};

/** Money in the currency the record itself carries, never a global default. */
export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** A yyyy-MM-dd value read as the calendar day it names, not a local instant. */
export function isoDay(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
}

/** The month a loan installment falls in: "Jun 2026". */
export function isoMonth(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Today as the calendar day where the user is, for date inputs. */
export function todayLocal(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The current month as yyyy-MM, for month inputs. */
export function thisMonthLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
