import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Deterministic tint from a stable key, so a person keeps the same colour
 * across every screen without storing one per employee.
 */
const PALETTE = [
  '#3f6cd6',
  '#0f8a72',
  '#b4531f',
  '#7a4fc0',
  '#0b7285',
  '#a5305a',
  '#4b6584',
  '#5a6b1f',
];

function tint(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0]!;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

const SIZES = {
  sm: 'size-7 text-[10.5px]',
  md: 'size-9 text-[12px]',
  lg: 'size-12 text-[15px]',
  xl: 'size-20 text-2xl',
} as const;

interface AvatarProps {
  name: string;
  photoUrl?: string | null;
  /** Stable identity for the colour - falls back to the name. */
  colorKey?: string;
  size?: keyof typeof SIZES;
  className?: string;
}

/**
 * One person, one circle - a photograph when there is one, initials when there
 * is not.
 *
 * This is the only component that decides between the two, which is what makes
 * uploading a photo show up on the people list, the org chart, the profile
 * header and anywhere else a person is rendered, without those screens knowing
 * a photo feature exists.
 *
 * The image is always `object-cover` inside a fixed square, so a portrait and a
 * landscape photo both fill the circle at their own aspect ratio and neither is
 * stretched. The crop is what varies, never the proportions.
 *
 * An image that fails to load falls back to initials rather than leaving a
 * broken frame. That is not a hypothetical: a photo is served through the API
 * behind the same permission as the record, so a viewer who may see the person
 * in a list but not open their file gets a 403 here - and the honest thing to
 * render then is exactly what we rendered before they had a photo at all.
 */
export function Avatar({ name, photoUrl, colorKey, size = 'md', className }: AvatarProps) {
  const [failed, setFailed] = React.useState(false);

  // A new photo deserves a new attempt: without this, one failure would stick
  // for the life of the component even after the photo is replaced.
  React.useEffect(() => setFailed(false), [photoUrl]);

  const base = cn(
    'grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white',
    SIZES[size],
    className,
  );

  if (photoUrl && !failed) {
    return (
      <img
        src={photoUrl}
        alt=""
        className={cn(base, 'bg-muted object-cover')}
        loading="lazy"
        onError={() => setFailed(true)}
        aria-hidden
      />
    );
  }

  return (
    <span className={base} style={{ backgroundColor: tint(colorKey ?? name) }} aria-hidden>
      {initialsOf(name)}
    </span>
  );
}
