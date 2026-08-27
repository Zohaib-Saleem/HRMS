import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || '?';
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '--';
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '--' : DATE_TIME.format(date);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '--';
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '--' : DATE_ONLY.format(date);
}

/** "3 minutes ago" style, falling back to an absolute date past a week. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '--';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '--';

  const diffMs = date.getTime() - Date.now();
  const absSeconds = Math.abs(diffMs) / 1000;
  if (absSeconds > 60 * 60 * 24 * 7) return DATE_ONLY.format(date);

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, seconds] of units) {
    if (absSeconds >= seconds || unit === 'second') {
      return rtf.format(Math.round(diffMs / 1000 / seconds), unit);
    }
  }
  return DATE_ONLY.format(date);
}

/** Splits an audit action such as `role.permissions.update` for display. */
export function humanise(value: string): string {
  return value
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
