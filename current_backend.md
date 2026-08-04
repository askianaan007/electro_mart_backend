# Electro Mart Backend — Current System Reference

Prepared: 2026-08-04. A complete, from-the-code survey of `electromart-backend` as it stands today — every
module, every endpoint, every business rule that isn't obvious from a glance. Intended as the ground-truth
reference for planning any new work (e.g. `Rep_Portal_DOCUMENTATION.md`) without having to re-read the
whole codebase each time.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Framework | NestJS 11 (Express platform) |
| ORM / DB | Prisma 6 → PostgreSQL (Neon), `DATABASE_URL` (pooled) + `DIRECT_URL` (migrations) |
| Auth | Passport JWT (`passport-jwt`), bcrypt password hashing |
| Validation | `class-validator` / `class-transformer`, global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) |
| Docs | Swagger at `/api/docs` (non-production only) |
| File storage | Cloudinary (product images) |
| Email | Nodemailer via SMTP (optional — degrades to a no-op log if unconfigured) |
| Scheduling | `@nestjs/schedule` — cron jobs for token cleanup and cheque reminders |
| Rate limiting | `@nestjs/throttler`, global default 100 req/min |
| Security headers | `helmet()` |
| Hosting | Vercel-compatible (`api/`, `vercel.json`) alongside a normal `nest start` server |

Env vars are validated at boot (`src/config/env.validation.ts`) — the app refuses to start if
`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` (min 32 chars), or the three `CLOUDINARY_*` vars are missing.
`CORS_ORIGIN` (comma-separated) is required in production; in dev, an unset value logs a warning and opens
CORS to all origins.

---

## 2. What the system is

A wholesale electronics distributor's internal ERP + a private ordering portal for its dealers. Two actors
today:

- **Admin** — the business owner/staff. Full back-office: catalog, inventory, purchasing, suppliers,
  investors/equity, expenses, dealer management, order approval, invoicing, payments, returns, reporting.
- **Dealer** — a wholesale customer with their own login. Browses the catalog, submits orders for approval,
  views their own invoices/payments/orders. Created only by an Admin — no public sign-up.

There is no public storefront and no self-service registration anywhere in the system.

---

## 3. Auth (`src/auth`)

Single `AuthModule` shared by both roles.

| Endpoint | Method | Notes |
|---|---|---|
| `/auth/admin/login` | POST | email + password |
| `/auth/dealer/login` | POST | username + password; rejects if dealer `status != ACTIVE` |
| `/auth/forgot-password` | POST | `{ identifier, role }` — always returns the same generic message whether or not the account exists |
| `/auth/reset-password` | POST | `{ token, role, newPassword }` |
| `/auth/refresh` | POST | rotates the refresh token (old one is revoked, a new pair issued) |
| `/auth/logout` | POST | revokes the given refresh token |
| `/auth/me` | GET | returns the current JWT payload |

**JWT payload**: `{ sub, role, email? , username? }` (`src/common/interfaces/jwt-payload.interface.ts`).
Access tokens are short-lived (`JWT_EXPIRES_IN`, signed by `JwtService`); refresh tokens are random 48-byte
hex strings, stored **hashed** (`hashToken`) in the generic `RefreshToken` table keyed by `{ tokenHash,
role, userId, expiresAt, revokedAt }` — so adding a third role needs zero changes to this table. Refresh
tokens default to 30 days (`JWT_REFRESH_EXPIRES_IN_DAYS`) and are pruned daily
(`AuthService.cleanupExpiredRefreshTokens`, cron `EVERY_DAY_AT_3AM`, keeping a 30-day tail past expiry for
incident investigation).

**Timing-attack hardening**: every login/forgot-password path compares against a precomputed
`DUMMY_PASSWORD_HASH` when the account isn't found, so a nonexistent-account attempt takes about as long as
a real one (no user-enumeration side channel via response latency).

**`JwtStrategy.validate()`** re-checks the account's live status on every authenticated request — but only
for `Role.DEALER` today. This is why deactivating a dealer immediately invalidates any access token they
already hold; an equivalent check would be needed for any new role that can be deactivated.

