-- CreateEnum
CREATE TYPE "DealerSource" AS ENUM ('DEALER_PORTAL', 'REP_PORTAL');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('LEAD', 'NEW', 'REGULAR', 'VIP', 'BLOCKED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BannerLinkType" AS ENUM ('NONE', 'CATEGORY', 'PRODUCT', 'BRAND', 'EXTERNAL_URL');

-- CreateEnum
CREATE TYPE "RepresentativeStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BLOCKED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AssignmentScopeType" AS ENUM ('CATEGORY', 'PRODUCT', 'BRAND', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "CommissionType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "CommissionLineStatus" AS ENUM ('PENDING', 'APPROVED', 'SETTLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('PENDING_VERIFICATION', 'CONFIRMED', 'REJECTED');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'REPRESENTATIVE';

-- AlterTable
ALTER TABLE "Dealer" ADD COLUMN     "createdByRepId" TEXT,
ADD COLUMN     "source" "DealerSource" NOT NULL DEFAULT 'DEALER_PORTAL';

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "iconPublicId" TEXT,
ADD COLUMN     "iconUrl" TEXT,
ADD COLUMN     "imagePublicId" TEXT,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "compareAtPrice" DECIMAL(65,30),
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retailPrice" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "createdByRepId" TEXT,
ADD COLUMN     "expectedDeliveryDate" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "Representative" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "nicOrEmployeeId" TEXT,
    "address" TEXT,
    "joiningDate" TIMESTAMP(3),
    "status" "RepresentativeStatus" NOT NULL DEFAULT 'ACTIVE',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "resetToken" TEXT,
    "resetTokenExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Representative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentativeLoginHistory" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "loginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL,
    "failureReason" TEXT,

    CONSTRAINT "RepresentativeLoginHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentativeActivityLog" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "deviceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepresentativeActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerProfile" (
    "dealerId" TEXT NOT NULL,
    "whatsapp" TEXT,
    "city" TEXT,
    "province" TEXT,
    "area" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "shopPhotoUrl" TEXT,
    "shopPhotoPublicId" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'NEW',
    "assignedRepId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfile_pkey" PRIMARY KEY ("dealerId")
);

-- CreateTable
CREATE TABLE "CustomerNote" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "authorRepId" TEXT,
    "authorAdminId" TEXT,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAssignment" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "scopeType" "AssignmentScopeType" NOT NULL,
    "scopeValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BannerAssignment" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "bannerId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BannerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAvailabilityOverride" (
    "productId" TEXT NOT NULL,
    "forceAvailable" BOOLEAN NOT NULL,
    "reason" TEXT,
    "setByAdminId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductAvailabilityOverride_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "CommissionType" NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "isCampaign" BOOLEAN NOT NULL DEFAULT false,
    "campaignName" TEXT,
    "createdByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionLedgerEntry" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "commissionRuleId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "status" "CommissionLineStatus" NOT NULL DEFAULT 'PENDING',
    "settlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentativeSettlement" (
    "id" TEXT NOT NULL,
    "settlementNumber" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalCommission" DECIMAL(65,30) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "PaymentMode",
    "chequeStatus" "ChequeStatus",
    "chequeNumber" TEXT,
    "bankName" TEXT,
    "chequeDate" TIMESTAMP(3),
    "expenseId" TEXT,
    "approvedByAdminId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepresentativeSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionSubmission" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "chequeNumber" TEXT,
    "bankName" TEXT,
    "chequeDate" TIMESTAMP(3),
    "collectionDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "chequeImageUrl" TEXT,
    "status" "CollectionStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verifiedByAdminId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "resultingPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionReminderLog" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "daysOverdue" INTEGER NOT NULL,

    CONSTRAINT "CollectionReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "logoPublicId" TEXT,
    "imageUrl" TEXT,
    "imagePublicId" TEXT,
    "description" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Banner" (
    "id" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "ctaLabel" TEXT,
    "linkType" "BannerLinkType" NOT NULL DEFAULT 'NONE',
    "linkValue" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepOrderDraft" (
    "id" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "dealerId" TEXT,
    "notes" TEXT,
    "expectedDeliveryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepOrderDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepOrderDraftItem" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "RepOrderDraftItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Representative_email_key" ON "Representative"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Representative_username_key" ON "Representative"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Representative_nicOrEmployeeId_key" ON "Representative"("nicOrEmployeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Representative_resetToken_key" ON "Representative"("resetToken");

-- CreateIndex
CREATE INDEX "Representative_status_idx" ON "Representative"("status");

-- CreateIndex
CREATE INDEX "RepresentativeLoginHistory_representativeId_idx" ON "RepresentativeLoginHistory"("representativeId");

-- CreateIndex
CREATE INDEX "RepresentativeActivityLog_representativeId_idx" ON "RepresentativeActivityLog"("representativeId");

-- CreateIndex
CREATE INDEX "RepresentativeActivityLog_action_idx" ON "RepresentativeActivityLog"("action");

-- CreateIndex
CREATE INDEX "CustomerProfile_status_idx" ON "CustomerProfile"("status");

-- CreateIndex
CREATE INDEX "CustomerProfile_assignedRepId_idx" ON "CustomerProfile"("assignedRepId");

-- CreateIndex
CREATE INDEX "CustomerNote_dealerId_idx" ON "CustomerNote"("dealerId");

-- CreateIndex
CREATE INDEX "ProductAssignment_representativeId_idx" ON "ProductAssignment"("representativeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAssignment_representativeId_scopeType_scopeValue_key" ON "ProductAssignment"("representativeId", "scopeType", "scopeValue");

-- CreateIndex
CREATE INDEX "BannerAssignment_representativeId_idx" ON "BannerAssignment"("representativeId");

-- CreateIndex
CREATE UNIQUE INDEX "BannerAssignment_representativeId_bannerId_key" ON "BannerAssignment"("representativeId", "bannerId");

-- CreateIndex
CREATE INDEX "CommissionRule_productId_idx" ON "CommissionRule"("productId");

-- CreateIndex
CREATE INDEX "CommissionRule_startDate_endDate_idx" ON "CommissionRule"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "CommissionLedgerEntry_representativeId_idx" ON "CommissionLedgerEntry"("representativeId");

-- CreateIndex
CREATE INDEX "CommissionLedgerEntry_orderId_idx" ON "CommissionLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "CommissionLedgerEntry_status_idx" ON "CommissionLedgerEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeSettlement_settlementNumber_key" ON "RepresentativeSettlement"("settlementNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeSettlement_expenseId_key" ON "RepresentativeSettlement"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionSubmission_resultingPaymentId_key" ON "CollectionSubmission"("resultingPaymentId");

-- CreateIndex
CREATE INDEX "CollectionSubmission_representativeId_idx" ON "CollectionSubmission"("representativeId");

-- CreateIndex
CREATE INDEX "CollectionSubmission_customerId_idx" ON "CollectionSubmission"("customerId");

-- CreateIndex
CREATE INDEX "CollectionSubmission_status_idx" ON "CollectionSubmission"("status");

-- CreateIndex
CREATE INDEX "CollectionReminderLog_orderId_idx" ON "CollectionReminderLog"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_name_key" ON "Brand"("name");

-- CreateIndex
CREATE INDEX "RepOrderDraft_repId_idx" ON "RepOrderDraft"("repId");

-- CreateIndex
CREATE INDEX "RepOrderDraftItem_draftId_idx" ON "RepOrderDraftItem"("draftId");

-- CreateIndex
CREATE INDEX "Dealer_source_idx" ON "Dealer"("source");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Order_createdByRepId_idx" ON "Order"("createdByRepId");

-- AddForeignKey
ALTER TABLE "Dealer" ADD CONSTRAINT "Dealer_createdByRepId_fkey" FOREIGN KEY ("createdByRepId") REFERENCES "Representative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdByRepId_fkey" FOREIGN KEY ("createdByRepId") REFERENCES "Representative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeLoginHistory" ADD CONSTRAINT "RepresentativeLoginHistory_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeActivityLog" ADD CONSTRAINT "RepresentativeActivityLog_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "Representative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_authorRepId_fkey" FOREIGN KEY ("authorRepId") REFERENCES "Representative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_authorAdminId_fkey" FOREIGN KEY ("authorAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAssignment" ADD CONSTRAINT "ProductAssignment_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerAssignment" ADD CONSTRAINT "BannerAssignment_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerAssignment" ADD CONSTRAINT "BannerAssignment_bannerId_fkey" FOREIGN KEY ("bannerId") REFERENCES "Banner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAvailabilityOverride" ADD CONSTRAINT "ProductAvailabilityOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_commissionRuleId_fkey" FOREIGN KEY ("commissionRuleId") REFERENCES "CommissionRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "RepresentativeSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeSettlement" ADD CONSTRAINT "RepresentativeSettlement_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeSettlement" ADD CONSTRAINT "RepresentativeSettlement_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionSubmission" ADD CONSTRAINT "CollectionSubmission_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionSubmission" ADD CONSTRAINT "CollectionSubmission_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionSubmission" ADD CONSTRAINT "CollectionSubmission_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionSubmission" ADD CONSTRAINT "CollectionSubmission_resultingPaymentId_fkey" FOREIGN KEY ("resultingPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionReminderLog" ADD CONSTRAINT "CollectionReminderLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepOrderDraft" ADD CONSTRAINT "RepOrderDraft_repId_fkey" FOREIGN KEY ("repId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepOrderDraft" ADD CONSTRAINT "RepOrderDraft_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepOrderDraftItem" ADD CONSTRAINT "RepOrderDraftItem_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "RepOrderDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepOrderDraftItem" ADD CONSTRAINT "RepOrderDraftItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

