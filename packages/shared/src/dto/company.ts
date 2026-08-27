import { z } from 'zod';

export const WEEK_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

export type WeekDay = (typeof WEEK_DAYS)[number];

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2, 'Company name is required.').max(160),
  legalName: z.string().trim().max(200).optional().nullable(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  website: z.string().trim().url('Enter a valid URL.').max(200).optional().nullable(),
  addressLine1: z.string().trim().max(200).optional().nullable(),
  addressLine2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  postalCode: z.string().trim().max(24).optional().nullable(),
  country: z.string().trim().max(120).optional().nullable(),
  timezone: z.string().trim().min(1).max(64),
  currency: z.string().trim().length(3, 'Use a 3-letter currency code.').toUpperCase(),
  dateFormat: z.string().trim().min(1).max(32),
  weekStartsOn: z.enum(WEEK_DAYS),
});

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
