-- When the current assignee was given the case. Additive and nullable: set on
-- every assignment from this release, cleared when a case goes back to nobody.
ALTER TABLE "cases" ADD COLUMN "assignedAt" TIMESTAMP(3);

-- Cases already holding an assignee get the time of their latest assignment,
-- read from the audit trail that has recorded every one of them.
UPDATE "cases" AS c
SET "assignedAt" = a."at"
FROM (
  SELECT "entityId", MAX("createdAt") AS "at"
  FROM "audit_logs"
  WHERE "entityType" = 'Case' AND "action" = 'case.assign'
  GROUP BY "entityId"
) AS a
WHERE a."entityId" = c."id" AND c."assignedUserId" IS NOT NULL;
