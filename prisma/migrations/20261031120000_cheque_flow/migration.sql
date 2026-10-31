-- Cheque Flow: a planning register of customer cheques to receive and
-- supplier cheques to pay.
--
-- Purely additive: two new enums and two new tables with their indexes and
-- guards. No existing table, column or row is read, changed or referenced —
-- no foreign key points into or out of existing tables, so nothing existing
-- can ever be blocked by these rows. Removing the feature = dropping the two
-- tables and two enums.

-- CreateEnum
CREATE TYPE "ChequeFlowDirection" AS ENUM ('RECEIVABLE', 'PAYABLE');

-- CreateEnum
CREATE TYPE "ChequeFlowStatus" AS ENUM ('PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ChequeFlowEntry" (
    "id" TEXT NOT NULL,
    "direction" "ChequeFlowDirection" NOT NULL,
    "chequeNumber" TEXT,
    "chequeKey" TEXT NOT NULL DEFAULT '',
    "bankName" TEXT NOT NULL,
    "bankKey" TEXT NOT NULL,
    "chequeDate" DATE NOT NULL,
    "partyName" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "invoiceRef" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "ChequeFlowStatus" NOT NULL DEFAULT 'PENDING',
    "clearedDate" DATE,
    "remarks" TEXT,
    "importBatchId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "ChequeFlowEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChequeFlowImport" (
    "id" TEXT NOT NULL,
    "importKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "inserted" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChequeFlowImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChequeFlowEntry_chequeDate_idx" ON "ChequeFlowEntry"("chequeDate");

-- CreateIndex
CREATE INDEX "ChequeFlowEntry_direction_status_chequeDate_idx" ON "ChequeFlowEntry"("direction", "status", "chequeDate");

-- CreateIndex
CREATE INDEX "ChequeFlowEntry_direction_bankKey_chequeKey_idx" ON "ChequeFlowEntry"("direction", "bankKey", "chequeKey");

-- CreateIndex
CREATE INDEX "ChequeFlowEntry_partyKey_idx" ON "ChequeFlowEntry"("partyKey");

-- CreateIndex
CREATE INDEX "ChequeFlowEntry_importBatchId_idx" ON "ChequeFlowEntry"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ChequeFlowImport_importKey_key" ON "ChequeFlowImport"("importKey");

-- AddForeignKey
ALTER TABLE "ChequeFlowEntry" ADD CONSTRAINT "ChequeFlowEntry_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ChequeFlowImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written guards (Prisma doesn't model CHECK constraints).
-- ---------------------------------------------------------------------------
ALTER TABLE "ChequeFlowEntry" ADD CONSTRAINT "ChequeFlowEntry_amount_positive_ck"
  CHECK ("amount" > 0);
-- Only a cleared cheque carries a cleared date.
ALTER TABLE "ChequeFlowEntry" ADD CONSTRAINT "ChequeFlowEntry_cleared_date_ck"
  CHECK ("status" = 'CLEARED' OR "clearedDate" IS NULL);
ALTER TABLE "ChequeFlowEntry" ADD CONSTRAINT "ChequeFlowEntry_text_len_ck"
  CHECK (char_length("partyName") BETWEEN 1 AND 120
     AND char_length("bankName") BETWEEN 1 AND 80
     AND ("chequeNumber" IS NULL OR char_length("chequeNumber") <= 40)
     AND ("invoiceRef" IS NULL OR char_length("invoiceRef") <= 120)
     AND ("remarks" IS NULL OR char_length("remarks") <= 500));
