-- Liquid Cash integrity (docs/LIQUID_CASH_ACCOUNTING_CONTRACT.md).
--
-- PREPARED, NOT APPLIED. Purely additive: new enums/enum value, nullable
-- columns on Investment and RepresentativeSettlement, and three new tables.
-- No existing row is read, updated or deleted. Existing Investment rows keep
-- chequeStatus NULL and so keep counting in Liquid Cash exactly as before.
-- Apply with `prisma migrate deploy` only after separate authorization, and
-- deploy the matching backend build after it (the build requires these
-- columns/tables).


-- CreateEnum
CREATE TYPE "CashAdjustmentType" AS ENUM ('OPENING_BALANCE', 'ADJUSTMENT', 'SETTLEMENT_REVERSAL');

-- CreateEnum
CREATE TYPE "RefundParty" AS ENUM ('DEALER', 'SUPPLIER');

-- AlterEnum
ALTER TYPE "SettlementStatus" ADD VALUE 'REVERSED';

-- AlterTable
ALTER TABLE "Investment" ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "chequeDate" TIMESTAMP(3),
ADD COLUMN     "chequeNumber" TEXT,
ADD COLUMN     "chequeStatus" "ChequeStatus",
ADD COLUMN     "chequeStatusUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RepresentativeSettlement" ADD COLUMN     "reference" TEXT,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CashAdjustment" (
    "id" TEXT NOT NULL,
    "adjustmentNumber" TEXT NOT NULL,
    "type" "CashAdjustmentType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "adjustmentDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "adminId" TEXT NOT NULL,
    "reversalOfId" TEXT,
    "settlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "refundNumber" TEXT NOT NULL,
    "party" "RefundParty" NOT NULL,
    "dealerId" TEXT,
    "supplierId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "refundDate" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "reason" TEXT NOT NULL,
    "chequeStatus" "ChequeStatus",
    "chequeStatusUpdatedAt" TIMESTAMP(3),
    "chequeNumber" TEXT,
    "bankName" TEXT,
    "chequeDate" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerRevision" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashAdjustment_adjustmentNumber_key" ON "CashAdjustment"("adjustmentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CashAdjustment_reversalOfId_key" ON "CashAdjustment"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "CashAdjustment_settlementId_key" ON "CashAdjustment"("settlementId");

-- CreateIndex
CREATE INDEX "CashAdjustment_adjustmentDate_idx" ON "CashAdjustment"("adjustmentDate");

-- CreateIndex
CREATE INDEX "CashAdjustment_type_idx" ON "CashAdjustment"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_refundNumber_key" ON "Refund"("refundNumber");

-- CreateIndex
CREATE INDEX "Refund_dealerId_idx" ON "Refund"("dealerId");

-- CreateIndex
CREATE INDEX "Refund_supplierId_idx" ON "Refund"("supplierId");

-- CreateIndex
CREATE INDEX "Refund_refundDate_idx" ON "Refund"("refundDate");

-- CreateIndex
CREATE INDEX "Refund_chequeStatusUpdatedAt_idx" ON "Refund"("chequeStatusUpdatedAt");

-- CreateIndex
CREATE INDEX "LedgerRevision_entityType_entityId_createdAt_idx" ON "LedgerRevision"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "Investment_chequeStatusUpdatedAt_idx" ON "Investment"("chequeStatusUpdatedAt");

-- AddForeignKey
ALTER TABLE "CashAdjustment" ADD CONSTRAINT "CashAdjustment_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashAdjustment" ADD CONSTRAINT "CashAdjustment_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "CashAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashAdjustment" ADD CONSTRAINT "CashAdjustment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "RepresentativeSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddCheckConstraint (hand-added; new tables only — Prisma does not model
-- CHECK constraints, so `migrate diff` leaves them alone)
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_party_matches_counterparty" CHECK (
  ("party" = 'DEALER' AND "dealerId" IS NOT NULL AND "supplierId" IS NULL)
  OR ("party" = 'SUPPLIER' AND "supplierId" IS NOT NULL AND "dealerId" IS NULL)
);
ALTER TABLE "CashAdjustment" ADD CONSTRAINT "CashAdjustment_amount_nonzero" CHECK ("amount" <> 0);
