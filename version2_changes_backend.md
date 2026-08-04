# Electro Mart — Representative Portal v2.1
## Backend Architecture: Representative Operations, Commission & Collections Layer

| | |
|---|---|
| **Document type** | Backend Architecture Specification (companion to `Rep_Portal_DOCUMENTATION.md`) |
| **Scope** | Every backend capability introduced by the v2.1 requirement set — Representative Management, product/banner assignment, commission engine, collections, cheque handling, activity logging, reporting |
| **Status** | Proposal for review — **nothing described here has been implemented** |
| **Companion documents** | `current_backend.md` (as-built reference) · `Rep_Portal_DOCUMENTATION.md` (v1 architecture, of which this is an additive extension) · `additional_requirement_changes_rep_portal.md` (the Representative Portal frontend's requirements against this backend) |
| **Constraint** | Identical to v1: **100% additive.** This is a live production ERP. Every guarantee in `Rep_Portal_DOCUMENTATION.md`'s "Non-Negotiable Production Safety Guarantees" and §3 Guiding Principles applies unchanged here — this document does not restate them in full, it holds itself to them and calls out, per feature, exactly how. |

---

## 0. How to read this document

Section 1 gives the full additive schema in one place (so it can be reviewed as a single diff). Section 2
covers the one genuinely hard architectural problem this requirement set raises — how commission and
collections touch money without touching the financial pipeline — and the decision made about it, because
every later section depends on that decision. Sections 3–17 then cover each requirement block from the v2.1
brief, **in the same order it was given**, each with all eleven of the dimensions requested: Business Flow,
UI Flow, Database Design, Backend Architecture, API Endpoints, Permission Model, Admin Screens,
Representative Screens, Notification Flow, Security Considerations, and Compatibility Justification. Section
18 consolidates every endpoint and every permission into two reference tables. Section 19 is the migration
plan. Section 20 is the exhaustive, subsystem-by-subsystem safety audit the brief requires.

---

## 1. Full Additive Schema (single reference)

Every model below is **new**. Every field added to an **existing** table is nullable/defaulted, called out
explicitly where it happens. Nothing here renames, retypes, or removes anything that exists today, and
nothing here touches `Order`, `OrderItem`, `Invoice`, or `Payment`'s existing columns.

```prisma
// ---- New enums ----

enum RepresentativeStatus {      // NEW — see §3.3 for why this is its own enum, not a reuse of AccountStatus
  ACTIVE
  SUSPENDED
  BLOCKED
  INACTIVE
}

enum AssignmentScopeType {       // NEW
  CATEGORY
  PRODUCT
  BRAND
  CAMPAIGN
}

enum CommissionType {            // NEW
  PERCENTAGE
  FIXED
}

enum CommissionLineStatus {      // NEW
  PENDING
  APPROVED
  SETTLED
  REVERSED
}

enum SettlementStatus {          // NEW
  PENDING
  APPROVED
  REJECTED
  PAID
}

enum CollectionStatus {          // NEW
  PENDING_VERIFICATION
  CONFIRMED
  REJECTED
}

// ---- Representative (revises the not-yet-built v1 draft of this table — see §3.3) ----

model Representative {
  id                  String               @id @default(uuid())
  name                String
  phone               String
  email               String               @unique   // also the login username, per §4
  username            String               @unique
  password            String
  nicOrEmployeeId     String?              @unique
  address             String?
  joiningDate         DateTime?
  status              RepresentativeStatus @default(ACTIVE)
  mustChangePassword  Boolean              @default(true)
  lastLoginAt         DateTime?
  failedLoginAttempts Int                  @default(0)
  lockedUntil         DateTime?
  resetToken          String?              @unique
  resetTokenExpiry    DateTime?
  createdAt           DateTime             @default(now())
  updatedAt           DateTime             @updatedAt

  customersCreated    Dealer[]                    @relation("DealerCreatedByRep")
  ordersCreated       Order[]                     @relation("OrderCreatedByRep")
  loginHistory        RepresentativeLoginHistory[]
  activityLog         RepresentativeActivityLog[]
  productAssignments  ProductAssignment[]
  bannerAssignments   BannerAssignment[]
  commissionLedger    CommissionLedgerEntry[]
  settlements         RepresentativeSettlement[]
  collectionSubmissions CollectionSubmission[]

  @@index([status])
}

// ---- Login & activity audit (§6, §11) ----

model RepresentativeLoginHistory {
  id               String    @id @default(uuid())
  representativeId String
  representative   Representative @relation(fields: [representativeId], references: [id])
  loginAt          DateTime  @default(now())
  ipAddress        String?
  userAgent        String?
  success          Boolean
  failureReason    String?

  @@index([representativeId])
}

model RepresentativeActivityLog {
  id               String    @id @default(uuid())
  representativeId String
  representative   Representative @relation(fields: [representativeId], references: [id])
  action           String
  targetId         String?
  details          String?
  ipAddress        String?
  userAgent        String?
  deviceType       String?
  createdAt        DateTime  @default(now())

  @@index([representativeId])
  @@index([action])
}

// ---- Product & banner assignment (§7, §8) ----

model ProductAssignment {
  id               String              @id @default(uuid())
  representativeId String
  representative   Representative      @relation(fields: [representativeId], references: [id])
  scopeType        AssignmentScopeType
  // productId / category name / brand name / campaign key, depending on scopeType — denormalized on
  // purpose, mirroring the existing Product.category / Product.brand text-field convention rather than
  // four separate nullable FK columns for a value that is only ever exactly one type at a time.
  scopeValue       String
  createdAt        DateTime            @default(now())

  @@unique([representativeId, scopeType, scopeValue])
  @@index([representativeId])
}

model BannerAssignment {
  id               String    @id @default(uuid())
  representativeId String
  representative   Representative @relation(fields: [representativeId], references: [id])
  bannerId         String
  banner           Banner    @relation(fields: [bannerId], references: [id])
  priority         Int       @default(0)
  startsAt         DateTime?
  expiresAt        DateTime?
  createdAt        DateTime  @default(now())

  @@unique([representativeId, bannerId])
  @@index([representativeId])
}

// ---- Inventory visibility override (§9) ----

model ProductAvailabilityOverride {
  productId      String   @id
  product        Product  @relation(fields: [productId], references: [id])
  // true  = show "In Stock" to reps even if currentStock <= 0
  // false = show "Out of Stock" to reps even if currentStock > 0 (quality hold, reserved batch, etc.)
  // absent (no row) = fall back to the real currentStock > 0 check, exactly like today
  forceAvailable Boolean
  reason         String?
  setByAdminId   String
  updatedAt      DateTime @updatedAt
}

// ---- Commission engine (§10, §12) ----

model CommissionRule {
  id                String           @id @default(uuid())
  productId         String
  product           Product          @relation(fields: [productId], references: [id])
  type              CommissionType
  // Percentage (0-100) or a fixed currency amount, depending on `type` — same
  // Decimal-typed-by-meaning pattern Order/Invoice already use throughout.
  value             Decimal
  startDate         DateTime
  endDate           DateTime?
  isCampaign        Boolean          @default(false)
  campaignName      String?
  createdByAdminId  String
  createdAt         DateTime         @default(now())

  ledgerEntries     CommissionLedgerEntry[]

  @@index([productId])
  @@index([startDate, endDate])
}

model CommissionLedgerEntry {
  id                String               @id @default(uuid())
  representativeId  String
  representative    Representative       @relation(fields: [representativeId], references: [id])
  orderId           String
  order             Order                @relation(fields: [orderId], references: [id])
  orderItemId       String
  productId         String
  commissionRuleId  String?
  commissionRule    CommissionRule?      @relation(fields: [commissionRuleId], references: [id])
  amount            Decimal
  status            CommissionLineStatus @default(PENDING)
  settlementId      String?
  settlement        RepresentativeSettlement? @relation(fields: [settlementId], references: [id])
  createdAt         DateTime             @default(now())

  @@index([representativeId])
  @@index([orderId])
  @@index([status])
}

// ---- Settlements — the payout, and its one and only bridge into accounting (§13, §14) ----

model RepresentativeSettlement {
  id                String            @id @default(uuid())
  settlementNumber  String            @unique
  representativeId  String
  representative    Representative    @relation(fields: [representativeId], references: [id])
  periodStart       DateTime
  periodEnd         DateTime
  totalCommission   Decimal
  status            SettlementStatus  @default(PENDING)
  mode              PaymentMode?      // reused existing enum — set once approved & a payment mode is chosen
  chequeStatus      ChequeStatus?     // reused existing enum — cheque-mode settlements only
  chequeNumber      String?
  bankName          String?
  chequeDate        DateTime?
  // The ONE link into the existing accounting engine — see §14. Nullable until paid; once set, points at
  // a real Expense row created through the existing, untouched Expense-creation path.
  expenseId         String?           @unique
  expense           Expense?          @relation(fields: [expenseId], references: [id])
  approvedByAdminId String?
  approvedAt        DateTime?
  rejectedReason    String?
  paidAt            DateTime?
  createdAt         DateTime          @default(now())

  lines             CommissionLedgerEntry[]
}

// ---- Collections — a staging inbox, never a direct financial write (§15) ----

model CollectionSubmission {
  id                  String            @id @default(uuid())
  representativeId    String
  representative      Representative    @relation(fields: [representativeId], references: [id])
  customerId          String
  customer            Dealer            @relation(fields: [customerId], references: [id])
  invoiceId           String?
  invoice             Invoice?          @relation(fields: [invoiceId], references: [id])
  amount              Decimal
  mode                PaymentMode       // reused existing enum
  chequeNumber        String?
  bankName            String?
  chequeDate          DateTime?
  collectionDate      DateTime
  notes               String?
  chequeImageUrl      String?           // future-ready, per the brief — nullable, unused today
  status              CollectionStatus  @default(PENDING_VERIFICATION)
  verifiedByAdminId   String?
  verifiedAt          DateTime?
  rejectedReason      String?
  // Set only once an admin confirms — points at the real Payment row created through the existing,
  // untouched PaymentsService.create(). Never set by the representative-facing submission itself.
  resultingPaymentId  String?           @unique
  resultingPayment    Payment?          @relation(fields: [resultingPaymentId], references: [id])
  createdAt           DateTime          @default(now())

  @@index([representativeId])
  @@index([customerId])
  @@index([status])
}

// ---- Collection reminders (§16) ----

model CollectionReminderLog {
  id           String   @id @default(uuid())
  orderId      String
  order        Order    @relation(fields: [orderId], references: [id])
  sentAt       DateTime @default(now())
  daysOverdue  Int

  @@index([orderId])
}
```

### 1.1 New nullable reverse relations on existing tables

Each of these is a **reverse relation field only** — Prisma requires the "many" side to declare a field
pointing back, but the foreign key itself lives entirely on the new table (`representativeId`, `productId`,
`orderId`, etc., all already shown above). No new *column* is added to `Dealer`, `Order`, `Invoice`,
`Payment`, `Product`, `Banner`, or `Expense` by this — these are Prisma-level relation declarations with zero
SQL-level footprint beyond what's already listed in the tables above.

| Existing model | New reverse relation field |
|---|---|
| `Dealer` | `collectionSubmissions CollectionSubmission[]` |
| `Order` | `commissionEntries CommissionLedgerEntry[]`, `collectionReminders CollectionReminderLog[]` |
| `Invoice` | `collectionSubmissions CollectionSubmission[]` |
| `Payment` | `collectionSubmission CollectionSubmission?` |
| `Product` | `commissionRules CommissionRule[]`, `availabilityOverride ProductAvailabilityOverride?` |
| `Banner` | `assignments BannerAssignment[]` |
| `Expense` | `representativeSettlement RepresentativeSettlement?` |

---

## 2. The one hard problem: commission without touching the order pipeline

Every other v2.1 capability is either a new standalone table or a genuinely new, standalone code path. This
one isn't, and it deserves to be argued explicitly rather than asserted.

**The problem.** A representative earns commission on an order once it's real — i.e. once an admin approves
it. `Rep_Portal_DOCUMENTATION.md`'s Appendix B states, as a hard compatibility guarantee: *"`OrdersService`
(approve/reject/status/complete/update/remove) — Not touched at all."* Computing commission "on approval"
sounds like it needs one more line inside `applyApproval()` — and that one line would break that guarantee.

**Option A — inline hook inside `applyApproval()`.** Rejected. Even a single additive line inside the one
function every order of every channel (dealer, admin-direct, and now rep) flows through is a change to
shared, highest-scrutiny code — exactly the risk category both this brief and the standing v1 guarantee
exist to prevent. A bug in a commission calculation could, in principle, throw inside the same transaction
that reserves stock and generates the invoice for *every* order in the system, not just rep orders.

**Option B (chosen) — scheduled reconciliation, entirely outside the order pipeline.** A new, independent
job (`CommissionReconciliationService`, using the same `@nestjs/schedule` `@Cron` mechanism the codebase
already relies on for `AuthService.cleanupExpiredRefreshTokens` and `CreditsService.sendChequeDepositReminders`)
runs on a short interval — proposed every 5 minutes — and does exactly one thing: find every `Order` where
`createdByRepId IS NOT NULL AND status IN (APPROVED, PACKED, DELIVERED, COMPLETED)` that has no
`CommissionLedgerEntry` rows yet, and create them by reading the order's already-final `OrderItem` rows and
matching `CommissionRule`s. It only ever **reads** `Order`/`OrderItem` and **writes** to the brand-new
`CommissionLedgerEntry` table. It cannot affect stock, invoicing, credit checks, or anything else in the
order pipeline, because it never calls into `OrdersService` at all — it queries the same rows that service
already wrote, after the fact.

**The trade-off, stated plainly.** Commission ledger entries lag order approval by up to the polling
interval (a few minutes), not instant. This is the deliberate cost of the stronger guarantee: `OrdersService`
gains **zero** new lines, in exchange for commission being *eventually* — not *immediately* — consistent.
For a representative's own earnings dashboard and an admin's settlement workflow, a several-minute lag
between "order approved" and "commission line appears" is immaterial; for the order pipeline's financial
integrity, "genuinely never touched" is not a trade worth making for a few minutes of latency.

**Reversal on returns.** If a `SalesReturn` is later recorded against a commissioned order, the same
reconciliation job also checks for `CommissionLedgerEntry` rows whose orders now have returns and marks the
affected lines `REVERSED` (excluded from future settlements). This, too, only reads `SalesReturn` (already
untouched per v1) and writes to the new ledger table — never the reverse.

---

## 3. Representative Management Module (Admin Panel)

### 3.1 Business Flow
Representatives are Electro Mart staff, onboarded and managed exclusively by an Admin — mirroring exactly
how Dealers are managed today (`current_backend.md`'s Dealer Management), with a richer detail/analytics
surface reflecting that a rep is an ongoing operational relationship (sales, commission, collections), not
just a login.

### 3.2 UI Flow (Admin Panel — new top-level nav item, "Representatives", peer to "Dealers")
`Representative List` → (search/filter by status) → `Representative Detail` (tabs: **Overview**, **Assigned
Products**, **Assigned Banners**, **Assigned Customers**, **Sales Statistics**, **Commission Statistics**,
**Settlement History**, **Login History**, **Activity History**) → row-level actions: **Edit**, **Suspend**,
**Activate**, **Block**, **Reset Password**.

### 3.3 Database Design
`Representative` (§1) — carries the full profile. Note two refinements over the `Representative` table
`Rep_Portal_DOCUMENTATION.md` (v1, not yet built) sketched: **(a)** `status` is now a dedicated
`RepresentativeStatus` enum (`ACTIVE/SUSPENDED/BLOCKED/INACTIVE`) rather than the shared `AccountStatus`
(`ACTIVE/INACTIVE`) that `Dealer` and `Product` already use — a suspended-vs-blocked distinction makes sense
for staff accounts and makes no sense for a dealer or a product, so stretching the shared enum to cover it
would leak Representative-specific semantics into two unrelated tables' type. **(b)** `email` is now the
unique login identifier (§4), not a separate optional field. Both are refinements to a table that has not
been implemented yet, so revising them here carries **zero migration risk** — there is no existing
`Representative` row anywhere to reinterpret.

### 3.4 Backend Architecture
New `RepresentativesModule` (`src/representatives/`), structured identically to the existing
`DealersModule` — `RepresentativesController`, `RepresentativesService`, DTOs — plus five small,
purpose-built read services backing the detail tabs: `RepAssignmentsService` (§7/§8), `RepSalesStatsService`
(reads `Order` filtered by `createdByRepId`, no new tables), `RepCommissionStatsService` (reads
`CommissionLedgerEntry`/`RepresentativeSettlement`), `RepLoginHistoryService`, `RepActivityLogService`. Every
one of these is read-only against tables this document defines; none of them touch `OrdersService`,
`DealersService`, or any other existing service.

### 3.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/representatives` | POST | Admin |
| `/representatives` | GET | Admin |
| `/representatives/:id` | GET | Admin |
| `/representatives/:id` | PATCH | Admin |
| `/representatives/:id/status` | PATCH `{status}` | Admin |
| `/representatives/:id/reset-password` | POST | Admin |
| `/representatives/:id/login-history` | GET | Admin |
| `/representatives/:id/activity-log` | GET | Admin |
| `/representatives/:id/sales-stats` | GET | Admin |
| `/representatives/:id/commission-stats` | GET | Admin |
| `/representatives/:id/settlements` | GET | Admin |
| `/representatives/:id/assigned-products` | GET | Admin |
| `/representatives/:id/assigned-banners` | GET | Admin |
| `/representatives/:id/assigned-customers` | GET | Admin — derived: `Dealer` where `createdByRepId = :id` (v1 §23.2 field, no new join needed) |

### 3.6 Permission Model
Every route above is `Role.ADMIN`-only, enforced by the existing `RolesGuard`/`@Roles()` mechanism — no new
guard logic. `Role.REPRESENTATIVE` never appears on any route in this module: **representatives have no
administrative capability of any kind**, by construction (the module simply never grants that role access,
the same design already used for every admin-only module in `current_backend.md`).

### 3.7 Admin Screens
Representative List, Representative Detail (7 tabs above), Create/Edit Representative form, Suspend/Block/
Activate confirmation dialogs, Reset Password confirmation dialog (mirrors the existing Dealer reset-password
UX exactly).

### 3.8 Representative Screens
None — this entire module is Admin-only.

### 3.9 Notification Flow
Status changes (Suspend/Block/Activate) trigger an email to the representative informing them of the change
(new `MailerService.notifyRepStatusChanged()` method — additive, same pattern as every existing
`notify*` method).

### 3.10 Security Considerations
Identical posture to `DealersController` today: JWT + `RolesGuard`, admin-only. Every mutating action is
written through `ActivityLogService.log()` (admin-authored, using the existing, unmodified admin activity
log) so there is a full audit trail of which admin suspended/blocked/edited which representative.

### 3.11 Compatibility Justification
This entire module operates on tables that do not exist in production today (`Representative` and its
satellites). It has no code path that reads, writes, or joins against `Dealer`, `Order`, `Invoice`, or
`Payment` except pure `SELECT`s already covered by v1's compatibility audit (`Order.createdByRepId`,
`Dealer.createdByRepId`). **Zero production data loss, zero historical data touched, zero existing table
column changed** — this is a pure net-new admin module, structurally identical in risk to the existing
Dealer Management module it mirrors.

---

## 4. Representative Account Creation

### 4.1 Business Flow
Admin fills in a form; the system provisions the account and emails the representative their credentials —
exactly mirroring `DealersService.create()`'s existing "auto-generate a temp password, email it" flow
(`current_backend.md`), extended with a mandatory first-login password change.

### 4.2 UI Flow
Admin Panel → Representatives → **+ New Representative** → form (Full Name, Mobile Number, Email, Address,
NIC/Employee ID, Joining Date, Status) → **Create** → success toast showing the generated username (=
email) and a one-time-visible temporary password (mirrors the existing `CreateDealerDto`/`temporaryPassword`
response pattern) → welcome email sent automatically.

### 4.3 Database Design
No new tables beyond `Representative` (§1). `username` is set equal to `email` at creation time (both
`@unique`); `mustChangePassword` defaults `true`.

### 4.4 Backend Architecture
`RepresentativesService.create()` — copy of `DealersService.create()`'s structure verbatim: uniqueness
checks (email, username, NIC), `generateTempPassword()` (existing utility, `src/common/utils/generate-password.ts`,
reused as-is), `bcrypt.hash()` (existing pattern, same salt rounds constant already used for
Admin/Dealer), wrapped in a transaction with an `ActivityLogService.log()` call, then
`MailerService.notifyRepWelcome()` fired after commit.

### 4.5 API Endpoints
`POST /representatives` (§3.5) — request/response shape:
```jsonc
// Request
{ "name": "...", "phone": "...", "email": "...", "address": "...", "nicOrEmployeeId": "...", "joiningDate": "...", "status": "ACTIVE" }
// Response
{ "representative": { ...omit password... }, "temporaryPassword": "Xk9#mQ2p" }
```

### 4.6 Permission Model
Admin only — identical to `POST /dealers` today.

### 4.7 Admin Screens
Create Representative form (§4.2).

### 4.8 Representative Screens
None at creation time — the representative's first screen is the login page, using the emailed credentials.

### 4.9 Notification Flow
`MailerService.notifyRepWelcome(email, name, username, temporaryPassword)` — new method, same
`send()`-wrapped, SMTP-optional-degrades-to-log pattern every existing mailer method already uses. Content,
per the brief:

> Congratulations. You have been appointed as an Official Sales Representative of Electro Mart.
> Login URL · Username · Temporary Password · Instructions to change password · Support contact · Security notice.

### 4.10 Security Considerations
Temporary passwords are bcrypt-hashed before storage (never stored or logged in plaintext) — identical
guarantee to the existing dealer temp-password flow. `mustChangePassword: true` is enforced server-side
(§5), not merely suggested client-side, so a rep cannot skip the forced change by ignoring a UI prompt.

### 4.11 Compatibility Justification
Additive `Representative` row creation only. No existing table is written to. Mirrors, field-for-field, a
creation flow (`DealersService.create()`) that has been in safe production use already — **this is the
lowest-risk possible way to introduce a new actor type**, because the pattern is proven, not novel.

---

## 5. Login & Password Management

### 5.1 Business Flow
A representative logs in with their email (as username) and password. First login forces a password change.
Forgot-password works via email reset link, exactly like Admin/Dealer today; an Admin can also force-reset,
suspend, block, or unlock an account directly.

### 5.2 UI Flow
Representative Portal: `/login` (already built, §"electromart_rep" — extended to redirect to a **mandatory
change-password screen** when `mustChangePassword` is true in the login response, before reaching `/rep/home`)
→ `/forgot-password` (already built) → email link → `/reset-password` (already built).
Admin Panel: Representative Detail → **Reset Password** / **Force Password Change** / **Suspend** /
**Block** / **Unlock** actions, and read-only **Last Login** / **Failed Login Attempts** fields.

### 5.3 Database Design
`Representative.mustChangePassword`, `.failedLoginAttempts`, `.lockedUntil`, `.lastLoginAt` (§1).
`RepresentativeLoginHistory` (§1) — one row per attempt, success or failure.
**"Active sessions" (flagged future-ready in the brief) needs no new table at all** — the existing
`RefreshToken` table (`current_backend.md` §3) is already generic over `{role, userId}` with
`expiresAt`/`revokedAt`; a representative's active sessions are simply their non-revoked, non-expired
`RefreshToken` rows. This is a pure read against an existing, untouched table.

### 5.4 Backend Architecture
`AuthService.repLogin()` (new method, alongside the existing `adminLogin()`/`dealerLogin()` — none of which
are modified): validates credentials with the same timing-attack-safe `DUMMY_PASSWORD_HASH` comparison
pattern already used for every login path; on failure, increments `failedLoginAttempts` and, past a
threshold (proposed: 5), sets `lockedUntil` (a rolling lockout window — not a permanent block, distinct from
the admin-driven `BLOCKED` status); on success, resets the counter, stamps `lastLoginAt`, writes a
`RepresentativeLoginHistory` row, and returns `mustChangePassword` in the response so the frontend can route
to the forced-change screen. `forgotPassword`/`resetPassword` gain a third branch for `Role.REPRESENTATIVE`
— the existing two branches (`ADMIN`, else-`DEALER`) are restructured into a switch/lookup rather than
modified in behavior (§ compatibility below).

### 5.5 API Endpoints
| Route | Method | Notes |
|---|---|---|
| `/auth/rep-login` | POST | `{ username, password }` → `{ accessToken, refreshToken, user, mustChangePassword }` |
| `/auth/change-password` | POST | Authenticated as `REPRESENTATIVE` — `{ currentPassword, newPassword }`, clears `mustChangePassword` |
| `/auth/forgot-password` | POST | existing route, third `role` branch |
| `/auth/reset-password` | POST | existing route, third `role` branch |
| `/representatives/:id/force-password-change` | POST | Admin — sets `mustChangePassword = true` |
| `/representatives/:id/unlock` | POST | Admin — clears `failedLoginAttempts`/`lockedUntil` |

### 5.6 Permission Model
`rep-login`/`change-password` reachable only as `REPRESENTATIVE`. Force-change/unlock/reset are Admin-only.
A `SUSPENDED` or `BLOCKED` representative fails login with a clear message, checked the same place
`dealerLogin()` already checks `dealer.status !== ACTIVE` today — a direct structural copy, not a new
mechanism.

### 5.7 Admin Screens
Representative Detail's login/security panel: Last Login, Failed Attempts, Locked-Until, and the four
action buttons above.

### 5.8 Representative Screens
Login, Forced Change Password (new, one-time), Forgot/Reset Password (existing, extended with the third
role branch).

### 5.9 Notification Flow
Password changed (self or admin-forced) → confirmation email, reusing the existing
`notifyDealerPasswordReset`-style pattern (`notifyRepPasswordReset`, new method). Account
suspended/blocked/unlocked → status-change email (§3.9).

### 5.10 Security Considerations
Rolling lockout after repeated failed attempts (new, rep-specific — Admin/Dealer login is unaffected).
`JwtStrategy.validate()` gains a `REPRESENTATIVE` branch re-checking live status on every request — the
exact mechanism already in place for `DEALER` (`current_backend.md` §3), extended by one more `if` branch,
not modified for the existing role. A `SUSPENDED`/`BLOCKED` rep's already-issued access token is invalidated
within one request, same guarantee dealers already have.

### 5.11 Compatibility Justification
`AuthService.adminLogin()` and `AuthService.dealerLogin()` are **not modified** — `repLogin()` is a new,
parallel method. The `forgotPassword`/`resetPassword` methods' existing two branches keep their exact
current behavior; a third branch is added alongside them. `JwtStrategy.validate()`'s existing `DEALER` check
is untouched; a new, independent `REPRESENTATIVE` check is added beside it. **Zero risk to Admin or Dealer
authentication**, provable by inspection: neither of their code paths gains a single new line.

---

## 6. Product Assignment

### 6.1 Business Flow
A representative's catalog is opt-in, not everything by default. Admin assigns visibility by category,
individual product, brand, or campaign; removing an assignment removes the product from that rep's catalog
immediately.

### 6.2 UI Flow
Admin: Representative Detail → **Assigned Products** tab → toggle whole categories/brands on, or search and
add individual products/campaign tags → save (each toggle is its own `ProductAssignment` row, added/removed
independently — no batch "save" transaction needed, mirroring how the existing Dealer credit-limit field is
a simple field-level PATCH).
Representative: the existing `/rep/catalog`, `/rep/home`, `/rep/search` screens (built in
`electromart_rep`) — unchanged in layout, their underlying product query is now scoped (§6.4).

### 6.3 Database Design
`ProductAssignment` (§1) — one row per `(representative, scopeType, scopeValue)` grant.

### 6.4 Backend Architecture
A single new query helper, `RepAssignmentsService.visibleProductWhereClause(representativeId)`, builds a
`Prisma.ProductWhereInput` from that rep's `ProductAssignment` rows (`OR` across matching `category`/
`brand`/`id`/campaign-tag values). This helper is **called from the Rep Portal's own catalog endpoints**
(`/rep-portal/products`-equivalent read paths already scoped to `Role.REPRESENTATIVE` per
`Rep_Portal_DOCUMENTATION.md` §5.3/§24.6) — it is an additional `AND` condition layered onto the existing
`ProductsService.findAll()` query shape, reached only via the rep-facing route, never via the Admin's or
Dealer's existing `GET /products` call, whose behavior is completely unchanged.

