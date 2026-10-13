import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { LoanEligibilityResult, LoanKind } from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';

/**
 * "May I borrow, and how much?" - asked of the server.
 *
 * Deliberately not computed in the browser. The maximum depends on a salary the
 * employee cannot see and a policy they cannot read, and the answer has to be
 * the same one the submit endpoint will reach - so there is one implementation
 * of it and it lives on the server. This hook only asks.
 *
 * The amount and the term are debounced because they come from an input being
 * typed into: a request per keystroke would ask the server what 8, then 80,
 * then 800 would cost. `keepPreviousData` holds the last answer while the next
 * is in flight, so the panel updates rather than flickering back to a skeleton.
 */
export function useLoanEligibility(input?: {
  employeeId?: string;
  principalAmount?: number;
  installmentCount?: number;
  /** Which ceiling to ask about. The server defaults to a loan. */
  kind?: LoanKind;
  enabled?: boolean;
}) {
  const amount = useDebounced(input?.principalAmount, 300);
  const installments = useDebounced(input?.installmentCount, 300);

  const params = new URLSearchParams();
  if (input?.employeeId) params.set('employeeId', input.employeeId);
  if (amount && Number.isFinite(amount) && amount > 0) params.set('principalAmount', String(amount));
  if (installments && Number.isFinite(installments) && installments > 0) {
    params.set('installmentCount', String(installments));
  }
  if (input?.kind && input.kind !== 'LOAN') params.set('kind', input.kind);
  const qs = params.toString();

  return useQuery({
    queryKey: ['loans', 'eligibility', qs],
    // `api.get` unwraps the `{ data }` envelope itself; the generic is the
    // value inside it, not the envelope around it.
    queryFn: () => api.get<LoanEligibilityResult>(`/loans/eligibility${qs ? `?${qs}` : ''}`),
    enabled: input?.enabled ?? true,
    placeholderData: keepPreviousData,
    // Eligibility moves with attendance and with other people's decisions, so
    // it is not something to cache for long.
    staleTime: 15_000,
  });
}
