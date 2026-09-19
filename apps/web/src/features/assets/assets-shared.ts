import type { BadgeProps } from '@/components/ui/badge';
import type { AssetCategoryRecord, AssetCondition, AssetStatus } from '@hrms/shared';

/**
 * Shared vocabulary for the asset screens.
 *
 * Here for the reason the recruitment equivalent is: an asset UNDER_REPAIR has
 * to look identical on the register, on its own page and on the assignment
 * screens that arrive next. A ternary repeated in six files is how one screen
 * ends up calling that amber and another grey, which a reader then reads as a
 * difference that means something.
 */

type Tone = NonNullable<BadgeProps['variant']>;

/**
 * An asset's status, coloured by what it is asking of the reader.
 *
 * AVAILABLE is the good outcome and gets the success colour: it is stock
 * somebody can hand out this afternoon. ASSIGNED is primary because it is the
 * ordinary working state, not a problem. The three ambers are the ones somebody
 * has to come back to - being fixed, handed in and unchecked, broken. LOST is
 * the only red, because it is the only one where something has gone wrong
 * rather than merely being in progress. The two endings are grey: nothing is
 * being asked of anybody about a disposed laptop.
 */
export const ASSET_STATUS_TONE: Record<AssetStatus, Tone> = {
  AVAILABLE: 'success',
  ASSIGNED: 'primary',
  UNDER_REPAIR: 'warning',
  RETURNED: 'warning',
  DAMAGED: 'warning',
  LOST: 'destructive',
  RETIRED: 'neutral',
  DISPOSED: 'neutral',
};

/**
 * An asset's condition.
 *
 * NEW and GOOD are deliberately not both green. Colouring every healthy row
 * would turn the column into a wall of green in which the two rows that need
 * attention stop standing out - and a column where everything is coloured is a
 * column where nothing is.
 */
export const ASSET_CONDITION_TONE: Record<AssetCondition, Tone> = {
  NEW: 'success',
  GOOD: 'neutral',
  FAIR: 'neutral',
  DAMAGED: 'warning',
  CRITICAL: 'destructive',
};

/**
 * Money, to the cent.
 *
 * Unlike recruitment's formatter, which rounds: these are what a thing cost and
 * what it is reckoned to be worth, and both are figures that get added up into
 * an asset register total. Rounding eighty laptops to the nearest unit is a
 * total that disagrees with the invoices.
 */
export function assetMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const code = currency ?? 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
  } catch {
    return `${code} ${value.toLocaleString()}`;
  }
}

/** A `yyyy-MM-dd` column value as something a person reads. */
export function assetDate(value: string | null): string {
  if (!value) return '--';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return '--';
  return parsed.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The category tree flattened for a dropdown, groups above their own types.
 *
 * Retired categories are dropped: this is the list somebody files a NEW asset
 * against, and offering a retired one would let them file into a category the
 * server refuses. The settings screen shows the retired rows, because that is
 * where somebody brings one back.
 */
export interface CategoryOption {
  id: string;
  label: string;
  isGroup: boolean;
}

export function categoryOptions(tree: readonly AssetCategoryRecord[]): CategoryOption[] {
  const options: CategoryOption[] = [];
  for (const group of tree) {
    if (!group.isActive) continue;
    options.push({ id: group.id, label: group.name, isGroup: true });
    for (const type of group.children) {
      if (!type.isActive) continue;
      options.push({ id: type.id, label: `${group.name} › ${type.name}`, isGroup: false });
    }
  }
  return options;
}

/** How a category reads on a row: the type, with its group above it. */
export function categoryLabel(
  category: { name: string; parentName: string | null } | null,
): { name: string; group: string | null } {
  if (!category) return { name: '--', group: null };
  return { name: category.name, group: category.parentName };
}
