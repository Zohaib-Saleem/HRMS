import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import {
  PERMISSIONS,
  WEEK_DAYS,
  updateCompanySchema,
  type UpdateCompanyInput,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { SESSION_QUERY_KEY, usePermissions } from '@/features/auth/session-context';

interface CompanyRecord extends UpdateCompanyInput {
  id: string;
}

/** A short, safe list. A full IANA picker arrives with the attendance module. */
const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'PKR', 'INR', 'SGD', 'AUD', 'CAD'];

const DATE_FORMATS = [
  { value: 'dd MMM yyyy', label: '31 Dec 2025' },
  { value: 'dd/MM/yyyy', label: '31/12/2025' },
  { value: 'MM/dd/yyyy', label: '12/31/2025' },
  { value: 'yyyy-MM-dd', label: '2025-12-31' },
];

export function CompanySettingsPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.COMPANY_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const query = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<CompanyRecord>('/company'),
  });

  const form = useForm<UpdateCompanyInput>({
    resolver: zodResolver(updateCompanySchema),
    values: query.data
      ? {
          name: query.data.name,
          legalName: query.data.legalName ?? '',
          email: query.data.email ?? '',
          phone: query.data.phone ?? '',
          website: query.data.website ?? '',
          addressLine1: query.data.addressLine1 ?? '',
          addressLine2: query.data.addressLine2 ?? '',
          city: query.data.city ?? '',
          state: query.data.state ?? '',
          postalCode: query.data.postalCode ?? '',
          country: query.data.country ?? '',
          timezone: query.data.timezone,
          currency: query.data.currency,
          dateFormat: query.data.dateFormat,
          weekStartsOn: query.data.weekStartsOn,
        }
      : undefined,
  });

  const { register, handleSubmit, formState, reset, setError } = form;

  const mutation = useMutation({
    mutationFn: (values: UpdateCompanyInput) => api.patch<CompanyRecord>('/company', values),
    onSuccess: async (updated) => {
      toast.success('Company settings saved.');
      queryClient.setQueryData(['company'], updated);
      // Localisation defaults live in the session payload too.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      reset(undefined, { keepValues: true });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof UpdateCompanyInput, { message: messages[0] });
        }
        toast.error('Some fields need your attention.');
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  // Empty optional text inputs should clear the column, not store "".
  const onSubmit = handleSubmit((values) => {
    const normalised = Object.fromEntries(
      Object.entries(values).map(([key, value]) =>
        typeof value === 'string' && value.trim() === '' ? [key, null] : [key, value],
      ),
    ) as UpdateCompanyInput;
    mutation.mutate(normalised);
  });

  const handleReset = async () => {
    const ok = await confirm({
      title: 'Discard your changes?',
      description: 'The form will go back to the last saved values.',
      confirmLabel: 'Discard',
      tone: 'destructive',
    });
    if (ok) reset();
  };

  if (query.isLoading) return <CompanyFormSkeleton />;
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const dirty = formState.isDirty;

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <fieldset disabled={!canManage} className="space-y-5">
        <Card>
          <CardHeader bordered>
            <CardTitle>Organisation</CardTitle>
            <CardDescription>How your company is identified across the system.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField label="Company name" htmlFor="name" error={formState.errors.name?.message} required>
              <Input {...register('name')} />
            </FormField>
            <FormField label="Legal name" htmlFor="legalName" error={formState.errors.legalName?.message} hint="Used on formal documents.">
              <Input {...register('legalName')} />
            </FormField>
            <FormField label="Contact email" htmlFor="email" error={formState.errors.email?.message}>
              <Input type="email" {...register('email')} />
            </FormField>
            <FormField label="Phone" htmlFor="phone" error={formState.errors.phone?.message}>
              <Input type="tel" {...register('phone')} />
            </FormField>
            <FormField label="Website" htmlFor="website" error={formState.errors.website?.message} className="sm:col-span-2">
              <Input type="url" placeholder="https://" {...register('website')} />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader bordered>
            <CardTitle>Registered address</CardTitle>
            <CardDescription>Appears on payroll and compliance documents later.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField label="Address line 1" htmlFor="addressLine1" error={formState.errors.addressLine1?.message} className="sm:col-span-2">
              <Input {...register('addressLine1')} />
            </FormField>
            <FormField label="Address line 2" htmlFor="addressLine2" error={formState.errors.addressLine2?.message} className="sm:col-span-2">
              <Input {...register('addressLine2')} />
            </FormField>
            <FormField label="City" htmlFor="city" error={formState.errors.city?.message}>
              <Input {...register('city')} />
            </FormField>
            <FormField label="State or region" htmlFor="state" error={formState.errors.state?.message}>
              <Input {...register('state')} />
            </FormField>
            <FormField label="Postal code" htmlFor="postalCode" error={formState.errors.postalCode?.message}>
              <Input {...register('postalCode')} />
            </FormField>
            <FormField label="Country" htmlFor="country" error={formState.errors.country?.message}>
              <Input {...register('country')} />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader bordered>
            <CardTitle>Localisation</CardTitle>
            <CardDescription>
              Defaults every module inherits - attendance windows, payroll periods and reports.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField label="Time zone" htmlFor="timezone" error={formState.errors.timezone?.message} required>
              <NativeSelect {...register('timezone')}>
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replace('_', ' ')}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Currency" htmlFor="currency" error={formState.errors.currency?.message} required>
              <NativeSelect {...register('currency')}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Date format" htmlFor="dateFormat" error={formState.errors.dateFormat?.message} required>
              <NativeSelect {...register('dateFormat')}>
                {DATE_FORMATS.map((format) => (
                  <option key={format.value} value={format.value}>
                    {format.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Week starts on" htmlFor="weekStartsOn" error={formState.errors.weekStartsOn?.message} required>
              <NativeSelect {...register('weekStartsOn')}>
                {WEEK_DAYS.map((day) => (
                  <option key={day} value={day}>
                    {day.charAt(0) + day.slice(1).toLowerCase()}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </CardContent>

          {canManage ? (
            <CardFooter className="justify-end">
              <Button type="button" variant="ghost" disabled={!dirty} onClick={() => void handleReset()}>
                Discard
              </Button>
              <Button type="submit" loading={mutation.isPending} disabled={!dirty}>
                <Save />
                Save changes
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      </fieldset>

      {!canManage ? (
        <p className="text-[13px] text-muted-foreground">
          You can view these settings but not change them.
        </p>
      ) : null}
    </form>
  );
}

function CompanyFormSkeleton() {
  return (
    <div className="space-y-5">
      {[2, 3, 2].map((rows, index) => (
        <Card key={index}>
          <CardHeader bordered>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-64" />
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: rows * 2 }).map((_, field) => (
              <div key={field} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-9.5 w-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
