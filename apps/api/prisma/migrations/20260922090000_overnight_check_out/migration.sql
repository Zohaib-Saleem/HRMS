-- A punch after midnight is a departure from the day before, not an arrival on
-- the day after. Both settings are additive and defaulted; the window is what
-- switches the rule on, and zero restores the previous reading.
--
-- They sit beside the other punch-integrity settings on the company, which is
-- the level the deriver already reads them from.
ALTER TABLE "companies"
  ADD COLUMN "overnightCheckOutWindowMinutes" INTEGER NOT NULL DEFAULT 1080,
  ADD COLUMN "overnightCheckOutCutoff" TEXT NOT NULL DEFAULT '06:00';
