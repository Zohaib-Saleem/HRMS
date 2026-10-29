-- The day of the month a payroll cycle closes on; null keeps calendar months.
ALTER TABLE "payroll_settings" ADD COLUMN "cycleEndDay" INTEGER;
