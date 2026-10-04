import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, type MedicalBenefitView } from '@hrms/shared';
import { api } from '@/lib/api';
import { useSession } from '@/features/auth/session-context';
import { MY_MEDICAL_KEY } from './my-medical-card';

/**
 * Whether Medical should be left out of this person's menu.
 *
 * An employee who is not eligible - by the policy, or because HR marked them
 * so - has no benefit to look at and no claim to make, so the menu entry goes
 * the same way the dashboard card already does. Somebody who oversees other
 * people's medical records (`medical.manage` or `medical.claim.approve`) keeps
 * it whatever their own eligibility, because the claims queue lives there.
 *
 * Hidden until the server has answered, for the reason the dashboard card
 * gives: an entry that appears and vanishes on every load is worse than one
 * that appears a moment late. Shares the card's query key, so the dashboard
 * and the menu cost one request between them.
 *
 * Presentation only. /medical/benefit and every claim route judge eligibility
 * themselves.
 */
export function useMedicalHiddenFromMenu(): boolean {
  const { permissions } = useSession();
  const canRead = permissions.has(PERMISSIONS.MEDICAL_READ);
  const oversees =
    permissions.has(PERMISSIONS.MEDICAL_MANAGE) ||
    permissions.has(PERMISSIONS.MEDICAL_CLAIM_APPROVE);

  const query = useQuery({
    queryKey: MY_MEDICAL_KEY,
    queryFn: () => api.get<MedicalBenefitView>('/medical/benefit'),
    enabled: canRead && !oversees,
    retry: false,
  });

  if (!canRead || oversees) return false;
  return query.data?.eligibility.eligible !== true;
}
