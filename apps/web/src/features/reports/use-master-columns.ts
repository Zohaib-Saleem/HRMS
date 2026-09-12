import * as React from 'react';
import { DEFAULT_MASTER_COLUMNS, EMPLOYEE_MASTER_COLUMNS } from '@hrms/shared';

const STORAGE_KEY = 'hrms.employee-master.columns';

/**
 * Which columns the operator has chosen, remembered on this device.
 *
 * A sixty-column report is unusable until somebody narrows it, and making them
 * narrow it again on every visit is the same as not having a picker. The choice
 * is a per-viewer convenience rather than shared state, so it lives in
 * localStorage - and every access is guarded, because a private window or a
 * browser set to block site data throws on the accessor itself rather than
 * returning empty.
 */
export function useMasterColumns(available: readonly string[]) {
  const [selected, setSelected] = React.useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((k) => typeof k === 'string')) return parsed;
      }
    } catch {
      // Unreadable storage is not a reason to render nothing.
    }
    return [...DEFAULT_MASTER_COLUMNS];
  });

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    } catch {
      // A choice that cannot be remembered still applies to this session.
    }
  }, [selected]);

  /**
   * The stored choice intersected with what this caller may actually see.
   *
   * Permissions can be narrowed after a choice was saved, and a column the
   * server will never fill must not sit in the table as a blank strip.
   */
  const visible = React.useMemo(() => {
    const allowed = new Set(available);
    const chosen = new Set(selected.filter((key) => allowed.has(key)));
    // Order follows the registry, not the click order, so the table's column
    // order is stable however the picker was used.
    return EMPLOYEE_MASTER_COLUMNS.filter((c) => chosen.has(c.key));
  }, [available, selected]);

  const toggle = React.useCallback((key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const setGroup = React.useCallback(
    (group: string, on: boolean, available: readonly string[]) => {
      const allowed = new Set(available);
      const keys = EMPLOYEE_MASTER_COLUMNS.filter((c) => c.group === group && allowed.has(c.key)).map(
        (c) => c.key,
      );
      setSelected((prev) =>
        on ? [...new Set([...prev, ...keys])] : prev.filter((k) => !keys.includes(k)),
      );
    },
    [],
  );

  const reset = React.useCallback(() => setSelected([...DEFAULT_MASTER_COLUMNS]), []);

  return { selected, visible, toggle, setGroup, reset };
}
