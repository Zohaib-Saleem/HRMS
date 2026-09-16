-- Lunch: the daily order, and the cash the office boy collects for it.
--
-- Three tables and three enums, entirely additive. Nothing existing is altered,
-- dropped or backfilled, so this cannot change what any current row means, and
-- rolling the application back leaves only unused tables behind.
--
-- What is NOT here is as much of the design as what is. There is no column
-- linking an order to payroll, to a salary, to a loan or to an approval, and no
-- subsidy column: lunch is settled in cash with the office boy on the day, and
-- a deduction would put a month between ordering a biryani and accounting for
-- it. Nothing in this migration touches a payroll table.
--
-- Four decisions are enforced here rather than in application code.
--
-- The order number. `lunch_orders_companyId_orderNumber_key` is what makes
-- LUNCH-2026-09-16-00042 unique under a race - the generator reads the highest
-- number issued TODAY and retries on this constraint rather than trusting its
-- own read, which is the only arrangement that survives two people ordering in
-- the same second.
--
-- The price snapshot. `lunch_order_items` carries its own `itemName`,
-- `unitPrice` and `lineTotal` rather than reading them through
-- `lunch_menu_items`. A menu price is a live setting somebody edits; what an
-- order cost is a fact that has already been counted out of a cash box. The
-- foreign key to the menu item is SET NULL for the same reason: removing an
-- item from the menu must not remove it from what was collected for it.
--
-- Money is `DECIMAL(12,2)` everywhere it appears - the unit price, the line
-- total and the order total - so the three can be added together without a
-- float creeping into a figure somebody counts against a cash box.
--
-- The day. `serviceDate` is a DATE, not a timestamp: which lunchtime an order
-- belongs to is a calendar question, decided in the company's own timezone and
-- stored at UTC midnight, the same contract every other date column here keeps.
-- `lunch_orders_companyId_serviceDate_status_idx` is the collection screen's
-- entire query.

-- CreateEnum
CREATE TYPE "LunchOrderStatus" AS ENUM ('PLACED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LunchPaymentStatus" AS ENUM ('UNPAID', 'PAID');

-- CreateEnum: how the money arrived, in the office boy's own words. Not a set
-- of channels the software operates - nothing here initiates or settles a
-- payment.
CREATE TYPE "LunchPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'OTHER');

-- CreateTable
CREATE TABLE "lunch_menu_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lunch_menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lunch_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "status" "LunchOrderStatus" NOT NULL DEFAULT 'PLACED',
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "paymentStatus" "LunchPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paymentMethod" "LunchPaymentMethod",
    "paidAt" TIMESTAMP(3),
    "paidByUserId" TEXT,
    "note" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lunch_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lunch_order_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "itemName" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lunch_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one name per company. Two rows called "Biryani" at different
-- prices is an ordering mistake waiting to happen on a dropdown sixty people
-- use every day.
CREATE UNIQUE INDEX "lunch_menu_items_companyId_name_key" ON "lunch_menu_items"("companyId", "name");

-- CreateIndex: the order form's read - this company's live items, in the order
-- they are shown.
CREATE INDEX "lunch_menu_items_companyId_isActive_sortOrder_idx" ON "lunch_menu_items"("companyId", "isActive", "sortOrder");

-- CreateIndex: one order number per company, and the constraint the generator
-- retries on rather than trusting its own read of the highest so far.
CREATE UNIQUE INDEX "lunch_orders_companyId_orderNumber_key" ON "lunch_orders"("companyId", "orderNumber");

-- CreateIndex: the collection screen's whole query - one company, one day.
CREATE INDEX "lunch_orders_companyId_serviceDate_status_idx" ON "lunch_orders"("companyId", "serviceDate", "status");

-- CreateIndex: the office boy's commonest filter - who has not paid yet, today.
CREATE INDEX "lunch_orders_companyId_serviceDate_paymentStatus_idx" ON "lunch_orders"("companyId", "serviceDate", "paymentStatus");

-- CreateIndex: the employee's own list, which is their entire side of this module.
CREATE INDEX "lunch_orders_employeeId_serviceDate_idx" ON "lunch_orders"("employeeId", "serviceDate");

-- CreateIndex
CREATE INDEX "lunch_order_items_orderId_idx" ON "lunch_order_items"("orderId");

CREATE INDEX "lunch_order_items_companyId_menuItemId_idx" ON "lunch_order_items"("companyId", "menuItemId");

-- AddForeignKey
ALTER TABLE "lunch_menu_items" ADD CONSTRAINT "lunch_menu_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lunch_orders" ADD CONSTRAINT "lunch_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lunch_orders" ADD CONSTRAINT "lunch_orders_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL: deleting the account of an office boy who has left must not delete
-- the orders he collected the money for.
ALTER TABLE "lunch_orders" ADD CONSTRAINT "lunch_orders_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lunch_order_items" ADD CONSTRAINT "lunch_order_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lunch_order_items" ADD CONSTRAINT "lunch_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "lunch_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: an item taken off the menu must not take the record of
-- what was ordered - and collected for - with it. The name and the price on the
-- line are what the order is actually made of.
ALTER TABLE "lunch_order_items" ADD CONSTRAINT "lunch_order_items_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "lunch_menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
