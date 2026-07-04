# Electro Mart Backend — Complete System & API Reference

Everything a frontend engineer needs to build against this backend: architecture, business rules, data model, authentication mechanism, and every single API endpoint with request/response/failure shapes.

Base URL (local): `http://localhost:3000`
Interactive Swagger UI: `http://localhost:3000/api/docs`

---

## 1. Tech Stack & Architecture

| Layer | Choice |
|---|---|
| Framework | NestJS 11 (Express adapter) |
| ORM / DB | Prisma 6 + PostgreSQL (Neon, direct connection) |
| Auth | JWT access tokens (Passport) + rotating refresh tokens |
| Validation | `class-validator` / `class-transformer`, global `ValidationPipe` |
| Docs | `@nestjs/swagger` at `/api/docs` |
| Mail | `nodemailer` (no-ops safely if SMTP env vars are unset) |
| Config | `@nestjs/config`, reads `.env` |

### Folder layout (`src/`)

```
common/          shared guards, decorators, filters, DTOs, utils (no business logic of its own)
auth/            login, refresh, logout, password reset
mailer/          email-sending abstraction, injected everywhere (global module)
dealers/         admin-managed dealer (customer) accounts
suppliers/       admin-managed supplier accounts
products/        product catalog
inventory/       stock level view, per-product ledger, manual adjustments
purchases/       supplier purchase entry → increases stock
orders/          the core order-approval flow
invoices/        read-only invoice views (generated automatically on order approval)
payments/        payment recording against invoices
activity-log/    audit trail of admin actions
dashboard/       aggregated KPIs for admin and dealer
prisma/          PrismaService + module (global)
```

Every feature module = `*.controller.ts` (HTTP layer + guards) + `*.service.ts` (business logic + Prisma calls) + `dto/*.ts` (validated request shapes). No comments in code by design — this document is the source of truth for *why*, the code is the source of truth for *what*.

---

## 2. Environment Variables

```
DATABASE_URL=                  # Postgres connection string (direct, NOT pgbouncer/pooled — see note below)
DIRECT_URL=                    # used only by `prisma migrate`
JWT_SECRET=                    # HMAC secret for signing access tokens
JWT_EXPIRES_IN="15m"           # access token lifetime
JWT_REFRESH_EXPIRES_IN_DAYS=30 # refresh token lifetime, in days
PORT=3000
SMTP_HOST= / SMTP_PORT= / SMTP_USER= / SMTP_PASS= / MAIL_FROM=   # optional; mailer no-ops (logs a warning) if unset
```

**Important infrastructure note:** `DATABASE_URL` must point at a **direct** (non-pooled) Postgres connection, not a PgBouncer/transaction-pooler endpoint. Several operations use Prisma interactive transactions (`$transaction(async (tx) => {...})`) for atomicity (order approval, purchase recording, payment recording, stock adjustment) — these are incompatible with transaction-mode connection pooling and will intermittently fail with `Transaction not found` errors if misconfigured.

---

## 3. Authentication & Authorization Mechanism

### 3.1 Two separate identities

There is no unified "User" table — **Admin** and **Dealer** are entirely separate models with separate login endpoints, separate ID spaces, and separate password fields. A JWT's `role` claim (`ADMIN` | `DEALER`) determines which table `sub` (the JWT subject/user id) refers to.

### 3.2 JWT access token

Payload shape (`JwtPayload`):
```ts
{ sub: string; role: 'ADMIN' | 'DEALER'; email?: string; username?: string; iat; exp }
```
- Signed with `JWT_SECRET`, `15m` default lifetime.
- Sent by the client as `Authorization: Bearer <accessToken>`.
- Validated by `JwtAuthGuard` on every protected route (checks signature + expiry only — no DB lookup per request, so revoking an admin/dealer mid-session is not instant; it takes effect on next login/refresh).

### 3.3 Refresh tokens (rotating)

