# Electro Mart Backend — Current System Reference

Prepared: 2026-08-04, updated 2026-08-05. A complete, from-the-code survey of `electromart-backend` as it
stands today — every module, every endpoint, every business rule that isn't obvious from a glance. Intended
as the ground-truth reference for planning any new work without having to re-read the whole codebase each
time.

This revision folds in the **Representative Portal** (v1 + v2.1), which shipped in full since the previous
version of this document: a third role (`REPRESENTATIVE`), ~40 new endpoints across 10 new modules, 17 new
tables, and additive columns on `Dealer`/`Category`/`Product`/`Order`/`Invoice`/`Payment`/`Expense`. Nothing
described in the original Admin/Dealer sections below changed in behavior — every addition is exactly that,
an addition; see §8 for the compatibility reasoning behind the handful of places new code had to touch
existing files at all.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Framework | NestJS 11 (Express platform) |
| ORM / DB | Prisma 6 → PostgreSQL (Neon), `DATABASE_URL` (pooled) + `DIRECT_URL` (migrations) |
| Auth | Passport JWT (`passport-jwt`), bcrypt password hashing |
| Validation | `class-validator` / `class-transformer`, global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) |
| Docs | Swagger at `/api/docs` (non-production only) |
| File storage | Cloudinary (product images, category image/icon, brand logo/image, banner image) |
| Email | Nodemailer via SMTP (optional — degrades to a no-op log if unconfigured) |
| Scheduling | `@nestjs/schedule` — four cron jobs (token cleanup, supplier-cheque reminders, commission reconciliation, collection reminders — see §9.7) |
| Rate limiting | `@nestjs/throttler`, global default 100 req/min |
| Security headers | `helmet()` |
| Hosting | Vercel-compatible (`api/`, `vercel.json`) alongside a normal `nest start` server |

Env vars are validated at boot (`src/config/env.validation.ts`) — the app refuses to start if
`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` (min 32 chars), or the three `CLOUDINARY_*` vars are missing.
`CORS_ORIGIN` (comma-separated) is required in production; in dev, an unset value logs a warning and opens
CORS to all origins. `REP_PORTAL_URL` (optional) is used only to build a login link inside
`notifyRepWelcome`'s email body — its absence never blocks boot or any request. `COLLECTION_REMINDER_GRACE_DAYS`
(optional, default 7) tunes the collection-reminder cron (§9.7).

---

## 2. What the system is

A wholesale electronics distributor's internal ERP, a private ordering portal for its dealers, **and** a
field-sales ordering/CRM/commission platform for its own representatives. Three actors today:

- **Admin** — the business owner/staff. Full back-office: catalog, inventory, purchasing, suppliers,
  investors/equity, expenses, dealer management, order approval, invoicing, payments, returns, reporting —
  plus (new) representative management, commission/settlement administration, a collections review queue,
  and brand/banner CMS.
- **Dealer** — a wholesale customer with their own login. Browses the catalog, submits orders for approval,
  views their own invoices/payments/orders. Created only by an Admin — no public sign-up.
- **Representative** *(new)* — Electro Mart field staff, onboarded only by an Admin. Logs into a separate
  Representative Portal frontend, browses an (optionally scoped) catalog, registers new shop customers,
  places orders on those customers' behalf, records field cash/cheque collections for admin verification,
  and tracks their own commission earnings/settlements. A representative has **no administrative capability
  of any kind** anywhere in the system — every module they can reach is either entirely new or an
  additively-widened existing read route (§8).

There is still no public storefront and no self-service registration anywhere in the system — a
representative-registered "shop" is itself just a `Dealer` row (§9.2), created by a rep, never able to log
into anything itself.

---

## 3. Auth (`src/auth`)

Single `AuthModule` shared by all three roles.

| Endpoint | Method | Notes |
|---|---|---|
| `/auth/admin/login` | POST | email + password |
| `/auth/dealer/login` | POST | username + password; rejects if dealer `status != ACTIVE` |
| `/auth/rep-login` | POST | *(new)* `{ username, password }` — username is always the rep's email; rejects if `status != ACTIVE`; account-lockout on repeated failures (see below); response includes `mustChangePassword` |
| `/auth/change-password` | POST | *(new, `Role.REPRESENTATIVE` only)* `{ currentPassword, newPassword }` — a representative's self-service change, independent of the Admin/Dealer reset flows |
| `/auth/forgot-password` | POST | `{ identifier, role }` — `role` now accepts `ADMIN`/`DEALER`/`REPRESENTATIVE`; always returns the same generic message whether or not the account exists |
| `/auth/reset-password` | POST | `{ token, role, newPassword }` — same 3-way role branch |
| `/auth/refresh` | POST | rotates the refresh token (old one is revoked, a new pair issued); now branches a third way for `Role.REPRESENTATIVE` |
| `/auth/logout` | POST | revokes the given refresh token |
| `/auth/me` | GET | returns the current JWT payload |

**JWT payload**: `{ sub, role, email?, username? }` (`src/common/interfaces/jwt-payload.interface.ts`) — `role`
is now typed `'ADMIN' | 'DEALER' | 'REPRESENTATIVE'`. Access tokens are short-lived (`JWT_EXPIRES_IN`, signed
by `JwtService`); refresh tokens are random 48-byte hex strings, stored **hashed** (`hashToken`) in the
generic `RefreshToken` table keyed by `{ tokenHash, role, userId, expiresAt, revokedAt }` — the
representative role needed **zero** changes to this table, exactly as the original design anticipated.
Refresh tokens default to 30 days (`JWT_REFRESH_EXPIRES_IN_DAYS`) and are pruned daily
(`AuthService.cleanupExpiredRefreshTokens`, cron `EVERY_DAY_AT_3AM`).

**Timing-attack hardening**: every login/forgot-password path (all three roles) compares against a
precomputed `DUMMY_PASSWORD_HASH` when the account isn't found.

**`JwtStrategy.validate()`** re-checks the account's live status on every authenticated request for both
`Role.DEALER` **and now `Role.REPRESENTATIVE`** — deactivating/suspending/blocking a representative
immediately invalidates any access token they already hold, mirroring the existing dealer behavior exactly.

