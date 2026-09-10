-- Punch integrity settings.
--
-- Defaults reproduce the behaviour that was already in force everywhere except
-- the implausible-span check, which is new and deliberately ON: crediting a day
-- nobody worked is the failure these columns exist to stop. A company that
-- wants the old behaviour sets allowImplausibleSpans to true.

ALTER TABLE "companies"
  ADD COLUMN "duplicatePunchWindowSeconds" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "maxPlausibleSpanMinutes"     INTEGER NOT NULL DEFAULT 960,
  ADD COLUMN "allowImplausibleSpans"       BOOLEAN NOT NULL DEFAULT false;

-- Null means "inherit the company value", exactly as every other override here.
ALTER TABLE "attendance_policies"
  ADD COLUMN "duplicatePunchWindowSeconds" INTEGER,
  ADD COLUMN "maxPlausibleSpanMinutes"     INTEGER,
  ADD COLUMN "allowImplausibleSpans"       BOOLEAN;
