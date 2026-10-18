-- CreateTable
CREATE TABLE "PurchaseReturnReplacement" (
    "id" TEXT NOT NULL,
    "replacementNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "purchaseReturnId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReturnReplacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturnReplacementItem" (
    "id" TEXT NOT NULL,
    "replacementId" TEXT NOT NULL,
    "purchaseReturnItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "lineTotal" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "PurchaseReturnReplacementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturnReplacement_replacementNumber_key" ON "PurchaseReturnReplacement"("replacementNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturnReplacement_idempotencyKey_key" ON "PurchaseReturnReplacement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseReturnReplacement_purchaseReturnId_idx" ON "PurchaseReturnReplacement"("purchaseReturnId");

-- CreateIndex
CREATE INDEX "PurchaseReturnReplacement_supplierId_idx" ON "PurchaseReturnReplacement"("supplierId");

-- CreateIndex
CREATE INDEX "PurchaseReturnReplacement_receivedDate_idx" ON "PurchaseReturnReplacement"("receivedDate");

-- CreateIndex
CREATE INDEX "PurchaseReturnReplacementItem_replacementId_idx" ON "PurchaseReturnReplacementItem"("replacementId");

-- CreateIndex
CREATE INDEX "PurchaseReturnReplacementItem_purchaseReturnItemId_idx" ON "PurchaseReturnReplacementItem"("purchaseReturnItemId");

-- CreateIndex
CREATE INDEX "PurchaseReturnReplacementItem_productId_idx" ON "PurchaseReturnReplacementItem"("productId");

-- AddForeignKey
ALTER TABLE "PurchaseReturnReplacement" ADD CONSTRAINT "PurchaseReturnReplacement_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "PurchaseReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnReplacement" ADD CONSTRAINT "PurchaseReturnReplacement_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnReplacement" ADD CONSTRAINT "PurchaseReturnReplacement_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnReplacementItem" ADD CONSTRAINT "PurchaseReturnReplacementItem_replacementId_fkey" FOREIGN KEY ("replacementId") REFERENCES "PurchaseReturnReplacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnReplacementItem" ADD CONSTRAINT "PurchaseReturnReplacementItem_purchaseReturnItemId_fkey" FOREIGN KEY ("purchaseReturnItemId") REFERENCES "PurchaseReturnItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnReplacementItem" ADD CONSTRAINT "PurchaseReturnReplacementItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddCheckConstraint (hand-added; new table only)
ALTER TABLE "PurchaseReturnReplacementItem" ADD CONSTRAINT "PurchaseReturnReplacementItem_quantity_positive" CHECK ("quantity" > 0);
