-- CreateEnum
CREATE TYPE "ChequeStatus" AS ENUM ('PENDING', 'CLEARED', 'RETURNED');

-- AlterTable
ALTER TABLE "SupplierPayment" ADD COLUMN     "chequeDepositDate" TIMESTAMP(3),
ADD COLUMN     "chequeStatus" "ChequeStatus";
