import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MedicalCategory, MedicalClaimAssessment } from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';

/**
 * "Would this claim be accepted, and what would it settle at?" - asked of the
 * server.
 *
 * Deliberately not computed in the browser. The answer depends on the policy
 * version in force, on the category's own cap, and on what every other claim
 * this year has already consumed - none of which the browser holds, and all of
 * which the submit endpoint re-evaluates before it writes anything. So there is
 * one implementation of the rules and it lives on the server; this hook only
 * asks.
 *
 * The amount is debounced because it comes from an input being typed into: a
 * request per keystroke would ask the server about 4, then 40, then 400. The
 * category and the dependent are not - those come from a select, where each
 * change is a deliberate one and the answer is worth having immediately.
 *
 * `keepPreviousData` holds the last answer while the next is in flight, so the
 * panel updates in place rather than collapsing to a skeleton on every keypress.
 */
export function useMedicalClaimAssessment(input: {
  /** Omitted for the caller's own claim, which is the only case an employee has. */
  employeeId?: string;
  category: MedicalCategory;
  dependentId?: string | null;
  treatmentDate?: string | null;
  requestedAmount?: number;
  enabled?: boolean;
}) {
  const amount = useDebounced(input.requestedAmount, 300);

  const query: Record<string, string> = { category: input.category };
  if (input.employeeId) query.employeeId = input.employeeId;
  if (input.dependentId) query.dependentId = input.dependentId;
  if (input.treatmentDate) query.treatmentDate = input.treatmentDate;
  if (amount !== undefined && Number.isFinite(amount) && amount > 0) {
    query.requestedAmount = String(amount);
  }

  const qs = new URLSearchParams(query).toString();

  return useQuery({
    queryKey: ['medical', 'claims', 'assessment', qs],
    // `api.get` unwraps the `{ data }` envelope itself; the generic is the
    // value inside it, not the envelope around it.
    queryFn: () => api.get<MedicalClaimAssessment>(`/medical/claims/assessment?${qs}`),
    enabled: input.enabled ?? true,
    placeholderData: keepPreviousData,
    // The balance moves as other claims are decided, so this is not an answer
    // worth holding for long.
    staleTime: 15_000,
    retry: false,
  });
}
