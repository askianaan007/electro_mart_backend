-- Dealer wallet: wallet credit spent on an invoice.
--
-- Purely additive: one new empty table with its indexes and foreign keys. No
-- existing row is read, updated or deleted, and no existing column changes.
-- The wallet balance itself is derived from existing payments, returns and
-- refunds, so dealers' current return credits show up without any data move.
-- Apply with `prisma migrate deploy` (test copy first), then deploy the
-- matching backend build.

-- CreateTable
CREATE TABLE "DealerCreditUse" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "note" TEXT,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerCreditUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealerCreditUse_dealerId_idx" ON "DealerCreditUse"("dealerId");

-- CreateIndex
CREATE INDEX "DealerCreditUse_invoiceId_idx" ON "DealerCreditUse"("invoiceId");

-- AddForeignKey
ALTER TABLE "DealerCreditUse" ADD CONSTRAINT "DealerCreditUse_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerCreditUse" ADD CONSTRAINT "DealerCreditUse_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerCreditUse" ADD CONSTRAINT "DealerCreditUse_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

