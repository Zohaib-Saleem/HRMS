import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/**
 * Organisation structure DTOs: departments, teams, designations, locations.
 *
 * `.nullish().transform(...)` on optional text turns an empty form input into
 * SQL NULL rather than an empty string, so "not set" has exactly one
 * representation in the database.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value));

// --------------------------------------------------------------- departments

export const departmentInputSchema = z.object({
  name: z.string().trim().min(2, 'Department name is required.').max(120),
  code: optionalText(24),
  description: optionalText(500),
  parentDepartmentId: optionalText(64),
  headEmployeeId: optionalText(64),
  isActive: z.boolean().default(true),
});

export type DepartmentInput = z.infer<typeof departmentInputSchema>;

export const departmentQuerySchema = paginationQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
  parentDepartmentId: z.string().trim().max(64).optional(),
});

// --------------------------------------------------------------------- teams

export const teamInputSchema = z.object({
  name: z.string().trim().min(2, 'Team name is required.').max(120),
  departmentId: z.string().trim().min(1, 'Choose a department.'),
  description: optionalText(500),
  leadEmployeeId: optionalText(64),
  isActive: z.boolean().default(true),
});

export type TeamInput = z.infer<typeof teamInputSchema>;

export const teamQuerySchema = paginationQuerySchema.extend({
  departmentId: z.string().trim().max(64).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

// -------------------------------------------------------------- designations

export const designationInputSchema = z.object({
  name: z.string().trim().min(2, 'Designation name is required.').max(120),
  code: optionalText(24),
  description: optionalText(500),
  isActive: z.boolean().default(true),
});

export type DesignationInput = z.infer<typeof designationInputSchema>;

export const designationQuerySchema = paginationQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
});

// ----------------------------------------------------------------- locations

export const locationInputSchema = z.object({
  name: z.string().trim().min(2, 'Location name is required.').max(120),
  code: optionalText(24),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(120),
  state: optionalText(120),
  postalCode: optionalText(24),
  country: optionalText(120),
  timezone: optionalText(64),
  isActive: z.boolean().default(true),
});

export type LocationInput = z.infer<typeof locationInputSchema>;

export const locationQuerySchema = paginationQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
});

// --------------------------------------------------------- shared read types

export interface DepartmentRecord {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
  parentDepartmentId: string | null;
  parentDepartmentName: string | null;
  headEmployeeId: string | null;
  headEmployeeName: string | null;
  employeeCount: number;
  teamCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  departmentId: string;
  departmentName: string;
  leadEmployeeId: string | null;
  leadEmployeeName: string | null;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesignationRecord {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocationRecord {
  id: string;
  name: string;
  code: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  timezone: string | null;
  isActive: boolean;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Minimal shape for dropdowns - avoids shipping full records to a select. */
export interface LookupOption {
  id: string;
  label: string;
  secondaryLabel?: string | null;
}

/** Node of the department hierarchy tree. */
export interface DepartmentTreeNode {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  headEmployeeName: string | null;
  employeeCount: number;
  children: DepartmentTreeNode[];
}