**Representative account lockout** (`AuthService.repLogin`, additive, admin/dealer login untouched): 5
consecutive failed attempts (`REP_LOCKOUT_THRESHOLD`) locks the account for 15 minutes
(`REP_LOCKOUT_DURATION_MS`); a successful login resets `failedLoginAttempts` to 0. Every login attempt
(success or failure) is recorded to `RepresentativeLoginHistory` (`{ ipAddress, userAgent, success,
failureReason? }`) — an admin can clear a lockout early via `POST /representatives/:id/unlock`.

`RolesGuard` + `@Roles(Role.X, ...)` gate every controller/route; a route with no `@Roles()` is open to any
authenticated user (or public, if it also skips `JwtAuthGuard`).

---

## 4. Data model (`prisma/schema.prisma`)

### 4.1 Enums

Original: `Role {ADMIN, DEALER, REPRESENTATIVE}` *(widened)* · `AccountStatus {ACTIVE, INACTIVE}` ·
`OrderStatus {PENDING_APPROVAL, APPROVED, REJECTED, PACKED, DELIVERED, COMPLETED}` ·
`PaymentStatus {PAID, PENDING, OVERDUE, PARTIAL}` · `PaymentMode {CASH, CHEQUE, BANK_TRANSFER}` ·
`InventoryLogType {PURCHASE, SALE, ADJUSTMENT, RESERVE, RELEASE}` ·
`ChequeStatus {PENDING, CLEARED, RETURNED}`

New (Representative Portal): `DealerSource {DEALER_PORTAL, REP_PORTAL}` ·
`CustomerStatus {LEAD, NEW, REGULAR, VIP, BLOCKED, INACTIVE}` ·
`BannerLinkType {NONE, CATEGORY, PRODUCT, BRAND, EXTERNAL_URL}` ·
`RepresentativeStatus {ACTIVE, SUSPENDED, BLOCKED, INACTIVE}` — deliberately its own enum, not a reuse of
`AccountStatus`, since "suspended vs. blocked" is a staff-account distinction that doesn't belong on
`Dealer`/`Product` · `AssignmentScopeType {CATEGORY, PRODUCT, BRAND, CAMPAIGN}` ·
`CommissionType {PERCENTAGE, FIXED}` · `CommissionLineStatus {PENDING, APPROVED, SETTLED, REVERSED}` ·
`SettlementStatus {PENDING, APPROVED, REJECTED, PAID}` ·
`CollectionStatus {PENDING_VERIFICATION, CONFIRMED, REJECTED}`

### 4.2 Core entities and how they relate

```
Admin ──< Purchase, ActivityLog, Order(approvedByAdminId), Order(createdByAdminId), CustomerNote

Dealer ──< Order, Invoice, Payment, SalesReturn
Dealer ──1:1 CustomerProfile              (Representative Portal CRM satellite, §9.2)
Dealer ──< CustomerNote, RepOrderDraft, CollectionSubmission
Dealer.createdByRepId → Representative     (null for every DEALER_PORTAL-sourced dealer)

Category (name only — NOT a FK target)     Product.category is free-text, denormalized
Category ──self self-relation (parentId)   two-level tree, optional, unused by any existing read
Product ──< OrderItem, PurchaseItem, InventoryLog, SalesReturnItem, PurchaseReturnItem, ProductImage[]
Product ──< CommissionRule, CommissionLedgerEntry, RepOrderDraftItem
Product ──1:1 ProductAvailabilityOverride  (§9.3)

Brand (name only — NOT a FK target, mirrors Category exactly)   Product.brand is free-text
Banner ──< BannerAssignment

Supplier ──< Purchase, SupplierPayment, PurchaseReturn
Purchase ──< PurchaseItem[], PurchaseReturn[]
PurchaseReturn ──< PurchaseReturnItem[]   (optionally tied to a Purchase, or standalone)

Order ──< OrderItem[], Invoice (1:1), SalesReturn[], CommissionLedgerEntry[], CollectionReminderLog[]
Order.createdByRepId → Representative      (null for every admin/dealer-originated order)
Invoice ──< Payment[], CollectionSubmission[]
Payment ──1:1 CollectionSubmission          (only when this payment resulted from a confirmed collection)
SalesReturn ──< SalesReturnItem[]

Investor ──< Investment[]
Expense (standalone) ──1:1 RepresentativeSettlement   (only once a settlement is actually paid, §9.5)
Counter (sequence generator, keyed by string)
RefreshToken (generic across all three roles)

Representative ──< RepresentativeLoginHistory, RepresentativeActivityLog, ProductAssignment,
                    BannerAssignment, CommissionLedgerEntry, RepresentativeSettlement,
                    CollectionSubmission, RepOrderDraft
Representative ──< Dealer (as createdByRep), Order (as createdByRep), CustomerNote (as authorRep),
                    CustomerProfile (as assignedRep)

CustomerProfile (1:1 Dealer)               CRM fields kept off the transactional Dealer table
CustomerNote                               free-text note, authored by either a rep or an admin

ProductAssignment                          (representative, scopeType, scopeValue) opt-in catalog grant
BannerAssignment                           (representative, banner, priority, startsAt?, expiresAt?)
ProductAvailabilityOverride (1:1 Product)  force In/Out-of-Stock for reps, independent of currentStock

CommissionRule ──< CommissionLedgerEntry   per-product %/fixed rate, optionally a time-boxed campaign
CommissionLedgerEntry ── Order, OrderItem, Product, Representative, CommissionRule?, RepresentativeSettlement?
RepresentativeSettlement ── Representative, Expense?  the payout batch + its one accounting bridge

CollectionSubmission ── Representative, Dealer(customer), Invoice?, Payment?(resultingPayment)
CollectionReminderLog ── Order              one row per reminder actually sent (dedupe guard)

RepOrderDraft ── Representative, Dealer?    the rep's server-side cart
RepOrderDraft ──< RepOrderDraftItem[] ── Product
```

### 4.3 Field notes worth knowing before changing anything

- **`Product.category` / `Product.brand` are plain strings, not FKs.** `Category`/`Brand` exist only to
  drive admin pickers and a rename cascade (`CategoriesService.update`/`BrandsService.update` bulk-update
  every matching `Product.category`/`Product.brand` when renamed). Deleting either is blocked while any
  product still references its name.
- **`Order.dealerId`, `Invoice.dealerId`, `Payment.dealerId` are all required, non-nullable.** Every
  financial record traces back to exactly one dealer — including reps' orders, since a rep always creates
  an order **on behalf of** a `Dealer` row (the "shop"), never as its own party.
