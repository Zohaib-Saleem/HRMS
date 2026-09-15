import { z } from 'zod';

/**
 * The people-shaped things an employee sees on their own dashboard: whose
 * birthday it is, who is celebrating a year here, and who has just joined.
 *
 * These are the narrowest employee views in the product, and deliberately so.
 * The employee portal is the one place where somebody with no HR permission at
 * all is shown other people's records, so what travels is only what it takes to
 * congratulate a colleague: a name, a face, and where they sit.
 *
 * In particular there is NO date of birth here - not the year, not the day.
 * The server has already decided the birthday is today; sending the date back
 * would publish the age of every person in the company to every other person,
 * which is exactly the sort of thing a dashboard has no business doing. Same
 * reasoning keeps out the national id, bank details, salary, personal email
 * and phone: none of them help you say happy birthday.
 */

/** One colleague, as a celebration card renders them. */
export interface CompanyMomentPerson {
  employeeId: string;
  /** Display name, falling back to first + last on the server. */
  fullName: string;
  /** Resolved photo URL, or null for initials. Never an object key. */
  photoUrl: string | null;
  departmentName: string | null;
  teamName: string | null;
  designationName: string | null;
  /**
   * Whether the VIEWER has already greeted this person for this occasion.
   *
   * Sent rather than inferred, because the answer lives in the database: one
   * greeting per sender per occasion is a unique constraint, so a second
   * attempt would be refused anyway and the button should say so beforehand.
   */
  greetedByMe: boolean;
  /**
   * How many colleagues have greeted them for this occasion, the viewer
   * included. Zero renders nothing - an unremarked birthday should not be
   * announced as having no well-wishers.
   */
  greetingCount: number;
}

/** Somebody whose birthday is today. Carries no date - see the file note. */
export type BirthdayMoment = CompanyMomentPerson;

export interface AnniversaryMoment extends CompanyMomentPerson {
  /**
   * Completed years of service, always 1 or more. A person's first day is a
   * new-joiner moment, not a nought-year anniversary, so it never appears here.
   */
  years: number;
}

export interface NewJoinerMoment extends CompanyMomentPerson {
  /** The canonical hire date, ISO `YYYY-MM-DD`. */
  hireDate: string;
  /**
   * Which of the five working days this is, 1 to 5. Counted in WORKING days:
   * a weekend or a company holiday does not consume one.
   */
  workingDay: number;
}

/**
 * `GET /me/company-moments`.
 *
 * Every list excludes the caller - you are not your own colleague - and every
 * list excludes anybody whose employment had ended, by the same canonical
 * lifecycle rule the attendance population uses. An empty list means the
 * dashboard hides that section entirely rather than rendering an empty card.
 */
export interface CompanyMomentsView {
  birthdays: BirthdayMoment[];
  anniversaries: AnniversaryMoment[];
  newJoiners: NewJoinerMoment[];
}

// ------------------------------------------------------------------ greetings

/**
 * Saying something back.
 *
 * A card that only reports a birthday is a noticeboard; the thing an employee
 * actually wants to do with it is wish the person well. These are the three
 * occasions the dashboard already knows about, and a greeting always names
 * one - a person can have a birthday and an anniversary on the same day, and
 * congratulating them for one is not congratulating them for the other.
 */
export const MOMENT_OCCASIONS = ['BIRTHDAY', 'ANNIVERSARY', 'NEW_JOINER'] as const;
export type MomentOccasion = (typeof MOMENT_OCCASIONS)[number];

/** What the occasion is called where one has to be named in a sentence. */
export const MOMENT_OCCASION_LABELS: Record<MomentOccasion, string> = {
  BIRTHDAY: 'Birthday',
  ANNIVERSARY: 'Work anniversary',
  NEW_JOINER: 'Welcome',
};

/**
 * The heading on the notification the recipient receives.
 *
 * A function rather than a template the server assembles, so the wording is
 * chosen once for all three occasions - "A welcome from Ayesha" and "Birthday
 * wishes from Ayesha" are not the same sentence with a noun swapped, and
 * forcing them to be produces "Welcome wishes from Ayesha".
 */
export function momentGreetingTitle(occasion: MomentOccasion, senderName: string): string {
  if (occasion === 'BIRTHDAY') return `Birthday wishes from ${senderName}`;
  if (occasion === 'ANNIVERSARY') return `Anniversary wishes from ${senderName}`;
  return `A welcome from ${senderName}`;
}

/**
 * Suggested lines, one set per occasion.
 *
 * They exist because the blank box is the reason people do not send anything:
 * composing a birthday wish from nothing is a small task that is easy to put
 * off until the day is over. A tap on a suggestion is a real greeting from a
 * real colleague, and the sender can edit it before it goes.
 *
 * Here in shared, not in the web app, so the server measures a greeting
 * against the same wording the employee was offered - and so a future digest
 * email or mobile client offers exactly these and not a second set that drifts.
 * Deliberately plain and free of company-specific in-jokes: this is the floor,
 * and anybody who wants to say something better types over it.
 */
export const MOMENT_GREETING_SUGGESTIONS: Record<MomentOccasion, readonly string[]> = {
  BIRTHDAY: [
    'Happy birthday! Wishing you a wonderful year ahead.',
    'Happy birthday! Hope you have a brilliant day.',
    'Many happy returns of the day!',
    'Happy birthday! Enjoy every moment of it.',
    'Wishing you health and happiness. Happy birthday!',
  ],
  ANNIVERSARY: [
    'Happy work anniversary! Thank you for everything you bring to the team.',
    'Congratulations on another year with us!',
    "Happy work anniversary - here's to many more.",
    'Congratulations! Your work makes a real difference here.',
    "Happy work anniversary! It's a pleasure working with you.",
  ],
  NEW_JOINER: [
    'Welcome aboard! Great to have you with us.',
    'Welcome to the team! Looking forward to working with you.',
    'A very warm welcome - wishing you a great start.',
    'Welcome! Do shout if you need anything while you settle in.',
    'Glad to have you here. Welcome to the team!',
  ],
};

/**
 * The longest a greeting may be.
 *
 * Short on purpose. This is a card on a dashboard, not a message thread, and a
 * greeting that needs more than a couple of sentences wants an email instead.
 */
export const MOMENT_GREETING_MAX_LENGTH = 280;

/**
 * `POST /me/company-moments/greetings`.
 *
 * There is no `senderEmployeeId`: the sender is the session, exactly as with
 * every other `/me` route. `employeeId` is the person being greeted, and the
 * server accepts it only if that person is genuinely on one of the caller's own
 * celebration lists for the named occasion today - so this is not a way to
 * message an arbitrary colleague.
 */
export const momentGreetingCreateSchema = z.object({
  employeeId: z.string().min(1),
  occasion: z.enum(MOMENT_OCCASIONS),
  message: z
    .string()
    .trim()
    .min(1, 'Write a greeting, or pick one of the suggestions.')
    .max(MOMENT_GREETING_MAX_LENGTH, `Keep it under ${MOMENT_GREETING_MAX_LENGTH} characters.`),
});

export type MomentGreetingCreateInput = z.infer<typeof momentGreetingCreateSchema>;

/** What the server sends back once a greeting is recorded. */
export interface MomentGreetingResult {
  id: string;
  /** The person's new total for this occasion, so the card can update. */
  greetingCount: number;
}
