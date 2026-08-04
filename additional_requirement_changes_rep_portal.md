# Electro Mart — Representative Portal v2.1
## Frontend Requirements: `electromart_rep` Changes

| | |
|---|---|
| **Document type** | Frontend Requirements Specification |
| **Applies to** | `electromart_rep` (the Representative Portal Next.js app, already built for the Phase 1 core loop) |
| **Companion documents** | `version2_changes_backend.md` (the backend this frontend will eventually call) · `Rep_Portal_DOCUMENTATION.md` (v1 architecture) |
| **Status** | Requirements only — **no frontend code has been changed for v2.1 yet** |
| **Constraint** | Every v1 screen, component, hook, and store already shipped in `electromart_rep` keeps working exactly as it does today. Everything below is a new screen, a new nav entry, or a scoping change layered on top of an existing data-fetching call — never a rewrite of existing UI. |

---

## 1. Why this is a separate document from the backend spec

`version2_changes_backend.md` specifies *what the API will do*. This document specifies *what the
Representative Portal frontend needs to do with it* — new screens, new navigation, and, just as importantly,
**new things the frontend must actively refuse to display** (real stock counts, other reps' data, commission
rule internals) even though nothing stops a naive UI from rendering whatever a response contains. Keeping
this separate from the backend document means the two can be reviewed and staffed independently: the backend
work is a NestJS/Prisma effort against `electromart-backend`; this work is entirely inside the already-shipped
`electromart_rep` codebase (`src/app/rep/`, `src/lib`, `src/hooks`, `src/stores`, `src/components/rep`).

## 2. Recap: what `electromart_rep` already has (unaffected by this document)

Per the existing build: rep login, homepage (banners/categories/brands/new-arrivals/best-sellers/offers),
full catalog with search/filter, product detail, brand pages, customer search/create/profile/status/
timeline, a persistent cart, the 5-screen checkout flow, order list/detail with a status timeline, and a
personal dashboard. All of it, and every file backing it, is **untouched** by this document — v2.1 adds
alongside it.

---

## 3. Navigation & Information Architecture Changes

`src/components/rep/rep-nav-items.ts` (currently: Home, Customers, Cart, Orders, Dashboard) gains three new
entries, all additive:

| New nav item | Route | Visibility |
|---|---|---|
| My Earnings | `/rep/earnings` | Always — but see §7's explicit "customers never see this" note (moot today since customers have no login at all, per v1, but the route itself must still never be reachable by anything other than a `REPRESENTATIVE` session) |
| Collections | `/rep/collections` | Always |
| My Activity | `/rep/activity` | Always (in the user-menu dropdown, not the primary nav — mirrors where "Change password" already sits in `components/shell/user-menu.tsx`) |

The existing `AuthGuard` (`src/components/auth-guard.tsx`) — already role-gates the entire `/rep/*` tree —
needs **no change** for this; every new route sits inside the same `app/rep/layout.tsx` guard that already
protects everything else.

---

## 4. Forced Password Change (§5 of the backend doc)

**Business need**: a representative's first login (or an admin-forced reset) must require setting a new
password before reaching the app.

