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
 * Company updates: whose birthday it is, who is celebrating a year, and who
 * has just joined.
 *
 * Every section here hides itself when it has nothing to say. That is the whole
 * design rule and it is worth stating plainly: an empty "Birthdays" card that
 * reads "no birthdays today" is on screen 364 days a year telling nobody
 * anything, and three of them turn an employee's dashboard into a wall of
 * absences. A celebration either exists or the section is not rendered.
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
    <li className="flex items-center gap-3">
      <Avatar name={person.fullName} photoUrl={person.photoUrl} colorKey={person.employeeId} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{person.fullName}</p>
        <p className="truncate text-[12.5px] text-muted-foreground">{message}</p>
        {place ? <p className="truncate text-[12px] text-muted-foreground">{place}</p> : null}
      </div>
    </li>
  );
}

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" aria-hidden /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">{children}</ul>
      </CardContent>
    </Card>
  );
}

export function BirthdaysCard({ people }: { people: BirthdayMoment[] }) {
  if (people.length === 0) return null;

  return (
    <MomentCard title="Birthdays" icon={Cake}>
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
    <MomentCard title="Welcome to the team" icon={Sparkles}>
      {people.map((person) => (
        <MomentRow
          key={person.employeeId}
          person={person}
          message={`Welcome ${person.fullName} to the team!`}
        />
      ))}
    </MomentCard>
  );
}

/**
 * The three sections together, and nothing at all when none of them has anyone.
 *
 * Returning null for the whole block matters as much as the individual cards
 * hiding: without it the dashboard would keep a "Company updates" heading and
 * an empty grid on a quiet day.
 */
export function CompanyMoments({ moments }: { moments: CompanyMomentsView | null }) {
  if (!moments) return null;

  const total =
    moments.birthdays.length + moments.anniversaries.length + moments.newJoiners.length;
  if (total === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground">Company updates</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <NewJoinersCard people={moments.newJoiners} />
        <BirthdaysCard people={moments.birthdays} />
        <AnniversariesCard people={moments.anniversaries} />
      </div>
    </section>
  );
}