### 6.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/representatives/:id/assigned-products` | GET | Admin |
| `/representatives/:id/assigned-products` | POST `{scopeType, scopeValue}` | Admin |
| `/representatives/:id/assigned-products/:assignmentId` | DELETE | Admin |

(The representative-facing catalog reads are the *existing* Rep Portal endpoints — no new route for the rep
side, only a scoping change to what those existing reads return, per rep.)

### 6.6 Permission Model
Assignment CRUD is Admin-only. A representative can only ever read their own assigned scope — enforced
server-side by deriving the scope from the authenticated `REPRESENTATIVE` JWT's `sub`, never from a
client-supplied representative id.

### 6.7 Admin Screens
Assigned Products tab (category/brand toggles + individual product/campaign search-and-add), per §6.2.

### 6.8 Representative Screens
No new screens — the existing catalog/home/search screens simply show a scoped result set.

### 6.9 Notification Flow
None required — this is a silent, real-time visibility change (assignment removed → product "disappears
immediately" per the brief, which the existing query-per-request model already guarantees with no caching
layer to invalidate).

### 6.10 Security Considerations
Scope is enforced at the query layer on every read, not filtered client-side — a rep's app never even
receives an unassigned product's data, closing the "hide it in the UI but it's still in the API response"
class of leak.

