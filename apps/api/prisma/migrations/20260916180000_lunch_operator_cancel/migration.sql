-- Lunch: the operator's cancel, the fulfilment states it needs, and the refund
-- decision that goes with cancelling an order somebody has already paid for.
--
-- Additive except for one rename, which is a rename and not a rewrite: the
-- status previously called PLACED is now called ORDERED, because it is now the
-- first of four live states rather than the only one. `ALTER TYPE ... RENAME
-- VALUE` changes the label in place, so every existing row keeps the value it
-- had and no data is read, rewritten or interpreted. Nothing can be lost by it.
--
-- Three decisions are enforced here rather than in application code.
--
-- The fulfilment states exist because DELIVERED is load-bearing. It is the line
-- after which an order may no longer simply be cancelled - the food has been
-- eaten - and a rule about a state the schema cannot express is a rule that
-- lives only in prose. The service layer holds the forward-only flow between
-- them; the enum holds the vocabulary.
--
-- `refundStatus` sits BESIDE `paymentStatus` rather than replacing a value in
-- it. Cancelling a paid order must never set it back to UNPAID: money changed
-- hands, and a cash system that forgets that has lost the only thing it was
-- keeping. So the payment record stays exactly as it was and the refund
-- decision is recorded next to it, which is also what lets the day's report
-- separate "refunded" from "retained" - two figures that mean opposite things
-- when somebody counts a cash box.
--
-- `cancelledByUserId` is SET NULL on user deletion, like `paidByUserId` before
-- it: deleting the account of somebody who has left must not delete the orders
-- they acted on. The same goes for `refundedByUserId`.
--
-- No finance or payroll table is touched, read or referenced. This migration
-- adds columns to `lunch_orders` and nothing else.

-- AlterEnum: PLACED becomes ORDERED, in place. Existing rows are untouched.
ALTER TYPE "LunchOrderStatus" RENAME VALUE 'PLACED' TO 'ORDERED';

-- AlterEnum: the rest of the lunch round.
ALTER TYPE "LunchOrderStatus" ADD VALUE 'PREPARING';
ALTER TYPE "LunchOrderStatus" ADD VALUE 'READY';
ALTER TYPE "LunchOrderStatus" ADD VALUE 'DELIVERED';

-- CreateEnum
CREATE TYPE "LunchRefundStatus" AS ENUM ('NONE', 'REFUNDED', 'RETAINED');

-- AlterTable: the default moves with the rename. Stated explicitly rather than
-- left to the rename, so the column's default is visible in this file.
ALTER TABLE "lunch_orders" ALTER COLUMN "status" SET DEFAULT 'ORDERED';

-- AlterTable: who cancelled it and why, and what became of the money.
--
-- Every column is nullable or defaulted, so existing rows are valid the moment
-- this runs: an order nobody has cancelled has no canceller, and an order that
-- was never both paid for and cancelled has no refund decision to record.
ALTER TABLE "lunch_orders" ADD COLUMN     "cancelledByUserId" TEXT,
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "refundStatus" "LunchRefundStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "refundedByUserId" TEXT,
ADD COLUMN     "refundReason" TEXT;

-- AddForeignKey
ALTER TABLE "lunch_orders" ADD CONSTRAINT "lunch_orders_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lunch_orders" ADD CONSTRAINT "lunch_orders_refundedByUserId_fkey" FOREIGN KEY ("refundedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
