import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Camera,
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
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  PERMISSIONS,
  type EmployeeDetail,
  type EmployeeProfileSummary,
  type EmployeeStatus,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmployeeCompensation } from './employee-compensation';
import { EmployeeEducation } from './employee-education';
import { EmployeeProfileSummaryCards } from './employee-profile-summary';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { Can, useSession, usePermissions } from '@/features/auth/session-context';
import { EmployeeFormDrawer } from './employee-form-drawer';
import { EmployeePhotoDialog } from './employee-photo-dialog';
import { EmployeeContracts } from '@/features/employment/employee-contracts';
import { EmployeePolicies } from '@/features/employment/employee-policies';
import { EmployeeLoans } from '@/features/loans/employee-loans';
import { EmployeeLeave } from '@/features/leave/employee-leave';
import { EmployeePayrollHistory } from '@/features/payroll/employee-payroll-history';
import { EmployeeAttendanceViews } from '@/features/time/employee-attendance-views';
import { EmployeeAssetsTab } from '@/features/assets/employee-assets-tab';
import { EmployeeTimeline } from './employee-timeline';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'warning' | 'destructive' | 'neutral'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  SUSPENDED: 'destructive',
  INACTIVE: 'neutral',
  RESIGNED: 'neutral',
  TERMINATED: 'neutral',
};

/**
 * Employee 360: one profile, every record HR holds about a person.
 *
 * The order is the order somebody actually reads a person in - who they are,
 * then their personal details, then what they did (attendance, leave), then
 * what it cost (loans, pay), then the paperwork, then their background. Each
 * tab mounts a component that owns that module's data and its own endpoint;
 * this page composes, it does not re-implement. Nothing here calculates an
 * attendance figure, a leave balance, an overtime amount or a deduction.
 *
 * Only the selected tab is mounted, so opening a profile costs the detail
 * request and the summary strip - not every module's queries at once.
 */
const TABS = [
  'Overview',
  'Personal',
  'Attendance',
  'Leave',
  'Loans',
  'Salary & Payroll',
  'Contracts & Policies',
  'Education & Experience',
  'Assets',
  'Timeline',
  'Reports',
] as const;
type Tab = (typeof TABS)[number];