`RolesGuard` + `@Roles(Role.X, ...)` gate every controller/route; a route with no `@Roles()` is open to any
authenticated user (or public, if it also skips `JwtAuthGuard`).

---

## 4. Data model (`prisma/schema.prisma`)

### 4.1 Enums
`Role {ADMIN, DEALER}` · `AccountStatus {ACTIVE, INACTIVE}` ·
`OrderStatus {PENDING_APPROVAL, APPROVED, REJECTED, PACKED, DELIVERED, COMPLETED}` ·
`PaymentStatus {PAID, PENDING, OVERDUE, PARTIAL}` · `PaymentMode {CASH, CHEQUE, BANK_TRANSFER}` ·
`InventoryLogType {PURCHASE, SALE, ADJUSTMENT, RESERVE, RELEASE}` ·
`ChequeStatus {PENDING, CLEARED, RETURNED}`

### 4.2 Core entities and how they relate

```
Admin ──< Purchase, ActivityLog, Order(approvedByAdminId), Order(createdByAdminId)
Dealer ──< Order, Invoice, Payment, SalesReturn

Category (name only — NOT a FK target)     Product.category is free-text, denormalized
Product ──< OrderItem, PurchaseItem, InventoryLog, SalesReturnItem, PurchaseReturnItem, ProductImage[]

Supplier ──< Purchase, SupplierPayment, PurchaseReturn
Purchase ──< PurchaseItem[], PurchaseReturn[]
PurchaseReturn ──< PurchaseReturnItem[]   (optionally tied to a Purchase, or standalone)

Order ──< OrderItem[], Invoice (1:1), SalesReturn[]
Invoice ──< Payment[]
SalesReturn ──< SalesReturnItem[]

Investor ──< Investment[]
Expense (standalone, no relations)
Counter (sequence generator, keyed by string)
RefreshToken (generic across roles)
```

### 4.3 Field notes worth knowing before changing anything

- **`Product.category` is a plain string, not a FK.** `Category` exists only to drive the admin's picker and
  a rename cascade (`CategoriesService.update` bulk-updates every `Product.category` match when a category
  is renamed). Deleting a category is blocked while any product still references its name.
- **`Order.dealerId`, `Invoice.dealerId`, `Payment.dealerId` are all required, non-nullable.** Every
  financial record traces back to exactly one dealer.
