import { Cake, PartyPopper, Sparkles } from 'lucide-react';
import type {
  AnniversaryMoment,
  BirthdayMoment,
  CompanyMomentPerson,
  CompanyMomentsView,
  NewJoinerMoment,
} from '@hrms/shared';
import { Avatar } from '@/components/ui/avatar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Today at the company: whose birthday it is, who is celebrating a year, and
 * who has just joined.
 *
 * This block sits directly under the greeting on the employee dashboard rather
 * than at the foot of it. A birthday is only worth showing on the day it
 * happens, and a section an employee has to scroll past leave balances and
 * holidays to reach is a section they find out about the day after. So it is
 * near the top - but compact, because being first is not the same as being big:
 * three short lists of people, not three panels.
 *
 * Every section here hides itself when it has nothing to say. That is the whole
 * design rule and it is worth stating plainly: an empty "Birthdays" card that
 * reads "no birthdays today" is on screen 364 days a year telling nobody
 * anything, and three of them turn an employee's dashboard into a wall of
 * absences. A celebration either exists or the section is not rendered - and
 * with nothing to celebrate at all, the heading goes too, so a quiet day costs
 * the dashboard no height whatsoever.
 *
 * None of these components decide WHO to show. The server picks the people -
 * today's date, the canonical hire date, the employment lifecycle - and sends
 * back the narrowest employee view in the product. This file arranges what it
 * is given. In particular there is no date of birth here to render, because the
 * API does not send one.
 */

/** Where somebody sits, as one line. Both parts are optional in the data. */
function placeLabel(person: CompanyMomentPerson): string | null {
  const parts = [person.designationName, person.departmentName ?? person.teamName].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * One person in a celebration list.
 *
 * `Avatar` is the app's own, so an uploaded photo shows up here for the same
 * reason it shows up on the people list - and falls back to initials the same
 * way when there is none, or when the viewer may not fetch it.
 */
function MomentRow({
  person,
  message,
}: {
  person: CompanyMomentPerson;
  message: string;
}) {
  const place = placeLabel(person);

  return (
    <li className="flex items-center gap-2.5">
      <Avatar
        name={person.fullName}
        photoUrl={person.photoUrl}
        colorKey={person.employeeId}
        size="sm"
      />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium leading-tight">{person.fullName}</p>
        <p className="truncate text-[12px] text-muted-foreground">{message}</p>
        {place ? <p className="truncate text-[11.5px] text-muted-foreground">{place}</p> : null}
      </div>
    </li>
  );
}

/**
 * One celebration card.
 *
 * `flex-1` with a minimum width is what makes the row behave at every size
 * without a breakpoint per card count: on a wide dashboard two or three cards
 * share the full width between them, and on a phone the minimum stops them
 * sharing at all and they stack. The minimum is capped at the container's own
 * width so a 320px screen wraps rather than scrolling sideways.
 */
function MomentCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Cake;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-w-[min(100%,15rem)] flex-1">
      <CardHeader className="py-3">
        <CardTitle className="flex items-center gap-2 text-[13.5px]">
          <Icon className="size-4 text-muted-foreground" aria-hidden /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 pb-3.5">
        <ul className="space-y-2.5">{children}</ul>
      </CardContent>
    </Card>
  );
}

export function BirthdaysCard({ people }: { people: BirthdayMoment[] }) {
  if (people.length === 0) return null;

  return (
    <MomentCard title="Birthdays today" icon={Cake}>
      {people.map((person) => (
        <MomentRow key={person.employeeId} person={person} message="Birthday today" />
      ))}
    </MomentCard>
  );
}

export function AnniversariesCard({ people }: { people: AnniversaryMoment[] }) {
  if (people.length === 0) return null;

  return (
    <MomentCard title="Work anniversaries" icon={PartyPopper}>
      {people.map((person) => (
        <MomentRow
          key={person.employeeId}
          person={person}
          message={`Celebrating ${person.years} ${person.years === 1 ? 'year' : 'years'}`}
        />
      ))}
    </MomentCard>
  );
}

export function NewJoinersCard({ people }: { people: NewJoinerMoment[] }) {
  if (people.length === 0) return null;

  return (
    <MomentCard title="New joiners" icon={Sparkles}>
      {people.map((person) => (
        <MomentRow key={person.employeeId} person={person} message="Welcome to the team!" />
      ))}
    </MomentCard>
  );
}

/**
 * The three sections together, and nothing at all when none of them has anyone.
 *
 * Returning null for the whole block matters as much as the individual cards
 * hiding: without it the dashboard would open with a heading over an empty grid
 * on a quiet day, which is a worse place for emptiness than the bottom was.
 *
 * The heading names the company when the caller's session knows it - "Today at
 * Acme" reads like a noticeboard rather than a report - and falls back to
 * describing itself when it does not. The name is never hardcoded: this is one
 * product serving several companies.
 */
export function CompanyMoments({
  moments,
  companyName,
}: {
  moments: CompanyMomentsView | null;
  companyName?: string | null;
}) {
  if (!moments) return null;

  const total =
    moments.birthdays.length + moments.anniversaries.length + moments.newJoiners.length;
  if (total === 0) return null;

  return (
    <section className="mb-4 space-y-2.5" aria-labelledby="company-moments-heading">
      <h2 id="company-moments-heading" className="text-sm font-semibold">
        {companyName ? `Today at ${companyName}` : 'Celebrations & new joiners'}
      </h2>
      <div className="flex flex-wrap gap-4">
        <BirthdaysCard people={moments.birthdays} />
        <AnniversariesCard people={moments.anniversaries} />
        <NewJoinersCard people={moments.newJoiners} />
      </div>
    </section>
  );
}
