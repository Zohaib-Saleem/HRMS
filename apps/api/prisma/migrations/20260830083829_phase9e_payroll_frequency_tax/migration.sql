-- CreateEnum
CREATE TYPE "PayrollFrequency" AS ENUM ('MONTHLY', 'BIWEEKLY', 'WEEKLY');

-- AlterTable
ALTER TABLE "payroll_settings" ADD COLUMN     "frequency" "PayrollFrequency" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "taxEnabled" BOOLEAN NOT NULL DEFAULT false;