### 6.11 Compatibility Justification
`ProductsService`, `ProductsController`, and every Admin/Dealer product read are **untouched** — the scoping
`AND` clause is added only inside the Rep Portal's own, already-separate read path (v1 §5.3). `Product`
itself gains no new column. **Zero risk to existing product data or to the Admin/Dealer catalog experience.**

---

## 7. Banner Assignment

### 7.1 Business Flow
Homepage banners (v1 §10, `Banner` table) can be targeted per representative, with scheduling and priority —
two reps can see entirely different homepages.

### 7.2 UI Flow
Admin: Banner Manager (v1 §10.1) gains an **"Assign to Representatives"** action per banner → multi-select
reps, set priority/schedule per assignment.
Representative: `/rep/home`'s existing banner slider (already built) — unchanged in code, now fed a
rep-scoped list.

### 7.3 Database Design
`BannerAssignment` (§1) — join table with `priority`/`startsAt`/`expiresAt`.

### 7.4 Backend Architecture
`GET /rep-portal/home`'s banner section (v1 §24.6) is extended: if the requesting rep has **any**
`BannerAssignment` rows, return exactly those (schedule/priority-filtered, i.e. `startsAt <= now <= expiresAt`
where set); if they have **none**, fall back to the existing global `Banner.status = ACTIVE` list (v1 §10) —
so a rep with no explicit assignment sees the same default homepage the feature shipped with, and nothing
about the existing global-banner behavior changes for a rep who has never been individually targeted.

