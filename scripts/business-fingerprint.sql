-- Read-only fingerprint of all business data (Bar_code_plan.md §10.1 step 1).
-- Must be identical before and after the serial-tracking migration.
BEGIN TRANSACTION READ ONLY;
SELECT 'product'  k, count(*), md5(string_agg(id||':'||"currentStock", ',' ORDER BY id)) FROM "Product"
UNION ALL SELECT 'invlog',   count(*), md5(string_agg(id||':'||"quantityIn"||':'||"quantityOut"||':'||"balanceAfter", ',' ORDER BY id)) FROM "InventoryLog"
UNION ALL SELECT 'invoice',  count(*), md5(string_agg(id||':'||"grandTotal"||':'||"paymentStatus", ',' ORDER BY id)) FROM "Invoice"
UNION ALL SELECT 'orderitem',count(*), md5(string_agg(id||':'||quantity||':'||"netLineTotal", ',' ORDER BY id)) FROM "OrderItem"
UNION ALL SELECT 'payment',  count(*), md5(string_agg(id||':'||amount||':'||coalesce("chequeStatus"::text,''), ',' ORDER BY id)) FROM "Payment"
UNION ALL SELECT 'dealer',   count(*), md5(string_agg(id||':'||"outstandingBalance", ',' ORDER BY id)) FROM "Dealer"
UNION ALL SELECT 'purchase', count(*), md5(string_agg(id||':'||"totalValue"||':'||coalesce("cancelledAt"::text,''), ',' ORDER BY id)) FROM "Purchase"
UNION ALL SELECT 'supppay',  count(*), md5(string_agg(id||':'||amount, ',' ORDER BY id)) FROM "SupplierPayment"
UNION ALL SELECT 'salesret', count(*), md5(string_agg(id||':'||"totalAmount", ',' ORDER BY id)) FROM "SalesReturn"
UNION ALL SELECT 'purchret', count(*), md5(string_agg(id||':'||"totalAmount", ',' ORDER BY id)) FROM "PurchaseReturn"
UNION ALL SELECT 'refund',   count(*), md5(string_agg(id||':'||amount, ',' ORDER BY id)) FROM "Refund"
UNION ALL SELECT 'cashadj',  count(*), md5(string_agg(id||':'||amount, ',' ORDER BY id)) FROM "CashAdjustment";
ROLLBACK;
