-- Full-day tolerance: how far short of a full day a person may fall and still
-- be credited one.
--
-- Additive, one column, with a default. Nothing is recalculated by adding it,
-- and no attendance figure changes until the day is next scored.
ALTER TABLE "companies"
  ADD COLUMN "fullDayToleranceMinutes" INTEGER NOT NULL DEFAULT 30;