- **`Order.createdByAdminId`** is set only when an admin recorded the order directly (walk-in/backdated
  sale) — distinguishes it from a dealer's own submission, and is what allows admin-recorded orders to be
  edited after the fact via `PATCH /orders/:id` (dealer-submitted ones can't, until approved).
- **`OrderItem.allocatedDiscount` / `netLineTotal` / `netUnitPrice`** are computed once (at approval, or at
  admin-creation time) and **never recomputed** — sales returns always refund from `netUnitPrice`, not the
  original `unitPrice`, so a discounted sale can't be refunded above what the customer actually paid. This
  "store it, never recompute" rule shows up repeatedly across the codebase's comments — it's a deliberate
  invariant, not an oversight.
- **`Payment.invoiceId`** — as of the currently uncommitted schema change (`git diff` at time of writing),
  this is being made nullable to support a standalone dealer credit/advance payment not tied to any
  specific invoice. Not yet migrated/deployed as of this document's writing — check `git status` /
  `git log` before assuming which state is live.
- **`Counter`** backs every human-readable sequence number (`ORD-2026-00001`, `INV-…`, `RTN-…`, `PRTN-…`) —
  see §6.4.

---

## 5. The Order → Invoice → Payment → Return pipeline

This is the most complex, most heavily-invariant part of the codebase (`src/orders/orders.service.ts`,
`src/invoices`, `src/payments`, `src/sales-returns`, `src/inventory`). Read this section before touching
any of it.

### 5.1 Order lifecycle

```
PENDING_APPROVAL --approve()--> APPROVED --status PACKED--> PACKED --status DELIVERED--> DELIVERED --status COMPLETED--> COMPLETED
       |
       --reject()--> REJECTED
```

- **Dealer-submitted** orders always start `PENDING_APPROVAL`; the dealer has no discount authority.
- **Admin-created** orders (`POST /orders` with `dealerId` supplied, requester role ADMIN) can carry an
  order-wide discount (`discountPercentage` XOR `discountAmount`) or **per-line discounts**
  (`OrderItemDto.discountPercentage`/`discountAmount`, mutually exclusive with the order-wide ones) and are
  **auto-approved inline** — `applyApproval()` runs immediately inside `create()`, so the order is born with
  an invoice already generated.
  - If `saleDate` is supplied, the order is instead created **directly as `COMPLETED`** — every intermediate
    timestamp (`approvedAt`/`packedAt`/`deliveredAt`/`completedAt`) is stamped with that date, and the
    dealer's `outstandingBalance` is incremented immediately — this is the "record a walk-in/offline sale
    after the fact" path.
- `PATCH /orders/:id/approve` — admin approves a pending order, optionally with a discount. Reserves stock,
  generates the invoice, moves to `APPROVED`.
- `PATCH /orders/:id/reject` — requires a reason; no stock/invoice side effects.
- `PATCH /orders/:id/status` — steps `APPROVED → PACKED → DELIVERED → COMPLETED` one at a time; only
  `COMPLETED` increments the dealer's `outstandingBalance` and sends the delivery email.
- `PATCH /orders/:id/complete` — fast-forwards straight to `COMPLETED` from any of
  `APPROVED/PACKED/DELIVERED`, backfilling any skipped timestamps.
- `PATCH /orders/:id/items` — replaces line items, **only while `PENDING_APPROVAL`** (no invoice exists
  yet).
- `PATCH /orders/:id` — full edit (dealer, items, discount, sale date) for any order that **already has an
  invoice**, i.e. `APPROVED` or later. Blocked if a sales return or any payment already exists against it.
  Reverses and re-applies the stock reservation and (if the order had reached `COMPLETED`) the dealer
  balance impact.
- `DELETE /orders/:id` — deletable at any status, reversing stock/balance/invoice, but blocked if the
  invoice already has payments recorded, or if a newer invoice has since been issued (invoice numbers must
  stay strictly sequential — see §6.4).

### 5.2 Discounts

Two mutually-exclusive discount modes, resolved by `resolveDiscount()` (order-wide) vs
`applyItemLevelDiscounts()` (per-line) — a single order uses one or the other, never both, and only an admin
can apply either. Once resolved, `allocateItemDiscounts()` spreads an order-wide discount across lines
proportionally by each line's subtotal share, rounds to 2 decimals per line, and **persists** the result
into `allocatedDiscount`/`netLineTotal`/`netUnitPrice` — this is the one-time computation later sales
returns rely on (§4.3).

### 5.3 Credit limit enforcement

`assertWithinCreditLimit()` is the single gate every order-creating/-editing path calls. It:
1. Row-locks the dealer (`SELECT ... FOR UPDATE`) so two concurrent orders against the same dealer can't
   both read a stale snapshot and both pass.
2. Skips the check entirely if `dealer.unlimitedCredit`.
3. Otherwise sums every "in-flight" order (`PENDING_APPROVAL/APPROVED/PACKED/DELIVERED` — deliberately not
   just `outstandingBalance`, since that field is only touched at `COMPLETED`) plus the dealer's existing
   `outstandingBalance` plus the new amount, and rejects if it exceeds `creditLimit`.

### 5.4 Stock / inventory (`src/inventory/inventory.service.ts`)

`InventoryService.recordMovement()` is the **only** way `Product.currentStock` ever changes — every
purchase, sale, reservation, release, and manual adjustment routes through it. It uses a single atomic
`UPDATE ... WHERE "currentStock" + delta >= 0` raw SQL statement (not a read-then-write) specifically to
close a race condition: under Postgres's default read-committed isolation, two concurrent movements against
the same product could otherwise both read the same stale stock, both pass a non-negative check in
application code, and both commit — driving stock negative. Every movement is also logged to
`InventoryLog` with the resulting `balanceAfter`, giving a full audit ledger (`GET
/inventory/:productId/ledger`).

Stock is **reserved** (`RESERVE`) at order approval, not at order creation — a pending order doesn't hold
stock. It's only actually and permanently deducted in the sense that `RESERVE` already decremented
`currentStock`; `RELEASE` is its inverse, used when reversing an approval (order edit/deletion).

### 5.5 Invoices (`src/invoices`)

Generated exactly once per order, at approval (`INV-<year>-<serial>`, via the shared `Counter` sequence).
`paymentStatus` (`PENDING/PARTIAL/PAID`) is **stored**, recomputed by
`recomputeInvoicePaymentStatus()` after every payment or sales-return change — but `OVERDUE` is **never
stored**; it's derived on read (`withComputedStatus()`) whenever a `PENDING`/`PARTIAL` invoice's `dueDate`
(15 days from creation, `INVOICE_DUE_DAYS`) has passed. This guarantees it's always accurate with no cron
needed and no window where a just-passed-due invoice still reads as `PENDING`.

`returnedAmount`/`netGrandTotal` are computed and attached on every read (never stored) — a sales return
lowers what's actually owed without rewriting the invoice's original `grandTotal`.

### 5.6 Payments (`src/payments`)

- `POST /payments` (Admin only) — records a payment against an invoice. Row-locks the invoice, computes
  `effectivePaid` (excludes bounced/`RETURNED` cheques — see `invoice-financials.ts`), rejects if the new
  payment would exceed the invoice's `netGrandTotal` (grand total minus any sales returns). On success,
  decrements the dealer's `outstandingBalance` by the payment amount — **not clamped to zero**, so a
  payment recorded while the dealer already has return credit correctly pushes the balance further negative
  rather than silently discarding the credit.
- Cheque payments require `bankName`, `chequeNumber`, `chequeDate`, `collectedDate` (not in the future);
  start life `chequeStatus: PENDING`.
- `PATCH /payments/:id/cheque-status` — moves a cheque `PENDING → CLEARED/RETURNED` (or reverts, within 1
  day of the status change). Only the `RETURNED ↔ (PENDING/CLEARED)` boundary actually changes whether the
  payment counts toward the dealer's balance — clearing after pending has zero balance effect since it was
  already counted.
- `PATCH /payments/:id` and `DELETE /payments/:id` — edits/reversals are only allowed **within 1 day** of
  the payment being recorded, and only while a cheque (if any) is still `PENDING` — once a cheque has
  actually cleared or bounced, a plain edit is blocked (correct it via the cheque-status flow instead).

### 5.7 Sales returns (`src/sales-returns`) / Purchase returns (`src/purchase-returns`)

Sales returns: only against `COMPLETED` orders. Validates requested return quantity against what's still
returnable per product (order quantity minus what other returns on the same order already took — row-locked
to prevent concurrent over-return), refunds from the order item's stored `netUnitPrice`
(§4.3/§5.2), restocks via `InventoryService`, and adjusts the dealer's `outstandingBalance` down by the
return total (can go negative → store credit, which the credit-limit check and payment-overpayment guard
both already account for). Edits/deletes only within 1 day.

Purchase returns: either tied to a specific `Purchase` (validated against that purchase's remaining
returnable quantity, priced from its `unitCost`) or **standalone** (e.g. a damaged unit found in stock —
admin supplies `unitCost` directly, requires `supplierId`). Same 1-day edit/delete window, same stock
reversal pattern.

---

## 6. Cross-cutting mechanisms (shared by many modules)

### 6.1 Transactions
Nearly every mutating operation runs inside `this.prisma.$transaction(async (tx) => {...}, TRANSACTION_OPTIONS)`
(`src/common/constants/prisma.ts`). Concurrency-sensitive operations additionally take an explicit
`SELECT ... FOR UPDATE` row lock before reading the value they're about to conditionally write (dealer
credit checks, invoice payment totals, supplier settlement totals, order/purchase return remaining-quantity
checks) — a recurring, deliberate pattern for closing TOCTOU races under Postgres's read-committed default.

