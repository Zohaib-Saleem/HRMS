import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EmployeeListItem } from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { Input, NativeSelect } from '@/components/ui/field';

/**
 * Choosing one employee, by typing part of their name.
 *
 * A search box feeding a short select rather than a select of three hundred
 * people, for the reason the interviewer picker gives: a native control with a
 * company's whole roster in it is a control nobody can use. The search runs on
 * the server - `GET /employees?q=` - so the list a reader can pick from is
 * already narrowed by their data scope, and nothing here has to re-decide who
 * they may see.
 *
 * It deliberately does NOT build its own endpoint. The employees list is the
 * canonical one and already does paging, searching and scoping; a second
 * "people for a dropdown" endpoint in the assets module would be a second
 * answer to "who works here".
 */
export function EmployeePicker({
  id,
  value,
  onChange,
  placeholder = 'Choose an employee',
}: {
  id: string;
  value: string;
  onChange: (employeeId: string) => void;
  placeholder?: string;
}) {
  const [search, setSearch] = React.useState('');
  const debounced = useDebounced(search, 300);

  const query = useQuery({
    queryKey: ['employees', 'picker', debounced],
    queryFn: () =>
      api.getPage<EmployeeListItem>('/employees', {
        query: { q: debounced || undefined, limit: 50, sort: 'lastName', order: 'asc' },
      }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const people = query.data?.data ?? [];

  /*
   * A person already chosen who falls outside the current search must stay in
   * the list, or typing in the box would silently unselect them.
   */
  const selected = people.some((person) => person.id === value);

  return (
    <div className="space-y-2">
      <Input
        value={search}
        placeholder="Search by name"
        aria-label="Search employees"
        onChange={(event) => setSearch(event.target.value)}
      />
      <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {!selected && value !== '' ? <option value={value}>Selected employee</option> : null}
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.fullName}
            {person.employeeNumber ? ` (${person.employeeNumber})` : ''}
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
