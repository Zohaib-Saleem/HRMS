import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, type AssetCategoryRecord } from '@hrms/shared';
import { api } from '@/lib/api';
import { usePermissions } from '@/features/auth/session-context';

/**
 * What the asset screens are allowed to offer.
 *
 * Read off the session's grants, and never the gate: every one of these is
 * checked again by the endpoint behind the control. Hiding a button the server
 * would refuse is a courtesy, not a permission.
 */
export function useAssetAccess() {
  const { has } = usePermissions();
  return {
    canReadAll: has(PERMISSIONS.ASSET_READ_ALL),
    canCreate: has(PERMISSIONS.ASSET_CREATE),
    canUpdate: has(PERMISSIONS.ASSET_UPDATE),
    canManageCategories: has(PERMISSIONS.ASSET_CATEGORY_MANAGE),
    /*
     * Two grants, because they answer different questions. `asset.read.all` is
     * the whole register and is what the dashboard needs - there is no honest
     * narrow version of a screen whose job is to count everything. `asset.report`
     * is permission to take that register away as a file, which is a separate
     * decision a company may well make differently.
     */
    canSeeDashboard: has(PERMISSIONS.ASSET_READ_ALL),
    canReport: has(PERMISSIONS.ASSET_REPORT),
  };
}

export const ASSET_CATEGORIES_QUERY_KEY = ['assets', 'categories'] as const;

/**
 * The category catalogue, as a tree.
 *
 * Cached for the session because it changes rarely - it is company
 * configuration, not a working list - and invalidated explicitly by the
 * settings screen that edits it.
 */
export function useAssetCategories() {
  const query = useQuery({
    queryKey: ASSET_CATEGORIES_QUERY_KEY,
    queryFn: () => api.get<AssetCategoryRecord[]>('/assets/categories'),
    staleTime: 5 * 60_000,
  });

  return {
    categories: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
