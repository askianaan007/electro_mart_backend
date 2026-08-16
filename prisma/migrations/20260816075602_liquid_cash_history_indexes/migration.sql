-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "invoiceId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");

-- CreateIndex
CREATE INDEX "Investment_investmentDate_idx" ON "Investment"("investmentDate");

-- CreateIndex
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- CreateIndex
CREATE INDEX "Payment_chequeStatusUpdatedAt_idx" ON "Payment"("chequeStatusUpdatedAt");

-- CreateIndex
CREATE INDEX "SupplierPayment_paymentDate_idx" ON "SupplierPayment"("paymentDate");

-- CreateIndex
CREATE INDEX "SupplierPayment_chequeStatusUpdatedAt_idx" ON "SupplierPayment"("chequeStatusUpdatedAt");
