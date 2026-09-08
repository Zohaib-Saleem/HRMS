import { PERMISSIONS, type AttendanceRulesView } from '@hrms/shared';
import { api } from '@/lib/api';
import { useCapability, type CapabilityState } from '@/lib/capability';
import { usePermissions } from '@/features/auth/session-context';

/**
 * The attendance rules endpoint, and whether it is there at all.
 *
 * One query key shared by the Settings tab strip and the rules screen, so the
 * availability probe and the screen's own read are the same request. Checking
 * whether a feature exists should not cost a second round trip to fetch what it
 * already returned.
 */
export const ATTENDANCE_RULES_KEY = ['company', 'attendance-rules'] as const;

export function useAttendanceRules(): {
  state: CapabilityState;
  data: AttendanceRulesView | undefined;
  error: unknown;
} {
  const { has } = usePermissions();

  // Not probed at all for someone who could not read it anyway: a guaranteed
  // 403 is not worth a request, and the permission is already the gate.
  const allowed = has(PERMISSIONS.COMPANY_READ);

  return useCapability<AttendanceRulesView>(
    ATTENDANCE_RULES_KEY,
    () => api.get<AttendanceRulesView>('/company/attendance-rules'),
    { enabled: allowed },
  );
}
