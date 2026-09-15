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