### 6.2 Activity log (`src/activity-log`)
Every mutating admin action is logged: `{ adminId, action, targetId?, details? }`, written inside the same
transaction as the change it describes. `GET /activity-logs` (filterable), `GET /activity-logs/admins`
(distinct list of admins who've logged actions, for a filter dropdown), `DELETE /activity-logs` (wipe, admin
only). `adminId` is currently a **required** FK — see §4.3 and the Rep Portal plan for why this matters if a
non-admin actor needs to log actions.

### 6.3 Pagination
Nearly every list endpoint shares one `paginate(data, total, page, limit)` helper
(`src/common/utils/paginate.ts`) returning `{ data, meta: { page, limit, total, totalPages } }`. Default
`page=1`, `limit=20` throughout.

### 6.4 Sequence numbering (`src/common/utils/sequence.ts`)
A single `Counter` table (keyed by string, e.g. `'order'`, `'invoice'`, `'salesReturn'`, `'purchaseReturn'`)
backs every human-readable serial: `nextSequenceNumber()` atomically upserts-and-increments, formats as
`<PREFIX>-<year>-<5-digit-serial>`. `isLatestSequenceNumber()` guards deletion so only the most-recently
issued number in a sequence can ever be deleted (preventing permanent gaps). `resetSequenceCounter()`
realigns a counter to the current max after a bulk clear (e.g. `clearDealerData`), so the next issued number
doesn't leave a huge unexplained gap.

