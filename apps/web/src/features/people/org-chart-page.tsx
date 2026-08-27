import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Users } from 'lucide-react';
import {
  EMPLOYEE_STATUS_LABELS,
  type EmployeeStatus,
  type EmployeeTreeNode,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';

/**
 * Reporting hierarchy. Anyone whose manager sits outside the caller's data
 * scope appears as a root, so the chart never implies access that is not there.
 */
export function OrgChartPage() {
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['employees', 'tree'],
    queryFn: () => api.get<EmployeeTreeNode[]>('/employees/tree'),
  });

  return (
    <>
      <div className="mb-5">
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link to="/people">
            <ArrowLeft />
            Back to people
          </Link>
        </Button>
      </div>

      <PageHeader
        title="Org chart"
        description="Reporting lines across the organisation."
      />

      <Card>
        {query.isLoading ? (
          <CardContent className="space-y-3 py-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-12" style={{ marginLeft: `${(index % 3) * 28}px` }} />
            ))}
          </CardContent>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (query.data ?? []).length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nothing to chart yet"
            description="Assign managers to employees to build the reporting hierarchy."
          />
        ) : (
          <CardContent className="space-y-1 py-4">
            {(query.data ?? []).map((node) => (
              <ChartBranch
                key={node.id}
                node={node}
                depth={0}
                onOpen={(id) => navigate(`/people/${id}`)}
              />
            ))}
          </CardContent>
        )}
      </Card>
    </>
  );
}

function ChartBranch({
  node,
  depth,
  onOpen,
}: {
  node: EmployeeTreeNode;
  depth: number;
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onOpen(node.id)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/50',
          node.status === 'TERMINATED' && 'opacity-55',
        )}
        style={{ marginLeft: `${depth * 26}px` }}
      >
        <Avatar name={node.fullName} photoUrl={node.photoUrl} colorKey={node.id} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">{node.fullName}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {node.jobTitle ?? '--'}
            {node.departmentName ? ` · ${node.departmentName}` : ''}
          </p>
        </div>

        {node.status !== 'ACTIVE' ? (
          <Badge variant="neutral">{EMPLOYEE_STATUS_LABELS[node.status as EmployeeStatus]}</Badge>
        ) : null}

        {node.reports.length > 0 ? (
          <Badge variant="outline" className="tabular shrink-0">
            <Users className="size-3" aria-hidden />
            {node.reports.length}
          </Badge>
        ) : null}
      </button>

      {node.reports.map((report) => (
        <ChartBranch key={report.id} node={report} depth={depth + 1} onOpen={onOpen} />
      ))}
    </div>
  );
}
