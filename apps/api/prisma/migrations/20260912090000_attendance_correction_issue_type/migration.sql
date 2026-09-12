-- Additive only: one new enum type and one new NULLABLE column on an existing
-- table. No row is read, rewritten or deleted; every request already on file
-- keeps its times, its reason and its approval, and reads back with a null
-- issue type. Nothing outside attendance_regularization_requests is touched -
-- no attendance record, no raw punch, no PunchCode mapping, no leave, salary,
-- payroll or loan row.
--
-- Reversible with:
--   ALTER TABLE "attendance_regularization_requests" DROP COLUMN "issueType";
--   DROP TYPE "AttendanceCorrectionIssue";

-- CreateEnum
CREATE TYPE "AttendanceCorrectionIssue" AS ENUM ('MISSING_PUNCH', 'INCORRECT_CHECK_IN', 'INCORRECT_CHECK_OUT', 'OTHER');

-- AlterTable
ALTER TABLE "attendance_regularization_requests" ADD COLUMN     "issueType" "AttendanceCorrectionIssue";