### 6.5 Soft invariants around money (`src/common/utils/invoice-financials.ts`)
Shared by payments and sales-returns so the two never drift into different formulas for the same numbers:
`isEffectivePayment` (a `RETURNED` cheque never counts), `computeEffectivePaid`, `computeReturnedAmount`,
`derivePaymentStatus`, `recomputeInvoicePaymentStatus`.

### 6.6 Error handling
`isForeignKeyViolation()` (`src/common/utils/prisma-errors.ts`) turns a raw Prisma FK-constraint error into
a friendly `ConflictException` (e.g. "This dealer has orders... cannot be deleted. Deactivate it instead.")
— used wherever a hard delete could otherwise fail with a cryptic DB error. A global
`HttpExceptionFilter` (`src/common/filters/http-exception.filter.ts`) normalizes error responses.

---

## 7. Module-by-module endpoint reference

Role column: **A** = Admin, **D** = Dealer. A route with both means either role may call it (service-layer
logic branches on role, e.g. a dealer only ever sees their own data).

### Dealers (`/dealers`) — Admin only
`POST /` create · `GET /` list (search by business/owner/phone/username, status filter) · `GET /:id` (+
lifetime order/invoice summary) · `PATCH /:id` update · `POST /:id/reset-password` · `DELETE /:id` (blocked
if it has any transactional history) · `POST /:id/clear-data` (wipes all orders/invoices/payments/returns
for this dealer, admin password re-confirmation required, irreversible) · `PATCH /:id/status`
(activate/deactivate).

### Products (`/products`)
`POST /` **A** · `GET /` **A,D** (search/category/status/out-of-stock filters; `costPrice` stripped for
dealers) · `GET /:id` **A,D** · `PATCH /:id` **A** · `PATCH /:id/status` **A** · `DELETE /:id` **A** (blocked
if it has order/purchase history) · `POST /:id/images` **A** (up to 5 images, 5MB each, Cloudinary) ·
`DELETE /:id/images/:imageId` **A**.

### Categories (`/categories`)
`POST /` **A** · `GET /` **A,D** · `PATCH /:id` **A** (renaming cascades to every `Product.category` match)
· `DELETE /:id` **A** (blocked while any product still references it).

### Orders (`/orders`) — see §5.1 for the full lifecycle
`POST /` **A,D** · `GET /` **A,D** · `POST /reset-counter` **A** · `GET /:id` **A,D** · `PATCH /:id/approve`
**A** · `PATCH /:id/items` **A** · `PATCH /:id` **A** · `PATCH /:id/reject` **A** · `PATCH /:id/status` **A**
· `PATCH /:id/complete` **A** · `DELETE /:id` **A**.

