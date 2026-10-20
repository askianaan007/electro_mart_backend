-- Purchase cancellation and purchase-linked supplier refunds.
--
-- Purely additive: two nullable columns on Purchase, a NOT NULL boolean with
-- a constant default on PurchaseReturn (metadata-only in PostgreSQL 11+, no
-- table rewrite), and a nullable foreign key on Refund. No existing row is
-- read, updated or deleted: every existing purchase stays active, every
-- existing return stays an ordinary return, and every existing refund stays
-- unlinked. Apply with `prisma migrate deploy` only after separate
-- authorization, then deploy the matching backend build.

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PurchaseReturn" ADD COLUMN     "isCancellation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "purchaseId" TEXT;

-- CreateIndex
CREATE INDEX "Refund_purchaseId_idx" ON "Refund"("purchaseId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
