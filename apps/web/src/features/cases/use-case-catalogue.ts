import { useQuery } from '@tanstack/react-query';
import type { CaseDepartmentCatalogue } from '@hrms/shared';
import { api } from '@/lib/api';

/**
 * The create form's vocabulary: departments, their categories, their
 * subcategories.
 *
 * Fetched, never hardcoded. Nothing in this app knows that HR has an
 * "Attendance & Leaves" queue or that IT has an "Email" one - it renders
 * whatever the company has configured, which is what lets Phase 2 add an admin
 * screen over the same rows without touching a line here.
 *
 * The departments in it are the company's OWN department rows. There is no
 * second list anywhere in this module and no free-text department field, which
 * is why the create form's department control is a select over this and never
 * an input.
 *
 * Cached for five minutes like the organisation lookups, because a catalogue
 * changes about as often as a department does.
 */

export const CASE_CATALOGUE_QUERY_KEY = ['cases', 'catalogue'] as const;

const EMPTY: CaseDepartmentCatalogue[] = [];

export function useCaseCatalogue(enabled = true) {
  const query = useQuery({
    queryKey: CASE_CATALOGUE_QUERY_KEY,
    queryFn: () => api.get<CaseDepartmentCatalogue[]>('/cases/categories'),
    staleTime: 5 * 60_000,
    enabled,
  });

  return {
    catalogue: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

/**
 * Every category and subcategory in the catalogue, flattened, for the list
 * screen's filter.
 *
 * The filter is one dropdown rather than the form's cascading pair, because a
 * filter is not a routing decision: somebody narrowing their own case list
 * wants to pick "Salary" and see the cases under it, including the ones filed
 * against one of its subcategories - which is exactly what the endpoint does
 * with a `categoryId`.
 */
export function flattenCatalogue(
  catalogue: CaseDepartmentCatalogue[],
): Array<{ id: string; label: string }> {
  return catalogue.flatMap((department) =>
    department.categories.flatMap((category) => [
      { id: category.id, label: `${department.departmentName} · ${category.name}` },
      ...category.subcategories.map((sub) => ({
        id: sub.id,
        label: `${department.departmentName} · ${category.name} · ${sub.name}`,
      })),
    ]),
  );
}