### Invoices (`/invoices`)
`GET /` **A,D** (payment-status filter treats `OVERDUE` as a derived filter, not a stored value — see §5.5)
· `POST /reset-counter` **A** · `GET /:id` **A,D**.

### Payments (`/payments`) — see §5.6
`POST /` **A** · `GET /` **A,D** · `GET /:id` **A,D** · `PATCH /:id` **A** · `DELETE /:id` **A** · `PATCH
/:id/cheque-status` **A**.

### Inventory (`/inventory`) — Admin only
`GET /` stock list (search, in-stock/out-of-stock filter) · `GET /:productId/ledger` (paginated movement
history, type/date filters) · `POST /adjustment` manual stock in/out with a reason.

### Suppliers (`/suppliers`) — Admin only
Standard CRUD; delete blocked if the supplier has purchase history.

### Purchases (`/purchases`) — Admin only
`POST /` (creates line items, increments stock via `PURCHASE` movements) · `GET /` (supplier/date/search
filters) · `GET /:id` · `PATCH /:id` (reverses old stock, re-applies new — blocked if any purchase return
exists against it) · `DELETE /:id` (unwinds any purchase returns first, then the purchase's own stock
increase — fails loudly if stock has since been sold below what it brought in).

### Purchase returns (`/purchase-returns`) — Admin only — see §5.7
`POST /` (against a purchase, or standalone with an explicit `unitCost`) · `GET /` · `GET
/by-purchase/:purchaseId` · `GET /:id` · `PATCH /:id` (1-day window) · `DELETE /:id` (1-day window).

### Sales returns (`/sales-returns`) — Admin only — see §5.7
`POST /` · `GET /` · `GET /by-order/:orderId` · `POST /reset-counter` · `GET /:id` · `PATCH /:id` (1-day
window) · `DELETE /:id` (1-day window).

### Credits — supplier-side ledger (`/credits`) — Admin only
Tracks what Electro Mart owes each supplier: `creditBalance = totalPurchases − totalReturns − totalSettled
− totalTransportCharges` (transport charges are deducted from the supplier's credit, not billed
separately). `GET /` summary across suppliers (with an "only outstanding" filter) · `GET
/cheques/send-reminders` … actually `POST /cheques/send-reminders` manual trigger for the daily cron below
· `GET /:supplierId` single-supplier detail · `GET /:supplierId/settlements` · `POST
/:supplierId/settlements` (row-locks the supplier, rejects if the amount exceeds the outstanding credit
balance) · `DELETE /settlements/:paymentId` (1-day window) · `PATCH /settlements/:paymentId/status`
(cheque lifecycle, same pattern as dealer payments). A daily cron (`EVERY_DAY_AT_8AM`) emails every admin a
reminder for cheques due for bank deposit tomorrow (`chequeReminderSentAt` guards against double-send).

### Investors / Investments (`/investors`, `/investments`) — Admin only
Standard CRUD, plus one real invariant: the **sum** of every investor's `profitSharePercentage` may never
exceed 100% (`InvestorsService.assertProfitShareWithinLimit` — individually each is capped 0–100 by the
DTO, but nothing else stops the sum from over-allocating profit/expense share in Equity). An `Investment`
with a negative `amount` is a withdrawal, not a separate type.

### Expenses (`/expenses`) — Admin only
Standard CRUD, date/search filterable.

### Equity (`/equity`) — Admin only
`GET /` per-investor summary: `equity = totalInvestment + (grossProfit × share%) − (totalExpenses × share%)`
— deliberately uses **gross** profit (from `SalesAnalysisService`, before expenses) since expenses are
already deducted per-investor here, avoiding double-subtraction. `GET /history` — every investment,
withdrawal, and expense merged into one timeline via a raw SQL `UNION ALL` CTE so pagination/filtering is
correct across both source tables at the SQL level (not fetch-everything-then-slice-in-JS).

