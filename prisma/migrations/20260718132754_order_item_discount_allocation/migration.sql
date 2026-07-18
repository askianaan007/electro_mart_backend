-- AlterTable: add as nullable first so existing rows can be backfilled
ALTER TABLE "OrderItem" ADD COLUMN     "allocatedDiscount" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "netLineTotal" DECIMAL(65,30),
ADD COLUMN     "netUnitPrice" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "SalesReturnItem" ADD COLUMN     "allocatedDiscount" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- Backfill: allocate each order's total discount across its items
-- proportionally by lineTotal share (same formula the app now uses going
-- forward), so historical orders get the same net figures a freshly
-- finalized order would have stored.
UPDATE "OrderItem" oi
SET
  "allocatedDiscount" = ROUND(oi."lineTotal" * o."discount" / o."subtotal", 2),
  "netLineTotal" = oi."lineTotal" - ROUND(oi."lineTotal" * o."discount" / o."subtotal", 2),
  "netUnitPrice" = CASE
    WHEN oi."quantity" > 0
      THEN ROUND((oi."lineTotal" - ROUND(oi."lineTotal" * o."discount" / o."subtotal", 2)) / oi."quantity", 2)
    ELSE oi."unitPrice"
  END
FROM "Order" o
WHERE oi."orderId" = o."id" AND o."subtotal" > 0;

-- Orders with a zero subtotal (shouldn't happen in practice) get no
-- discount allocation — net simply equals gross.
UPDATE "OrderItem"
SET "netLineTotal" = "lineTotal", "netUnitPrice" = "unitPrice", "allocatedDiscount" = 0
WHERE "netLineTotal" IS NULL;

-- Now that every row has a value, enforce NOT NULL.
ALTER TABLE "OrderItem" ALTER COLUMN "netLineTotal" SET NOT NULL;
ALTER TABLE "OrderItem" ALTER COLUMN "netUnitPrice" SET NOT NULL;