- **`Order.createdByAdminId`** is set only when an admin recorded the order directly (walk-in/backdated
  sale); **`Order.createdByRepId`** is set only when a representative placed it on a shop's behalf — the two
  are mutually exclusive in practice (a rep is never also an admin) and both leave the field null for a
  dealer's own submission.
- **`OrderItem.allocatedDiscount` / `netLineTotal` / `netUnitPrice`** are computed once (at approval, or at
  admin-creation time) and **never recomputed** — sales returns always refund from `netUnitPrice`, not the
  original `unitPrice`. This "store it, never recompute" rule is a deliberate invariant, not an oversight,
  and it's exactly why commission (§9.5) is computed by reading these already-final columns rather than
  re-deriving anything.
- **`Payment.invoiceId` is nullable.** Null means a standalone dealer credit/advance not tied to any
  specific invoice — mode/cheque-lifecycle/edit-window/activity-log all still work identically; only the
  invoice-balance cap and `paymentStatus` recompute don't apply. Confirmed live and migrated as of this
  document's writing.
- **`Counter`** backs every human-readable sequence number: `ORD-…`, `INV-…`, `RTN-…`, `PRTN-…`, and now
  `STL-…` (settlement numbers, `nextSequenceNumber(tx, 'settlement', 'STL')`) — see §7.4.
- **`Product.retailPrice`** falls back to `wholesalePrice` when unset — this is a *display* price for the
  Representative Portal catalog only. **`OrdersService.buildItemsAndSubtotal()` never reads it** — every
  order, regardless of channel, is still priced exclusively from `wholesalePrice`, so a rep-placed order's
  actual charged amount is identical in kind to a dealer's own order. `compareAtPrice` is a struck-through
  "was" price for showing a discount; `isFeatured` surfaces a product in Rep Portal featured rails. All
  three are admin-editable from the existing Product edit form (no new screen).
- **`ProductAvailabilityOverride`/`CommissionRule` never touch `currentStock`/pricing themselves** — they're
  read-only-consulted satellites. A representative's product read is the only code path that ever resolves
  them; Admin/Dealer product reads are completely unaffected (§9.3).

---

## 5. The Order → Invoice → Payment → Return pipeline

This is the most complex, most heavily-invariant part of the codebase (`src/orders/orders.service.ts`,
`src/invoices`, `src/payments`, `src/sales-returns`, `src/inventory`). Read this section before touching
any of it. **The Representative Portal reuses this pipeline entirely rather than building a parallel one** —
the only changes here are described explicitly at the end of §5.1; nothing else in this section changed.

### 5.1 Order lifecycle

```
PENDING_APPROVAL --approve()--> APPROVED --status PACKED--> PACKED --status DELIVERED--> DELIVERED --status COMPLETED--> COMPLETED
       |
       --reject()--> REJECTED
```

- **Dealer-submitted** orders always start `PENDING_APPROVAL`; the dealer has no discount authority.
- **Admin-created** orders (`POST /orders` with `dealerId` supplied, requester role ADMIN) can carry an
  order-wide discount (`discountPercentage` XOR `discountAmount`) or **per-line discounts**, and are
  **auto-approved inline**. If `saleDate` is supplied, the order is instead created directly as `COMPLETED`.
- **Representative-created orders** (`POST /rep-portal/orders`, which delegates straight into this same
  `OrdersService.create()`) behave exactly like a dealer's own submission: `PENDING_APPROVAL`, no discount
  authority, admin must explicitly approve. The **one** line of shared code that changed to support this:
  `OrdersService.create()`'s `dealerId` resolution, previously `role === ADMIN ? dto.dealerId : requester.id`,
  is now `(role === ADMIN || role === REPRESENTATIVE) ? dto.dealerId : requester.id` — a representative
  supplies which shop the order is for, exactly as an admin already could. The admin-only auto-approve
  branch itself was **not** touched or widened — a representative's order can never skip approval. When the
  creator is a representative, the created row additionally stamps `createdByRepId`, and (representative-only,
  optional) `notes`/`expectedDeliveryDate` — both plain nullable columns every existing order simply has null.
- `PATCH /orders/:id/approve` — admin approves a pending order, optionally with a discount. Reserves stock,
  generates the invoice, moves to `APPROVED`. Now also emails the representative (`notifyRepOrderApproved`)
  if the order has `createdByRepId` set, alongside the existing, unchanged dealer-approval email.
- `PATCH /orders/:id/reject` — requires a reason; no stock/invoice side effects. Same additive
  rep-notification pattern (`notifyRepOrderRejected`).
- `PATCH /orders/:id/status` — steps `APPROVED → PACKED → DELIVERED → COMPLETED` one at a time; only
  `COMPLETED` increments the dealer's `outstandingBalance` and sends the delivery email.
- `PATCH /orders/:id/complete` — fast-forwards straight to `COMPLETED` from any of
  `APPROVED/PACKED/DELIVERED`, backfilling any skipped timestamps.
- `PATCH /orders/:id/items` — replaces line items, **only while `PENDING_APPROVAL`** (no invoice exists
  yet).
- `PATCH /orders/:id` — full edit (dealer, items, discount, sale date) for any order that **already has an
  invoice**. Blocked if a sales return or any payment already exists against it.
- `DELETE /orders/:id` — deletable at any status, reversing stock/balance/invoice, but blocked if the
  invoice already has payments recorded, or if a newer invoice has since been issued.

`GET /orders/:id` and `GET /invoices/:id`/`GET /payments/:id` requester-role checks were widened from a
narrow `'ADMIN' | 'DEALER'` union type to the full `Role` enum, purely so the widened `JwtPayload.role` type
compiles against them (`REPRESENTATIVE` can never actually reach these routes — they're not in that role's
`@Roles()` list on any of the three controllers, so this is a type-level fix with zero behavior change).

### 5.2 Discounts