### 7.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/banners/:id/assignments` | GET | Admin |
| `/banners/:id/assignments` | POST `{representativeId, priority?, startsAt?, expiresAt?}` | Admin |
| `/banners/:id/assignments/:assignmentId` | DELETE | Admin |

### 7.6 Permission Model
Admin-only CRUD; representatives only ever receive their own resolved banner list via the existing
`/rep-portal/home` read, never a raw assignment list.

### 7.7 Admin Screens
Banner Manager's new per-banner assignment panel (§7.2).

### 7.8 Representative Screens
None new — same homepage banner slider, differently scoped.

### 7.9 Notification Flow
None required.

### 7.10 Security Considerations
None beyond standard admin-only write access — banners carry no sensitive data.

### 7.11 Compatibility Justification
`Banner` gains a reverse relation only (§1.1), no new column. The existing global-banner fallback behavior
(v1 §10) is preserved exactly for any rep with no assignments. **Zero risk** — this is presentation-layer
targeting on top of an already-additive, not-yet-built v1 table.

---

## 8. Representative Inventory Visibility

### 8.1 Business Flow
A representative must never see or infer the real warehouse quantity — only a binary **In Stock / Out of
Stock** signal, which an admin can override in either direction independent of the true count (e.g. force
"Available" while `currentStock = 0` because a fresh purchase is confirmed in transit; or force "Out of
Stock" on a batch under quality hold despite `currentStock > 0`).

### 8.2 UI Flow
Representative: every existing stock badge in `electromart_rep` (`StockStatusBadge`, already built) —
unchanged in code, fed a resolved boolean instead of a raw comparison.
Admin: Product edit screen gains an **Availability Override** field (radio: *Use actual stock* / *Force
Available* / *Force Unavailable*, with an optional reason note) — a new, small panel on the existing product
form, not a new screen.

### 8.3 Database Design
`ProductAvailabilityOverride` (§1) — a single-row-per-product satellite, absent by default (i.e. "use real
stock," today's exact behavior).

### 8.4 Backend Architecture
A single pure function, `resolveRepVisibleAvailability(product, override)`:
```ts
function resolveRepVisibleAvailability(currentStock: number, override?: { forceAvailable: boolean }): 'IN_STOCK' | 'OUT_OF_STOCK' {
  if (override) return override.forceAvailable ? 'IN_STOCK' : 'OUT_OF_STOCK';
  return currentStock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
}
```
Called **only** from the Rep Portal's product-serialization path (the same place `costPrice` is already
stripped for reps per v1 §5.3) — it replaces `currentStock` in the rep-facing response with this resolved
label and **never includes the numeric `currentStock` field at all** in any Rep Portal API response. The
Admin's and Dealer's product responses are untouched and continue to include the real `currentStock` exactly
as today.

### 8.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/products/:id/availability-override` | PUT `{forceAvailable, reason}` | Admin |
| `/products/:id/availability-override` | DELETE (revert to real stock) | Admin |

Representative-facing catalog/search/home endpoints are the existing ones (§6.4) — their response shape
gains a `stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK'` field and **omits** `currentStock`/`isOutOfStock`'s
numeric basis entirely for that role.

### 8.6 Permission Model
Override CRUD is Admin-only. This is enforced not just by the write route being Admin-gated, but by the
read side never emitting the raw number to a `REPRESENTATIVE`-scoped response in the first place — the
strongest form of the guarantee, since there's no client-side value to reverse-engineer from.

### 8.7 Admin Screens
Product edit form's new Availability Override panel (§8.2).

### 8.8 Representative Screens
None new — existing stock badges, now driven by the resolved label.

### 8.9 Notification Flow
None required.

### 8.10 Security Considerations
This is fundamentally an information-hiding requirement, not a data-integrity one — satisfied by never
serializing the sensitive field into the rep-facing response, rather than by hiding it in the frontend
(the same "server strips it, not the client" principle already used for `costPrice`, v1 §5.3).

### 8.11 Compatibility Justification
`Product.currentStock` itself is **never modified, renamed, or reinterpreted** — the override is a display
layer sitting entirely in front of it for one specific role's responses. Every existing stock-driven
calculation — `InventoryService.recordMovement()`'s atomic guard, `assertWithinCreditLimit`, order creation's
stock check — reads the real `currentStock` exactly as it does today, untouched. **The override affects what
a representative sees; it never affects what stock actually reserves, sells, or reports as.**

---

## 9. Commission Management (Engine)

### 9.1 Business Flow
Admin defines commission rules per product — percentage or fixed amount — optionally scoped to a date range
and/or flagged as a time-boxed campaign rate that supersedes the standing/default rate while active.

### 9.2 UI Flow
Admin: Product edit screen → **Commission** tab → list of `CommissionRule` rows for this product (add/edit/
end-date a rule) — the standing/default rule has no `endDate`; a campaign rule has both `isCampaign: true`
and a bounded `startDate`/`endDate` and is preferred over the default whenever both are active for the same
date (highest-priority match wins, resolved in the reconciliation job, §2).

### 9.3 Database Design
`CommissionRule` (§1).

### 9.4 Backend Architecture
`CommissionRulesService` (new, `src/commission/`) — plain CRUD, no interaction with the order pipeline at
all. Rule resolution (which rule applies to a given commissioned order line) happens exclusively inside the
reconciliation job described in §2, at read/compute time — never inside `OrdersService`.

### 9.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/products/:id/commission-rules` | GET | Admin |
| `/products/:id/commission-rules` | POST | Admin |
| `/products/:id/commission-rules/:ruleId` | PATCH | Admin |
| `/products/:id/commission-rules/:ruleId` | DELETE | Admin (blocked if any `CommissionLedgerEntry` already references it — same "can't delete what's referenced" guard pattern `SuppliersService`/`ProductsService` already use) |

### 9.6 Permission Model
Admin-only, full stop — commission economics are never visible or editable by a representative beyond their
own resolved earnings (§10).

### 9.7 Admin Screens
Product edit → Commission tab (§9.2); also surfaced read-only inside the Commission Dashboard (§13).

### 9.8 Representative Screens
None — reps see only *resolved* commission amounts on their own orders (§10), never the underlying rule
table.

### 9.9 Notification Flow
None required for rule changes themselves.

### 9.10 Security Considerations
Standard admin-only write; no representative-facing endpoint ever exposes another product's commission
economics.

### 9.11 Compatibility Justification
`Product` gains a reverse relation only (§1.1). No existing pricing, discount, or order-total calculation
reads `CommissionRule` — commission is computed entirely out-of-band (§2) and never feeds back into
`OrderItem.unitPrice`, `Order.totalAmount`, or anything a customer's invoice reflects. **The customer-facing
price of a product is completely unaffected by its commission configuration.**

---

## 10. Representative Earnings Dashboard

### 10.1 Business Flow
A representative has a private "My Earnings" view of their own sales and commission performance — never
visible to a customer (customers have no login at all, per v1, so this is moot by construction, but stated
explicitly per the brief).

### 10.2 UI Flow
Representative Portal: new nav item **My Earnings** (`/rep/earnings`) → summary cards (Total Sales, Today's
Sales, Monthly Sales, Completed Sales, Pending Approval Sales, Commission Earned, Pending Commission, Paid
Commission) → tabs: **Settlement History**, **Commission per Invoice**, **Commission per Product**,
**Commission Timeline** → **Download Statement** action (PDF/CSV export of a period's ledger).

### 10.3 Database Design
No new tables — pure aggregation over `CommissionLedgerEntry` and `RepresentativeSettlement` (§1), scoped by
`representativeId = requester.sub`.

### 10.4 Backend Architecture
`RepEarningsService.getSummary(representativeId)` and `.getLedger(representativeId, params)` — read-only
aggregation, same `groupBy`/`aggregate` toolkit `DashboardService`/`SalesAnalysisService` already use
(`current_backend.md`), pointed at the new ledger tables. Zero writes.

### 10.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/rep-portal/earnings/summary` | GET | Representative (own data only, derived from JWT `sub`) |
| `/rep-portal/earnings/ledger` | GET | Representative |
| `/rep-portal/earnings/statement` | GET (PDF/CSV) | Representative |

### 10.6 Permission Model
`Role.REPRESENTATIVE`-only, and **always implicitly scoped to the caller's own `representativeId`** — there
is no `:id` path parameter on any of these routes, specifically so a rep can never even attempt to query
another rep's earnings by guessing an id (contrast with the Admin-side equivalent in §3.5, which does take
`:id` because an admin is allowed to view any rep's data).

### 10.7 Admin Screens
None — this section is the representative's own view; the admin equivalent is §13.

### 10.8 Representative Screens
My Earnings (§10.2) — the one genuinely new representative-facing screen family in this whole document.

### 10.9 Notification Flow
None required for viewing; settlement-related notifications are covered in §13.9.

### 10.10 Security Considerations
Self-scoped-only access (§10.6) is the entire security model here — no representative-supplied identifier is
ever trusted for whose data to return.

### 10.11 Compatibility Justification
Pure read-side aggregation over new tables. **No existing table, calculation, or report changes.**

---

## 11. Admin Commission Management

### 11.1 Business Flow
Admin reviews pending commission across all representatives, approves or rejects settlements, records how a
settlement was actually paid, and generates a receipt — the commission-side mirror of the existing
Payments/Credits admin workflow.

### 11.2 UI Flow
Admin Panel → new **Commission** section: **Commission Dashboard** (KPIs) → **Representative Commission
Summary** (per-rep pending/paid totals) → **Pending Settlements** / **Paid Settlements** / **Monthly
Settlements** lists → Settlement Detail → **Approve** / **Reject** / **Record Payment** (Cash / Bank Transfer
/ Cheque) → **Generate Settlement Receipt** (PDF, mirrors the existing Invoice PDF generation pattern).

### 11.3 Database Design
`RepresentativeSettlement` + `CommissionLedgerEntry.settlementId` (§1) — a settlement is created by batching
a rep's `PENDING`/`APPROVED` ledger lines for a period; approving/paying it updates `status` and (for
cash/bank/cleared-cheque) triggers §14's expense linkage.

### 11.4 Backend Architecture
`SettlementsService` (new, `src/commission/settlements.service.ts`): `create()` (batches eligible ledger
lines for a rep+period into a new `PENDING` settlement, marking those lines `APPROVED`-pending-settlement),
`approve()`/`reject()`, `recordPayment()` (sets `mode`/cheque fields, and — the one place this module talks
to accounting — calls into §14's `createSettlementExpense()`). All of it is new code in a new module; none
of it calls `PaymentsService`, `InvoicesService`, or `OrdersService`.

### 11.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/commission/dashboard` | GET | Admin |
| `/commission/representatives/:id/summary` | GET | Admin |
| `/commission/settlements` | GET (filterable: pending/paid/monthly) | Admin |
| `/commission/settlements` | POST (create/batch for a rep+period) | Admin |
| `/commission/settlements/:id` | GET | Admin |
| `/commission/settlements/:id/approve` | PATCH | Admin |
| `/commission/settlements/:id/reject` | PATCH `{reason}` | Admin |
| `/commission/settlements/:id/pay` | PATCH `{mode, reference, chequeDetails?}` | Admin |
| `/commission/settlements/:id/receipt` | GET (PDF) | Admin |
| `/commission/reports/*` | GET | Admin — see §17 |

### 11.6 Permission Model
Admin-only, entirely — a representative's only view into this data is their own read-only §10 dashboard.

### 11.7 Admin Screens
Commission Dashboard, Representative Commission Summary, Pending/Paid/Monthly Settlement lists, Settlement
Detail with Approve/Reject/Record Payment actions, Settlement Receipt (PDF).

### 11.8 Representative Screens
None — covered by §10.

### 11.9 Notification Flow
Settlement approved/paid → email to the representative (`notifyRepSettlementPaid`, new method) with amount,
period, and payment mode. Settlement rejected → email with the rejection reason.

### 11.10 Security Considerations
Every settlement state transition (`approve`/`reject`/`pay`) is written through the existing
`ActivityLogService.log()` with the acting admin's id — full audit trail, same mechanism already governing
every other financially-consequential admin action in the system.

### 11.11 Compatibility Justification
New module, new tables, and — critically — the **only** point of contact with existing financial tables is
the single, explicit, admin-triggered call described next in §14, which itself only ever *creates* a new
`Expense` row (never updates or deletes an existing one). **No existing settlement, payment, invoice, or
order row is ever read for a purpose other than display, let alone written to.**

---

## 12. Accounting Integration

### 12.1 Business Flow
A paid representative settlement is a real business expense and must show up exactly where every other
expense does — in Liquid Cash, in the Equity calculation, in Expense reports — with no separate, parallel
"commission expenses" ledger that could drift out of sync with the real one.

### 12.2 UI Flow
No new UI — the existing Admin **Expenses** screen (`current_backend.md`) now also shows
settlement-originated expenses inline with every other expense, distinguishable by description (see §12.4)
and, for anyone who needs to trace it, a link back to the originating settlement (via the reverse relation,
§1.1).

### 12.3 Database Design
No new financial table. `RepresentativeSettlement.expenseId` (§1) is a nullable, unique FK into the
**existing, completely unmodified** `Expense` table (`current_backend.md`). `Expense` itself gains **zero**
new columns — the relationship is declared entirely from the `RepresentativeSettlement` side.

### 12.4 Backend Architecture
`SettlementsService.createSettlementExpense(tx, settlement)`, called only from `recordPayment()` (§11.4)
when the mode is Cash or Bank Transfer, or when a Cheque-mode settlement's `chequeStatus` transitions to
`CLEARED` (mirroring exactly how `SupplierPayment`'s existing cheque-clearing logic already gates when money
"really" moves, per `current_backend.md`'s `SUPPLIER_CLEARED_FILTER`). It does exactly one thing:
```ts
const expense = await tx.expense.create({
  data: {
    description: `Representative commission settlement — ${rep.name} (${settlement.settlementNumber})`,
    amount: settlement.totalCommission,
    expenseDate: new Date(),
    remarks: `Settlement period ${periodStart}–${periodEnd}`,
  },
});
await tx.representativeSettlement.update({ where: { id: settlement.id }, data: { expenseId: expense.id, status: 'PAID', paidAt: new Date() } });
```
This calls **the exact same `tx.expense.create()` Prisma call** `ExpensesService.create()` already uses
(`current_backend.md`) — not a copy of its logic, not a parallel path, the identical write. Because it lands
in the real `Expense` table, **every existing calculation that already sums expenses — `computeLiquidCash()`,
`SalesAnalysisService`'s `netProfit`, `EquityService`'s `expenseShare` — picks it up automatically, with zero
changes to any of those functions.** This is the payoff of "reuse existing financial architecture" taken
literally: the integration point is a single `INSERT`-equivalent into a table three other subsystems already
read from, not a new subsystem those three now have to be taught about.

### 12.5 API Endpoints
No new endpoints — this is a side effect of `PATCH /commission/settlements/:id/pay` (§11.5).

### 12.6 Permission Model
Inherits §11.6 (Admin-only) — a representative can never trigger an expense write, directly or indirectly.

### 12.7 Admin Screens
The existing Expenses screen, unchanged, now simply contains more rows.

### 12.8 Representative Screens
None.

### 12.9 Notification Flow
Covered by §11.9 (settlement-paid email); no separate accounting notification.

### 12.10 Security Considerations
The expense-creation call happens **inside the same database transaction** as the settlement's status
update to `PAID` (shown above) — either both happen or neither does, the same all-or-nothing guarantee every
other financially consequential operation in this codebase already has (`TRANSACTION_OPTIONS`,
`current_backend.md` §6.1).

### 12.11 Compatibility Justification — the core claim of this whole section
- **Zero existing Expense rows touched**: every write is a new row.
- **Zero changes to `ExpensesService`, `DashboardService.computeLiquidCash()`, `SalesAnalysisService`, or
  `EquityService`**: none of their code is modified; they simply, automatically, correctly include the new
  expense rows because they already sum the whole `Expense` table.
- **Zero new financial calculation invented**: commission settlement cash-flow impact is expressed entirely
  in terms of the existing Expense concept, not a new one.
- **Historical figures are unaffected**: an `Expense` row is only ever created at the moment a settlement is
  actually paid — no historical backfill, no retroactive adjustment to any past period's totals.

---

## 13. Representative Activity Log

### 13.1 Business Flow
Every action a representative takes is recorded for accountability — richer than the admin activity log
(IP, browser, device), visible to the representative themselves (read-only) and to admins (who alone can
purge it).

### 13.2 UI Flow
Representative Portal: `/rep/activity` (new, read-only list of the rep's own actions).
Admin Panel: Representative Detail → **Activity History** tab (§3.2) — filterable, with a **Clear Log**
action (Admin only), mirroring the existing Admin Activity Log screen's own clear-all pattern
(`current_backend.md`).

### 13.3 Database Design
`RepresentativeActivityLog` (§1) — a **dedicated** table, deliberately separate from the existing shared
`ActivityLog` (which v1 had proposed extending with a nullable `repId`, per `Rep_Portal_DOCUMENTATION.md`
§23.10). This v2.1 requirement asks for materially richer per-entry data (IP, user agent, device type) than
`ActivityLog` carries for anyone, including admins — adding those columns to the shared table would apply to
every admin-authored row too, for no benefit to the Admin Panel's existing screen. A dedicated satellite
table (the same "new actor, new table" principle already used for `CustomerProfile` in v1 §23.3) keeps the
richer schema scoped to where it's actually needed. **v1's `ActivityLog.repId` addition is superseded by
this table and is no longer needed** — noted here as a design refinement, not a reversal of anything built
(neither has been implemented yet).

### 13.4 Backend Architecture
`RepActivityLogService.log(tx, { representativeId, action, targetId?, details?, ipAddress?, userAgent?,
deviceType? })` — called from every mutating Rep Portal endpoint (customer create/update, order create,
collection submission, password change, login/logout), the same "one call per mutation, inside the same
transaction" convention `ActivityLogService.log()` already establishes for admin actions
(`current_backend.md` §6.2). IP/user-agent are read from the request object at the controller layer (Nest's
standard `@Req()` access), not invented data.

### 13.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/rep-portal/activity-log` | GET | Representative (own log only, scoped by JWT `sub`, same pattern as §10.6) |
| `/representatives/:id/activity-log` | GET | Admin (any rep) — already listed in §3.5 |
| `/representatives/:id/activity-log` | DELETE | Admin only |

### 13.6 Permission Model
Representatives have **read-only** access to their own log and **no delete capability whatsoever** — the
`DELETE` route is not merely hidden from them in the UI, it is not `@Roles()`-permitted for `REPRESENTATIVE`
at all, so a direct API call would be rejected by `RolesGuard` regardless of what the frontend shows.

### 13.7 Admin Screens
Representative Detail → Activity History tab, with Clear Log.

### 13.8 Representative Screens
My Activity (`/rep/activity`) — read-only.

### 13.9 Notification Flow
None required — this is itself the audit trail other notification flows are logged into.

### 13.10 Security Considerations
This log is the single most important forensic tool for investigating a compromised representative account
or a disputed order/collection — hence read-only-for-the-actor, delete-only-for-admins, and capturing
IP/device specifically so an admin can distinguish "the rep did this" from "someone else did this with the
rep's credentials."

### 13.11 Compatibility Justification
Entirely new, standalone table. **Does not touch the existing `ActivityLog` table at all** (supersedes only
a not-yet-built v1 *proposal* to touch it, per §13.3) — so even that minor nullability change from v1 is now
unnecessary. This is, if anything, **less** invasive than the v1 plan it replaces.

---

## 14. Customer Collection Management

### 14.1 Business Flow
A representative is often the one physically collecting payment from a shop. They record what they
collected; **this never directly updates accounting** — it lands in an admin inbox, and only once an admin
verifies it does a real `Payment` get created, through the exact existing payment pipeline.

### 14.2 UI Flow
Representative Portal: Customer Profile (already built in `electromart_rep`) gains a **Collections** panel:
Outstanding balance, Invoice list, Pending cheques, Overdue amount, Credit limit/remaining, Last payment,
Collection history, and a **Record Collection** form (Cash/Cheque, amount, date, notes, optional cheque
photo). Submission shows a `PENDING_VERIFICATION` status until an admin acts.
Admin Panel: new **Collections** queue — pending submissions list → Detail (customer, invoice, amount, mode,
rep, notes) → **Verify & Confirm** (creates the real payment) or **Reject** (with reason, nothing else
happens).

### 14.3 Database Design
`CollectionSubmission` (§1) — the staging record. `resultingPaymentId` is set **only** on confirmation.

### 14.4 Backend Architecture — the safety-critical part
`CollectionSubmissionsService.submit()` (rep-facing): pure insert into `CollectionSubmission`,
`status: PENDING_VERIFICATION`. **No call to `PaymentsService` anywhere in this method.**

`CollectionSubmissionsService.confirm(id, adminId)` (admin-facing): reads the submission, then calls **the
existing, completely unmodified `PaymentsService.create()`** with the submission's `invoiceId`/`amount`/
`mode`/cheque fields — the *exact* code path (`current_backend.md` §5.6) that already handles row-locking,
the overpayment guard, cheque-field validation, `outstandingBalance` decrement, and
`recomputeInvoicePaymentStatus()`. The resulting real `Payment.id` is written back onto
`CollectionSubmission.resultingPaymentId`, and the submission's own `status` becomes `CONFIRMED`. If
`PaymentsService.create()` throws (e.g. the amount now exceeds the outstanding balance because another
payment landed in the meantime), the confirmation fails loudly and the submission stays
`PENDING_VERIFICATION` for the admin to re-check — it is **never** possible for a `CollectionSubmission` to
silently produce an inconsistent financial state, because the only thing that can move money is the same
guarded function that already prevents that for every other payment in the system.

`CollectionSubmissionsService.reject(id, adminId, reason)`: sets `status: REJECTED`, `rejectedReason` — no
financial effect of any kind, by construction (nothing was ever written to `Payment`/`Invoice`/`Dealer` for
a submission that reaches this branch).

### 14.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/rep-portal/collections` | POST (submit) | Representative |
| `/rep-portal/collections` | GET (own submissions) | Representative |
| `/rep-portal/collections/customer/:customerId` | GET (outstanding/invoices/pending cheques/history for one customer) | Representative |
| `/collections` | GET (admin queue, filterable by status) | Admin |
| `/collections/:id` | GET | Admin |
| `/collections/:id/confirm` | PATCH | Admin |
| `/collections/:id/reject` | PATCH `{reason}` | Admin |

### 14.6 Permission Model
Representatives can create and read only their own submissions (JWT-scoped, same pattern as §10.6/§13.6).
**Only an Admin can call `confirm`** — the route that is the sole bridge into `PaymentsService.create()` is
never reachable with a `REPRESENTATIVE` token, closing off any path for a rep to single-handedly create a
real payment.

### 14.7 Admin Screens
Collections queue, Collection Detail with Verify/Reject actions.

### 14.8 Representative Screens
Customer Profile's Collections panel (§14.2), plus a standalone **My Collections** list of their own
submissions and statuses.

### 14.9 Notification Flow
Submission confirmed → email to the rep (confirmation) and the existing payment-recorded flow proceeds
exactly as it does for an admin-entered payment today (no separate customer-facing email is introduced here
beyond what already exists). Submission rejected → email to the rep with the reason.

### 14.10 Security Considerations
This is the single highest-value safety property in the entire v2.1 brief, worth restating: **a
representative's collection submission has no code path that can move money, adjust `outstandingBalance`, or
change `Invoice.paymentStatus` — it can only ever request that an admin do so, through the same guarded
function that already governs every payment in the system.**

### 14.11 Compatibility Justification
`PaymentsService.create()` is called, not modified — zero lines changed in it. `CollectionSubmission` is a
new, standalone staging table with **no** effect on `Payment`/`Invoice`/`Dealer.outstandingBalance` unless
and until an admin explicitly confirms it, at which point the effect is *identical* to an admin recording
that same payment by hand today. **There is no new way for money to move in this system — only a new front
door (submission → admin review) leading to the same, unmodified door that already exists.**

---

## 15. Cheque Management

### 15.1 Business Flow
Cheque lifecycle (Received → Deposited → Cleared / Returned / Cancelled) is already fully modeled today via
`Payment.chequeStatus` (`current_backend.md` §5.6: `PENDING/CLEARED/RETURNED`, admin-updated via `PATCH
/payments/:id/cheque-status`). v2.1 asks for two additions: an intermediate **Received/Deposited** distinction
for reps' visibility, and an **automatic email to the representative** when a cheque tied to one of their
customers' invoices is marked Returned.

### 15.2 UI Flow
Admin: the existing `PATCH /payments/:id/cheque-status` action (unchanged) — Received/Deposited are surfaced
as **representative-facing display states only** (§15.3), not new values the admin sets, since the existing
enum's `PENDING` already means "received, awaiting clearance" and introducing new admin-settable statuses
would touch the existing, working cheque-status state machine documented in `current_backend.md` §5.6.
Representative: Customer Profile's Collections panel shows each pending cheque's status using this display
mapping, plus a new email when one bounces.

### 15.3 Database Design
No new enum values on `ChequeStatus`, no new columns on `Payment`. "Received" vs. "Deposited" is a
**representative-facing display distinction only**, derived read-side from whether the payment's
`chequeDate`/`collectedDate` (existing fields) have passed — **Cancelled** is out of scope for this pass
(the existing `Payment` model has no such status today, per `current_backend.md`, and adding one would be a
change to the existing cheque state machine, which this document declines to make without a dedicated review,
consistent with v1's stance on not casually extending shared status enums, per
`Rep_Portal_DOCUMENTATION.md` §14.2's identical reasoning about `OrderStatus`).

### 15.4 Backend Architecture
No changes to `PaymentsService.updateChequeStatus()` (`current_backend.md`, untouched). One new,
purely-additive hook: `PaymentsService`'s existing cheque-status update, on transition to `RETURNED`, already
fires inside a transaction — **outside** that transaction (after commit, fire-and-forget, exactly like every
other post-commit notification in this codebase, e.g. `checkAndNotifyOutOfStock` in `OrdersService`), a new
listener checks whether `payment.invoice.order.createdByRepId` is set and, if so, calls
`MailerService.notifyRepChequeReturned()`. This is implemented as a small addition to the **existing**
`PaymentsController`/`PaymentsService` call site — the **one** place in this entire document where new code
sits directly next to (not inside) existing payment logic, and it is deliberately scoped to be a read-only
notification trigger with no ability to alter the transaction it's attached to.

### 15.5 API Endpoints
No new endpoints — reuses the existing `PATCH /payments/:id/cheque-status` (`current_backend.md` §5.6)
entirely as-is. Representative-facing cheque visibility is served by the existing §14.5
`/rep-portal/collections/customer/:customerId` read.

### 15.6 Permission Model
Unchanged — cheque status updates remain Admin-only, exactly as today.

### 15.7 Admin Screens
No new screens — the existing Payments/Collections cheque-status action.

### 15.8 Representative Screens
Collections panel's cheque status display (§15.2); a new email, not a screen, for the return notification.

### 15.9 Notification Flow
Cheque marked Returned → `notifyRepChequeReturned(repEmail, { customer, invoiceNumber, chequeNumber,
chequeAmount, bankName, reason, outstandingBalance, requiredNextAction })`, per the brief's exact field
list — new mailer method, fired post-commit, never inside the payment-status transaction itself.

### 15.10 Security Considerations
None beyond the existing cheque-status update's own (Admin-only, already audited via `ActivityLogService`).

### 15.11 Compatibility Justification
**Zero changes to `Payment`, `ChequeStatus`, or `PaymentsService.updateChequeStatus()`'s logic.** The one
addition is a post-commit, side-effect-only email trigger — if it failed outright, the cheque-status update
that already happened is unaffected (the same fire-and-forget resilience already documented for
`checkAndNotifyOutOfStock`, `current_backend.md`).

---

## 16. Collection Reminders

### 16.1 Business Flow
Every approved order gets a grace period (default 7 days) to have its collection submitted; if not, the
representative gets an automatic reminder email with days-overdue/priority framing.

### 16.2 UI Flow
No new screen — this is a background email flow. The representative's existing Collections panel (§14.2)
already surfaces "overdue" status derived from the same data the reminder job reads, so the email is a
proactive nudge toward information already visible on demand.

### 16.3 Database Design
`CollectionReminderLog` (§1) — one row per reminder actually sent, so the job never double-sends for the
same order on the same day (the exact `chequeReminderSentAt`-guard pattern `CreditsService`'s existing daily
cheque-deposit-reminder cron already uses, `current_backend.md` §"Credits").

### 16.4 Backend Architecture
`CollectionRemindersService`, a new `@Cron(CronExpression.EVERY_DAY_AT_9AM)` job (same mechanism, new,
independent registration — does not touch `CreditsService`'s existing cron): finds `Order` rows where
`createdByRepId IS NOT NULL`, `status` indicates an active, uncollected balance (i.e. the linked `Invoice`'s
`paymentStatus` is `PENDING`/`PARTIAL`/computed-`OVERDUE`, per the existing, unmodified derivation in
`invoice-financials.ts`), `approvedAt` is more than the grace period (default 7 days, admin-configurable via
a simple settings value — not a new table, a single config constant/env var) in the past, and no
`CollectionReminderLog` row exists for today. Pure read of existing + new-but-untouched tables, pure write to
the new log table.

### 16.5 API Endpoints
No representative or admin-facing endpoints required for MVP — this is a background job. (Future-ready, per
the brief: SMS/WhatsApp/push are additional notification channels layered onto the same trigger, not a new
data model — noted and deliberately not built now, consistent with v1 §22's "future-ready means not
blocked, not pre-built" principle.)

### 16.6 Permission Model
N/A — system-triggered, no user-facing route.

### 16.7 Admin Screens
None new — overdue collections already surface via the existing Invoices/Payments screens' `OVERDUE`
derivation (`current_backend.md` §5.5), and via the new Collection Performance report (§17).

### 16.8 Representative Screens
None new beyond the existing Collections panel (§14.2) the reminder email links back to.

### 16.9 Notification Flow
`notifyRepCollectionReminder(repEmail, { customer, invoiceNumber, outstandingAmount, daysRemaining,
overdueDays, priority })` — new mailer method, per the brief's exact field list.

### 16.10 Security Considerations
None beyond standard email-content hygiene (no sensitive data beyond what the rep already has legitimate
access to via the same customer relationship).

### 16.11 Compatibility Justification
Reads `Order`/`Invoice`'s existing, unmodified fields and the existing `OVERDUE` derivation logic
(`invoice-financials.ts`, untouched) exclusively. Writes only to the new `CollectionReminderLog`.
**Zero interaction with any write path in the order/invoice/payment pipeline.**

---

## 17. Reporting

### 17.1 Business Flow
A consolidated set of admin reports covering representative and collection performance, layered on top of
data this document already introduces or that already exists.

### 17.2 UI Flow
Admin Panel → **Reports** (extends the existing Sales Analysis / Dashboard area) → new report tabs:
Representative Performance, Collection Performance, Outstanding by Representative, Commission Summary,
Settlement Summary, Overdue Collections, Returned Cheques, Product-wise Sales, Category-wise Sales,
Representative-wise Sales.

### 17.3 Database Design
No new tables. Every report is an aggregation query.

### 17.4 Backend Architecture
`RepReportsService`, new, read-only, reusing the exact aggregation toolkit (`groupBy`, `aggregate`,
occasional `date_trunc` raw SQL for time series) `DashboardService`/`SalesAnalysisService`/`EquityService`
already use (`current_backend.md`), pointed at `Order.createdByRepId`, `CommissionLedgerEntry`,
`RepresentativeSettlement`, `CollectionSubmission`, and `Payment.chequeStatus` — the same reuse discipline
v1 §20 already established for its own analytics section.

| Report | Source |
|---|---|
| Representative Performance | `Order` grouped by `createdByRepId`, revenue/count over time |
| Collection Performance | `CollectionSubmission` grouped by `representativeId`, confirmed vs. rejected vs. pending |
| Outstanding by Representative | `Dealer.outstandingBalance` summed, grouped by `createdByRepId` |
| Commission Summary | `CommissionLedgerEntry` grouped by `representativeId`/`status` |
| Settlement Summary | `RepresentativeSettlement` grouped by `status`/period |
| Overdue Collections | Same query as §16.4's reminder job, presented as a report rather than an email |
| Returned Cheques | `Payment` where `chequeStatus = RETURNED`, joined to `Order.createdByRepId` |
| Product-wise / Category-wise / Representative-wise Sales | `OrderItem` aggregation, the exact pattern `DashboardService`'s top-products widget and v1 §20 already use, filtered/grouped one dimension further |

### 17.5 API Endpoints
| Route | Method | Role |
|---|---|---|
| `/reports/representative-performance` | GET | Admin |
| `/reports/collection-performance` | GET | Admin |
| `/reports/outstanding-by-representative` | GET | Admin |
| `/reports/commission-summary` | GET | Admin |
| `/reports/settlement-summary` | GET | Admin |
| `/reports/overdue-collections` | GET | Admin |
| `/reports/returned-cheques` | GET | Admin |
| `/reports/sales/product` \| `/category` \| `/representative` | GET | Admin |

### 17.6 Permission Model
Admin-only — identical posture to the existing Sales Analysis module.

### 17.7 Admin Screens
Reports section (§17.2), each report a filterable table/chart pairing consistent with the existing Sales
Analysis screen's visual language.

### 17.8 Representative Screens
None — a representative's equivalent view of their own numbers is §10's My Earnings.

### 17.9 Notification Flow
None required — on-demand reporting.

### 17.10 Security Considerations
Standard admin-only read access; no report ever aggregates across a boundary a representative couldn't
otherwise see cross-referenced (i.e., these reports don't leak anything a sufficiently patient admin
couldn't already derive from the existing, unmodified Dashboard/Sales Analysis screens plus this document's
new tables).

### 17.11 Compatibility Justification
100% read-only against existing (untouched) and new (already-justified) tables. **No write path, therefore
no data-integrity risk of any kind.**

---

## 18. Consolidated Reference Tables

### 18.1 Every new endpoint, by module

| Module | Base path | Roles reachable |
|---|---|---|
| Representatives (Admin CRUD) | `/representatives` | Admin |
| Auth extensions | `/auth/rep-login`, `/auth/change-password` | Representative; `/auth/forgot-password`, `/auth/reset-password` shared |
| Product Assignment | `/representatives/:id/assigned-products` | Admin |
| Banner Assignment | `/banners/:id/assignments` | Admin |
| Availability Override | `/products/:id/availability-override` | Admin |
| Commission Rules | `/products/:id/commission-rules` | Admin |
| Settlements | `/commission/*` | Admin |
| Rep Earnings | `/rep-portal/earnings/*` | Representative (self-scoped) |
| Rep Activity Log | `/rep-portal/activity-log`, `/representatives/:id/activity-log` | Representative (self, read-only) / Admin (any, read+delete) |
| Collections | `/rep-portal/collections/*` | Representative (submit/read own) |
| Collections (admin) | `/collections/*` | Admin (review/confirm/reject) |
| Reports | `/reports/*` | Admin |

### 18.2 Permission matrix

| Capability | Admin | Representative |
|---|---|---|
| Create/edit/suspend/block representatives | ✅ | ❌ |
| Assign products/banners | ✅ | ❌ (read own scope only, implicitly) |
| Set availability overrides | ✅ | ❌ (sees resolved status only) |
| Define commission rules | ✅ | ❌ |
| Approve/reject/pay settlements | ✅ | ❌ |
| View own earnings/commission | — | ✅ (self only) |
| Submit collections | — | ✅ (self only) |
| Confirm/reject collections (moves money) | ✅ | ❌ |
| View own activity log | — | ✅ (read-only) |
| Delete activity log | ✅ | ❌ |
| View reports | ✅ | ❌ (self-scoped dashboards only, §10) |

---

## 19. Migration Plan

Follows `Rep_Portal_DOCUMENTATION.md` §25's Migration Safety Protocol exactly — every statement below is
`CREATE TABLE` or an additive `ALTER TYPE ... ADD VALUE`; nothing here needs `DROP`, `RENAME`, or a
non-defaulted `NOT NULL ADD COLUMN` on a table with existing rows, since `Representative` and every table in
§1 do not exist in production yet.

**Phase 0 — schema.** All enums and tables in §1, plus the `Expense`/`Dealer`/`Order`/`Invoice`/`Payment`/
`Product`/`Banner` reverse relations in §1.1 (zero SQL-level column changes on any of them). Independently
deployable, exactly as v1 §25 establishes — the running Admin/Dealer app is unaware any of this exists.

**Phase 1 — representative lifecycle.** §3 (Representative Management), §4 (Account Creation), §5 (Login &
Password Management), §6 (Product Assignment), §8 (Inventory Visibility). This is the minimum needed for a
representative to exist, log in, and see a correctly-scoped catalog.

**Phase 2 — money.** §9 (Commission Rules), §2's reconciliation job, §11–§12 (Settlement approval +
Accounting Integration), §14 (Collections). Deliberately phased after Phase 1 — commission and collections
are meaningless without representatives and orders already flowing.

**Phase 3 — operational polish.** §7 (Banner Assignment), §13 (rich Activity Log), §15 (cheque-return
notification), §16 (Collection Reminders), §17 (Reporting), §10 (Earnings Dashboard UI). None of these block
or are blocked by anything else — independently schedulable.

---

## 20. Exhaustive Safety Audit (v2.1)

Per the brief's Non-Negotiable Requirement, each item below is proven, not asserted — every claim names the
exact table/service/method it depends on.

| Guarantee | How v2.1 satisfies it |
|---|---|
| Zero production data loss | Every table in §1 is new. Every existing-table touch is a reverse relation only (§1.1) — zero columns added, renamed, or removed on `Order`, `Invoice`, `Payment`, `Dealer`, `Product`, `Banner`, `Expense`. |
| Zero historical sales loss | `OrdersService` gains no new code (§2) — every historical and future order's approval/rejection/status/edit/delete path is byte-for-byte what it is today. |
| Zero invoice loss | `InvoicesService` is not referenced by any v2.1 write path. |
| Zero payment loss | `PaymentsService.create()`/`updateChequeStatus()` are called, never modified (§14.4, §15.4) — the only two v2.1 touchpoints with payments are a read-only email trigger (§15.4) and a call to the existing, unmodified creation function (§14.4). |
| Zero inventory history loss | `InventoryService.recordMovement()` is not referenced anywhere in this document. The availability override (§8) is a display-layer construct with no `InventoryLog` interaction. |
| Zero financial inconsistencies | The single financial write this document introduces — settlement → `Expense` (§12.4) — happens inside one transaction, in the exact shape `ExpensesService.create()` already writes, and is immediately and correctly picked up by every existing aggregate (`computeLiquidCash`, `SalesAnalysisService`, `EquityService`) with no changes to any of them. |
| Zero breaking API changes | Every existing endpoint in `current_backend.md` keeps its exact request/response shape. New fields on Rep-Portal-scoped responses (`stockStatus`, §8.5) are additive and only ever reachable via `REPRESENTATIVE`-scoped routes that don't exist for any other role to break. |
| Zero downtime migration | All-additive DDL (§19), deployable ahead of any application code, per the same protocol v1 §25.5 already established. |
| Full backward compatibility | Admin Panel and Dealer Portal require zero code changes — every v2.1 capability is reachable only through new routes, a new Admin nav section, and the already-separate `electromart_rep` frontend. |

The pattern is identical to v1: **every new capability is a new table plus a new, independent code path —
or, where money is involved, a new code path that ends by calling the one existing, unmodified function
already trusted to move that money.** Nothing in this document edits the pipeline; everything in it either
sits beside the pipeline or calls into it exactly the way an admin already does today.
