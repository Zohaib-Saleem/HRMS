import { z } from 'zod';

/**
 * The organisation hierarchy: who runs which team, and what the chart looks
 * like from the top.
 *
 * ONE IDEA RUNS THROUGH THIS FILE. A team manager is a STORED APPOINTMENT -
 * a row in `team_managers` that an administrator wrote - and never an
 * inference. Not a job title containing the word "manager", not the head of
 * the department the team sits in, not a role named MANAGER, not the person
 * whose name sorts first. Every type here describes that row or reads it back.
 */

// ------------------------------------------------------------ the roster

/**
 * How many managers a team may have.
 *
 * The ceiling is enforced on the server, inside the transaction that writes
 * the row. It is stated here as well so the form can refuse a fourth before
 * the round trip and say why - the two must agree, and the server is the one
 * that matters.
 */
export const TEAM_MANAGER_MIN = 1;
export const TEAM_MANAGER_MAX = 3;

export const teamManagerAssignSchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.'),
});

export type TeamManagerAssignInput = z.infer<typeof teamManagerAssignSchema>;

export const teamManagerRemoveSchema = z.object({
  /**
   * Why the appointment ended. Optional, and worth asking for: "left the
   * company" and "moved to Design" are read very differently a year later by
   * whoever is looking at why a team changed hands.
   */
  reason: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

export type TeamManagerRemoveInput = z.infer<typeof teamManagerRemoveSchema>;

/**
 * Replacing a manager: end one appointment and start another, atomically.
 *
 * Its own endpoint rather than a remove followed by an assign, because a team
 * at its three-manager ceiling cannot do those two things in that order - the
 * assign would be refused - and doing them in the other order leaves the team
 * briefly with a departed manager still in charge of its approvals.
 */
export const teamManagerReplaceSchema = z.object({
  outgoingEmployeeId: z.string().trim().min(1, 'Choose the manager being replaced.'),
  incomingEmployeeId: z.string().trim().min(1, 'Choose the new manager.'),
  reason: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

export type TeamManagerReplaceInput = z.infer<typeof teamManagerReplaceSchema>;

export interface TeamManagerRecord {
  id: string;
  teamId: string;
  teamName: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  designation: string | null;
  /** The employee's own status. A manager who has left still shows, greyed. */
  employeeStatus: string;
  isActive: boolean;
  assignedAt: string;
  endedAt: string | null;
  endReason: string | null;
  /**
   * Whether this person's login can actually SEE the team they manage.
   *
   * An appointment and a role are two separate things, and the gap between
   * them is the most likely thing to go wrong in this feature: somebody is
   * made a manager of Development on the Teams screen, and nothing changes for
   * them, because no role they hold carries `team.data.read`. Rather than
   * leave that to be discovered, the roster reports it.
   *
   * Null when the employee has no login account at all, which is a different
   * problem with a different fix.
   */
  hasTeamDataAccess: boolean | null;
}

/** One team with its roster, as the Teams screen shows it. */
export interface TeamManagerRoster {
  teamId: string;
  teamName: string;
  departmentName: string;
  employeeCount: number;
  managers: TeamManagerRecord[];
  /** Ended appointments, most recent first. History, not the roster. */
  formerManagers: TeamManagerRecord[];
  canManage: boolean;
}

// -------------------------------------------------------------- the chart

/** A person on the org chart. Deliberately six fields and no more. */
export interface OrgChartPerson {
  employeeId: string;
  name: string;
  employeeNumber: string;
  designation: string | null;
  status: string;
  photoUrl: string | null;
}

export interface OrgChartTeam {
  teamId: string;
  teamName: string;
  departmentId: string;
  departmentName: string;
  isActive: boolean;
  managers: OrgChartPerson[];
  members: OrgChartPerson[];
  /**
   * Members, counted on the server. Not `members.length`: the list is capped
   * so that a team of two hundred does not arrive as two hundred objects, and
   * a count that quietly meant "the first fifty" would be a lie on a screen
   * whose whole job is telling somebody how big their company is.
   */
  memberCount: number;
}

/**
 * The chart, top down: CEO, then HR, then the teams.
 *
 * `ceo` and `hrManagers` are read from the approval stage assignees - the same
 * rows the CEO and HR Manager approval stages resolve to - because a company
 * that has said "these people are the CEO stage" has already answered "who is
 * at the top of the chart", and asking them twice would let the two answers
 * disagree.
 */
export interface OrgChart {
  ceo: OrgChartPerson[];
  hrManagers: OrgChartPerson[];
  teams: OrgChartTeam[];
  /** People with no team at all. Not an error - contractors, new starters. */
  unassignedCount: number;
  totalEmployees: number;
}

/**
 * What the CALLER's own place in the hierarchy is.
 *
 * Served to every signed-in user, because several screens need to know whether
 * this person manages anything before deciding what to show, and each working
 * it out separately is how two screens come to disagree.
 */
export interface MyTeamContext {
  /** Teams the caller actively manages. Empty for most people. */
  managedTeams: Array<{ teamId: string; teamName: string; memberCount: number }>;
  /** The caller's own primary team, if they are on one. */
  myTeamId: string | null;
  myTeamName: string | null;
  /** The managers of the caller's own team - who their requests go to first. */
  myTeamManagers: OrgChartPerson[];
  isTeamManager: boolean;
}