- On login, the server returns **both** `accessToken` and `refreshToken`.
- `refreshToken` is a random 96-character hex string. The server never stores it in plaintext — only its SHA-256 hash, in the `RefreshToken` table (`tokenHash`, `role`, `userId`, `expiresAt`, `revokedAt`).
- `POST /auth/refresh` — client sends the refresh token, server:
  1. Hashes it, looks up the row.
  2. Rejects (`401`) if not found, already revoked, or expired.
  3. **Revokes the presented token immediately** (marks `revokedAt`) and issues a **brand-new** access+refresh pair. This is rotation — a refresh token can only ever be used once. If a client tries to reuse an old (rotated-out) refresh token, it gets `401`.
  4. Re-checks the underlying Admin/Dealer still exists and (for dealers) is still `ACTIVE`.
- `POST /auth/logout` — revokes a specific refresh token (idempotent; always returns success even if the token wasn't found, to avoid leaking information).
- Frontend implication: **you must persist the refresh token** (e.g. secure storage) and call `/auth/refresh` proactively (short access-token life) or reactively (on a 401 from any protected endpoint), then retry the original request with the new access token.

### 3.4 Roles & guards

- `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)` / `@Roles(Role.ADMIN, Role.DEALER)` on controllers/routes.
- No `@Roles()` decorator + no guard → public route (only `/auth/*` login/refresh/reset endpoints and `GET /`).
- `@UseGuards(JwtAuthGuard)` alone (no `RolesGuard`/`@Roles`) → any authenticated user, role doesn't matter (`GET /auth/me`).
- Failing the role check throws an explicit `403` with message `"This action requires one of the following roles: X, Y"` — not Nest's generic `"Forbidden resource"`.

### 3.5 Password reset (self-service, both roles)

1. `POST /auth/forgot-password { identifier, role }` — `identifier` is **email** for `ADMIN`, **username** for `DEALER`. Always returns the same generic success message regardless of whether the account exists (prevents account enumeration). If it exists, a random 32-byte hex token + 30-minute expiry is stored on the record and emailed.
2. `POST /auth/reset-password { token, role, newPassword }` — validates token + expiry, sets new bcrypt-hashed password, clears the token.

---

## 4. Data Model

All monetary fields are Postgres `Decimal` — serialized as **strings** in JSON responses (e.g. `"39000"`, not `39000`). Parse them as decimals/numbers client-side as needed; do not assume native JS float precision.

### Admin
`id, email (unique), password (hashed, never returned), name, role, resetToken, resetTokenExpiry, createdAt, updatedAt`

### Dealer
`id, businessName, ownerName, phone, email (unique, nullable), address, district, username (unique), password (hashed, never returned), creditLimit, outstandingBalance, status (ACTIVE|INACTIVE), resetToken, resetTokenExpiry, createdAt, updatedAt`

### Product
`id, productCode (unique), sku (unique, nullable), barcode (unique, nullable), name, brand, category, model, description, imageUrl, costPrice, wholesalePrice, sellingPrice, currentStock, minimumStock, warranty, status (ACTIVE|INACTIVE), createdAt, updatedAt`
- `costPrice` is stripped from every response when the requester's role is `DEALER` (dealers never see margin).
- Computed field `isLowStock: boolean` (`currentStock <= minimumStock`) is added to every product response by the API — not a DB column.

### Supplier
`id, name, contact, phone, email, address`

### Purchase / PurchaseItem
Purchase: `id, supplierId, invoiceNumber, purchaseDate, totalValue, adminId, createdAt` + `items[]`
PurchaseItem: `id, purchaseId, productId, quantity, unitCost, lineTotal`

### InventoryLog
`id, productId, type (PURCHASE|SALE|ADJUSTMENT|RESERVE|RELEASE), quantityIn, quantityOut, balanceAfter, reference, createdAt`
- One row is written every time stock changes. `balanceAfter` is the resulting `Product.currentStock` at that moment — the ledger is a full audit trail, not just a log of deltas.
- `reference` holds a related entity id (order id, purchase id, or a free-text adjustment reason).

### Order / OrderItem
Order: `id, orderNumber (unique, e.g. ORD-2026-00001), dealerId, status, subtotal, discount, totalAmount, rejectReason, approvedByAdminId, approvedAt, rejectedAt, packedAt, deliveredAt, completedAt, createdAt, updatedAt`
OrderItem: `id, orderId, productId, quantity, unitPrice (snapshot at order time), lineTotal`
- `OrderStatus` enum: `PENDING_APPROVAL → APPROVED → PACKED → DELIVERED → COMPLETED`, or `PENDING_APPROVAL → REJECTED`. Exactly these 6 states, no others — forward-only.

### Invoice
`id, invoiceNumber (unique, e.g. INV-2026-00001), orderId (unique — one invoice per order), dealerId, subtotal, discountTotal, grandTotal, paymentStatus (PENDING|PARTIAL|PAID|OVERDUE), dueDate, createdAt` + `payments[]`
- Created automatically the moment an order is **approved** (not at creation, not at completion).
- `dueDate` = approval time + 15 days.

### Payment
`id, invoiceId, dealerId, amount, mode (CASH|CHEQUE|BANK_TRANSFER), reference, paymentDate, createdAt`

### ActivityLog
`id, adminId, action (free-text, e.g. "APPROVED_ORDER", "REJECTED_ORDER", "RECORDED_PAYMENT", "ORDER_PACKED"/"ORDER_DELIVERED"/"ORDER_COMPLETED"), targetId, details, createdAt`

### Counter (internal only, never exposed via API)
Backs the atomic sequence generator for `orderNumber` / `invoiceNumber` (`{prefix}-{year}-{5-digit serial}`).

### RefreshToken (internal only, never exposed via API)
See §3.3.

---

## 5. Core Business Mechanisms

### 5.1 The order lifecycle (the heart of the system)

**Step 1 — Dealer submits an order** (`POST /orders`, role `DEALER`)
- Dealer must be `ACTIVE`, else `403`.
- For every line item: product must exist (`404`) and be `ACTIVE` (`400`), and `currentStock >= requestedQuantity` (`400` — "Insufficient stock"). Nothing is deducted yet at this stage.
- `unitPrice` is snapshotted from `Product.wholesalePrice` at this instant — later price changes never retroactively affect an existing order.
- **Credit check**: `dealer.outstandingBalance + newOrderTotal` must **not exceed** `dealer.creditLimit`, or the order is rejected outright with `400` ("This order exceeds your available credit limit"). This runs at submission time, not at approval time — a dealer physically cannot submit an over-limit order.
- On success: sequential `orderNumber` generated (`ORD-YYYY-NNNNN`), order created with status `PENDING_APPROVAL`, and **every admin** in the system is emailed a "new order" notification.

**Step 2 — Admin approves** (`PATCH /orders/:id/approve`, role `ADMIN`)
- Order must currently be `PENDING_APPROVAL`, else `400`.
- Stock is re-validated per item (it may have changed since submission) — insufficient stock throws `400` for that specific product.
- Atomically, in one transaction:
  1. For every item: `Product.currentStock` is **decremented** by the ordered quantity, and an `InventoryLog` row of type `RESERVE` is written. This is the "stock reservation" — from this point the units are no longer visible/orderable by other dealers, even though the order isn't delivered yet.
  2. A sequential `invoiceNumber` is generated and an `Invoice` is created (`PENDING`, due in 15 days).
  3. Order status → `APPROVED`, `approvedByAdminId` + `approvedAt` stamped.
  4. An `ActivityLog` entry (`APPROVED_ORDER`) is written.
- After commit: the dealer is emailed "order approved + invoice ready", and if any item's product dropped to/below its `minimumStock`, every admin is emailed a low-stock alert.

**Step 3 — Admin rejects** (`PATCH /orders/:id/reject { reason }`, role `ADMIN`)
- Order must currently be `PENDING_APPROVAL`, else `400`.
- No stock or invoice changes at all (nothing was reserved yet). Status → `REJECTED`, `rejectReason` + `rejectedAt` stamped, `ActivityLog` (`REJECTED_ORDER`), dealer emailed with the reason.

**Step 4 — Admin advances fulfillment** (`PATCH /orders/:id/status { status }`, role `ADMIN`)
- Strictly forward, one step at a time: `APPROVED → PACKED → DELIVERED → COMPLETED`. Requesting any status out of sequence (e.g. `PACKED` when the order is still `PENDING_APPROVAL`, or `COMPLETED` when it's only `PACKED`) throws `400` naming the expected current status.
- Stock is **not** touched again here — it was already decremented at approval. `PACKED`/`DELIVERED` just stamp timestamps.
- On `COMPLETED` specifically: `Dealer.outstandingBalance` is **increased** by the invoice's `grandTotal` — this is when the sale becomes an actual receivable owed by the dealer (not at approval). `ActivityLog` (`ORDER_PACKED`/`ORDER_DELIVERED`/`ORDER_COMPLETED`) is written at every step.

### 5.2 Payments & invoice status

- `POST /payments { invoiceId, amount, mode, reference?, paymentDate }`, role `ADMIN`.
- Rejects (`400`) if `amount` would push total payments on that invoice above its `grandTotal` (no overpayment).
- Recomputes `Invoice.paymentStatus` from the running total of all payments against it: `0 paid → PENDING`, `0 < paid < grandTotal → PARTIAL`, `paid >= grandTotal → PAID`. (`OVERDUE` exists in the enum for a future scheduled job comparing `dueDate` vs now; nothing currently sets it automatically.)
- `Dealer.outstandingBalance` is reduced by the payment amount (floored at 0).
- `ActivityLog` entry (`RECORDED_PAYMENT`).

### 5.3 Purchases → stock increase

- `POST /purchases`, role `ADMIN`. Admin logs what was bought from a supplier: header (supplier, invoice #, date) + line items (product, quantity, unit cost).
- Atomically: `Purchase` + `PurchaseItem[]` created, `totalValue` computed server-side (never trust a client-supplied total), and for every item `Product.currentStock` is **incremented** with an `InventoryLog` row of type `PURCHASE`.

### 5.4 Manual stock adjustment

- `POST /inventory/adjustment { productId, direction: 'IN'|'OUT', quantity, reason? }`, role `ADMIN`.
- Same underlying mechanism as purchases/reservations (`InventoryService.recordMovement`) — writes an `ADJUSTMENT` log entry. `OUT` adjustments that would drive stock negative are rejected with `400`.

### 5.5 Low stock

- Not a stored flag — computed live as `currentStock <= minimumStock` everywhere it matters: the `isLowStock` field on every product response, `GET /products?lowStockOnly=true`, the `IN_STOCK`/`LOW_STOCK`/`OUT_OF_STOCK` badge in `GET /inventory`, the `lowStockItems` count on the admin dashboard, and the low-stock email fired right after an order approval reduces stock.

### 5.6 Deletion safety

- Dealers and Products are never hard-deleted from the UI's perspective — use the `PATCH .../status` toggle (`ACTIVE`/`INACTIVE`) instead.
- `DELETE /products/:id` and `DELETE /suppliers/:id` do attempt a real delete, but are blocked with `409 Conflict` if the row is referenced elsewhere (order history, purchase history, inventory logs) — this is detected robustly regardless of which underlying Postgres/Prisma error shape the foreign-key violation surfaces as.

---

## 6. Global Response Conventions

### 6.1 Pagination

Every list endpoint accepts (as query params) and returns the same shape:

Query: `?page=1&limit=20&search=foo` (`page` default 1, `limit` default 20 / max 100, `search` optional free-text)

Response:
```json
{
  "data": [ /* array of entities */ ],
  "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 }
}
```

### 6.2 Error shape (every non-2xx response, no exceptions)

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Dealer not found",
  "path": "/dealers/00000000-0000-0000-0000-000000000000",
  "timestamp": "2026-07-04T09:21:06.643Z"
}
```
- `message` is a `string` for most errors, but an **array of strings** for validation failures (one entry per invalid field), e.g. `["ownerName must be a string", "phone must be a string"]`.
- Raw database errors are never leaked — Prisma constraint violations are translated into the same shape (`409` for duplicates/FK conflicts, `404` for "record not found on update/delete", `500` only for truly unexpected errors, which are logged server-side).

### 6.3 Status codes used across the whole API

| Code | Meaning here |
|---|---|
| 200 | Successful GET/PATCH/POST-that-doesn't-create, DELETE |
| 201 | Successful POST that creates a resource (default Nest behavior; login/refresh/logout/forgot/reset use `200` explicitly via `@HttpCode`) |
| 400 | Validation failure, or a business rule violation (credit limit exceeded, insufficient stock, invalid order-status transition, invoice overpayment) |
| 401 | Missing/invalid/expired JWT, bad login credentials, invalid/expired/reused refresh token |
| 403 | Authenticated but wrong role, or a dealer trying to access another dealer's order/invoice/payment, or a deactivated dealer trying to order |
| 404 | Entity not found |
| 409 | Duplicate unique field (username, email, product code/SKU/barcode, invoice number collision), or delete blocked by existing references |
| 500 | Unexpected server error (logged, never exposes internals to the client) |

---

## 7. Complete API Reference

Legend: 🔓 Public · 🔑 Any authenticated user · 👑 Admin only · 🏪 Dealer only · 👑🏪 Both roles (server scopes results by role internally)

### 7.1 Auth (`/auth`)

#### 🔓 `POST /auth/admin/login`
Body: `{ email: string, password: string (min 6) }`
Success `200`:
```json
{
  "accessToken": "...", "refreshToken": "...",
  "user": { "id": "...", "name": "...", "email": "...", "role": "ADMIN" }
}
```
Failures: `401` invalid credentials · `400` validation.

#### 🔓 `POST /auth/dealer/login`
Body: `{ username: string, password: string (min 6) }`
Success `200`:
```json
{
  "accessToken": "...", "refreshToken": "...",
  "user": { "id": "...", "businessName": "...", "username": "...", "role": "DEALER" }
}
```
Failures: `401` invalid credentials · `401` "Account is inactive" · `400` validation.

#### 🔓 `POST /auth/forgot-password`
Body: `{ identifier: string, role: "ADMIN"|"DEALER" }` (`identifier` = email for admin, username for dealer)
Success `200`: `{ "message": "If the account exists, a reset link has been sent." }` — always this, regardless of existence.
Failures: `400` validation only.

#### 🔓 `POST /auth/reset-password`
Body: `{ token: string, role: "ADMIN"|"DEALER", newPassword: string (min 6) }`
Success `200`: `{ "message": "Password has been reset. You can now log in." }`
Failures: `400` "Invalid or expired reset token" · `400` validation.

#### 🔓 `POST /auth/refresh`
Body: `{ refreshToken: string }`
Success `200`: new `{ accessToken, refreshToken }` pair (old refresh token is now revoked).
Failures: `401` "Invalid or expired refresh token" · `401` "Account no longer exists" / "Account no longer active".

#### 🔓 `POST /auth/logout`
Body: `{ refreshToken: string }`
Success `200`: `{ "message": "Logged out" }` (idempotent — same response even if token was already invalid).

#### 🔑 `GET /auth/me`
No body. Returns the decoded JWT payload: `{ sub, role, email?, username?, iat, exp }`.
Failures: `401` if no/invalid/expired token.

---

### 7.2 Dealers (`/dealers`) — 👑 all routes

#### `POST /dealers`
Body:
```ts
{
  businessName: string, ownerName: string, phone: string,
  email?: string, address?: string, district?: string,
  username: string, password?: string,   // omit to auto-generate a temp password
  creditLimit?: number,                  // default 0
  status?: "ACTIVE"|"INACTIVE"           // default ACTIVE
}
```
Success `201`:
```json
{
  "dealer": { "id": "...", "businessName": "...", "...": "... (no password field, ever)" },
  "temporaryPassword": "6583T8qFvn"   // present ONLY if you didn't supply `password` — show this to the admin once
}
```
Failures: `409` "Username already in use" · `409` "Email already in use" · `400` validation.

#### `GET /dealers?page&limit&search&status`
`search` matches businessName/ownerName/phone/username (case-insensitive contains). `status` filters `ACTIVE`/`INACTIVE`.
Success `200`: paginated list of dealers (no password field).

#### `GET /dealers/:id`
Success `200`: dealer fields (no password) + 
```json
{ "summary": { "totalOrders": 12, "totalInvoices": 9, "lifetimeCompletedValue": "450000" } }
```
Failures: `404` "Dealer not found".

#### `PATCH /dealers/:id`
Body: any subset of the create fields (all optional). Supplying `password` resets it.
Success `200`: updated dealer (no password).
Failures: `404` · `409` (username/email conflict with another dealer) · `400` validation.

#### `PATCH /dealers/:id/status`
Body: `{ "status": "ACTIVE" | "INACTIVE" }`
Success `200`: updated dealer. Failures: `404`.
Note: deactivating a dealer immediately blocks their ability to place new orders (checked at order submission) and blocks login (checked at dealer login).

---

### 7.3 Suppliers (`/suppliers`) — 👑 all routes

#### `POST /suppliers`
Body: `{ name: string, contact?, phone?, email?, address? }` → `201` created supplier.

#### `GET /suppliers?page&limit&search`
`search` matches `name`. → `200` paginated list.

#### `GET /suppliers/:id` → `200` or `404` "Supplier not found".

#### `PATCH /suppliers/:id` — body: any subset of create fields → `200` or `404`.

#### `DELETE /suppliers/:id`
`200`: `{ "message": "Supplier deleted" }`
Failures: `404` · `409` "This supplier has purchase history and cannot be deleted".

---

### 7.4 Products (`/products`)

#### 👑 `POST /products`
Body:
```ts
{
  productCode: string, sku?: string, barcode?: string, name: string,
  brand?: string, category?: string, model?: string, description?: string, imageUrl?: string,
  costPrice: number, wholesalePrice: number, sellingPrice: number,   // all >= 0
  currentStock?: number,   // default 0
  minimumStock?: number,   // default 0
  warranty?: string,
  status?: "ACTIVE"|"INACTIVE"
}
```
Success `201`: created product + `isLowStock: boolean`.
Failures: `409` "Product code, SKU, or barcode already in use" · `400` validation.

#### 👑🏪 `GET /products?page&limit&search&category&status&lowStockOnly`
`search` matches name/productCode/sku/brand. `lowStockOnly=true` restricts to `currentStock <= minimumStock`.
Success `200`: paginated products. **`costPrice` is omitted entirely from every item when the caller is a `DEALER`.**

#### 👑🏪 `GET /products/:id`
Success `200`: product (costPrice omitted for dealers). Failures: `404` "Product not found".

#### 👑 `PATCH /products/:id`
Body: any subset of create fields except `currentStock` (stock is only ever changed via purchases/orders/adjustments, never a direct edit).
Success `200`. Failures: `404` · `409` (code/sku/barcode conflict) · `400` validation.

#### 👑 `PATCH /products/:id/status`
Body: `{ "status": "ACTIVE" | "INACTIVE" }` → `200` or `404`.

#### 👑 `DELETE /products/:id`
`200`: `{ "message": "Product deleted" }`
Failures: `404` · `409` "This product has order or purchase history and cannot be deleted. Deactivate it instead."

---

### 7.5 Inventory (`/inventory`) — 👑 all routes

#### `GET /inventory?page&limit&search`
`search` matches product name/productCode. Success `200`, paginated, each row:
```json
{ "id": "...", "productCode": "...", "name": "...", "currentStock": 47, "minimumStock": 5, "updatedAt": "...", "status": "IN_STOCK" }
```
`status` ∈ `IN_STOCK` / `LOW_STOCK` (`currentStock <= minimumStock`) / `OUT_OF_STOCK` (`currentStock <= 0`).

#### `GET /inventory/:productId/ledger?page&limit`
Success `200`: paginated `InventoryLog` rows for that product, newest first (see §4 InventoryLog for shape).
Failures: `404` "Product not found".

#### `POST /inventory/adjustment`
Body: `{ productId: string (uuid), direction: "IN"|"OUT", quantity: number (>=1), reason?: string }`
Success `200`: the updated product's row.
Failures: `404` product not found · `400` "Insufficient stock for \"<product name>\"" (only for `OUT` that would go negative) · `400` validation.

---

### 7.6 Purchases (`/purchases`) — 👑 all routes

#### `POST /purchases`
Body:
```ts
{
  supplierId: string (uuid), invoiceNumber: string, purchaseDate: string (ISO date),
  items: [ { productId: string (uuid), quantity: number (>=1), unitCost: number (>=0) } ]  // min 1 item
}
```
Success `201`: created purchase with `items[]`, `supplier`, and computed `totalValue`. Also increments stock + writes `PURCHASE` inventory logs for every item (see §5.3).
Failures: `404` (bad supplierId/productId in items, surfaces as FK error → translated) · `400` validation.

#### `GET /purchases?page&limit` → `200` paginated, each with `supplier` + `items[]`.

#### `GET /purchases/:id` → `200` full detail (`supplier`, `items[].product`, `admin` [password omitted]).
Failures: `404` "Purchase not found".

---

### 7.7 Orders (`/orders`)

#### 🏪 `POST /orders`
Body:
```ts
{ items: [ { productId: string (uuid), quantity: number (>=1) } ] }   // min 1 item
```
Success `201`: created order (`status: "PENDING_APPROVAL"`) with `items[].product`, `dealer` (password omitted), `invoice: null`.
Failures:
- `404` dealer not found (shouldn't happen — derived from JWT) / product not found
- `403` "Dealer account is inactive"
- `400` "Product \"X\" is not available" (inactive product)
- `400` "Insufficient stock for \"X\""
- `400` "This order exceeds your available credit limit"
- `400` validation

#### 👑🏪 `GET /orders?page&limit&search&status&dealerId`
Admins see all orders (optionally filtered by `dealerId`, `search` matches orderNumber/dealer businessName); dealers only ever see their own (dealerId filter is ignored/irrelevant for them — server forces it to their own id).
Success `200`: paginated orders with `items[].product`, `dealer`, `invoice`.

#### 👑🏪 `GET /orders/:id`
Success `200`: full order detail.
Failures: `404` · `403` "You do not have access to this order" (dealer requesting someone else's order).

#### 👑 `PATCH /orders/:id/approve`
No body. Success `200`: order now `APPROVED`, with `invoice` populated. See §5.1 step 2 for the full side-effect chain.
Failures: `404` · `400` "Only pending orders can be approved" · `400` "Insufficient stock for \"X\"" (re-validated at approval time).

#### 👑 `PATCH /orders/:id/reject`
Body: `{ "reason": string (min 3 chars) }`
Success `200`: order now `REJECTED` with `rejectReason` set.
Failures: `404` · `400` "Only pending orders can be rejected" · `400` validation.

#### 👑 `PATCH /orders/:id/status`
Body: `{ "status": "PACKED" | "DELIVERED" | "COMPLETED" }`
Success `200`: order with new status + corresponding timestamp stamped (`packedAt`/`deliveredAt`/`completedAt`). On `COMPLETED`, dealer's `outstandingBalance` increases by the invoice's `grandTotal`.
Failures: `404` · `400` "Cannot move order from X to Y. Expected current status Z." (out-of-sequence transition) · `400` validation (bad enum value).

---

### 7.8 Invoices (`/invoices`) — 👑🏪 read-only

#### `GET /invoices?page&limit&search&paymentStatus&dealerId`
Admins see all (optionally filtered); dealers only see their own. `search` matches invoiceNumber.
Success `200`: paginated, each with `order.items[].product`, `dealer` (password omitted), `payments[]`.

#### `GET /invoices/:id`
Success `200`: full detail.
Failures: `404` · `403` "You do not have access to this invoice" (dealer requesting someone else's).

---

### 7.9 Payments (`/payments`)

#### 👑 `POST /payments`
Body: `{ invoiceId: string (uuid), amount: number (>=0.01), mode: "CASH"|"CHEQUE"|"BANK_TRANSFER", reference?: string, paymentDate: string (ISO date) }`
Success `201`: created payment record. See §5.2 for the invoice-status/outstanding-balance side effects.
Failures: `404` invoice not found · `400` "Payment amount exceeds the outstanding invoice balance" · `400` validation.

#### 👑🏪 `GET /payments?page&limit&search&mode&dealerId`
Admins see all; dealers only their own. `search` matches `reference`.
Success `200`: paginated, each with `invoice`, `dealer` (admin view only, password omitted).

#### 👑🏪 `GET /payments/:id`
Success `200`. Failures: `404` · `403` "You do not have access to this payment".

---

### 7.10 Activity Log (`/activity-logs`) — 👑 only

#### `GET /activity-logs?page&limit`
Success `200`: paginated audit trail, each with `admin: { id, name, email }` (no password), newest first. See §4 ActivityLog for the `action` string vocabulary.

---

### 7.11 Dashboard (`/dashboard`)

#### 👑 `GET /dashboard/admin`
Success `200`:
```json
{
  "todaysSales": "39000",
  "todaysOrders": 3,
  "pendingApprovals": 2,
  "lowStockItems": 1,
  "outstandingPayments": "24000",
  "recentOrders": [ /* last 10 orders, with dealer.businessName only */ ],
  "monthlyRevenue": [ { "month": "2026-02", "revenue": "120000" }, "... last 6 months" ],
  "topProducts": [ { "product": { "id", "name", "productCode" }, "quantitySold": 42 }, "... top 5" ]
}
```
`todaysSales`/`todaysOrders` are scoped to completions/creations since local midnight of the server. `topProducts` is computed across all orders that reached at least `APPROVED` (i.e. excludes pending/rejected).

#### 🏪 `GET /dashboard/dealer`
Success `200`:
```json
{
  "outstandingBalance": "24000",
  "creditLimit": "100000",
  "creditRemaining": "76000",
  "pendingOrders": 1,
  "recentOrders": [ /* last 5 */ ],
  "recentInvoices": [ /* last 5 */ ]
}
```

---

## 8. Frontend Integration Checklist

1. **Two login forms**, hitting `/auth/admin/login` vs `/auth/dealer/login` — route to the right dashboard based on the returned `user.role`.
2. **Store both tokens** from login/refresh responses. Attach `accessToken` as `Authorization: Bearer <token>` on every request after login.
3. **Handle 401 globally**: on any `401` from a protected endpoint (except the login endpoints themselves), attempt `POST /auth/refresh` once with the stored refresh token; on success retry the original request with the new access token; on failure (refresh also 401s), force logout and redirect to login.
4. **Never** attempt to reuse a refresh token twice — always overwrite your stored refresh token with the new one returned by `/auth/refresh`.
5. **Render `error.message`** directly for user-facing failure toasts — it's already a clean, human string (or array of strings for form validation — map each to its field if you can correlate by content, otherwise join and show as one toast).
6. **Treat all money fields as strings** coming from the API; format for display, and send plain numbers back in request bodies (DTOs expect `number`, not `string`, on the way in).
7. **Role-gate UI, not just API calls** — e.g. don't render a cost-price column for dealers even though the API already strips it; don't show admin-only nav items to dealers (the API will `403` anyway, but the UX should never let them try).
8. **Pagination** is 1-indexed (`page=1` is the first page) everywhere, uniformly.
9. **Swagger UI** (`/api/docs`) is live and reflects every DTO validation rule in real time — use it to double check exact field names/types if anything here seems ambiguous.
