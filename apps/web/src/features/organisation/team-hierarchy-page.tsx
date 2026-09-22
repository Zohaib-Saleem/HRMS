import { useQuery } from '@tanstack/react-query';
import { Building2, Crown, UserCog, Users2 } from 'lucide-react';
import type { OrgChart, OrgChartPerson } from '@hrms/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';

/**
 * The organisation, top down: CEO, HR, teams, managers, people.
 *
 * NOT THE SAME PAGE AS `/people/org-chart`, and the difference is worth
 * stating because both are called an org chart in conversation. That one draws
 * the REPORTING LINE - who whose `managerId` points at - which is a fact about
 * individuals. This draws the TEAM STRUCTURE, which is a fact about groups,
 * and is the one the approval chain actually walks.
 *
 * CEO, then HR, then the teams with their managers and their people - the
 * shape the brief asks for, drawn from the same rows the approval chain
 * resolves against rather than from a separate picture somebody maintains.
 * That is the property worth having: if this page says Ahmed manages
 * Development, then Development's leave goes to Ahmed, because both read
 * `team_managers`.
 *
 * WHAT IT SHOWS IS BOUNDED BY WHAT THE CALLER MAY SEE. HR opens it and finds
 * the company; a team manager opens it and finds their own teams. The
 * narrowing happens on the server - see `teamScopeFilter` - and not by hiding
 * cards here.
 */
export function TeamHierarchyPage() {
  const query = useQuery({
    queryKey: ['org-chart'],
    queryFn: () => api.get<OrgChart>('/organisation/chart'),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const chart = query.data;
  if (!chart) return null;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <TopCard
          title="CEO"
          icon={Crown}
          people={chart.ceo}
          empty="Nobody is named as CEO. The CEO approval stage is skipped on every request until somebody is."
        />
        <TopCard
          title="HR Manager"
          icon={Building2}
          people={chart.hrManagers}
          empty="Nobody is named as HR Manager. That approval stage is skipped until somebody is."
        />
      </div>

      <Card>
        <CardHeader bordered>
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Users2 className="size-4 text-muted-foreground" aria-hidden />
              Teams
            </span>
            <span className="text-[12.5px] font-normal text-muted-foreground">
              {chart.totalEmployees} people
              {chart.unassignedCount > 0 ? ` · ${chart.unassignedCount} on no team` : ''}
            </span>
          </CardTitle>
        </CardHeader>

        {chart.teams.length === 0 ? (
          <EmptyState
            icon={Users2}
            title="No teams to show"
            description="Either no teams have been created yet, or none of them holds anybody you can see."
          />
        ) : (
          <div className="divide-y divide-border">
            {chart.teams.map((team) => (
              <div key={team.teamId} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-[14px] font-medium">{team.teamName}</p>
                    <p className="text-[12px] text-muted-foreground">{team.departmentName}</p>
                  </div>
                  <Badge variant="neutral">{team.memberCount} people</Badge>
                </div>

                <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_2fr]">
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                      <UserCog className="size-3.5" aria-hidden />
                      {team.managers.length === 1 ? 'Manager' : 'Managers'}
                    </p>
                    {team.managers.length === 0 ? (
                      <p className="text-[12.5px] text-warning">
                        None appointed - this team&apos;s requests skip the Team Manager stage.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {team.managers.map((person) => (
                          <li key={person.employeeId} className="text-[13px]">
                            {person.name}
                            {person.designation ? (
                              <span className="text-muted-foreground"> · {person.designation}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                      Members
                    </p>
                    {team.members.length === 0 ? (
                      <p className="text-[12.5px] text-muted-foreground">Nobody on this team yet.</p>
                    ) : (
                      <p className="text-[13px] leading-relaxed">
                        {team.members.map((person) => person.name).join(', ')}
                        {team.memberCount > team.members.length
                          ? ` and ${team.memberCount - team.members.length} more`
                          : ''}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function TopCard({
  title,
  icon: Icon,
  people,
  empty,
}: {
  title: string;
  icon: typeof Crown;
  people: OrgChartPerson[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader bordered>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="py-4">
        {people.length === 0 ? (
          <p className="text-[12.5px] text-warning">{empty}</p>
        ) : (
          <ul className="space-y-1.5">
            {people.map((person) => (
              <li key={person.employeeId}>
                <p className="text-[13.5px] font-medium">{person.name}</p>
                <p className="text-[12px] text-muted-foreground">
                  {person.designation ?? person.employeeNumber}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