Two mutually-exclusive discount modes, resolved by `resolveDiscount()` (order-wide) vs
`applyItemLevelDiscounts()` (per-line) — a single order uses one or the other, never both, and only an admin
can apply either (a representative-placed order never carries a discount at creation, same as a dealer's).

### 5.3 Credit limit enforcement

`assertWithinCreditLimit()` is the single gate every order-creating/-editing path calls — including
representative-placed orders, since they resolve to a real `Dealer` row like any other. Representative
Portal shop registrations always set `unlimitedCredit: true` (§9.2) specifically so a brand-new shop's first
order isn't blocked by a `creditLimit: 0` default; `PENDING_APPROVAL` remains the actual checkpoint.

### 5.4 Stock / inventory (`src/inventory/inventory.service.ts`)

`InventoryService.recordMovement()` is the **only** way `Product.currentStock` ever changes. Unchanged by
the Representative Portal. What *did* change is who's allowed to see the number: a representative's product
reads never receive `currentStock` at all (§9.3) — they receive a resolved `stockStatus` instead, computed
from this same real column plus an optional admin override.

### 5.5 Invoices (`src/invoices`)

Unchanged. Generated exactly once per order, at approval. A representative-placed order gets an invoice
through the identical path a dealer's does.

### 5.6 Payments (`src/payments`)

Unchanged, **except** one small additive hook: `PaymentsController.updateChequeStatus()`, when a cheque
transitions to `RETURNED`, now also fires a post-commit (never inside the same transaction, fire-and-forget
like every other post-commit notification in this codebase) lookup — `payment → invoice → order →
createdByRep` — and if that chain resolves to a representative, emails them (`notifyRepChequeReturned`).
`PaymentsService.updateChequeStatus()` itself has zero lines changed; the hook lives entirely in the
controller, right next to (not inside) the existing call.

### 5.7 Sales returns (`src/sales-returns`) / Purchase returns (`src/purchase-returns`)

Unchanged.

---

## 6. Cross-cutting mechanisms (shared by many modules)

### 6.1 Transactions
Nearly every mutating operation, across both the original and new modules, runs inside
`this.prisma.$transaction(async (tx) => {...}, TRANSACTION_OPTIONS)` (`src/common/constants/prisma.ts`).

### 6.2 Activity log (`src/activity-log`)
Every mutating **admin** action is logged: `{ adminId, action, targetId?, details? }`. This table is
unchanged and admin-only, exactly as before — representative actions are logged to a **separate** table
instead (§9.6), deliberately not by extending this one (see that section for why).

### 6.3 Pagination
Nearly every list endpoint, old and new, shares one `paginate(data, total, page, limit)` helper
(`src/common/utils/paginate.ts`) returning `{ data, meta: { page, limit, total, totalPages } }`.

### 6.4 Sequence numbering (`src/common/utils/sequence.ts`)
A single `Counter` table backs every human-readable serial, now including `'settlement'` → `STL-<year>-<serial>`
for `RepresentativeSettlement.settlementNumber`, generated the same way `ORD-`/`INV-`/etc. always have been.

### 6.5 Soft invariants around money (`src/common/utils/invoice-financials.ts`)
Unchanged, still shared by payments and sales-returns. `CollectionsService.confirm()` (§9.4) deliberately
does **not** duplicate any of this logic — it calls the existing `PaymentsService.create()`, which is what
already calls into these helpers.

### 6.6 Error handling
`isForeignKeyViolation()` is now also used by `RepresentativesService.remove()` (blocked if a rep has any
customers/orders/etc.) and `BrandsService.remove()`/`BannersService.remove()` (blocked if referenced),
identical pattern to the original Dealer/Product/Category/Supplier deletion guards.

---

## 7. Original module-by-module endpoint reference (Admin/Dealer)

Role column: **A** = Admin, **D** = Dealer, **R** = Representative. A route with more than one role means
the service-layer logic branches on role (e.g. a dealer only ever sees their own data).

### Dealers (`/dealers`) — Admin only
`POST /` create · `GET /` list (search by business/owner/phone/username, status filter) · `GET /:id` (+
lifetime order/invoice summary) · `PATCH /:id` update · `POST /:id/reset-password` · `DELETE /:id` (blocked
if it has any transactional history) · `POST /:id/clear-data` (wipes all orders/invoices/payments/returns
for this dealer, admin password re-confirmation required, irreversible) · `PATCH /:id/status`
(activate/deactivate). Unchanged — a Representative Portal-registered "shop" is a `Dealer` row and shows up
here identically, distinguishable only by `source: REP_PORTAL` and `createdByRepId` (neither surfaced in
this screen's existing UI, both present in the API response).

### Products (`/products`)
`POST /` **A** · `GET /` **A, D, R** *(role widened)* · `GET /:id` **A, D, R** *(role widened)* · `PATCH /:id`
**A** · `PATCH /:id/status` **A** · `DELETE /:id` **A** (blocked if it has order/purchase history) ·
`POST /:id/images` **A** (up to 5 images, 5MB each, Cloudinary) · `DELETE /:id/images/:imageId` **A** ·
`POST /:id/availability-override` **A** *(new)* `{forceAvailable, reason?}` · `DELETE
/:id/availability-override` **A** *(new)*.

`costPrice` is stripped from every response for **both** `D` and `R` (the function doing this was renamed
`hideCostPriceForDealer` → `hideCostPrice`, behavior for Dealer is byte-identical). For `R` specifically, the
response goes through one more step (`RepCatalogVisibilityService.serializeForRep`/`serializeManyForRep`) that
additionally strips `currentStock`/`isOutOfStock` and adds a resolved `stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK'`
(§9.3), and the list is scoped to that representative's assigned catalog if they have any assignments at all
(§9.3). Search (`findAll`'s `search` param) now also matches `Product.model`, benefiting every role. See §9.3
for the full mechanism and §9.5 for the two new sub-routes hanging off `/products/:id` for commission rules.

### Categories (`/categories`)
`POST /` **A** · `GET /` **A, D, R** *(role widened)* · `GET /:id` **A, D, R** *(new endpoint)* · `PATCH /:id`
**A** (renaming cascades to every `Product.category` match) · `DELETE /:id` **A** (blocked while any product
still references it) · `POST /:id/image` **A** *(new)* · `POST /:id/icon` **A** *(new)*. `Category` gained
CMS fields (`imageUrl`, `iconUrl`, `sortOrder`, `isFeatured`, `slug`, `parentId`) — all optional/defaulted, so
every existing category renders exactly as before until an admin opts in via the new upload endpoints or a
`PATCH` carrying the new fields.

### Orders (`/orders`) — see §5.1 for the full lifecycle
`POST /` **A, D** · `GET /` **A, D** · `POST /reset-counter` **A** · `GET /:id` **A, D** · `PATCH /:id/approve`
**A** · `PATCH /:id/items` **A** · `PATCH /:id` **A** · `PATCH /:id/reject` **A** · `PATCH /:id/status` **A**
· `PATCH /:id/complete` **A** · `DELETE /:id` **A**. A representative never calls this controller directly —
their equivalent surface is `/rep-portal/orders` (§9.4), which delegates into the exact same
`OrdersService.create()`/read logic underneath.

### Invoices (`/invoices`)
`GET /` **A, D** · `POST /reset-counter` **A** · `GET /:id` **A, D**. Unchanged.

### Payments (`/payments`) — see §5.6
`POST /` **A** · `GET /` **A, D** · `GET /:id` **A, D** · `PATCH /:id` **A** · `DELETE /:id` **A** · `PATCH
/:id/cheque-status` **A** (now also fires the rep-notification hook described in §5.6).

### Inventory (`/inventory`) — Admin only
`GET /` stock list · `GET /:productId/ledger` (paginated movement history) · `POST /adjustment`. Unchanged.

### Suppliers (`/suppliers`) — Admin only. Unchanged.

### Purchases (`/purchases`) — Admin only. Unchanged.

### Purchase returns (`/purchase-returns`) — Admin only. Unchanged.

### Sales returns (`/sales-returns`) — Admin only. Unchanged.

### Credits — supplier-side ledger (`/credits`) — Admin only. Unchanged, including its own independent
daily cheque-deposit-reminder cron (`EVERY_DAY_AT_8AM`) — the new collection-reminder cron (§9.7) is a
separate registration and does not touch this one.

### Investors / Investments (`/investors`, `/investments`) — Admin only. Unchanged.

### Expenses (`/expenses`) — Admin only. Unchanged as a module — but its underlying `Expense` table is now
also written to (never read from differently) by the settlement-payout flow (§9.5); see that section for why
this required zero changes to `ExpensesService`.

### Equity (`/equity`) — Admin only. Unchanged.

### Sales analysis (`/sales-analysis`) — Admin only. Unchanged.

### Dashboard (`/dashboard`)
`GET /admin` **A**, `GET /dealer` **D**. Unchanged — no representative-specific dashboard route exists here;
a representative's equivalent is `GET /rep-portal/dashboard` (§9.4), a separate, purpose-built payload.

### Activity log (`/activity-logs`) — Admin only. Unchanged — this is the admin-authored log; see §9.6 for
the separate representative-authored log.

### Uploads
No standalone controller — `UploadsService` (Cloudinary wrapper: `uploadImage`, `deleteImage`) is now
consumed by five services: `ProductsService`, `CategoriesService`, `BrandsService`, `BannersService`, and
(indirectly, via the rep's own submission) nothing writes cheque-photo uploads server-side yet (see §11).

---

## 8. The Representative Portal — design principles

Before the module reference, the two decisions worth understanding first, since they explain *why* several
of the new modules are shaped the way they are rather than hooking directly into existing services.

### 8.1 Commission, computed entirely outside the order pipeline

A representative earns commission once their order is real (admin-approved). The tempting implementation —
one more line inside `OrdersService.applyApproval()` — was rejected: that function is shared by every order
in the system, of every channel, and is the single highest-scrutiny piece of code in the app. Instead,
`CommissionReconciliationService` (`src/commission/commission-reconciliation.service.ts`) runs on a
**5-minute cron** (`EVERY_5_MINUTES`) and does exactly two read-then-write passes, both against brand-new
tables only:

1. Finds every `Order` with `createdByRepId IS NOT NULL`, `status IN (APPROVED, PACKED, DELIVERED,
   COMPLETED)`, and no `CommissionLedgerEntry` rows yet. For each `OrderItem`, resolves the applicable
   `CommissionRule` (an active campaign rule beats the standing/default rule; `PERCENTAGE` applies to
   `netLineTotal`, `FIXED` is interpreted as a flat amount per unit sold) and writes a new `PENDING` ledger
   line. A product with no matching rule at all is simply skipped — no zero-amount row.
2. Finds every `PENDING`/`APPROVED` ledger line whose order now has a `SalesReturn` against it, and marks it
   `REVERSED` — never touching an already-`SETTLED` line, since that commission has already been paid out.

`OrdersService` itself gained **zero** lines for this — the cron only ever reads `Order`/`OrderItem`/
`SalesReturn` (all pre-existing, unmodified) and writes to the new `CommissionLedgerEntry` table. The
trade-off is a few minutes of lag between "order approved" and "commission line appears," accepted
deliberately in exchange for the stronger guarantee.

### 8.2 Collections — a staging inbox that can never itself move money

A representative recording a field collection **cannot** create a real payment. `CollectionSubmission` (rep
submits via `POST /rep-portal/collections`) is a pure insert with **no call to `PaymentsService` anywhere in
that path**. Only `CollectionsService.confirm()` (admin-facing, `PATCH /collections/:id/confirm`) can ever
turn a submission into money moving, and it does so by calling the exact, unmodified
`PaymentsService.create()` — the identical guarded function (row-locking, overpayment guard, cheque
validation, balance decrement, `recomputeInvoicePaymentStatus()`) every other payment in the system already
goes through. If that call throws, the submission simply stays `PENDING_VERIFICATION` for the admin to
re-check; it can never silently produce an inconsistent financial state. `CollectionsService.reject()` has
zero financial effect by construction — nothing was ever written to `Payment`/`Invoice`/`Dealer` for a
submission that reaches that branch.

---

## 9. Representative Portal module-by-module reference

### 9.1 Representatives (`/representatives`) — Admin only, `src/representatives/`
Structured identically to `DealersModule`.

`POST /` create (email doubles as username; auto-generates a temp password unless one is supplied; welcome
email) · `GET /` list (search, status filter) · `GET /:id` (+ summary: totalCustomers, totalOrders,
lifetimeCompletedValue) · `PATCH /:id` update · `PATCH /:id/status` (Active/Suspended/Blocked/Inactive,
emails the rep if it actually changed) · `POST /:id/reset-password` (new temp password + email) · `POST
/:id/force-password-change` (sets `mustChangePassword: true` for next login) · `POST /:id/unlock` (clears
`failedLoginAttempts`/`lockedUntil`) · `DELETE /:id` (blocked via FK-violation guard if the rep has any
customers/orders/etc.) · `GET /:id/login-history` (paginated) · `GET /:id/activity-log` (paginated, reads
`RepresentativeActivityLog`, §9.6) · `DELETE /:id/activity-log` (admin-only wipe, itself logged to the
*admin* `ActivityLog`) · `GET /:id/sales-stats` (today/monthly/pending/completed order counts + revenue) ·
`GET /:id/commission-stats` (pending/approved/paid totals from `CommissionLedgerEntry`) · `GET
/:id/settlements` (paginated `RepresentativeSettlement` history) · `GET /:id/assigned-products` /
`POST /:id/assigned-products` `{scopeType, scopeValue}` / `DELETE /:id/assigned-products/:assignmentId`
(§9.3) · `GET /:id/assigned-banners` (read-only here — assignment itself happens from the Banners module,
§9.9) · `GET /:id/assigned-customers` (paginated `Dealer` rows where `createdByRepId = :id`).

### 9.2 Rep Portal — Customer (shop) management (`/rep-portal/customers`) — Representative only, `src/rep-portal/rep-customers.service.ts`
A "customer" is a `Dealer` row with `source: REP_PORTAL`, extended by a `CustomerProfile` satellite.

`GET /` search (**not** scoped to the calling rep — shared across every representative, so two reps can't
independently register the same shop twice; matches business name/owner/phone/city/area) · `POST /` create
(duplicate-phone check, exact then loose; auto-generates a `username: shop-<hex>` this shop can never log in
with; creates the `Dealer` + `CustomerProfile` in one transaction; `creditLimit: 0`, `unlimitedCredit: true`
— §5.3) · `GET /:id` (+ order summary + `CustomerNote[]`) · `PATCH /:id/status` (upserts `CustomerProfile.status`)
· `POST /:id/notes` `{note}`. Every mutation is logged to `RepresentativeActivityLog` (§9.6). Every `Dealer`
read here omits `password` via Prisma-level `omit`, not manual field deletion.

### 9.3 Rep catalog visibility (`src/rep-catalog-visibility/`) — shared service, no controller of its own
`RepCatalogVisibilityService` is the single choke point both `/products`+`/categories` (once `Role.REPRESENTATIVE`
is on their read routes) and `/rep-portal/home`+`/rep-portal/search` funnel through, so scoping/hiding logic
is never duplicated:

- **`buildAssignedProductWhereClause(repId)`** — opt-in scoping. If a representative has any
  `ProductAssignment` rows, returns a `Prisma.ProductWhereInput` OR-ing together every matching
  `PRODUCT`/`CATEGORY`/`BRAND` scope, plus (for `CAMPAIGN` scopes) every product with an active campaign
  `CommissionRule` under that name. With **zero** assignments, returns an unrestricted clause — a
  freshly-created rep isn't silently shown an empty catalog before an admin configures anything.
- **`resolveStockStatus`/`resolveStockStatusMany`** — real `currentStock > 0` check, unless a
  `ProductAvailabilityOverride` row exists for that product, in which case its `forceAvailable` wins.
- **`serializeForRep`/`serializeManyForRep`** — strips `currentStock`, `costPrice`, `isOutOfStock` from a
  product payload and adds `stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK'`. **The raw stock number is never
  serialized into any representative-facing response, anywhere** — this is enforced at this single choke
  point, not per-endpoint, and is applied to every place a product is embedded in a rep response: catalog
  reads, homepage rails, search results, cart/draft line items, and order-history line items.
- **`getVisibleBanners(repId)`** — that rep's own active `BannerAssignment`s if any exist (respecting
  `startsAt`/`expiresAt`), else the existing global active `Banner` list.

Admin write route for the override: `POST /products/:id/availability-override`
`{forceAvailable, reason?}` / `DELETE /products/:id/availability-override` (§7). Admin write routes for
product-scope assignment live on `/representatives/:id/assigned-products` (§9.1), not here.

### 9.4 Rep Portal — Drafts, Orders, Home/Search/Dashboard, Earnings, Collections (`/rep-portal/*`) — Representative only, `src/rep-portal/`, `src/commission/`

**Drafts** (`/rep-portal/drafts`, `src/rep-portal/rep-drafts.service.ts`) — the server-side cart. `POST /`
(start), `GET /` (list own), `GET /:id`, `PATCH /:id` `{dealerId?, notes?, expectedDeliveryDate?, items?}`
(replaces items wholesale when `items` is provided), `DELETE /:id`. Deliberately **not** an `Order` row —
zero interaction with `OrderStatus`, stock reservation, or credit checks until explicitly submitted. Every
returned draft's line items are passed through `RepCatalogVisibilityService.serializeForRep` before leaving
the service — a cart preview is a product read like any other and gets the identical cost/stock hiding.

**Orders** (`/rep-portal/orders`, `src/rep-portal/rep-orders.service.ts`) — `POST /` delegates straight into
`OrdersService.create()` (§5.1); `GET /` and `GET /:id` are read-only queries scoped to `createdByRepId =
caller`, with the same product-serialization pass applied to embedded order-item products as drafts get.

**Home / Search / Dashboard / Activity Log** (`/rep-portal/home`, `/rep-portal/search`, `/rep-portal/dashboard`,
`/rep-portal/activity-log`, `src/rep-portal/rep-home.service.ts`) — `home` returns one aggregated payload:
banners (§9.3), featured categories/brands, new arrivals, best sellers (via an `orderItem.groupBy`
over-fetch-then-intersect-with-scope pattern), offers (`compareAtPrice` genuinely exceeding the quoted
price), and a recommended rail. `search` is a single free-text query across
name/sku/barcode/productCode/brand/category/model. `dashboard` returns the rep's own KPIs (today's/monthly
orders, pending/completed counts, revenue, customers registered, 5 most recent orders). `activity-log`
(added to this controller) is the rep's own read-only view into `RepresentativeActivityLog` (§9.6).

**Earnings** (`/rep-portal/earnings/*`, `src/commission/rep-earnings.service.ts`) — always self-scoped from
the JWT, no `:id` param exists on any of these routes so a rep can never even attempt another rep's data:
`GET /summary` (total/today's/monthly/completed sales, pending-approval count, commission
pending/approved/paid/earned) · `GET /ledger` (paginated `CommissionLedgerEntry`, own) · `GET /settlements`
(paginated `RepresentativeSettlement`, own) · `GET /statement` (CSV export of the ledger for an optional
date range — no server-side PDF pipeline exists anywhere in this codebase to mirror, so this is CSV, not
PDF; see §11).

**Collections** (`/rep-portal/collections`, `src/rep-portal/rep-collections.service.ts`) — see §8.2 for the
safety architecture. `POST /` submit (`{customerId, invoiceId?, amount, mode, chequeNumber?, bankName?,
chequeDate?, collectionDate, notes?, chequeImageUrl?}` — pure insert, `PENDING_VERIFICATION`) · `GET /` own
submissions, paginated · `GET /customer/:customerId` — outstanding balance, invoice list, pending cheques,
last payment, and collection history for one customer (used by the Customer Profile's Collections panel).

### 9.5 Commission engine + Settlements (`src/commission/`) — see §8.1 for the reconciliation architecture

**Commission Rules** (`/products/:productId/commission-rules`, Admin only, `commission-rules.service.ts`) —
plain CRUD: `GET /`, `POST /` `{type, value, startDate, endDate?, isCampaign?, campaignName?}`, `PATCH
/:ruleId`, `DELETE /:ruleId` (blocked if any `CommissionLedgerEntry` already references it). Never touches
the order pipeline; rule *resolution* only ever happens inside the reconciliation cron.

**Settlements & dashboard** (`/commission/*`, Admin only, `settlements.service.ts`) — the commission-side
mirror of the existing Payments/Credits admin workflow: `GET /dashboard` (pending/approved/settled totals,
pending-settlements count, this-month paid total) · `GET /representatives/:id/summary` · `GET /settlements`
(filterable by status/representative, paginated) · `POST /settlements` `{representativeId, periodStart,
periodEnd}` — batches every `PENDING` ledger line for that rep created within the period into a new
`PENDING` settlement, flipping those lines to `APPROVED` (spoken-for) · `GET /settlements/:id` (+ line
items) · `PATCH /settlements/:id/approve` · `PATCH /settlements/:id/reject` `{reason}` — releases its lines
back to `PENDING`/unbatched so they aren't stranded · `PATCH /settlements/:id/pay` `{mode, reference?,
chequeNumber?, bankName?, chequeDate?}` — Cash/Bank Transfer settle (and expense-record) immediately; Cheque
mode sets `chequeStatus: PENDING` and defers the expense until it clears · `PATCH
/settlements/:id/cheque-status` `{status: CLEARED|RETURNED}` — cheque-mode settlements only, mirrors
`PaymentsService.updateChequeStatus()`'s own transition guard shape; `CLEARED` triggers the expense write ·
`GET /settlements/:id/receipt` — structured JSON (settlement + rep + line items) for the frontend to
render/print; again, no server-side PDF generation exists in this codebase.

**The accounting bridge** (`SettlementsService.createSettlementExpense`, called only from `pay()`/cheque-clear):
```ts
const expense = await tx.expense.create({
  data: { description: `Representative commission settlement — ${rep.name} (${settlement.settlementNumber})`,
          amount: settlement.totalCommission, expenseDate: new Date(), remarks: `Settlement period …` } });
await tx.representativeSettlement.update({ where: { id }, data: { expenseId: expense.id, status: 'PAID', paidAt: new Date() } });
await tx.commissionLedgerEntry.updateMany({ where: { settlementId: settlement.id }, data: { status: 'SETTLED' } });
```
This is **the exact same `tx.expense.create()`** `ExpensesService.create()` already uses — not a copy, the
identical write — so `DashboardService.computeLiquidCash()`, `SalesAnalysisService`'s profit calc, and
`EquityService`'s expense-share all pick up a paid settlement automatically, with zero changes to any of
those three. All-or-nothing inside one transaction alongside the settlement's own status flip.

### 9.6 Representative Activity Log (`RepresentativeActivityLog`, `src/rep-activity-log/`)
A **dedicated** table, deliberately separate from the shared, admin-scoped `ActivityLog` — carries richer
per-entry data (`ipAddress`, `userAgent`, `deviceType`) than that table has for anyone, admins included.
`RepActivityLogService.log(tx, {representativeId, action, targetId?, details?, ipAddress?, userAgent?,
deviceType?})` is called from every mutating Rep Portal endpoint. Representatives have **read-only** access
to their own log (`GET /rep-portal/activity-log`); only an admin can read any rep's log or clear it (`GET`/
`DELETE /representatives/:id/activity-log`) — the `DELETE` route is not `@Roles()`-permitted for
`REPRESENTATIVE` at all, so it's unreachable regardless of what any frontend shows.

### 9.7 Cheque-return notification + Collection reminders cron
Covered functionally in §5.6 (cheque-return hook) and §8.2. The reminders cron
(`CollectionRemindersService.sendReminders`, `src/collections/collection-reminders.service.ts`,
`EVERY_DAY_AT_9AM`, independent registration from the existing Credits cheque cron) finds every `Order` with
`createdByRepId` set, an active fulfilled status, a linked `Invoice` still `PENDING`/`PARTIAL`, whose
`approvedAt` is more than `COLLECTION_REMINDER_GRACE_DAYS` (default 7) in the past, and no
`CollectionReminderLog` row for today — emails the rep (`notifyRepCollectionReminder`, priority `OVERDUE` if
the invoice's own `dueDate` has also passed, else `HIGH`) and logs one `CollectionReminderLog` row per send
so it can never double-send the same order the same day.

### 9.8 Collections (admin review) (`/collections`) — Admin only, `src/collections/collections.service.ts`
See §8.2. `GET /` queue (filterable by status/representative, paginated) · `GET /:id` · `PATCH /:id/confirm`
`{invoiceId?}` (required if the submission itself didn't specify one) — calls `PaymentsService.create()`,
writes `resultingPaymentId`/`status: CONFIRMED`/`verifiedByAdminId`/`verifiedAt`, emails the rep · `PATCH
/:id/reject` `{reason}` — no financial effect, emails the rep with the reason.

### 9.9 Brands (`/brands`) — `src/brands/`
Mirrors `CategoriesService` exactly (name uniqueness, rename cascade to `Product.brand`, delete blocked
while referenced). `POST /` **A** · `GET /` **A, D, R** · `GET /:id` **A, D, R** · `PATCH /:id` **A** ·
`DELETE /:id` **A** · `POST /:id/logo` **A** (multipart) · `POST /:id/image` **A** (multipart, brand-page
hero image).

### 9.10 Banners (`/banners`) — `src/banners/`
The global, admin-managed banner pool — the *personalized* homepage banner list a representative actually
sees is resolved by `RepCatalogVisibilityService.getVisibleBanners()` (§9.3) and served from
`/rep-portal/home`; this controller is the plain CRUD surface plus the assignment sub-routes. `POST /` **A**
(multipart, image required at creation — a banner is meaningless without one) · `GET /` **A, R** · `GET
/:id` **A, R** · `PATCH /:id` **A** (non-image fields only — no "replace image" endpoint exists) · `PATCH
/:id/status` **A** · `DELETE /:id` **A** (also deletes every assignment + the Cloudinary asset) · `GET
/:id/assignments` **A** · `POST /:id/assignments` **A** `{representativeId, priority?, startsAt?,
expiresAt?}` · `DELETE /:id/assignments/:assignmentId` **A**.

### 9.11 Reports (`/reports/*`) — Admin only, `src/reports/rep-reports.service.ts`
100% read-only aggregation, reusing the same `groupBy`/`aggregate` toolkit `DashboardService`/
`SalesAnalysisService` already use, pointed at `Order.createdByRepId` and the new tables. No write path of
any kind. `GET /representative-performance` (revenue/order-count per rep) · `GET /collection-performance`
(confirmed/rejected/pending per rep) · `GET /outstanding-by-representative` (`Dealer.outstandingBalance`
summed per rep) · `GET /commission-summary` (ledger totals per rep, by status) · `GET /settlement-summary`
(settlement totals by status) · `GET /overdue-collections` (same underlying query as the §9.7 reminder cron,
presented as a report) · `GET /returned-cheques` (`Payment.chequeStatus = RETURNED`, joined to the
originating rep if any) · `GET /sales/product`, `GET /sales/category`, `GET /sales/representative`
(`OrderItem` aggregation, one dimension each).

---

## 10. Notifications (`src/mailer`)

`MailerService` degrades gracefully to a logged no-op if SMTP env vars aren't set. Original methods
(admin/dealer welcome/reset, order-submitted/approved/rejected/delivered, out-of-stock alert,
cheque-deposit-reminder digest) are all unchanged. New, additive-only methods: `notifyRepWelcome` (temp
credentials + a `REP_PORTAL_URL` login link if configured), `notifyRepPasswordReset`,
`notifyRepStatusChanged`, `notifyRepOrderApproved`/`notifyRepOrderRejected` (§5.1),
`notifyRepSettlementPaid`/`notifyRepSettlementRejected` (§9.5), `notifyRepCollectionConfirmed`/
`notifyRepCollectionRejected` (§9.8), `notifyRepChequeReturned` (§5.6), `notifyRepCollectionReminder` (§9.7).
All fire-and-forget, errors logged not thrown, same as every original method.

---

## 11. Security posture summary

- `helmet()` + `trust proxy` set globally. CORS explicit allow-list, required in production. Global
  `ValidationPipe` strips-and-rejects unknown fields. Global `ThrottlerGuard`, 100 req/min. All unchanged.
- `costPrice` is stripped from every product response for Dealer **and now Representative**
  (`hideCostPrice`, §7). For Representative specifically, `currentStock`/`isOutOfStock` are *also* never
  serialized — enforced at the single `RepCatalogVisibilityService` choke point (§9.3), applied consistently
  across catalog reads, homepage, search, cart/draft, and order-history line items. This was tightened once
  during hardening: draft and order-history embedded products were initially missed by this boundary
  (they went through a separate, un-sanitized Prisma include) and were fixed to route through the same
  `serializeForRep` call as every other product read — see `rep-drafts.service.ts`/`rep-orders.service.ts`/
  `rep-home.service.ts`'s `dashboard()` for the sanitizing wrapper each now applies.
- `RepCustomersService`'s `Dealer` reads use Prisma-level `omit: { password: true }` throughout (also
  tightened once — `findOne()` initially lacked it while `search()`/`create()`/`setStatus()` already had it).
- Representative accounts lock out after 5 failed logins for 15 minutes (§3), independent of Admin/Dealer
  login, which have no such mechanism.
- `RepresentativesController`/every route under it is `Role.ADMIN`-only, full stop — a representative has no
  path, direct or indirect, to any administrative capability (§9.1's permission model).
- A representative's collection submission has **no code path that can move money**, adjust
  `outstandingBalance`, or change `Invoice.paymentStatus` — only `CollectionsService.confirm()` (Admin) can,
  and only through the pre-existing, unmodified `PaymentsService.create()` (§8.2).
- Password reset tokens are single-use, 30-minute TTL, validated before paying bcrypt's hashing cost.
  Refresh tokens stored hashed. Access-token status re-verified per-request for Dealer **and now
  Representative**.
- Swagger (`/api/docs`) is only mounted outside production.

---

## 12. What does NOT exist yet (as of this document)

Explicitly noting these so future planning docs don't have to re-derive it:

- **No server-side PDF generation anywhere in this codebase.** Settlement receipts and commission
  statements are structured JSON / CSV respectively — any PDF rendering happens client-side, if at all.
- **No SMS/WhatsApp/push notification channel** — every notification in the system, old and new, is email
  only (or a logged no-op without SMTP configured).
- **No finer-grained admin RBAC** — `Role.ADMIN` remains a single, undifferentiated permission level; there
  is no "admin sub-role" concept anywhere, including for the new Representative-management/Commission/
  Collections modules (any admin can do anything any other admin can).
- **`Category`/`Brand` → `Product` are still not real foreign-key relationships** — both remain denormalized
  free-text fields on `Product`, exactly as `Category` always was, worth remembering before assuming any
  cascade behavior beyond what's explicitly coded in `CategoriesService`/`BrandsService`.
- **Product Assignment/Banner Assignment scoping only ever narrows, never re-derives price** — a
  representative's assigned catalog controls *visibility*, not what they're charged; every order they place
  is still priced from `wholesalePrice` exactly like a dealer's.
- **The commission reconciliation cron has no manual "run now" trigger** — it's purely time-driven
  (`EVERY_5_MINUTES`); there's no endpoint to force an immediate pass for a specific order.
- **Cheque-photo upload for a collection submission is client-supplied-URL only** (`chequeImageUrl` is a
  plain string field) — there's no dedicated multipart upload endpoint for it the way product/category/
  brand/banner images have one.
- **No representative-facing "sub-role" or hierarchy** (e.g. team lead vs. individual rep) — every
  representative is a flat, equal peer in the data model.
