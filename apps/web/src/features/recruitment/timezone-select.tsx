import * as React from 'react';
import { NativeSelect } from '@/components/ui/field';

/**
 * The zone an interview is booked in.
 *
 * On the form rather than assumed, because the whole point of storing a day, a
 * wall-clock time and a zone is that "10:00" is meaningless without the third
 * part. The default is the COMPANY's zone - the overwhelming majority of
 * interviews happen in the office's hours - and the list is the runtime's own
 * when it will give it up, so a remote candidate in another country can be
 * booked in theirs.
 *
 * `Intl.supportedValuesOf` is not in every runtime this app is built against
 * (jsdom, notably, where these screens are tested), so its absence falls back
 * to the zones that are actually plausible plus whatever the current value is.
 * A select that cannot show the value it holds is worse than a short list.
 */
const FALLBACK_ZONES = [
  'UTC',
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
];

function zones(current: string, companyTimezone: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? (Intl.supportedValuesOf('timeZone') as string[])
      : FALLBACK_ZONES;

  // The company's zone first, then the value in hand if it is something else,
  // then everything - so the two answers somebody almost always wants are at
  // the top of a list four hundred long.
  const head = [companyTimezone, current].filter(
    (zone, index, list) => zone && list.indexOf(zone) === index,
  );
  return [...head, ...supported.filter((zone) => !head.includes(zone))];
}

export function TimezoneSelect({
  value,
  onChange,
  companyTimezone,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  companyTimezone: string;
  id?: string;
}) {
  const options = React.useMemo(() => zones(value, companyTimezone), [value, companyTimezone]);

  return (
    <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((zone) => (
        <option key={zone} value={zone}>
          {zone === companyTimezone ? `${zone} (company)` : zone}
        </option>
      ))}
    </NativeSelect>
  );
}
