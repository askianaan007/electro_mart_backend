-- CreateTable
CREATE TABLE "PaymentRevision" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "action" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "PaymentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentRevision_paymentId_createdAt_idx" ON "PaymentRevision"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRevision_action_undoneAt_idx" ON "PaymentRevision"("action", "undoneAt");

-- CreateIndex
CREATE INDEX "PaymentRevision_invoiceId_idx" ON "PaymentRevision"("invoiceId");

