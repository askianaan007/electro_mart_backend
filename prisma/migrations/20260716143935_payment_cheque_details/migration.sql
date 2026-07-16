-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "chequeDate" TIMESTAMP(3),
ADD COLUMN     "chequeNumber" TEXT,
ADD COLUMN     "chequeStatus" "ChequeStatus",
ADD COLUMN     "chequeStatusUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "collectedDate" TIMESTAMP(3),
ADD COLUMN     "remarks" TEXT;
