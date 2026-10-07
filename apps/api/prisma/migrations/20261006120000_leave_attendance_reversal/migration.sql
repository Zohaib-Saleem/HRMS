-- Leave given back when attendance is recorded on an approved leave day.
-- Additive only: no existing row is read or rewritten. Existing requests get
-- cancelledBySystem = false and no reason, which is what they were.
ALTER TABLE "leave_requests"
  ADD COLUMN "cancelledBySystem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancellationReason" TEXT;

CREATE TABLE "leave_reversals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveRequestId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "attendanceRecordId" TEXT,
    "attendanceSource" "AttendanceSource" NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_reversals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_reversals_leaveRequestId_date_key" ON "leave_reversals"("leaveRequestId", "date");
CREATE INDEX "leave_reversals_employeeId_date_idx" ON "leave_reversals"("employeeId", "date");

ALTER TABLE "leave_reversals" ADD CONSTRAINT "leave_reversals_leaveRequestId_fkey"
  FOREIGN KEY ("leaveRequestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_reversals" ADD CONSTRAINT "leave_reversals_attendanceRecordId_fkey"
  FOREIGN KEY ("attendanceRecordId") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
