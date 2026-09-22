import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { EMPLOYEE_STATUS_LABELS, type AssetEmployeeLookupItem } from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { Input, NativeSelect } from '@/components/ui/field';

/**
 * Choosing one employee, by typing part of their name.
 *
 * A search box feeding a short select rather than a select of three hundred
 * people, for the reason the interviewer picker gives: a native control with a
 * company's whole roster in it is a control nobody can use.
 *
 * IT READS `/assets/employee-lookup`, NOT `/employees`, and that is the whole
 * point of this file. It used to read the directory, which is gated on
 * `employee.read` - the grant that also opens the People screen, Team
 * attendance, Attendance reports and the Employee Master Report. So the person
 * whose job is the asset register faced two wrong answers: without the grant
 * this picker 403'd and reported "Nobody matches that search", which is what
 * the hand-made IT role in production actually saw; with it, the whole HR
 * surface opened up behind a laptop handover.
 *
 * The lookup is the third answer. Six fields, the ones it takes to be sure you
 * have the right Ahmed - name, number, department, team, whether he still works
 * here - and the server never reads the rest off the record. See the route.
 */
export function EmployeePicker({
  id,
  value,
  onChange,
  placeholder = 'Choose an employee',
  /**
   * Whether people who have left should appear.
   *
   * Off for assigning - you do not issue a laptop to somebody who has gone -
   * and on for taking one back or writing one off, where the person handing it
   * over may already be marked RESIGNED on their last day.
   */
  includeInactive = false,
}: {
  id: string;
  value: string;
  onChange: (employeeId: string) => void;
  placeholder?: string;
  includeInactive?: boolean;
}) {
  const [search, setSearch] = React.useState('');
  const debounced = useDebounced(search, 300);

  const query = useQuery({
    queryKey: ['assets', 'employee-lookup', debounced, includeInactive],
    queryFn: () =>
      api.get<AssetEmployeeLookupItem[]>('/assets/employee-lookup', {
        query: {
          q: debounced || undefined,
          limit: 50,
          includeInactive: includeInactive ? 'true' : undefined,
        },
      }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const people = query.data ?? [];

  /*
   * A person already chosen who falls outside the current search must stay in
   * the list, or typing in the box would silently unselect them.
   */
  const selected = people.some((person) => person.id === value);

  /** `Ahmed Raza (EMP-014) · Engineering` - enough to tell two Ahmeds apart. */
  const optionLabel = (person: AssetEmployeeLookupItem): string => {
    const parts = [person.fullName];
    if (person.employeeNumber) parts[0] += ` (${person.employeeNumber})`;
    if (person.departmentName) parts.push(person.departmentName);
    // Only worth saying when it is not the ordinary case.
    if (!person.isActive) parts.push(EMPLOYEE_STATUS_LABELS[person.status]);
    return parts.join(' · ');
  };

  return (
    <div className="space-y-2">
      <Input
        value={search}
        placeholder="Search by name, number or work email"
        aria-label="Search employees"
        onChange={(event) => setSearch(event.target.value)}
      />
      <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {!selected && value !== '' ? <option value={value}>Selected employee</option> : null}
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {optionLabel(person)}
          </option>
        ))}
      </NativeSelect>
      {query.isLoading ? (
        <p className="text-[12.5px] text-muted-foreground">Loading people...</p>
      ) : people.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">Nobody matches that search.</p>
      ) : null}
    </div>
  );
}
