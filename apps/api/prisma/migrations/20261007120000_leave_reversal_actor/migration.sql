-- Who gave a day of leave back by hand. Null for every row reconciliation
-- wrote automatically, which is every row before this release. Additive and
-- nullable: nothing existing is rewritten.
ALTER TABLE "leave_reversals" ADD COLUMN "reversedById" TEXT;
