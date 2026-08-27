import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight, Users } from 'lucide-react';
import type { DepartmentTreeNode } from '@hrms/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';

/** Department hierarchy, rendered from the nested tree the API returns. */
export function StructurePage() {
  const query = useQuery({
    queryKey: ['departments', 'tree'],
    queryFn: () => api.get<DepartmentTreeNode[]>('/departments/tree'),
  });

  if (query.isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-10" style={{ marginLeft: `${(index % 3) * 24}px` }} />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const roots = query.data ?? [];

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Department structure</CardTitle>
        <CardDescription>
          Departments nested under their parent, with headcount at each level.
        </CardDescription>
      </CardHeader>

      {roots.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No departments yet"
          description="Create a department to start building the structure."
        />
      ) : (
        <CardContent className="space-y-1 py-4">
          {roots.map((node) => (
            <TreeBranch key={node.id} node={node} depth={0} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function TreeBranch({ node, depth }: { node: DepartmentTreeNode; depth: number }) {
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent/50',
          !node.isActive && 'opacity-60',
        )}
        style={{ marginLeft: `${depth * 22}px` }}
      >
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-md',
            depth === 0 ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground',
          )}
          aria-hidden
        >
          {hasChildren ? <ChevronRight className="size-3.5" /> : <Building2 className="size-3.5" />}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">
            {node.name}
            {node.code ? (
              <span className="ml-2 font-mono text-[11.5px] text-muted-foreground">{node.code}</span>
            ) : null}
          </p>
          {node.headEmployeeName ? (
            <p className="truncate text-[12px] text-muted-foreground">
              Head: {node.headEmployeeName}
            </p>
          ) : null}
        </div>

        {!node.isActive ? <Badge variant="neutral">Inactive</Badge> : null}

        <Badge variant="outline" className="tabular shrink-0">
          <Users className="size-3" aria-hidden />
          {node.employeeCount}
        </Badge>
      </div>

      {hasChildren
        ? node.children.map((child) => (
            <TreeBranch key={child.id} node={child} depth={depth + 1} />
          ))
        : null}
    </div>
  );
}
