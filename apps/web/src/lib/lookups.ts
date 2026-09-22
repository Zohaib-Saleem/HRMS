import { useQuery } from '@tanstack/react-query';
import type { LookupOption } from '@hrms/shared';
import { api } from './api';

export interface OrganisationLookups {
  departments: LookupOption[];
  /*
   * NO `departmentId` on a team. Teams are not sub-departments, so no form
   * narrows its team list by the department chosen beside it.
   */
  teams: LookupOption[];
  designations: LookupOption[];
  locations: LookupOption[];
  managers: LookupOption[];
  /** Only the people who actively run a team. See the API's `organisationLookups`. */
  teamManagers: LookupOption[];
}

const EMPTY: OrganisationLookups = {
  departments: [],
  teams: [],
  designations: [],
  locations: [],
  managers: [],
  teamManagers: [],
};

/**
 * Dropdown data for every organisation and employee form.
 *
 * Cached for the session because this changes rarely; mutations that alter the
 * structure invalidate `['lookups']` explicitly.
 */
export function useLookups() {
  const query = useQuery({
    queryKey: ['lookups'],
    queryFn: () => api.get<OrganisationLookups>('/departments/lookups'),
    staleTime: 5 * 60_000,
  });

  return { lookups: query.data ?? EMPTY, isLoading: query.isLoading, error: query.error };
}

export const LOOKUPS_QUERY_KEY = ['lookups'] as const;
