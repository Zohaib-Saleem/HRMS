-- CreateEnum
CREATE TYPE "DataScope" AS ENUM ('NONE', 'OWN', 'REPORTS', 'REPORTS_AND_OWN', 'DEPARTMENT', 'ALL');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "employeeNumberPrefix" TEXT NOT NULL DEFAULT 'EMP-';

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "dataScope" "DataScope" NOT NULL DEFAULT 'OWN';
