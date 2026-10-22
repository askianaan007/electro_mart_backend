-- CreateEnum
CREATE TYPE "ProductUnitStatus" AS ENUM ('IN_STOCK', 'ALLOCATED', 'SOLD', 'RETURNED_TO_SUPPLIER', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "ProductUnitSource" AS ENUM ('PURCHASE', 'REPLACEMENT', 'OPENING_STOCK');

-- CreateEnum
CREATE TYPE "ProductUnitCondition" AS ENUM ('GOOD', 'DEFECTIVE');

-- CreateEnum
CREATE TYPE "ProductUnitEventType" AS ENUM ('REGISTERED', 'SERIAL_CORRECTED', 'ASSIGNED_TO_ORDER', 'UNASSIGNED_FROM_ORDER', 'MARKED_SOLD', 'RETURNED_BY_DEALER', 'DEALER_RETURN_REVERSED', 'RETURNED_TO_SUPPLIER', 'SUPPLIER_RETURN_REVERSED', 'SUPPLIER_RETURN_RELINKED', 'MARKED_DEFECTIVE', 'MARKED_GOOD', 'WARRANTY_SWAP_OUT', 'WARRANTY_SWAP_IN', 'WRITTEN_OFF', 'WRITE_OFF_REVERSED', 'WARRANTY_UPDATED', 'RELEASED_BY_DATA_CLEAR');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "trackSerials" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warrantyMonths" INTEGER;

-- CreateTable
CREATE TABLE "ProductUnit" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "serialKey" TEXT NOT NULL,
    "status" "ProductUnitStatus" NOT NULL DEFAULT 'IN_STOCK',
    "condition" "ProductUnitCondition" NOT NULL DEFAULT 'GOOD',
    "source" "ProductUnitSource" NOT NULL,
    "replacesUnitId" TEXT,
    "purchaseId" TEXT,
    "replacementId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "allocatedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "warrantyStartsAt" TIMESTAMP(3),
    "warrantyExpiresAt" TIMESTAMP(3),
    "warrantyManual" BOOLEAN NOT NULL DEFAULT false,
    "purchaseReturnId" TEXT,
    "notes" TEXT,
    "createdByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductUnitEvent" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "type" "ProductUnitEventType" NOT NULL,
    "documentId" TEXT,
    "documentRef" TEXT,
    "partyName" TEXT,
    "reason" TEXT,
    "faultNote" TEXT,
    "statusAfter" "ProductUnitStatus" NOT NULL,
    "conditionAfter" "ProductUnitCondition" NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(65,30),
    "details" TEXT,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductUnitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerialRequest" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SerialRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductUnit_replacesUnitId_key" ON "ProductUnit"("replacesUnitId");

-- CreateIndex
CREATE INDEX "ProductUnit_serialKey_idx" ON "ProductUnit"("serialKey");

-- CreateIndex
CREATE INDEX "ProductUnit_productId_status_idx" ON "ProductUnit"("productId", "status");

-- CreateIndex
CREATE INDEX "ProductUnit_orderId_idx" ON "ProductUnit"("orderId");

-- CreateIndex
CREATE INDEX "ProductUnit_purchaseId_idx" ON "ProductUnit"("purchaseId");

-- CreateIndex
CREATE INDEX "ProductUnit_purchaseReturnId_idx" ON "ProductUnit"("purchaseReturnId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductUnit_productId_serialKey_key" ON "ProductUnit"("productId", "serialKey");

-- CreateIndex
CREATE INDEX "ProductUnitEvent_unitId_createdAt_idx" ON "ProductUnitEvent"("unitId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductUnitEvent_documentId_idx" ON "ProductUnitEvent"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "SerialRequest_idempotencyKey_key" ON "SerialRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SerialRequest_adminId_createdAt_idx" ON "SerialRequest"("adminId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_replacesUnitId_fkey" FOREIGN KEY ("replacesUnitId") REFERENCES "ProductUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_replacementId_fkey" FOREIGN KEY ("replacementId") REFERENCES "PurchaseReturnReplacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "PurchaseReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnitEvent" ADD CONSTRAINT "ProductUnitEvent_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "ProductUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written guards (Bar_code_plan.md §3 "Extra SQL"). New tables only —
-- nothing existing is touched. Prisma doesn't model CHECKs or triggers.
-- ---------------------------------------------------------------------------

-- ALLOCATED/SOLD units always point at an order; nothing else does.
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_order_link_ck"
  CHECK (("status" IN ('ALLOCATED', 'SOLD')) = ("orderId" IS NOT NULL));

-- A sold unit always has its sale date.
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_sold_date_ck"
  CHECK ("status" <> 'SOLD' OR "soldAt" IS NOT NULL);

-- A unit with the supplier always points at the return that sent it.
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_supplier_return_ck"
  CHECK (("status" = 'RETURNED_TO_SUPPLIER') = ("purchaseReturnId" IS NOT NULL));

-- Only good units can be allocated to an order.
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_allocated_good_ck"
  CHECK ("status" <> 'ALLOCATED' OR "condition" = 'GOOD');

ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_serial_len_ck"
  CHECK (char_length("serialKey") BETWEEN 3 AND 64 AND char_length("serialNumber") BETWEEN 3 AND 64);

ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_not_self_replacement_ck"
  CHECK ("replacesUnitId" IS NULL OR "replacesUnitId" <> "id");

-- History is insert-only. DELETE stays possible solely for removing a
-- mistakenly registered unit together with its events.
CREATE FUNCTION "product_unit_event_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ProductUnitEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProductUnitEvent_no_update"
  BEFORE UPDATE ON "ProductUnitEvent"
  FOR EACH ROW EXECUTE FUNCTION "product_unit_event_immutable"();
