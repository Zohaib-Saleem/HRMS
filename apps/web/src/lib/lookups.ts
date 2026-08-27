import { useQuery } from '@tanstack/react-query';
import type { LookupOption } from '@hrms/shared';
import { api } from './api';

export interface OrganisationLookups {
  departments: LookupOption[];
  teams: Array<LookupOption & { departmentId: string }>;
  designations: LookupOption[];
  locations: LookupOption[];
  managers: LookupOption[];
}

const EMPTY: OrganisationLookups = {
  departments: [],
  teams: [],
  designations: [],
  locations: [],
  managers: [],
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
