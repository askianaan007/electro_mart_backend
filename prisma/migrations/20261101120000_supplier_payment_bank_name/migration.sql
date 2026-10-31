-- Additive only: one nullable column for the bank of a supplier cheque
-- settlement. Existing rows keep NULL; nothing else is read or rewritten.
ALTER TABLE "SupplierPayment" ADD COLUMN "bankName" TEXT;
