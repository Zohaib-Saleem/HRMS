-- Employee profile photo.
--
-- Additive only: three new nullable columns on an existing table. Nothing is
-- altered, renamed or dropped, no existing value is read or rewritten, and no
-- default is applied - so every row already in `employees` is left exactly as
-- it is and the statement takes no table rewrite. Safe to apply to a populated
-- database.
--
-- The image itself is NOT stored here. `photoObjectKey` names an object in the
-- file store; the bytes live on disk behind the API, which is what keeps an
-- employee list query from dragging megabytes of image through it.

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "photoObjectKey" TEXT,
ADD COLUMN     "photoContentType" TEXT,
ADD COLUMN     "photoUpdatedAt" TIMESTAMP(3);
