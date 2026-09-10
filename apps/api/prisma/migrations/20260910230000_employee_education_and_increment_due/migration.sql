-- Additive only: one new nullable column and one new table. Nothing existing is
-- altered or dropped, so this is safe to apply to a populated database.

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "nextIncrementDueDate" DATE;

-- CreateTable
CREATE TABLE "employee_education" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "degree" TEXT,
    "institution" TEXT,
    "yearCompleted" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_education_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_education_employeeId_idx" ON "employee_education"("employeeId");

-- AddForeignKey
ALTER TABLE "employee_education" ADD CONSTRAINT "employee_education_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