### Sales analysis (`/sales-analysis`) — Admin only
`GET /summary`, `GET /` — per-order profit (`sellingPrice − buyingPrice`, both **net of any sales
returns**) across `COMPLETED` orders only, filterable by date/dealer/search. This is the single source of
truth `EquityService` and `DashboardService` both build on, specifically so the three pages can never
disagree on profit.

### Dashboard (`/dashboard`)
`GET /admin` **A** — today's sales (net of same-day returns), today's orders, pending approvals,
out-of-stock count, outstanding payments, recent orders, 6-month revenue trend (extended further back if an
admin backdated a sale older than 6 months, so it doesn't silently vanish from the chart), top 5 products by
net quantity sold, month-over-month KPI deltas (`pctChange` returns `null`/"N/A" for sign-crossing
comparisons that wouldn't be meaningful), **Liquid Cash** (all-time: investor contributions + cleared dealer
payments − cleared supplier payments − expenses; a pending/bounced cheque doesn't count on either side until
it actually clears), supplier credit balance, upcoming/due cheques.
`GET /dealer` **D** — the calling dealer's own outstanding balance, credit limit/remaining, pending orders,
5 most recent orders/invoices.

### Activity log (`/activity-logs`) — Admin only
`GET /` (filterable) · `GET /admins` (distinct admin list for a filter dropdown) · `DELETE /` (wipe all).

### Uploads
No standalone controller — `UploadsService` (Cloudinary wrapper: `uploadImage`, `deleteImage`) is consumed
directly by `ProductsService` for product image galleries. Cleans up orphaned Cloudinary uploads on any
partial-batch or DB-write failure (never leaves an image uploaded with no corresponding row, or vice versa).

---

## 8. Notifications (`src/mailer`)

`MailerService` degrades gracefully to a logged no-op if SMTP env vars aren't set — safe for local dev.
Current notification methods (all fire-and-forget, errors logged not thrown): admin welcome/reset emails for
dealers, order-submitted (to admins), order-approved/rejected/delivered (to the dealer), out-of-stock alert
(to admins, checked after every approval), password-reset links (admin or dealer), and the daily
cheque-deposit-reminder digest (to admins).

---

## 9. Security posture summary

- `helmet()` + `trust proxy` set globally.
- CORS: explicit allow-list via `CORS_ORIGIN` (comma-separated), **required** in production — the app
  refuses to boot with CORS wide open in prod.
- Global `ValidationPipe`: strips unknown fields (`whitelist`) and **rejects** requests containing them
  (`forbidNonWhitelisted`) rather than silently dropping them.
- Global `ThrottlerGuard`: 100 requests/min per client by default.
- `costPrice` is stripped from every product response returned to a dealer (`hideCostPriceForDealer` in
  `products.controller.ts`) — dealers only ever see `wholesalePrice`.
- Password reset tokens are single-use, 30-minute TTL, validated **before** paying bcrypt's hashing cost (so
  a garbage/expired token doesn't burn a full hash cycle).
- Refresh tokens are stored hashed, never in plaintext; access-token status is re-verified per-request for
  dealers (not yet for any other role, since none exists yet).
- Swagger (`/api/docs`) is only mounted outside production — the full schema, including destructive
  admin-only routes, is otherwise unauthenticated and publicly browsable if left on in prod.

---

## 10. What does NOT exist yet (as of this document)

Explicitly noting these so future planning docs don't have to re-derive it:

- No third role beyond `ADMIN`/`DEALER` — no representatives, no plain "customers" without login.
- No retail price field — `wholesalePrice` is the only customer-facing price anywhere in the system.
- No banners/homepage-marketing concept — `Category` has no image field.
- No server-side cart — the Dealer Portal's cart (per `README.md`'s screen list) is client-side state until
  an order is submitted.
- No commission/performance tracking for any actor.
- `Category` → `Product` is not a real foreign key relationship (§4.3) — worth remembering before assuming
  any cascade behavior that isn't explicitly coded in `CategoriesService`.