export function EmployeeDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { has } = usePermissions();
  const { session } = useSession();
  const [tab, setTab] = React.useState<Tab>('Overview');
  const [editing, setEditing] = React.useState(false);
  const [managingPhoto, setManagingPhoto] = React.useState(false);

  const query = useQuery({
    queryKey: ['employees', id],
    queryFn: () => api.get<EmployeeDetail>(`/employees/${id}`),
    enabled: id !== '',
  });

  /**
   * The 360 summary, shared with the headline strip.
   *
   * Same query key, so the strip and the Overview tab's PunchCode field are one
   * request between them rather than two. Its failure is not this page's
   * failure: the strip hides itself and Overview simply omits the field.
   */
  const summary = useQuery({
    queryKey: ['employees', id, 'profile-summary'],
    queryFn: () => api.get<EmployeeProfileSummary>(`/employees/${id}/profile-summary`),
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

  /**
   * Who may change the photo on this profile.
   *
   * `employee.manage` for anybody else's - the same grant that already governs
   * every other edit to an employee record - or your own record whatever you
   * hold, which is the rule the API enforces and the reason an ordinary member
   * of staff can put up their own photograph and nobody else's.
   *
   * A courtesy either way: hiding the button is not the control. The endpoint
   * makes the same decision and is the one that counts.
   */
  const isOwnRecord = session?.user.employee?.id === employee.id;
  const canManagePhoto = has(PERMISSIONS.EMPLOYEE_MANAGE) || isOwnRecord;

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
          {canManagePhoto ? (
            <button
              type="button"
              onClick={() => setManagingPhoto(true)}
              // The avatar itself is the control, with the camera badge as the
              // affordance - the same gesture people already expect from every
              // other profile screen they use.
              className="group relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`Change profile photo for ${employee.fullName}`}
            >
              <Avatar
                name={employee.fullName}
                photoUrl={employee.photoUrl}
                colorKey={employee.id}
                size="xl"
              />
              <span
                className="absolute -bottom-0.5 -right-0.5 grid size-7 place-items-center rounded-full border-2 border-surface bg-primary text-primary-foreground shadow-sm transition-transform group-hover:scale-105"
                aria-hidden
              >
                <Camera className="size-3.5" />
              </span>
            </button>
          ) : (
            <Avatar
              name={employee.fullName}
              photoUrl={employee.photoUrl}
              colorKey={employee.id}
              size="xl"
            />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{employee.fullName}</h2>
              <Badge variant={STATUS_TONE[employee.status]}>
                {EMPLOYEE_STATUS_LABELS[employee.status]}
              </Badge>
              {employee.employmentStatus ? (
                <Badge variant="neutral">
                  {EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]}
                </Badge>
              ) : null}
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

      <EmployeeProfileSummaryCards employeeId={employee.id} />

      <div className="mb-5 overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Employee sections">
          {TABS.filter((item) => {
            // A tab whose contents the caller cannot read is not shown empty;
            // it is not shown at all, so the row says what is actually here.
            if (item === 'Attendance') return has(PERMISSIONS.ATTENDANCE_READ);
            if (item === 'Leave') return has(PERMISSIONS.LEAVE_READ);
            if (item === 'Loans') return has(PERMISSIONS.LOAN_READ);
            if (item === 'Salary & Payroll') {
              return has(PERMISSIONS.PAYROLL_READ) || has(PERMISSIONS.PAYSLIP_READ);
            }
            if (item === 'Contracts & Policies') {
              return has(PERMISSIONS.CONTRACT_READ) || has(PERMISSIONS.POLICY_READ);
            }
            // The endpoint behind it narrows by the reader's data scope as
            // well, so an employee on an OWN scope finds their own kit here and
            // is refused anybody else's.
            if (item === 'Assets') return has(PERMISSIONS.ASSET_READ);
            return true;
          }).map((item) => (
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

      {tab === 'Overview' ? <OverviewTab employee={employee} summary={summary.data} /> : null}
      {tab === 'Personal' ? <PersonalTab employee={employee} canSeeRestricted={has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ)} /> : null}
      {tab === 'Attendance' ? (
        <EmployeeAttendanceViews employeeId={employee.id} employeeName={employee.fullName} />
      ) : null}
      {tab === 'Leave' ? <EmployeeLeave employeeId={employee.id} /> : null}
      {tab === 'Loans' ? (
        <EmployeeLoans employeeId={employee.id} employeeName={employee.fullName} />
      ) : null}
      {tab === 'Salary & Payroll' ? (
        <div className="space-y-5">
          <EmployeeCompensation employeeId={employee.id} employeeName={employee.fullName} />
          <EmployeePayrollHistory employeeId={employee.id} />
        </div>
      ) : null}
      {tab === 'Contracts & Policies' ? (
        <div className="space-y-5">
          <EmployeeContracts employeeId={employee.id} employeeName={employee.fullName} />
          <EmployeePolicies employeeId={employee.id} />
        </div>
      ) : null}
      {tab === 'Education & Experience' ? <ExperienceTab employee={employee} /> : null}
      {tab === 'Assets' ? <EmployeeAssetsTab employeeId={employee.id} /> : null}
      {tab === 'Timeline' ? (
        <EmployeeTimeline
          employeeId={employee.id}
          employeeName={employee.fullName}
          photoUrl={employee.photoUrl}
          // The drawer's "Open ..." button lands the reader on the tab that owns
          // the record. Every TimelineLinkTab is one of TABS, so this cannot
          // send them somewhere the row does not offer.
          onOpenTab={(target) => setTab(target)}
        />
      ) : null}
      {tab === 'Reports' ? <ReportsTab employee={employee} onOpen={(rid) => navigate(`/people/${rid}`)} /> : null}

      <EmployeeFormDrawer open={editing} employee={employee} onClose={() => setEditing(false)} />

      {canManagePhoto ? (
        <EmployeePhotoDialog
          open={managingPhoto}
          onOpenChange={setManagingPhoto}
          employeeId={employee.id}
          employeeName={employee.fullName}
          photoUrl={employee.photoUrl}
          hasPhoto={employee.hasPhoto}
        />
      ) : null}
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

function OverviewTab({
  employee,
  summary,
}: {
  employee: EmployeeDetail;
  summary: EmployeeProfileSummary | undefined;
}) {
  // `?? []` because a response cached before this field existed has no key at
  // all, and a profile that throws is a worse answer than one missing a line.
  const teamManagers = employee.teamManagers ?? [];

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
            <Field label="Employee ID" value={<span className="font-mono">{employee.employeeNumber}</span>} />
            {/*
              The PunchCode the terminals know this person by, for display only.
              Read from the mapping the device module owns; changing it is done
              there, on the screen that also re-attributes the punches, because
              editing it here would silently change whose attendance is whose.
              Absent for a caller without device.read, and for anyone not
              enrolled on a terminal.
            */}
            {summary?.punchCodes && summary.punchCodes.length > 0 ? (
              <Field
                label={summary.punchCodes.length > 1 ? 'PunchCodes' : 'PunchCode'}
                value={<span className="font-mono">{summary.punchCodes.join(', ')}</span>}
              />
            ) : null}
            <Field label="Status" value={EMPLOYEE_STATUS_LABELS[employee.status]} />
            <Field label="Designation" value={employee.designation?.name} />
            <Field label="Employment type" value={EMPLOYMENT_TYPE_LABELS[employee.employmentType]} />
            {/*
              Next to Status and Employment type deliberately: it is the field
              people mistake for both, and seeing the three together is what
              makes the difference legible. "Not set" rather than a blank,
              because an unclassified record is a thing HR can act on.
            */}
            <Field
              label="Employment status"
              value={
                employee.employmentStatus
                  ? EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]
                  : 'Not set'
              }
            />
            <Field label="Hire date" value={formatDate(employee.hireDate)} />
            <Field label="Confirmation date" value={formatDate(employee.confirmationDate)} />
            <Field label="Next increment due" value={formatDate(employee.nextIncrementDueDate)} />
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
            {/*
              Shown only when set. A row reading "Attendance: counted" against
              all 77 people who simply punch would be noise; the exception is
              the thing worth stating.
            */}
            {employee.excludedFromAttendance ? (
              <Field label="Attendance" value="Not counted - does not punch in" />
            ) : null}
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
            {/*
              Three separate facts, in this order. The team manager comes from
              the TEAM's roster - it is not the department head and not the
              reporting line below, and it is who this person's requests go to.
            */}
            <Field
              label={teamManagers.length === 1 ? 'Team manager' : 'Team managers'}
              value={
                teamManagers.length > 0 ? (
                  <span className="flex flex-col gap-0.5">
                    {teamManagers.map((m) => (
                      <Link key={m.id} to={`/people/${m.id}`} className="text-primary hover:underline">
                        {m.fullName}
                      </Link>
                    ))}
                  </span>
                ) : null
              }
            />
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
            {/*
              The sign-in email is authentication data, not HR data, and it is
              not the same field as the work email even when the two happen to
              agree. It is neither shown nor edited here: it lives on the login
              account, under Settings -> Users, behind its own permission.
            */}
            {employee.hasLogin ? (
              <Field
                label="Sign-in email"
                value={
                  <Can
                    permission={PERMISSIONS.USER_READ}
                    fallback={
                      <span className="text-muted-foreground">
                        Held on the login account, separately from the work email.
                      </span>
                    }
                  >
                    <Link to="/settings/users" className="text-primary hover:underline">
                      Managed in Settings &rarr; Users
                    </Link>
                  </Can>
                }
              />
            ) : null}
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
    <div className="grid gap-5 lg:grid-cols-2">
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

      <EmployeeEducation employeeId={employee.id} education={employee.education} />
    </div>
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
                <Avatar
                  name={report.fullName}
                  photoUrl={report.photoUrl}
                  colorKey={report.id}
                  size="sm"
                />
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
