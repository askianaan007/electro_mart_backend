-- Remove Product.sellingPrice and Product.minimumStock: no longer used by the app.
ALTER TABLE "Product" DROP COLUMN "sellingPrice";
ALTER TABLE "Product" DROP COLUMN "minimumStock";
