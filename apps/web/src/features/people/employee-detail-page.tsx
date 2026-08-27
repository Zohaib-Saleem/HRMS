import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Lock,
  Mail,
  MapPin,
  Pencil,
  Phone,
  RotateCcw,
  UserMinus,
  Users,
} from 'lucide-react';
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  PERMISSIONS,
  type EmployeeDetail,
  type EmployeeStatus,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { Can, usePermissions } from '@/features/auth/session-context';
import { EmployeeFormDrawer } from './employee-form-drawer';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'warning' | 'destructive' | 'neutral'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  SUSPENDED: 'destructive',
  TERMINATED: 'neutral',
};

const TABS = ['Overview', 'Personal', 'Experience', 'Reports'] as const;
type Tab = (typeof TABS)[number];

export function EmployeeDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { has } = usePermissions();
  const [tab, setTab] = React.useState<Tab>('Overview');
  const [editing, setEditing] = React.useState(false);

  const query = useQuery({
    queryKey: ['employees', id],
    queryFn: () => api.get<EmployeeDetail>(`/employees/${id}`),
    enabled: id !== '',
  });

  const terminate = useMutation({
    mutationFn: (terminationDate: string) =>
      api.post(`/employees/${id}/terminate`, { terminationDate }),
    onSuccess: async () => {
      toast.success('Employee terminated.');
      await queryClient.invalidateQueries({ queryKey: ['employees'] });
      await queryClient.invalidateQueries({ queryKey: ['company', 'stats'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reactivate = useMutation({
    mutationFn: () => api.post(`/employees/${id}/reactivate`),
    onSuccess: async () => {
      toast.success('Employee reactivated.');
      await queryClient.invalidateQueries({ queryKey: ['employees'] });
      await queryClient.invalidateQueries({ queryKey: ['company', 'stats'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (query.isLoading) return <DetailSkeleton />;

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const employee = query.data;
  if (!employee) {
    return (
      <Card>
        <EmptyState title="Employee not found" description="It may have been removed." />
      </Card>
    );
  }

  const handleTerminate = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ok = await confirm({
      title: `Terminate ${employee.fullName}?`,
      description:
        'The record is retained and marked terminated. Any linked login account is suspended and all its sessions are signed out.',
      confirmLabel: 'Terminate',
      tone: 'destructive',
    });
    if (ok) terminate.mutate(today);
  };

  const handleReactivate = async () => {
    const ok = await confirm({
      title: `Reactivate ${employee.fullName}?`,
      description: 'The status returns to Active and the termination date is cleared.',
      confirmLabel: 'Reactivate',
    });
    if (ok) reactivate.mutate();
  };

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

      <Card className="mb-5">
        <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
          <Avatar name={employee.fullName} photoUrl={employee.photoUrl} colorKey={employee.id} size="xl" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{employee.fullName}</h2>
              <Badge variant={STATUS_TONE[employee.status]}>
                {EMPLOYEE_STATUS_LABELS[employee.status]}
              </Badge>
              {employee.hasLogin ? <Badge variant="primary">Has login</Badge> : null}
            </div>
            <p className="mt-0.5 text-[13.5px] text-muted-foreground">
              {employee.jobTitle ?? 'No designation'}
              {employee.department ? ` · ${employee.department.name}` : ''}
            </p>
            <p className="mt-1 font-mono text-[12px] text-muted-foreground">
              {employee.employeeNumber}
            </p>
          </div>

          <Can permission={PERMISSIONS.EMPLOYEE_MANAGE}>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
              {employee.status === 'TERMINATED' ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={reactivate.isPending}
                  onClick={() => void handleReactivate()}
                >
                  <RotateCcw />
                  Reactivate
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  loading={terminate.isPending}
                  onClick={() => void handleTerminate()}
                >
                  <UserMinus />
                  Terminate
                </Button>
              )}
            </div>
          </Can>
        </CardContent>
      </Card>

      <div className="mb-5 overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Employee sections">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={cn(
                'border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors',
                tab === item
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item}
              {item === 'Reports' && employee.directReports.length > 0 ? (
                <span className="tabular ml-1.5 text-[12px] text-muted-foreground">
                  {employee.directReports.length}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'Overview' ? <OverviewTab employee={employee} /> : null}
      {tab === 'Personal' ? <PersonalTab employee={employee} canSeeRestricted={has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ)} /> : null}
      {tab === 'Experience' ? <ExperienceTab employee={employee} /> : null}
      {tab === 'Reports' ? <ReportsTab employee={employee} onOpen={(rid) => navigate(`/people/${rid}`)} /> : null}

      <EmployeeFormDrawer open={editing} employee={employee} onClose={() => setEditing(false)} />
    </>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-[13.5px]">{value || '--'}</dd>
    </div>
  );
}

function OverviewTab({ employee }: { employee: EmployeeDetail }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader bordered>
          <CardTitle className="flex items-center gap-2">
            <Briefcase className="size-4 text-muted-foreground" aria-hidden />
            Employment
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Designation" value={employee.designation?.name} />
            <Field label="Employment type" value={EMPLOYMENT_TYPE_LABELS[employee.employmentType]} />
            <Field label="Hire date" value={formatDate(employee.hireDate)} />
            <Field label="Confirmation date" value={formatDate(employee.confirmationDate)} />
            {employee.status === 'TERMINATED' ? (
              <Field label="Termination date" value={formatDate(employee.terminationDate)} />
            ) : null}
            <Field label="Source of hire" value={employee.sourceOfHire} />
            <Field
              label="Prior experience"
              value={
                employee.priorExperienceMonths !== null
                  ? `${Math.floor(employee.priorExperienceMonths / 12)}y ${employee.priorExperienceMonths % 12}m`
                  : null
              }
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader bordered>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="size-4 text-muted-foreground" aria-hidden />
            Organisation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Department" value={employee.department?.name} />
            <Field label="Team" value={employee.team?.name} />
            <Field
              label="Location"
              value={
                employee.location ? (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="size-3.5 text-muted-foreground" aria-hidden />
                    {employee.location.name}
                  </span>
                ) : null
              }
            />
            <Field
              label="Reports to"
              value={
                employee.manager ? (
                  <Link to={`/people/${employee.manager.id}`} className="text-primary hover:underline">
                    {employee.manager.fullName}
                  </Link>
                ) : null
              }
            />
            <Field
              label="Secondary manager"
              value={
                employee.secondaryManager ? (
                  <Link to={`/people/${employee.secondaryManager.id}`} className="text-primary hover:underline">
                    {employee.secondaryManager.fullName}
                  </Link>
                ) : null
              }
            />
          </dl>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader bordered>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4 text-muted-foreground" aria-hidden />
            Contact
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Work email" value={employee.workEmail} />
            <Field label="Personal email" value={employee.personalEmail} />
            <Field
              label="Work phone"
              value={
                employee.phone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="size-3.5 text-muted-foreground" aria-hidden />
                    {employee.phone}
                  </span>
                ) : null
              }
            />
            <Field label="Personal phone" value={employee.personalPhone} />
            <Field label="Present address" value={employee.presentAddress} />
            <Field label="Permanent address" value={employee.permanentAddress} />
            <Field label="Emergency contact" value={employee.emergencyContactName} />
            <Field
              label="Emergency phone"
              value={
                employee.emergencyContactPhone
                  ? `${employee.emergencyContactPhone}${employee.emergencyContactRelationship ? ` (${employee.emergencyContactRelationship})` : ''}`
                  : null
              }
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function PersonalTab({
  employee,
  canSeeRestricted,
}: {
  employee: EmployeeDetail;
  canSeeRestricted: boolean;
}) {
  const humanise = (value: string | null) =>
    value ? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ') : null;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader bordered>
          <CardTitle>Personal details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Date of birth" value={formatDate(employee.dateOfBirth)} />
            <Field label="Gender" value={humanise(employee.gender)} />
            <Field label="Marital status" value={humanise(employee.maritalStatus)} />
            <Field label="Nationality" value={employee.nationality} />
            <Field label="Blood group" value={employee.bloodGroup} />
            <Field
              label="LinkedIn"
              value={
                employee.linkedinUrl ? (
                  <a
                    href={employee.linkedinUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-primary hover:underline"
                  >
                    Profile
                  </a>
                ) : null
              }
            />
            <Field label="Notes" value={employee.notes} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader bordered>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" aria-hidden />
            Restricted
          </CardTitle>
        </CardHeader>
        {canSeeRestricted && employee.restricted ? (
          <CardContent>
            <p className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[12.5px] text-warning-foreground">
              Your view of these fields has been recorded in the audit log.
            </p>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="National ID" value={employee.restricted.nationalId} />
              <Field label="Bank account" value={employee.restricted.bankAccountNumber} />
              <Field label="Passport number" value={employee.restricted.passportNumber} />
              <Field label="Passport expiry" value={formatDate(employee.restricted.passportExpiry)} />
              <Field label="Visa number" value={employee.restricted.visaNumber} />
              <Field label="Visa expiry" value={formatDate(employee.restricted.visaExpiry)} />
            </dl>
          </CardContent>
        ) : (
          <EmptyState
            icon={Lock}
            title="Restricted fields are hidden"
            description="National ID, passport, visa and bank details need the restricted-fields permission."
            className="py-10"
          />
        )}
      </Card>
    </div>
  );
}

function ExperienceTab({ employee }: { employee: EmployeeDetail }) {
  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Previous employment</CardTitle>
      </CardHeader>
      {employee.workExperience.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No previous employment recorded"
          description="Earlier roles appear here once added."
        />
      ) : (
        <ul className="divide-y divide-border">
          {employee.workExperience.map((entry) => (
            <li key={entry.id} className="px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13.5px] font-medium">{entry.companyName}</p>
                <p className="tabular text-[12.5px] text-muted-foreground">
                  {formatDate(entry.fromDate)} – {entry.toDate ? formatDate(entry.toDate) : 'Present'}
                </p>
              </div>
              {entry.jobTitle ? (
                <p className="text-[13px] text-muted-foreground">{entry.jobTitle}</p>
              ) : null}
              {entry.description ? (
                <p className="mt-1 text-[12.5px] text-muted-foreground">{entry.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReportsTab({
  employee,
  onOpen,
}: {
  employee: EmployeeDetail;
  onOpen: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Direct reports</CardTitle>
      </CardHeader>
      {employee.directReports.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No direct reports"
          description="Nobody currently reports to this employee."
        />
      ) : (
        <ul className="divide-y divide-border">
          {employee.directReports.map((report) => (
            <li key={report.id}>
              <button
                type="button"
                onClick={() => onOpen(report.id)}
                className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-accent/50"
              >
                <Avatar name={report.fullName} colorKey={report.id} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium">{report.fullName}</p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {report.jobTitle ?? '--'}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="flex items-center gap-4 py-5">
          <Skeleton className="size-20 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-3 w-24" />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index}>
            <CardHeader bordered>
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, field) => (
                <div key={field} className="space-y-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-32" />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