**Screen**: new `app/change-password/page.tsx`, structurally a sibling of the existing `forgot-password`/
`reset-password` pages (same `AuthShell` wrapper, same `react-hook-form` + `zod` pattern already used
throughout `electromart_rep`'s auth screens).

**Flow change**: `useRepLogin`'s `onSuccess` handler (`src/hooks/use-auth.ts`) currently does
`router.replace('/rep/home')` unconditionally. It gains one branch: if the login response's new
`mustChangePassword` field is `true`, redirect to `/change-password` instead; that screen, on successful
submit, then does the existing `/rep/home` redirect. **No existing successful-login behavior changes** for
the (eventual) case where `mustChangePassword` is `false`.

**Type change**: `AuthResponse` (`src/lib/api/types.ts`) gains an additive `mustChangePassword?: boolean`
field — optional, so nothing currently reading `AuthResponse` needs to change.

**Mock layer**: `src/lib/mock/auth.ts`'s `mockRepLogin()` returns `mustChangePassword: false` for the demo
account (since the demo credential is meant to drop straight into the app) — the screen still needs to
exist and be reachable directly for design/QA review even though the seeded demo flow doesn't trigger it.

---

## 5. Catalog Visibility Scoping (§6, §8 of the backend doc)

**Business need**: a rep only sees products an admin assigned them, and only ever sees `In Stock`/`Out of
Stock`, never a number.

**What does NOT change**: `app/rep/catalog/page.tsx`, `app/rep/home/page.tsx`, `app/rep/products/[id]/page.tsx`,
`components/rep/product-card.tsx`, `components/status-badge.tsx`'s `StockStatusBadge` — **none of these
components change at all**. The scoping happens entirely in the data they're fed.

**What does change**: `Product` (`src/lib/api/types.ts`) currently carries `currentStock: number` and derives
`isOutOfStock` from it. Once assignment/override scoping is live server-side, the Rep-Portal-facing product
response (per backend §8.4-8.5) **omits the numeric field entirely** for a `REPRESENTATIVE` caller — so the
type contract for what `catalogService.listProducts()`/`getProduct()` return needs a Rep-Portal-specific
shape:

```ts
// New, additive — does not replace the existing Product type used by the mock/demo data model today.
export interface RepVisibleProduct extends Omit<Product, 'currentStock' | 'isOutOfStock'> {
  stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK';
}
```

`StockStatusBadge` already takes a `status: 'IN_STOCK' | 'OUT_OF_STOCK'` string (§ existing component, see
`current_backend.md`-mirrored patterns) — it already doesn't care where that string came from, so **the
existing component requires zero changes**; only the hook feeding it (`useProducts`/`useProduct` in
`src/hooks/use-catalog.ts`) needs its return type updated once the live backend ships this shape. Until then,
the mock layer (`src/lib/mock/db.ts`) continues to compute `isOutOfStock` from a real `currentStock` exactly
as it does today — the mock fixtures represent an admin's assignment as "the rep sees the whole seed catalog,"
which remains a faithful (if maximal) stand-in until product assignment is worth simulating in the mock layer
too (see §12).

**UI consideration — non-negotiable**: no screen, tooltip, admin-only debug panel, or `console.log` anywhere
in the Rep Portal build may render a numeric stock figure. This is enforced by the type contract itself once
`RepVisibleProduct` replaces `Product` in every Rep-Portal-facing hook — if the field doesn't exist on the
type, no component can accidentally read it.

---

## 6. Homepage Banner Scoping (§7 of the backend doc)

**What does NOT change**: `components/rep/banner-slider.tsx` — it already just renders whatever `Banner[]`
it's given.

**What does change**: nothing in the frontend at all. Per backend §7.4, the same `GET /rep-portal/home`
call `useHome()` (`src/hooks/use-catalog.ts`) already makes returns a rep-scoped `banners` array server-side
— this is the cleanest possible v2.1 addition from the frontend's point of view: **zero lines change**,
because the scoping decision was deliberately pushed entirely into the existing endpoint's response shape
rather than requiring the client to know it's looking at a personalized list.

---

## 7. My Earnings (§10 of the backend doc)

**New route**: `app/rep/earnings/page.tsx`.

**Layout** (mirrors the existing `app/rep/dashboard/page.tsx`'s stat-card-grid-plus-list structure — same
`StatCard` component, same `Tabs` component already used on the Customer Profile page):

- Stat card row: Total Sales, Today's Sales, Monthly Sales, Completed Sales, Pending Approval Sales,
  Commission Earned, Pending Commission, Paid Commission (8 cards — same responsive
  `grid-cols-2 lg:grid-cols-4` pattern already used on the Dashboard).
- Tabs: **Settlement History** (table: settlement number, period, amount, status badge, paid date),
  **Commission per Invoice** (table: order/invoice number, product lines, commission amount, status),
  **Commission per Product** (grouped totals), **Commission Timeline** (chronological list, same visual
  language as the Customer Profile's merged timeline, `components/rep/` pattern already established there).
- **Download Statement** button — calls the backend's PDF/CSV export endpoint; client-side this is a plain
  `<a href>`/`window.open()` to the authenticated endpoint, the same pattern the existing app already uses
  nowhere yet but is standard for an authenticated-download button in this stack (no new library needed).

**New types** (`src/lib/api/types.ts`, additive):
```ts
export type CommissionLineStatus = 'PENDING' | 'APPROVED' | 'SETTLED' | 'REVERSED';
export type SettlementStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID';

export interface CommissionLedgerEntry {
  id: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  amount: string;
  status: CommissionLineStatus;
  createdAt: string;
}

export interface RepresentativeSettlement {
  id: string;
  settlementNumber: string;
  periodStart: string;
  periodEnd: string;
  totalCommission: string;
  status: SettlementStatus;
  mode: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | null;
  paidAt: string | null;
}

export interface EarningsSummary {
  totalSales: string;
  todaysSales: string;
  monthlySales: string;
  completedSales: string;
  pendingApprovalSales: string;
  commissionEarned: string;
  pendingCommission: string;
  paidCommission: string;
}
```

**New service/hooks**: `src/lib/services/earnings-service.ts` (mock + live branches, identical shape to
every existing service per `src/lib/services/README.md`'s established swap pattern) and
`src/hooks/use-earnings.ts`.

**New status badge variants**: `components/status-badge.tsx` gains `SettlementStatusBadge` and
`CommissionStatusBadge` — additive exports, alongside (not replacing) the existing `OrderStatusBadge`/
`StockStatusBadge`/`CustomerStatusBadge`.

**Security note for this screen specifically**: every call this page makes is to the self-scoped
`/rep-portal/earnings/*` routes (backend §10.6) — there is no id parameter anywhere in this screen's data
fetching, by design, so there is no client-side mistake (e.g. a copy-pasted URL) that could leak another
representative's earnings even in principle.

---

## 8. Collections (§14, §15, §16 of the backend doc)

**New route**: `app/rep/collections/page.tsx` — the rep's own submissions list, filterable by status
(`PENDING_VERIFICATION` / `CONFIRMED` / `REJECTED`), same `Tabs`-based status filter pattern already used on
`app/rep/orders/page.tsx`.

**Customer Profile changes** (`app/rep/customers/[id]/page.tsx`, already built): the existing **Overview**
tab gains a **Collections** sub-section (not a new top-level tab — it belongs next to the existing
outstanding-balance display) showing: Outstanding balance (already fetched via `customer.summary`, extended
per backend §14.5 with invoice-list/pending-cheque/overdue data), and a **Record Collection** button opening
a form dialog (reusing `components/ui/dialog.tsx`, already in the component library):

- Amount, Mode (Cash/Cheque — reuses the existing `PaymentMode` type already defined for order-adjacent
  data), Cheque fields (conditional, same show/hide pattern the Admin Panel's payment form already
  establishes for cheque details), Collection Date, Notes.
- On submit: `useSubmitCollection()` mutation → success toast → the submission appears in both the
  Customer Profile's Collections section and `/rep/collections`, `PENDING_VERIFICATION`.

**New types** (additive):
```ts
export type CollectionStatus = 'PENDING_VERIFICATION' | 'CONFIRMED' | 'REJECTED';

export interface CollectionSubmission {
  id: string;
  customerId: string;
  customerName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  amount: string;
  mode: PaymentMode;
  chequeNumber: string | null;
  bankName: string | null;
  collectionDate: string;
  notes: string | null;
  status: CollectionStatus;
  rejectedReason: string | null;
  createdAt: string;
}
```

**New status badge**: `CollectionStatusBadge` (additive, same file as §7's additions).

**Critical UI framing** — the Record Collection form must make the "this is a request, not a payment" nature
of the action explicit (mirroring how the existing Checkout Summary screen already states "submits it for
admin approval" before the Place Order button, §16 of `Rep_Portal_DOCUMENTATION.md`): a short inline note
under the submit button — *"This records what you collected for admin verification. The customer's
outstanding balance updates once an admin confirms it."* — so a representative never mistakes submission for
settlement.

---

## 9. My Activity (§13 of the backend doc)

**New route**: `app/rep/activity/page.tsx` — read-only, paginated list, same `PaginationBar` component
already used everywhere else in the app. Each row: action, target (if any, linked where sensible — e.g. an
"Order Created" row links to `/rep/orders/[id]`), timestamp (`formatDateTime`, existing util).

**No delete affordance anywhere on this screen** — per backend §13.6, the delete route isn't even reachable
with a representative's token, but the frontend reinforces this by simply never rendering a delete control
here, consistent with the principle that a screen should not offer an action the user could never
successfully complete.

---

## 10. Cheque Return Notification (§15 of the backend doc)

No new screen. The existing Collections panel (§8) already surfaces a cheque's current status; the backend's
new `notifyRepChequeReturned` email is the delivery mechanism, not a frontend concern. Optional, non-blocking
enhancement worth flagging for a later pass: a small "1 cheque returned" badge on the Collections nav item,
sourced from the same data the Collections page already fetches — explicitly **not required** for this
phase, listed here only so it isn't mistaken for an oversight.

---

## 11. Updated Product Card & Detail: Commission Is Never Shown

Explicit non-requirement, stated because the backend doc's commission engine could tempt a well-meaning
future contributor to "surface the commission rate on the product card to motivate reps." **Do not build
this without a deliberate, separate decision** — the v2.1 brief's earnings screen (§7) is the sanctioned
place a representative sees commission figures (their own, already-earned or resolved amounts), not a
per-product incentive display on the shopping surface. `components/rep/product-card.tsx` and the product
detail page (`app/rep/products/[id]/page.tsx`) are correctly out of scope for any v2.1 change.

---

## 12. Mock Layer Considerations (`src/lib/mock`)

Consistent with the existing app's approach (per its own README: "frontend only, mock-backed, structured so
pointing it at a real backend later is a two-line env change"), v2.1's frontend work should extend the mock
layer just enough to make the new screens demonstrable, without simulating the full backend:

- `fixtures.ts` gains a small set of seed `CommissionLedgerEntry`/`RepresentativeSettlement`/
  `CollectionSubmission` rows tied to the existing seed orders/customers, so §7's Earnings screen and §8's
  Collections screen have real content on first load — the same "seed enough history that every screen has
  something to show" approach already used for the existing seed orders.
- `db.ts` gains `mockGetEarningsSummary()`, `mockListSettlements()`, `mockListCommissionLedger()`,
  `mockSubmitCollection()`, `mockListCollections()`, `mockListActivityLog()` — same shape and latency-
  simulation pattern (`src/lib/mock/latency.ts`) every existing mock function already follows.
- Product assignment scoping (§5) is **not** worth simulating in the mock layer for this phase — the
  existing seed catalog is small (~28 products) and entirely owned by the single demo representative; a mock
  "some products are assigned, some aren't" distinction would add complexity for a scenario the live backend
  will actually enforce, and is explicitly deferred rather than half-built.
- The forced-password-change flow (§4) should still get a real screen and be reachable by direct navigation
  for review purposes, even though the seeded demo login bypasses it (§4's note).

---

## 13. Compatibility Justification (Frontend)

- **No existing route is removed, renamed, or restructured.** `/rep/home`, `/rep/catalog`, `/rep/products/[id]`,
  `/rep/search`, `/rep/brands*`, `/rep/customers*`, `/rep/cart`, `/rep/checkout/*`, `/rep/orders*`,
  `/rep/dashboard` all keep their exact current behavior, component tree, and data-fetching hooks.
- **No existing component's props change.** `ProductCard`, `StockStatusBadge`, `OrderTimeline`,
  `CustomerCard`, `CheckoutStepper`, and every other component built for v1 keep their exact current
  signatures — every v2.1 addition is a new component or a new page composing existing components
  unchanged (`StatCard`, `Tabs`, `Dialog`, `PaginationBar` are all reused as-is).
- **No existing type is narrowed or renamed** — `Product`, `Order`, `Customer` and every other v1 type in
  `src/lib/api/types.ts` are extended only by new, separate types (`RepVisibleProduct`,
  `CommissionLedgerEntry`, `RepresentativeSettlement`, `CollectionSubmission`, `EarningsSummary`) or, in
  `AuthResponse`'s one case, a single new **optional** field.
- **No existing store changes shape.** `useAuthStore` and `useRepCartStore` are untouched; nothing in this
  document requires new client-side state beyond what TanStack Query's existing per-hook caching already
  provides for the new screens' data.
- **The mock/live swap point is unaffected.** Every new capability follows the exact same
  `src/lib/services/*` pattern (`isLiveMode()` branch between `src/lib/api/endpoints.ts` and
  `src/lib/mock/*`) already established and documented in `src/lib/services/README.md` — v2.1 adds more
  services to that same, already-proven pattern, it does not introduce a second one.

**Net effect**: a developer who has only ever worked on the v1 build of `electromart_rep` can implement every
item in this document by adding new files and extending existing type unions/service objects — at no point
does implementing v2.1 require them to open, understand, or risk breaking a screen or component that already
ships today.
