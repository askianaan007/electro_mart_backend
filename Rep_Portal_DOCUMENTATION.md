# Electro Mart — Representative Portal
## Architecture & Product Design Proposal

| | |
|---|---|
| **Document type** | Solution Architecture Proposal |
| **Prepared for** | Electro Mart |
| **Prepared by** | Backend/Platform Architecture (Claude Code) |
| **Version** | 2.1 — extended additively with the Representative Operations, Commission & Collections layer; the v2.0 architecture below is unchanged and still authoritative for everything it covers |
| **Status** | Proposal for review — **nothing described here has been implemented** |
| **Companion documents** | `current_backend.md` — the as-built reference this proposal is designed against · `version2_changes_backend.md` — full backend spec for the v2.1 additions (Representative Management, commission engine, collections, cheque handling, activity logging, reporting) · `additional_requirement_changes_rep_portal.md` — the `electromart_rep` frontend requirements against those v2.1 additions |
| **Compatibility guarantee** | 100% additive. Admin Panel and Dealer Portal require zero code or schema changes to keep working exactly as they do today. |

> **A note on this revision.** The v1 draft covered the mechanics of "a rep places an order for a shop."
> This revision goes further: it treats the Representative Portal as a distinct **product** — a modern,
> catalog-first B2B ordering experience in the spirit of Amazon Business, Alibaba's buyer-side UX, Uline,
> and Grainger — while holding the same non-negotiable constraint the business set from day one: the
> existing Order → Invoice → Payment → Inventory pipeline, and everything the Admin and Dealer rely on
> today, does not move. Every new capability below is designed to sit *beside* that pipeline, not inside it.

> **v2.1 note.** Everything from here through §30 is the original v2.0 proposal, unchanged. A second wave of
> requirements — representative staff management, per-product commission, field payment collection, and
> the reporting/notification layer that goes with them — is specified in full in the two companion documents
> named above, and summarized in §31 at the end of this document. The same non-negotiable safety framework
> below applies to every line of that work; §31 and its companions hold themselves to it explicitly.

---

## Non-Negotiable Production Safety Guarantees

This system holds live, business-critical production data — products, categories, dealers, suppliers,
purchases, orders, order items, invoices, payments, inventory history, sales returns, purchase returns,
activity logs, and every report/dashboard figure derived from them. **Safety of that data is a harder
constraint on this proposal than any feature in it.** Where a safer option and a simpler option conflict
anywhere in this document, the safer option was chosen — see §3 for the principles that enforce this, §23
for a per-change safety justification on every schema addition, and §30 for an exhaustive, subsystem-by-
subsystem audit proving each guarantee below.

| Guarantee | How it is enforced | Proven in |
|---|---|---|
| Zero data loss, of any kind, on any existing table | Every migration is `CREATE TABLE` / `ADD COLUMN [DEFAULT ...]` / `ADD ENUM VALUE` only — no `DROP`, `RENAME`, or type-narrowing statement appears anywhere in this proposal | §23, §25.5 |
| Zero historical sales / invoice / payment / inventory-history / dealer / product / activity-log loss | No existing row is updated, reclassified, or deleted by any migration or any new code path | §30 |
| Zero report or dashboard calculation changes | `DashboardService`, `SalesAnalysisService`, `EquityService`, and `invoice-financials.ts` are not modified — new optional response fields only | §19, §20, §30.9 |
| Zero sequence-number corruption | New modules never write to the existing `Counter` keys (`'order'`, `'invoice'`, `'salesReturn'`, `'purchaseReturn'`) — rep-placed orders draw the *same* `'order'`/`'invoice'` sequence a dealer order would, through the same `nextSequenceNumber()` call, with no new key introduced that could collide | §30.10 |
| Zero migration risk / zero-downtime | Every migration is deployable and reversible independently of any application code — see the Migration Safety Protocol | §25.5 |
| Zero breaking API changes | No existing endpoint's request or response shape changes; new fields are additive-only on existing responses | §24, §30.11 |
| Admin Panel, Dealer Portal, and any other existing API consumer continue working exactly as today | No existing controller's mutating logic changes; only read-only routes gain an additional permitted role | §30 |
| Existing business rules, financial calculations, and the Order → Invoice → Payment → Inventory pipeline are unmodified | `OrdersService`, `InvoicesService`, `PaymentsService`, `InventoryService`, `SalesReturnsService`, `PurchaseReturnsService` gain, at most, one new role-gated branch or one new nullable field read — never a changed formula, changed status transition, or changed guard condition | §16, §30 |
| Historical orders/invoices/payments remain valid and readable forever | Nothing in this proposal ever rewrites, migrates, or reinterprets an existing row — a record created before this feature ships reads back identically after it ships | §30 |

Every one of these guarantees is re-derived, not merely asserted, for each concrete change proposed in §23
and §30 below — each answers, explicitly: *why it is safe, why it doesn't touch existing production data,
why it preserves historical sales and financial integrity, why it's backward compatible, and why no
existing client needs to change.*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Guiding Design Principles](#3-guiding-design-principles)
4. [The Representative Portal — Product Vision](#4-the-representative-portal--product-vision)
5. [Product Catalog](#5-product-catalog)
6. [Product Search](#6-product-search)
7. [Product Filters](#7-product-filters)
8. [Brand Module](#8-brand-module)
9. [Category Module](#9-category-module)
10. [Homepage CMS](#10-homepage-cms)
11. [Customer Management](#11-customer-management)
12. [Customer Creation](#12-customer-creation)
13. [Customer Status Lifecycle](#13-customer-status-lifecycle)
14. [Shopping Cart & Drafts](#14-shopping-cart--drafts)
15. [Checkout Flow](#15-checkout-flow)
16. [Order Lifecycle — Representative Channel](#16-order-lifecycle--representative-channel)
17. [Notifications](#17-notifications)
18. [Representative Dashboard](#18-representative-dashboard)
19. [Admin Dashboard Enhancements](#19-admin-dashboard-enhancements)
20. [Analytics & Reporting](#20-analytics--reporting)
21. [Security & Access Control](#21-security--access-control)
22. [Future-Ready Capabilities](#22-future-ready-capabilities)
23. [Database Design](#23-database-design)
24. [API Design](#24-api-design)
25. [Migration Plan](#25-migration-plan)
26. [Implementation Checklist](#26-implementation-checklist)
27. [UX Guidelines](#27-ux-guidelines)
28. [Performance & Scalability](#28-performance--scalability)
29. [Appendix A — Business Decisions Required](#29-appendix-a--business-decisions-required)
30. [Appendix B — Compatibility Guarantee, In Detail](#30-appendix-b--compatibility-guarantee-in-detail)
31. [Version 2.1 — Representative Operations, Commission & Collections Layer](#31-version-21--representative-operations-commission--collections-layer)

---

## 1. Executive Summary

### 1.1 The business problem

Electro Mart's sales today happen through two channels, both requiring the buyer to either operate the
back office directly (Admin, walk-in sale entry) or hold their own dealer login (Dealer Portal,
self-service ordering). Neither channel fits how a **field or phone representative** actually sells: a rep
visits or calls a shop, the shop owner has no login and never will, and the rep needs to place the order
*for* them — quickly, from a catalog that looks and feels like something a shop owner would be excited to
browse, not a back-office data-entry screen.

Today that gap is filled informally — a phone call to the office, a WhatsApp message, a hand-written order
passed along later. It doesn't scale past a handful of reps, it has no audit trail, it has no real-time
stock visibility, and it puts the burden of correctly capturing prices, discounts, and credit exposure on
whoever happens to answer the phone.

### 1.2 The solution

A third frontend — the **Representative Portal** — purpose-built for this exact motion: rep logs in, browses
a polished single-vendor catalog (banners, categories, brands, search, filters — the browsing quality of a
consumer marketplace), finds or registers the shop they're selling to, builds an order, and submits it. From
that point on, **the order behaves exactly like a dealer's order does today** — it lands in the same
`PENDING_APPROVAL` queue the Admin already reviews, on the same Order Approval screen, with the same credit
checks, the same invoice generation, the same stock reservation. The rep gets a fast, modern ordering tool;
the business gets a new sales channel without a single new risk surface in its financial core.

### 1.3 Why this does not affect the current backend

This is the load-bearing property of the whole proposal, so it is worth stating plainly up front, before any
design detail: **every schema change in this document is either a brand-new table or a new nullable column
on an existing table, and every new code path is a new branch alongside — never inside — existing
branches.** Section 30 (Appendix B) walks through this claim file-by-file. The short version: the Order,
Invoice, Payment, SalesReturn, and Inventory engines — the parts of the codebase the business has explicitly
called out as untouchable — are not modified. They are *extended with one more caller*, the same way they
already serve both the Dealer Portal and the Admin's own order-entry screen today.

### 1.4 Why this scales

Three things make this a platform, not a one-off feature:

- **The catalog, brand, and category layer is admin-managed CMS, not developer-managed config.** Banners,
  featured products, category/brand ordering, and homepage sections are all editable from the Admin Panel
  without a deploy — the same operational model the business already has for products and dealers.
- **The customer data model is a satellite, not a patch.** Rather than bolting fifteen CRM-style columns
  (WhatsApp, GPS, shop photo, lead status, notes) onto the transactional `Dealer` table, this proposal
  introduces a dedicated `CustomerProfile` extension (§23.3) — so the rich relationship-management surface a
  modern sales team expects can grow freely without ever touching the table `Order`/`Invoice`/`Payment`
  depend on.
- **Nothing here forecloses what comes next.** Route planning, GPS check-ins, commission tracking, offline
  ordering, a customer-facing app — none of it requires re-architecting what's proposed here. Section 22
  spells out exactly why, feature by feature, without pre-building schema for capabilities the business
  hasn't committed to yet (speculative columns are a cost, not a benefit — see §3.4).

---

## 2. System Architecture

### 2.1 Component map

```
                                   ┌───────────────────────────┐
                                   │        PostgreSQL          │
                                   │   (Neon — single database) │
                                   │                             │
                                   │  Shared: Admin, Dealer,     │
                                   │  Product, Category, Order,  │
                                   │  Invoice, Payment, ...      │
                                   │                             │
                                   │  New (this proposal):       │
                                   │  Representative,             │
                                   │  CustomerProfile, Brand,     │
                                   │  Banner, RepOrderDraft, ...  │
                                   └──────────────▲──────────────┘
                                                  │ Prisma
                                   ┌──────────────┴──────────────┐
                                   │      NestJS Backend API      │
                                   │      (single deployment)     │
                                   │                               │
                                   │  Existing modules — UNCHANGED │
                                   │  Orders / Invoices / Payments │
                                   │  / Inventory / Dealers / ...  │
                                   │                               │
                                   │  New modules — ADDITIVE       │
                                   │  Representatives / RepPortal  │
                                   │  / Brands / Banners           │
                                   └───▲──────────▲──────────▲────┘
                                       │          │          │
                       JWT (role: ADMIN) │ JWT (role: DEALER) │ JWT (role: REPRESENTATIVE)
                                       │          │          │
                        ┌──────────────┴──┐ ┌─────┴──────┐ ┌─┴───────────────────┐
                        │   Admin Panel    │ │Dealer Portal│ │ Representative      │
                        │  (existing,      │ │ (existing,  │ │ Portal (NEW —       │
                        │   unchanged)     │ │  unchanged) │ │ separately hosted)  │
                        └──────────────────┘ └─────────────┘ └──────────────────────┘
                                                                          │
                                                                          ▼
                                                              ┌───────────────────────┐
                                                              │  Cloudinary (images)   │
                                                              │  shared across all     │
                                                              │  three frontends       │
                                                              └───────────────────────┘

                        ┌───────────────────────────────────────────────────┐
                        │  Future: Customer-facing Portal (optional, §22)     │
                        │  Would sit at the same layer as Dealer Portal,      │
                        │  reusing the Order/Invoice pipeline identically —   │
                        │  not designed in detail here, but nothing in this   │
                        │  proposal blocks it.                                │
                        └───────────────────────────────────────────────────┘
```

### 2.2 Component responsibilities

| Component | Responsibility | Status |
|---|---|---|
| **Admin Panel** | Full back-office: catalog, inventory, purchasing, dealer management, order approval, invoicing, payments, returns, equity/investor accounting, reporting. Gains new CMS surfaces for banners/brands/featured products (§10) and a small set of additive dashboard widgets (§19) — otherwise untouched. | Existing, extended additively |
| **Dealer Portal** | Self-service ordering for wholesale dealers with their own login. | Existing, **zero changes** |
| **Representative Portal** | New, separately-hosted frontend for internal sales reps: catalog browsing, customer search/registration, cart/draft, checkout, order tracking, personal dashboard. | **New** |
| **Backend API** | Single NestJS deployment, one codebase, serving all three frontends via role-scoped JWTs against the same route-guard mechanism already in place. | Existing, extended additively |
| **Database** | Single PostgreSQL instance. New tables and new nullable columns only (§23). | Existing, extended additively |
| **Cloudinary** | Image storage, already used for product galleries. Gains three new folders: `banners`, `brands`, `customers` (shop photos) — same service, same upload/cleanup pattern already proven in `ProductsService`. | Existing, extended additively |
| **Authentication** | Single JWT/Passport/RolesGuard mechanism. Gains one new role value (`REPRESENTATIVE`) in an enum that already supports exactly this kind of addition (`RefreshToken` is already generic over role). | Existing, extended additively |
| **Future Customer Portal** | Optional, not in scope. A logged-in, self-service portal for the shop itself (place their own reorders, view their own invoices) would sit architecturally where the Dealer Portal sits today, against the same `Order`/`Invoice` pipeline — this proposal's customer data model (§23.3) does not need to change to support it later. | Not designed here — explicitly not foreclosed |

### 2.3 Why one backend, one database

An alternative architecture would stand up a separate service for the Representative Portal — its own
database, its own product/customer replication, syncing back to the ERP. This proposal rejects that
explicitly:

| | Separate service (rejected) | Single shared backend (this proposal) |
|---|---|---|
| Stock accuracy | Requires a sync pipeline; a rep can oversell against stale stock | Reads live `Product.currentStock` — same source of truth as Admin/Dealer |
| Order approval | Needs its own approval workflow, duplicating `OrdersService`'s ~1300 lines of tested logic | Reuses it entirely — a rep order *is* an `Order` row |
| Operational cost | A second deployment, a second database, a sync job to monitor | Zero new infrastructure beyond the frontend itself |
| Data consistency | Two sources of truth for products/pricing/customers, prone to drift | One source of truth |
| Time to ship | Weeks of integration work before the first order can be placed | The order-placement pipeline is already production-tested |

The only cost of the shared-backend approach is architectural discipline — every addition must be provably
additive. Section 3 establishes the rules that provide that discipline; Section 30 shows the receipts.

---

## 3. Guiding Design Principles

Four rules govern every decision in this document. Where a design choice below looks unusual, it is
because one of these rules forced it — each such case is called out explicitly with a **"Why"** note.

**3.1 — Additive only.** Every schema change is a new table, or a new nullable/defaulted column on an
existing table. No existing column is renamed, retyped, or made non-nullable. No existing enum value is
removed or reinterpreted.

**3.2 — New branch, not modified branch.** Every new code path is an additional `if`/`else if` alongside
existing role branches (the pattern `OrdersService.create()` already uses for `ADMIN` vs `DEALER`), or an
additional role in an existing `@Roles(...)` list on a read-only route. No existing branch's behavior
changes.

**3.3 — Satellite tables over shared-table sprawl.** When a new actor (Representative) needs a large amount
of data that doesn't belong to an existing transactional entity, that data gets its own table connected by a
foreign key — not a growing pile of nullable columns bolted onto `Dealer`, `Order`, or `Product`. This is
why customer CRM data lives in `CustomerProfile` (§23.3) rather than directly on `Dealer`.

**3.4 — Future-ready means "not blocked," not "pre-built."** Nothing in this document adds a database
column or a table for a capability the business hasn't committed to (GPS check-ins, commission percentages,
route planning). Section 22 explains, capability by capability, why today's design doesn't need to guess at
those shapes in advance — unused speculative columns are a maintenance cost with no present benefit, and
every one of them is trivial to add additively later, exactly like everything in this document is being
added additively to the system that exists today.

---

## 4. The Representative Portal — Product Vision

The Representative Portal is a **single-vendor B2B ordering application**, not a marketplace. The right
reference points are Amazon Business, Alibaba's buyer-facing browsing experience, Uline, and Grainger — all
of which sell one catalog to logged-in business buyers with a premium browsing experience, not a bazaar of
competing sellers. Concretely:

- **One seller** — Electro Mart. No vendor selection, no seller ratings, no marketplace fees.
- **No public storefront** — behind the rep's login, full stop. No guest browsing, no public product URLs.
- **The buyer is the rep, on behalf of a shop** — every browsing, cart, and checkout decision below is built
  around "I am shopping *for* someone else," which is the one structural difference from a normal storefront
  and the reason the checkout flow (§15) inserts a customer-selection step before order review rather than
  after login.

### 4.1 Homepage

The homepage is the portal's storefront — its job is to get a rep from login to "adding things to a cart"
in the fewest taps, while looking like a product the business is proud to hand a rep in front of a shop
owner. Sections, top to bottom:

| Section | Purpose | Data source |
|---|---|---|
| **Hero banner slider** | Seasonal promotions, new product launches, admin-curated messaging | `Banner` (§23.4), admin-managed |
| **Quick search / global search bar** | Always visible, sticky on scroll — the fastest path for a rep who already knows what they want (§6) | `Product` full-text-style search |
| **Featured categories** | A curated, image-led grid — not the full category list — pointing at the highest-value browsing paths | `Category.isFeatured` + `sortOrder` (§9) |
| **Featured brands** | Logo grid for brand-led browsing (a rep who sells "Samsung TVs" today should reach that catalog in one tap) | `Brand.isFeatured` + `sortOrder` (§8) |
| **New arrivals** | Recently added products | Derived from `Product.createdAt` — **no new column** (§10.4) |
| **Best sellers** | Highest sales-volume products | Derived from `OrderItem` aggregation — reuses the exact aggregation `DashboardService` already runs for its own "top products" widget |
| **Popular products** | Same data source as Best Sellers for MVP (see §10.4 for the future distinction from *browse*-based popularity) | Derived |
| **Recommended products** | MVP: admin-curated (`Product.isFeatured`); future: rule- or AI-based (§22) | `Product.isFeatured` for MVP |
| **Recently added** | Same as New Arrivals, presented as a distinct rail for homepage rhythm | Derived |
| **Offers / promotions** | Products currently carrying a `compareAtPrice` (struck-through "was" price) — a real discount badge, not a marketing label with no backing data | `Product.compareAtPrice` (§23.5) |

All of the above is served by **one aggregated endpoint** (`GET /rep-portal/home`, §24.6) rather than eight
separate calls — a deliberate performance choice explained in §28.1.

### 4.2 Why this is the right level of ambition

The old draft's product surface stopped at "browse and place an order." That is necessary but not
sufficient for a tool reps will actually prefer over a phone call — the difference between "a form to place
an order" and "a catalog reps enjoy showing a shop owner" is exactly the set of sections above. None of it
requires new financial logic; all of it is presentation and curation on top of data the system either
already has (products, categories) or gains as small, purpose-built additions (brands, banners, feature
flags).

---

## 5. Product Catalog

### 5.1 Product card (grid/list view)

| Element | Source | Notes |
|---|---|---|
| Primary image + hover/swipe gallery | `Product.imageUrl` + `ProductImage[]` (existing) | Already supports up to 5 images per product |
| Product name, brand, category | `Product.name/brand/category` (existing) | |
| Price | `Product.retailPrice ?? Product.wholesalePrice` (§23.5) | See §5.4 for the pricing decision |
| Compare-at / "was" price + discount badge | `Product.compareAtPrice` (§23.5) | Badge shown only when `compareAtPrice > price` |
| "New" badge | Derived: `createdAt` within a configurable window (default 30 days) | No schema needed |
| Stock / availability badge | `Product.currentStock` via the existing `isOutOfStock` flag `ProductsService` already computes | Reused as-is |
| Quick Add (+ quantity stepper) | Client-side cart action | Adds to the active draft (§14) without leaving the grid |
| Wishlist toggle | `CustomerWishlistItem` (§23.8, Phase 3) | See §22 — not MVP |

### 5.2 Product detail page

Everything the card shows, plus:

- Full image gallery (existing `ProductImage[]`)
- Specifications block: brand, model, category, warranty (`Product.warranty`, existing — currently
  captured but not surfaced anywhere customer-facing; this is its first real use)
- Description (`Product.description`, existing)
- Related products — same category, excluding self
- Recommended products — MVP: same brand + `isFeatured`; future: behavior-based (§22)
- Recently viewed — **client-side only** for MVP (localStorage), no backend needed; a `ProductView` log is a
  clearly-scoped future addition if server-side "recently viewed across devices" is wanted
- Product comparison — explicitly future-ready (§22): the product grid's checkbox-to-compare UI pattern
  needs no backend support beyond the product list endpoint that already exists

### 5.3 Cost price stays hidden

`ProductsController.hideCostPriceForDealer()` already strips `costPrice` from every response returned to a
`DEALER`. This proposal renames it to a role-neutral `hideCostPrice()` and adds `REPRESENTATIVE` to the
roles it strips for — one function, one new branch, zero risk (§3.2).

### 5.4 Pricing decision: `retailPrice` and `compareAtPrice`

Today there is exactly one customer-facing price, `wholesalePrice`, used identically by the Admin and every
Dealer. A rep-portal customer is structurally closer to a retail/individual buyer than a wholesale dealer —
they may reasonably be quoted a different (typically higher) price.

**Proposal**: add `Product.retailPrice Decimal?` (nullable — falls back to `wholesalePrice` when unset, so
every existing product is priced correctly for reps from day one with zero data entry required) and
`Product.compareAtPrice Decimal?` (nullable — a "was" price for the discount-badge/offers experience in
§4.1 and §5.1). Both are additive nullable columns; `wholesalePrice` and every dealer/admin code path that
reads it is untouched. This is flagged in §29 as a business decision to confirm (does the business in fact
want a different retail price tier?) — the schema supports either answer without rework.

---

## 6. Product Search

| Search axis | Backing field | Notes |
|---|---|---|
| Product name | `Product.name` | existing, already indexed via the products search endpoint |
| SKU | `Product.sku` | existing |
| Barcode | `Product.barcode` | existing |
| Brand | `Product.brand` | existing |
| Category | `Product.category` | existing |
| Model | `Product.model` | **new to search** — the field exists today but `ProductsService.findAll`'s search clause doesn't currently include it; adding it is a one-line, zero-risk change to the `OR` clause (used only by the rep-portal read path, or optionally backported to the shared endpoint since it only *adds* matches, never removes any existing ones) |
| Keyword (free text) | Name + description + brand + category + model combined | Same `contains`/`insensitive` pattern already used throughout the codebase (`DealersService`, `ProductsService`, etc.) |

**Instant search / autocomplete**: a lightweight, debounced call against the existing search endpoint,
capped to 5–8 results with just image + name + price — no new backend capability, purely a frontend
interaction pattern.

**Recent searches**: client-side (localStorage), scoped per rep device — no backend needed for MVP.

**Popular searches**: requires knowing what other reps searched, which by definition needs server-side
logging. Proposed as a Phase 2 addition — a minimal `SearchLog { id, repId, term, resultCount, createdAt }`
table, written fire-and-forget (never blocking the search response), aggregated into a top-N list on a
schedule. Explicitly not MVP (§25) — it has no dependency on anything else in this document and can be added
at any point without touching a single existing table.

---

## 7. Product Filters

| Filter | Backing | Notes |
|---|---|---|
| Category | `Product.category` | existing |
| Brand | `Product.brand` | existing field, newly filterable once the Brand module (§8) gives brands a curated, canonical list |
| Price range | `retailPrice`/`wholesalePrice` | new field, existing query-range pattern |
| Availability (in stock / out of stock) | `currentStock` | existing — `ProductsService` already supports `outOfStockOnly` |
| Sort: Newest | `createdAt desc` | existing default order, already used |
| Sort: Popular | `OrderItem` quantity aggregation | derived, same pattern as Dashboard's top-products query |
| Sort: Alphabetical | `name asc` | trivial |
| Sort: Recently added | same as Newest | alias |

All filters compose via the same `Prisma.ProductWhereInput` builder pattern `ProductsService.findAll`
already uses — this is a query-shape extension, not a new query engine.

---

## 8. Brand Module

Today, `Product.brand` is a free-text string with no backing table — there is no brand logo, no brand page,
no curated "featured brands" list, and no protection against "Samsung" and "SAMSUNG" being treated as two
different brands.

### 8.1 Design: mirror the existing `Category` pattern exactly

Electro Mart's codebase already solved this *exact* problem for categories: `Category` is a small curated
table (`id`, `name`, `createdAt`) that exists purely to drive an admin picker and a rename cascade —
`Product.category` itself stays a denormalized string, and `CategoriesService.update()` bulk-updates every
matching `Product.category` value when a category is renamed, with delete blocked while any product still
references it.

**Proposal: `Brand` replicates this pattern precisely**, extended with the presentation fields a brand page
needs: `logoUrl`, `imageUrl` (banner/hero image for the brand page), `description`, `status`, `sortOrder`,
`isFeatured`. `Product.brand` **remains a free-text string**, exactly as today — `BrandsService.update()`
gets the identical rename-cascade guard `CategoriesService` already has, verbatim in structure. `Product.brand`
is never turned into a foreign key.

**Why not a real foreign key?** A `brandId` FK would be the "cleaner" textbook design, but it requires a
migration that reclassifies every existing product's brand string into a relation — real work, real risk,
and a change to `Product` that has nothing to do with Representative Portal functionality. The
denormalized-string-plus-curated-table pattern the codebase already trusts for `Category` achieves the same
user-facing outcome (a manageable brand list, consistent naming, a brand page) with **zero migration risk**
and **zero new query complexity** anywhere `Product.brand` is already read. This is principle 3.1 in
practice: reuse a proven additive pattern instead of introducing a new kind of risk to hit a marginally
"purer" data model.

### 8.2 Brand page

`GET /brands/:id` (or `/slug`) → brand hero image + description + the product grid filtered to that brand
name, using the exact same product-list endpoint and pagination every other catalog view uses.

---

## 9. Category Module

### 9.1 What's added

| New field | Type | Purpose |
|---|---|---|
| `imageUrl` | `String?` | Category tile image for the homepage/catalog grid |
| `iconUrl` | `String?` | Small icon for compact nav/filter chips |
| `sortOrder` | `Int @default(0)` | Admin-controlled display order (§10) |
| `isFeatured` | `Boolean @default(false)` | Drives the homepage's "Featured Categories" rail |
| `slug` | `String? @unique` | SEO-friendly URL segment — future-ready, unused by MVP routing which can key off `id` |
| `parentId` | `String?` (self-relation) | Future-ready subcategory support (e.g. "TVs" → "Smart TVs", "LED TVs") — nullable, so every existing category is implicitly top-level with no migration needed |

Every one of these is additive and defaulted/nullable — existing categories render exactly as they do today
(no image, natural sort by name as `CategoriesController` already does) until an admin opts in via the new
CMS screen (§10).

### 9.2 Why `parentId` now, even though subcategories aren't in scope

This is the one deliberate exception to principle 3.4 ("don't pre-build for the future"), and it's worth
justifying rather than just listing: a self-relation nullable FK costs nothing today (every row simply has
`parentId: null`) but is the one category-schema change that is **not** safely addable after products have
already been organized into a flat list without breaking the mental model reps and admins have built up
("is this category actually a subcategory I should have nested?"). Every other future item in §22 is left
out precisely because it *can* wait; this one column is cheap insurance against a much more disruptive
reorganization later. If the business is confident a flat category list is permanent, this column can be
dropped from the plan with no effect on anything else in this document.

---

## 10. Homepage CMS

The explicit goal: an admin manages banners, featured products, category/brand order, and homepage sections
**without developer involvement**, the same operating model the business already has for products and
dealers today.

### 10.1 Admin Panel additions (all additive — new screens, no changes to existing ones)

| Screen | Backed by | Admin can |
|---|---|---|
| Banner manager | `Banner` (§23.4) | Upload/reorder/activate/deactivate hero slides, each optionally linking to a category, brand, product, or external URL |
| Brand manager | `Brand` (§23.6) | Create/edit/reorder/feature brands, upload logo + hero image |
| Category manager (extended) | `Category` + new fields | Upload category image/icon, set `sortOrder`, toggle `isFeatured` — added to the **existing** category screen, not a new one |
| Featured products picker | `Product.isFeatured` (§23.5) | Toggle which products appear in "Recommended"/"Featured" homepage rails |

### 10.2 What is *not* a new CMS concept

"New Arrivals," "Best Sellers," and "Popular Products" are **not** admin-curated lists — they're computed
(§4.1, §10.4) from data the system already has. This is a deliberate simplification: fewer CMS screens for
the admin to maintain, no stale "best sellers" list that quietly stops reflecting reality, and one less
place data can drift out of sync with what's actually selling.

### 10.3 Homepage sections

"Homepage sections" (the ability to reorder the rails themselves — banners above categories, or vice versa)
is scoped as a simple ordered list of section keys (`['banners', 'featuredCategories', 'newArrivals', ...]`)
stored as a single small config row rather than a bespoke table per section — the *content* of each section
is already fully data-driven per the table above; only the *order* needs to be configurable, and a single
`HomepageLayout { key: 'default', sectionOrder: String[] }` row (or even a `.json` config field) is enough.
Not a structurally significant addition — flagged here for completeness, not because it needs its own deep
design.

### 10.4 Derivation rules (so "New Arrivals" and "Best Sellers" behave predictably)

- **New Arrivals**: `Product.status = ACTIVE ORDER BY createdAt DESC LIMIT N`, optionally windowed to "added
  in the last 30 days" so the rail doesn't silently include six-month-old stock once nothing newer exists.
- **Best Sellers / Popular**: `OrderItem` grouped by `productId`, summed by `quantity`, scoped to
  fulfillment-stage statuses — **the exact query `DashboardService.getAdminSummary()` already runs** for its
  own top-products widget, reused rather than reinvented. For MVP, "Popular" and "Best Sellers" are the same
  computation; a future *browse*-based popularity signal (view counts) is a distinct, optional enhancement
  (§22) that would sit alongside this without replacing it.

---

## 11. Customer Management

A representative's two core lookups: *find a shop I've sold to before*, or *this is a new shop*. Both need
to be fast, forgiving of partial/misremembered input, and resistant to accidentally creating duplicate shop
records.

### 11.1 Search

`GET /rep-portal/customers?search=` searches across:

| Field | Source |
|---|---|
| Phone | `Dealer.phone` |
| Shop name | `Dealer.businessName` |
| Owner name | `Dealer.ownerName` |
| Area | `CustomerProfile.area` (§23.3) |
| City | `CustomerProfile.city` (§23.3) |

Scoped by default to `Dealer.source = REP_PORTAL` (§23.2) — a rep searching for "shops I or my colleagues
have registered" should not surface Electro Mart's real wholesale dealer accounts, which are a different
business relationship with real credit lines and their own portal login. (Whether reps should *also* be able
to find and order for an existing wholesale dealer is flagged as an open decision in §29 — the search query
is a one-line change either way.)

**Representative** is also a search/filter axis at the admin level — "show me every shop rep X registered"
— via `CustomerProfile.assignedRepId` / `Dealer.createdByRepId` (§29 open question resolves which of the two
is authoritative; see §23.3).

### 11.2 Customer profile view

| Section | Data |
|---|---|
| Identity | Shop name, owner, phone, WhatsApp, email, address, city/district/province |
| Financial | Outstanding balance, credit limit (both existing `Dealer` fields — a rep-registered shop's credit posture is governed by the same fields and the same `assertWithinCreditLimit()` gate every dealer order already goes through) |
| Orders | Previous orders, pending orders, recent purchases — all standard `Order` queries filtered by `dealerId`, identical in shape to what `DealersService.findOne()` already returns for the Admin Panel |
| Status | Lead / New / Regular / VIP / Blocked / Inactive (§13) |
| Location | City/district/province text fields; optional GPS pin (`CustomerProfile.latitude/longitude`) |
| Timeline | Merged view of `CustomerNote` entries and order milestones — see §11.3 |
| Notes | Free-text notes a rep leaves after a visit or call |

### 11.3 Customer timeline

A rep needs a single scroll of "everything that's happened with this shop" — visit notes, status changes,
and order events, chronologically merged. This reuses a pattern already proven in this codebase:
`EquityService.getHistory()` merges `Investment` and `Expense` rows into one paginated timeline via a single
`UNION ALL` SQL query rather than fetching both tables and stitching them together in application code. The
customer timeline does the same thing across `CustomerNote` and `Order` (keyed by `createdAt`/status-change
timestamps), for the same reason: correct pagination across two source tables without a fetch-everything
performance cliff as either table grows.

### 11.4 Duplicate detection

Before creating a new shop record, `POST /rep-portal/customers` checks for an existing `source: REP_PORTAL`
`Dealer` with the same phone number and, if found, returns `409 Conflict` with a pointer to the existing
record instead of silently creating a duplicate. This is an exact-match guard for MVP (phone number is the
most reliable natural key a rep will have on hand); a softer name-similarity warning ("a shop named
'Electro City' already exists nearby") is flagged as a Phase 2 refinement (§22) rather than MVP scope — fuzzy
matching is a genuine design problem in its own right (which similarity threshold, which fields to weight)
and doesn't need to block the first release.

---

## 12. Customer Creation

`POST /rep-portal/customers` — the form a rep fills in for a brand-new shop, mapped to fields:

| Field | Required | Backing |
|---|---|---|
| Shop name | ✅ | `Dealer.businessName` |
| Owner name | ✅ | `Dealer.ownerName` |
| Phone | ✅ | `Dealer.phone` |
| WhatsApp | optional | `CustomerProfile.whatsapp` |
| Email | optional | `Dealer.email` |
| Address | optional | `Dealer.address` |
| City | optional | `CustomerProfile.city` |
| District | optional | `Dealer.district` (existing field, reused as-is) |
| Province | optional | `CustomerProfile.province` |
| Google Maps location | optional, future-ready | `CustomerProfile.latitude`/`longitude` — nullable from day one, so a "pin the shop on the map" UI can be added to the rep app whenever the business wants it without any backend change |
| Shop photo | optional, future-ready | `CustomerProfile.shopPhotoUrl` — same Cloudinary pattern as product images, new folder `customers/` |
| Business registration number | optional, future-ready | Deliberately **not added to the schema yet** — no current use case reads it, and it's a one-line additive migration whenever one exists (principle 3.4) |

On success, the server builds a full `Dealer` row behind the scenes (`source: REP_PORTAL`,
`createdByRepId`, auto-generated hidden `username`/`password` — the shop never logs in, so these are never
surfaced in any response) plus a paired `CustomerProfile` row for the CRM fields, and a default credit
posture per §29.2.

---

## 13. Customer Status Lifecycle

| Status | Meaning |
|---|---|
| `LEAD` | A prospect a rep has identified but hasn't sold to yet — exists in the system, may have zero orders |
| `NEW` | Just placed their first order (or was just registered with intent to order immediately) |
| `REGULAR` | Established, ordering pattern is routine |
| `VIP` | High-value or strategically important account |
| `BLOCKED` | Business has stopped selling to this shop (bad debt, dispute, etc.) — **does not reuse
  `AccountStatus`** (§13.1) |
| `INACTIVE` | Dormant — no recent activity, kept for history/reactivation rather than deleted |

Backed by a new `CustomerStatus` enum on `CustomerProfile` (§23.3) — set manually by a rep/admin today, with
`LEAD → NEW` transition candidates for later automation (e.g. auto-promote on first completed order) once
the business has opinions about exactly when that should happen.

### 13.1 Why this is a new enum, not a reuse of `AccountStatus`

`Dealer.status` already exists (`AccountStatus: ACTIVE | INACTIVE`) and gates whether the shop's `Order`s
can even be created (`OrdersService.create()` checks it today for every dealer, and would for a rep-created
shop too, since it *is* a `Dealer` row). That's a **binary operational switch** — can this account transact
at all — and changing its meaning or adding values to it risks interacting with that existing gate in
ways that are hard to reason about. `CustomerStatus` is a **CRM classification** layered on top, answering a
completely different question ("how do we think about this relationship"), lives on the new
`CustomerProfile` satellite table, and has zero interaction with whether an order can actually be placed —
that's still governed exclusively by the existing `Dealer.status`/credit-limit machinery, untouched.
(`BLOCKED` here is a sales-classification signal for the rep's own awareness; actually preventing new orders
from a shop is still done the existing way, by setting `Dealer.status = INACTIVE`.)

---

## 14. Shopping Cart & Drafts

### 14.1 The cart, and why it needs a server-side home here (unlike the Dealer Portal's)

The Dealer Portal's cart today is purely client-side state — a dealer builds their cart and submits in one
sitting. The Representative Portal's requirements are different in a way that matters: a rep may build a
cart mid-visit, get interrupted, switch to a different shop, or want to prepare an order in advance of a
scheduled call — and expects to find it again later, from any device. That needs server persistence.

**Proposal**: a new `RepOrderDraft` + `RepOrderDraftItem` pair (§23.9) — a lightweight, rep-owned scratch
space that is **not** an `Order` row and has **no interaction with `OrderStatus`, stock reservation, credit
checks, or invoicing** until the rep explicitly submits it. A draft can exist before a customer is even
selected (items added while browsing), gets a `dealerId` attached at the customer-selection step of checkout
(§15), and is deleted the moment it's successfully promoted into a real `Order` via the existing
`OrdersService.create()` pipeline.

### 14.2 Why not just add a `DRAFT` value to `OrderStatus`

This is worth spelling out because it's the more "obvious" design and the one this proposal deliberately
avoids. `OrderStatus` today drives several pieces of logic that all implicitly assume every row in the
`Order` table is a real, financially-relevant transaction:

- `IN_FLIGHT_ORDER_STATUSES` (credit-limit exposure calculation)
- `NEXT_STATUS` / `TIMESTAMP_FIELD` maps (the Packed→Delivered→Completed state machine)
- The Admin's Orders List status filter and the Order Approval queue
- `findAllForAdmin`/`findAllForDealer` — every list a Dealer or Admin sees today

Adding `DRAFT` to that enum means auditing every one of those call sites to make sure a draft never
accidentally counts toward credit exposure, never shows up in the Admin's pending-approval queue, and never
trips a status-transition guard expecting the state machine to start at `PENDING_APPROVAL`. That is real,
non-trivial risk to code the business has explicitly asked not to touch, in exchange for what is ultimately
just "a place to save unsubmitted cart contents." A separate table sidesteps all of it: a draft simply isn't
an `Order`, so none of that logic needs to know it exists. This is principle 3.1 and 3.2 working together —
the "obvious" shared-enum design fails principle 3.2 (new branch, not modified branch), so the satellite
table wins even though it's one extra table.

The same reasoning is why **`CANCELLED`** (requested as a future-ready status) is deliberately *not* added
to `OrderStatus` in this proposal — it's flagged in §22 as something that needs its own focused design pass
through the exact same call sites, when the business actually needs it, rather than being added speculatively
now.

### 14.3 Cart/draft capabilities

| Capability | Mechanism |
|---|---|
| Edit quantities, remove items | Standard CRUD on `RepOrderDraftItem` |
| Save Draft | The draft *is* the save — no explicit "save" action needed, it persists as soon as an item is added |
| Order notes / special instructions | `RepOrderDraft.notes` — copied onto `Order.notes` at submission (§14.4) |
| Expected delivery date | `RepOrderDraft.expectedDeliveryDate` — copied onto `Order.expectedDeliveryDate` at submission |
| Multiple saved drafts | A rep may have more than one open draft (e.g. prepared for several upcoming shop visits) — no artificial single-cart limit |
| Offline draft | Future-ready (§22) — the draft's flat, simple shape (a header + line items) is exactly the shape a local-first/offline sync layer would want, whenever that's built |

### 14.4 New fields on `Order` itself

`notes String?` and `expectedDeliveryDate DateTime?` are proposed as additive nullable columns on the
**existing** `Order` table (§23.7) — not rep-exclusive. They're generically useful (an admin recording a
walk-in sale might want a note too) and cost nothing for the Dealer Portal or Admin's existing order paths,
which simply never set them and never see them referenced in any of their current screens or logic.

---

## 15. Checkout Flow

```
 ① Customer Selection        ② Cart Review           ③ Order Notes            ④ Summary                ⑤ Confirmation           ⑥ Success
 ───────────────────         ──────────────           ───────────────          ─────────                ──────────────           ────────
 Search existing shop    →   Adjust quantities   →    Special instructions →   Subtotal, item list, →   Explicit "Place    →     Order number,
 or register new shop        Remove items              Expected delivery        credit/limit check        Order" action            "Pending Approval"
 (§11 / §12)                 attached to draft          date                    surface (read-only —      submits the draft        state, link to
                                                                                 no discount authority,    via OrdersService.        track this order
                                                                                 per §16.2)                 create() (§16)
```

Each step maps to existing or newly-proposed backend calls:

| Step | Backend interaction |
|---|---|
| ① Customer Selection | `GET /rep-portal/customers?search=` or `POST /rep-portal/customers`; result attaches `dealerId` to the active `RepOrderDraft` |
| ② Cart Review | `PATCH /rep-portal/drafts/:id` (items) |
| ③ Order Notes | `PATCH /rep-portal/drafts/:id` (notes, expectedDeliveryDate) |
| ④ Summary | `GET /rep-portal/drafts/:id` — a read-only pricing preview computed the same way `OrdersService.buildItemsAndSubtotal()` prices a real order, so the number a rep sees here is never a surprise once submitted |
| ⑤ Confirmation | `POST /rep-portal/orders` — the one call that actually creates a real `Order` row (§16) |
| ⑥ Success | Order number + status returned by the same call, drafts deleted |

This mirrors the Dealer Portal's existing Cart → Order Confirmation shape (per `README.md`'s screen list)
with exactly one structural addition — the customer-selection step — which is the one genuinely new thing
about this buying flow.

---

## 16. Order Lifecycle — Representative Channel

### 16.1 A rep-placed order is a real `Order` row, full stop

Once submitted, a rep's order is indistinguishable in kind from a dealer's own order — same table, same
`OrderStatus` enum, same `Invoice`/`Payment`/`SalesReturn`/`InventoryLog` machinery. The **only** difference
is provenance: `Order.createdByRepId` is set (§23.7), exactly mirroring how `Order.createdByAdminId` already
distinguishes an admin-recorded walk-in sale from a dealer's own submission.

```
 PENDING_APPROVAL ──approve()──▶ APPROVED ──status──▶ PACKED ──status──▶ DELIVERED ──status──▶ COMPLETED
        │                                    (existing Admin Order Approval screen — unchanged)
        └──reject()──▶ REJECTED
```

### 16.2 Why `PENDING_APPROVAL`, not auto-approved like the Admin's direct-entry path

`OrdersService.create()` already has two behaviors depending on requester role: a **Dealer's** own order
always starts `PENDING_APPROVAL`; an **Admin** creating an order on a dealer's behalf can apply a discount
and is auto-approved inline. A rep-placed order adopts the **Dealer** behavior, not the Admin one — a rep is
staff acting on a shop's behalf, structurally the same position a dealer is in when submitting their own
order, and specifically *not* in the position of ownership/authority an admin has to bypass the approval
checkpoint. Concretely: `OrdersService.create()` gains one additional `else if (requester.role ===
Role.REPRESENTATIVE)` branch that behaves like the existing `DEALER` branch (starts `PENDING_APPROVAL`, no
discount authority) with one difference — it stamps `createdByRepId` instead of relying on `dealer.id ===
requester.id`, since the rep is not the dealer. This is the smallest possible change to the function: one
new branch, the two existing branches (`ADMIN`, `DEALER`) untouched (principle 3.2).

This also means the **existing Admin Order Approval screen requires zero changes** to handle rep-placed
orders on day one — a rep's order simply appears in the same pending queue, with the same credit-limit
gate (`assertWithinCreditLimit()`, unmodified) already protecting the business exactly as it does for every
dealer order today.

### 16.3 Status visibility for the rep

`GET /rep-portal/orders` — the rep's own placed orders (`createdByRepId = requester.id`), same
status-filter/pagination shape `findAllForDealer` already provides. Each order's detail view includes a
visual timeline (`Order.approvedAt/rejectedAt/packedAt/deliveredAt/completedAt` — all existing fields,
simply rendered as a timeline rather than a flat status label).

---

## 17. Notifications

| Event | Channel (MVP) | Channel (future) |
|---|---|---|
| Order approved | Email to the rep (new `MailerService` method, same pattern as `notifyDealerOrderApproved`) | Push notification |
| Order rejected | Email to the rep, with reason | Push notification |
| Order packed / delivered | Rep checks their own Orders list (no email needed at MVP — dealer-facing delivery emails already exist for the dealer's own visibility; a rep-facing equivalent is a small additive mailer method if wanted) | Push notification |
| Payment reminder | N/A — a rep-registered shop's payment collection is handled the same way any dealer's is today, through the existing Admin Payments screen | Future — flagged in §22, requires the same push infrastructure as above |

**Push notifications** are explicitly a Phase 2/3 capability (§22) — they require genuinely new
infrastructure (Web Push + a service worker, or a mobile push provider), not just an additive column. When
built, they'd be backed by a small additive `PushSubscription`/`DeviceToken` table and would sit entirely
alongside the existing `MailerService`, which continues to handle every email notification exactly as it
does today.

---

## 18. Representative Dashboard

`GET /rep-portal/dashboard` — a rep's personal landing view, mirroring the shape
`DashboardService.getDealerSummary()` already returns for a dealer, scoped to `createdByRepId`:

| Metric | Source |
|---|---|
| Today's orders | `Order` count, `createdByRepId`, `createdAt` today |
| Monthly orders | Same, current calendar month |
| Pending orders | `Order` count, `status: PENDING_APPROVAL` |
| Completed orders | `Order` count, `status: COMPLETED` |
| Revenue (this rep's completed orders) | `Order.totalAmount` sum, `status: COMPLETED` |
| Target progress | Future-ready (§22) — requires the business to define what a "target" is (revenue? order count? per rep or per team?) before it can be modeled; no schema exists for it yet by design |

---

## 19. Admin Dashboard Enhancements

All additive to the existing `GET /dashboard/admin` response (new fields alongside the existing ones — no
existing field removed or renamed) or new, separate endpoints, entirely optional for the Admin Panel to
adopt on its own schedule:

| Widget | Query shape |
|---|---|
| Top Representatives | `Order` grouped by `createdByRepId`, summed `totalAmount`, `status: COMPLETED` |
| Top Customers (rep channel) | `Order` grouped by `dealerId` where `dealer.source = REP_PORTAL` |
| Top Products (rep channel) | Same `OrderItem` aggregation `DashboardService` already runs, filtered to orders with `createdByRepId IS NOT NULL` |
| Sales by Representative | Time-bucketed `Order.totalAmount` sum, grouped by `createdByRepId` — same `date_trunc` raw-SQL pattern already used for the existing monthly revenue chart |
| Orders by Representative | Count, same grouping |
| Customer Acquisition (rep channel) | `Dealer` count where `source = REP_PORTAL`, grouped by `createdAt` month — "how many new shops did we bring on this month" |
| Average Order Value | `Order.totalAmount` average, filterable by channel (rep vs dealer vs admin-direct) — a genuinely useful cut the Admin doesn't have today at all, cheap to add once `createdByRepId` exists |

---

## 20. Analytics & Reporting

| Report | Derivation |
|---|---|
| Customer growth | `Dealer.createdAt` trend, split by `source` |
| Representative performance | Orders/revenue by `createdByRepId` over time — same shape as §19's rep widgets, presented as a trend rather than a snapshot |
| Product popularity | `OrderItem` aggregation — same pattern used throughout (Dashboard, Homepage best-sellers, this report) |
| Category performance | `OrderItem` joined to `Product.category`, summed |
| Brand performance | `OrderItem` joined to `Product.brand`, summed — meaningfully improved by the Brand module (§8) giving brand names a canonical, de-duplicated form |
| Monthly trends | Time-bucketed versions of all of the above, reusing the existing `date_trunc` raw-SQL pattern from `DashboardService`'s revenue chart |

None of this needs a new analytics engine — it's the same aggregation toolkit (`groupBy`, `aggregate`, and
occasional raw `date_trunc` SQL for time-series) already used by `DashboardService`, `SalesAnalysisService`,
and `EquityService` today, pointed at the new `createdByRepId`/`source`/Brand data.

---

## 21. Security & Access Control

| Control | Mechanism |
|---|---|
| Authentication | Same JWT/Passport mechanism, one new role value (`REPRESENTATIVE`) |
| Authorization | Same `RolesGuard` + `@Roles(...)` — reps get a deliberately curated, separate set of routes (`RepPortalModule`) rather than a widened role list on every existing controller, so the surface a rep can reach is obvious at a glance and doesn't require re-auditing every existing admin/dealer route |
| Session invalidation | `JwtStrategy.validate()`'s live status re-check (today `DEALER`-only) gains a matching `REPRESENTATIVE` branch — deactivating a rep invalidates their live token immediately, same guarantee dealers already have |
| Cost price protection | `hideCostPrice()` (renamed from `hideCostPriceForDealer()`, §5.3) strips `costPrice` for `REPRESENTATIVE` exactly as it does for `DEALER` |
| Representative permissions | MVP: a single flat `REPRESENTATIVE` role — no per-rep permission tiers. Fine-grained permissions (e.g. a senior rep with discount authority) are explicitly future-ready (§22), not needed given §29's recommendation that no rep carries discount authority |
| Activity logging | `ActivityLog` gains a nullable `repId` alongside the existing (now-nullable) `adminId` — every action a rep takes that matters for audit (customer creation, order submission) is logged through the same `ActivityLogService.log()` every other module already uses |
| Audit trail | The combination of `ActivityLog` + `Order.createdByRepId` + `Dealer.createdByRepId` gives a complete "who did what, when" trail with no new logging mechanism |
| Rate limiting | Existing global `ThrottlerGuard` (100 req/min) applies automatically; revisit only if catalog-browsing traffic patterns from the new frontend warrant a separate limit |
| Session management | Existing generic `RefreshToken` table (already keyed by `{ role, userId }`) requires no changes to support a third role |
| CORS | The Representative Portal's deployed origin is added to the existing comma-separated `CORS_ORIGIN` env var — an operations change, not a code change |

---

## 22. Future-Ready Capabilities

For each item requested for future consideration: what it would need, and — critically — confirmation that
nothing in this proposal blocks it later (principle 3.4: future-ready means *not blocked*, not *pre-built*).

| Capability | What it would eventually need | Blocked by this proposal? |
|---|---|---|
| Offline ordering | Local-first storage + sync layer on top of the `RepOrderDraft` shape (§14.2) — the draft's flat header+items structure is already sync-friendly | No |
| Barcode scanning | Frontend camera integration hitting the existing `Product.barcode` search field (§6) | No |
| QR code ordering | A QR payload encoding a product ID or a pre-filled draft link | No |
| Voice search | Frontend speech-to-text feeding the existing search endpoint | No |
| AI product search / AI recommendations | A ranking layer on top of the existing search/recommendation endpoints — additive, doesn't replace the rule-based MVP behavior (§4.1, §10.4) | No |
| Customer wishlist | `CustomerWishlistItem { dealerId, productId, addedByRepId }` — small additive join table (§23.8) | No |
| Favourite products (rep) | `RepFavoriteProduct { repId, productId }` — small additive join table | No |
| Favourite customers (rep) | `RepFavoriteCustomer { repId, dealerId }` — small additive join table | No |
| Customer visit tracking | A `CustomerVisit` log table, keyed to `CustomerProfile` — layers naturally on the timeline pattern already established in §11.3 | No |
| Commission module | Needs the business to define the commission model first (flat? tiered? per-product?) before any schema is meaningful — `Order.createdByRepId` is already the join key any commission report would need | No |
| GPS check-in | `RepCheckIn { repId, dealerId, latitude, longitude, createdAt }` — trivial additive table once `CustomerProfile.latitude/longitude` (§12) exists as the "where the shop actually is" reference point | No |
| Route planning | A genuinely new capability (route optimization) — consumes `CustomerProfile` location data as an input, doesn't require changing it | No |
| Delivery tracking | Layers onto the existing `Order` status timeline (`packedAt`/`deliveredAt`) — could add granular waypoint tracking as a new table if the business adopts its own delivery fleet | No |
| Mobile app | Same backend API, same JWT auth — a mobile client is just another frontend consumer, identical in principle to the Representative Portal itself being "a new frontend on the same backend" | No |
| Progressive Web App | A build/deployment characteristic of the Representative Portal frontend, not a backend concern at all | No |
| Push notifications | `PushSubscription`/`DeviceToken` table + Web Push or FCM/APNs integration, sitting alongside (not replacing) the existing `MailerService` | No |

---

## 23. Database Design

All changes are additive: new tables, or new nullable/defaulted columns on existing tables. No existing
column, index, or constraint is altered or removed.

### 23.1 New enums

```prisma
enum Role {
  ADMIN
  DEALER
  REPRESENTATIVE          // NEW
}

enum DealerSource {        // NEW
  DEALER_PORTAL             // default — every existing row
  REP_PORTAL
}

enum CustomerStatus {       // NEW
  LEAD
  NEW
  REGULAR
  VIP
  BLOCKED
  INACTIVE
}

enum BannerLinkType {       // NEW
  NONE
  CATEGORY
  PRODUCT
  BRAND
  EXTERNAL_URL
}
```

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | `ADD VALUE` on `Role` and four brand-new enum types are pure additions — Postgres enum creation and value addition never touch a single existing row |
| 2 | Why no effect on existing production data? | No existing table references these new enums; no existing row's `Role` value changes |
| 3 | Why historical sales preserved? | Not referenced by `Order`, `Invoice`, or `Payment` at all |
| 4 | Why financial integrity preserved? | Zero interaction with any financial table or calculation |
| 5 | Why backward compatible? | Existing code that switches on `Role` (`RolesGuard`, `JwtStrategy`) already treats an unrecognized-to-it role as "not authorized" by default — adding a value it doesn't check for changes nothing about how `ADMIN`/`DEALER` are handled |
| 6 | Why no client changes needed? | Admin Panel and Dealer Portal never construct or inspect these new enum values |

### 23.2 `Dealer` — two new columns

```prisma
model Dealer {
  // ...every existing field, unchanged...
  source          DealerSource @default(DEALER_PORTAL)   // NEW
  createdByRepId  String?                                 // NEW
  createdByRep    Representative? @relation("DealerCreatedByRep", fields: [createdByRepId], references: [id])  // NEW
  customerProfile CustomerProfile?                        // NEW — 1:1 satellite, see 23.3

  @@index([source])   // NEW
}
```

Every existing `Dealer` row implicitly becomes `source: DEALER_PORTAL` (the enum default) — no backfill
migration needed, no change to how any existing query filters or displays dealers.

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | `ADD COLUMN ... DEFAULT 'DEALER_PORTAL'` and `ADD COLUMN "createdByRepId" TEXT NULL` are both single-pass, non-locking operations on modern Postgres (a defaulted/nullable column add does not rewrite the table) |
| 2 | Why no effect on existing production data? | Every existing dealer row is populated with the default automatically; no existing value in any existing column changes |
| 3 | Why historical sales preserved? | `Order.dealerId` — the FK every historical order/invoice/payment is keyed on — is untouched; a historical order still points at the exact same `Dealer` row it always did |
| 4 | Why financial integrity preserved? | `creditLimit`, `outstandingBalance`, `unlimitedCredit`, `status` — every field `assertWithinCreditLimit()` and the payment/return balance logic reads — are unchanged in name, type, and semantics |
| 5 | Why backward compatible? | `DealersService`/`DealersController` (the Admin's existing dealer screens) never select or filter on `source`/`createdByRepId` — they continue to see and manage the exact same set of dealers, the exact same way |
| 6 | Why no client changes needed? | The Admin Panel's dealer list/detail API responses gain two fields it doesn't render — additive JSON fields are ignored by any client not explicitly updated to use them |

### 23.3 `CustomerProfile` — new satellite table (the key architectural improvement over v1)

```prisma
model CustomerProfile {
  dealerId    String   @id                 // 1:1 with Dealer — same id, not a separate identity
  dealer      Dealer   @relation(fields: [dealerId], references: [id], onDelete: Cascade)

  whatsapp    String?
  city        String?
  province    String?
  area        String?                      // neighbourhood/zone — the search axis requested in §11.1
  latitude    Float?
  longitude   Float?
  shopPhotoUrl String?
  shopPhotoPublicId String?                 // Cloudinary cleanup key, same pattern as ProductImage

  status         CustomerStatus @default(NEW)
  assignedRepId  String?
  assignedRep    Representative? @relation("CustomerAssignedRep", fields: [assignedRepId], references: [id])

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  notes       CustomerNote[]

  @@index([status])
  @@index([assignedRepId])
}

model CustomerNote {                        // NEW — customer timeline entries
  id           String   @id @default(uuid())
  dealerId     String
  dealer       Dealer   @relation(fields: [dealerId], references: [id])
  authorRepId  String?
  authorRep    Representative? @relation(fields: [authorRepId], references: [id])
  authorAdminId String?
  authorAdmin  Admin?   @relation(fields: [authorAdminId], references: [id])
  note         String
  createdAt    DateTime @default(now())

  @@index([dealerId])
}
```

**Why a satellite table instead of columns on `Dealer` directly** (this is the single most important
refinement over the v1 draft, which proposed adding CRM fields directly to `Dealer`): `Dealer` is a
**financial/transactional entity** — it's the FK target of `Order`, `Invoice`, and `Payment`, and every one
of those relationships needs `Dealer` to stay exactly as stable and predictable as it is today. The CRM
surface a modern sales team wants (WhatsApp, GPS, shop photo, lead status, notes, assigned rep) is large,
will keep growing, and has *nothing to do with* how orders/invoices/payments work. Bolting fifteen-plus
nullable CRM columns directly onto `Dealer` would still be *technically* additive (principle 3.1), but it
would blur a table with a precise, well-understood financial role into a second, unrelated responsibility —
exactly what principle 3.3 exists to prevent. `CustomerProfile` gets to grow freely (more fields, more
notes, eventually visit logs) without `Dealer` ever needing to change again for CRM reasons.

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | Both are brand-new tables — `CREATE TABLE` has no way to affect any pre-existing row anywhere in the database |
| 2 | Why no effect on existing production data? | `CustomerProfile.dealerId` is a 1:1 FK that is *optional from the referencing side* — an existing `Dealer` simply has no `CustomerProfile` row until one is explicitly created for it; nothing forces one to exist |
| 3 | Why historical sales preserved? | Neither table is referenced by `Order`, `Invoice`, `Payment`, or any return/inventory table |
| 4 | Why financial integrity preserved? | `CustomerProfile` carries zero financial fields — it deliberately does not duplicate `creditLimit`/`outstandingBalance`, so there is no second source of truth for money to ever drift out of sync with `Dealer` |
| 5 | Why backward compatible? | The Admin's existing dealer profile screen queries `Dealer` directly today and will continue to return exactly the same shape it always has, whether or not a `CustomerProfile` row exists |
| 6 | Why no client changes needed? | Nothing in the existing Admin/Dealer applications joins against or expects a `CustomerProfile`/`CustomerNote` table — they are invisible to those clients until deliberately surfaced |

### 23.4 `Representative` — new table, mirrors `Admin`/`Dealer`

```prisma
model Representative {
  id               String        @id @default(uuid())
  name             String
  phone            String
  email            String?       @unique
  username         String        @unique
  password         String
  status           AccountStatus @default(ACTIVE)
  resetToken       String?       @unique
  resetTokenExpiry DateTime?
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt

  customersCreated  Dealer[]         @relation("DealerCreatedByRep")
  customersAssigned CustomerProfile[] @relation("CustomerAssignedRep")
  ordersCreated     Order[]          @relation("OrderCreatedByRep")
  notes             CustomerNote[]
  activityLogs      ActivityLog[]
}
```

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | A brand-new, standalone table — structurally identical in risk profile to `Admin`/`Dealer`, both of which already coexist safely in this database |
| 2 | Why no effect on existing production data? | No existing table gains a required (`NOT NULL`, no default) FK pointing at `Representative` — every relation to it from `Order`/`Dealer`/`ActivityLog` is nullable |
| 3 | Why historical sales preserved? | A historical `Order` has `createdByRepId = NULL` by construction (the column didn't exist when it was created, and the default for the new column is `NULL`) — it is unambiguously and permanently attributable to whatever it was attributed to before (a dealer's own submission, or an admin's direct entry) |
| 4 | Why financial integrity preserved? | `Representative` has no financial fields and no relationship to `Invoice`/`Payment`/credit-limit logic whatsoever |
| 5 | Why backward compatible? | Reuses the exact same auth/session/reset-password *mechanism* `Admin`/`Dealer` already use (bcrypt, `RefreshToken`, `resetToken`/`resetTokenExpiry`) rather than inventing a new one — no new security surface to independently validate |
| 6 | Why no client changes needed? | Admin Panel and Dealer Portal never authenticate as, query, or render a `Representative` |

### 23.5 `Product` — three new columns

```prisma
model Product {
  // ...every existing field, unchanged...
  retailPrice    Decimal?               // NEW — falls back to wholesalePrice when unset (§5.4)
  compareAtPrice Decimal?               // NEW — "was" price for discount badges (§5.1)
  isFeatured     Boolean @default(false) // NEW — homepage "Recommended"/"Featured" curation (§10)
}
```

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | Three nullable/defaulted columns added to `Product` — the same low-risk operation already used for every prior additive migration in this document |
| 2 | Why no effect on existing production data? | Every existing product's `costPrice`, `wholesalePrice`, `currentStock`, `status`, and every other existing field are untouched byte-for-byte |
| 3 | Why historical sales preserved? | `OrderItem` snapshots `unitPrice`/`netUnitPrice` at the moment of sale (per `current_backend.md` §4.3's "store it, never recompute" rule) — a historical order's recorded price is already independent of whatever `Product.wholesalePrice`/`retailPrice` reads today, exactly as it is today for every existing dealer order |
| 4 | Why financial integrity preserved? | `wholesalePrice` — the only price `buildItemsAndSubtotal()` reads for the Admin/Dealer channels — is not renamed, retyped, or reinterpreted; `retailPrice`/`compareAtPrice` are read only by new, rep-channel-specific pricing logic |
| 5 | Why backward compatible? | `isFeatured` defaults `false` for every existing product — no product silently appears in a new "featured" rail it wasn't explicitly opted into |
| 6 | Why no client changes needed? | The Admin/Dealer product screens request the same fields they always have; three additional JSON keys in the response are inert to a client that doesn't read them |

### 23.6 `Category` and new `Brand` table

```prisma
model Category {
  // ...existing fields (id, name, createdAt)...
  imageUrl   String?              // NEW
  iconUrl    String?              // NEW
  sortOrder  Int     @default(0)  // NEW
  isFeatured Boolean @default(false) // NEW
  slug       String? @unique      // NEW — future SEO routing
  parentId   String?              // NEW — future subcategories (see 9.2)
  parent     Category? @relation("CategoryParent", fields: [parentId], references: [id])
  children   Category[] @relation("CategoryParent")
}

model Brand {                     // NEW — mirrors Category's existing pattern (see §8)
  id          String  @id @default(uuid())
  name        String  @unique
  logoUrl     String?
  logoPublicId String?
  imageUrl    String?
  imagePublicId String?
  description String?
  status      AccountStatus @default(ACTIVE)
  sortOrder   Int     @default(0)
  isFeatured  Boolean @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | `Category` gains six nullable/defaulted columns (including a self-referencing FK that is nullable, so every existing category is implicitly top-level); `Brand` is a brand-new table |
| 2 | Why no effect on existing production data? | `Category.name` — the only field `CategoriesService`'s existing rename-cascade logic reads and writes — is untouched; every existing category row keeps its exact `id`/`name`/`createdAt` |
| 3 | Why historical sales preserved? | Neither table is referenced by `Order`/`OrderItem` — `Product.category` (the field actually used in historical sales analysis, per `current_backend.md` §4.3) remains the same free-text string it always was |
| 4 | Why financial integrity preserved? | No financial field on either table; `Brand` deliberately does **not** become a foreign key from `Product` (§8.1), so no existing `Product.brand` value needs reclassification or risks becoming an orphaned reference |
| 5 | Why backward compatible? | The existing category delete-guard (blocked while any product still references its name) and rename-cascade are not modified — they operate on `name` exactly as before, oblivious to the six new columns |
| 6 | Why no client changes needed? | The Admin Panel's existing category screen renders correctly with the new fields simply absent from its request/response usage until it's deliberately updated to surface them (§26) |

### 23.7 `Order` — two new columns

```prisma
model Order {
  // ...every existing field, unchanged...
  createdByRepId       String?                                 // NEW — mirrors createdByAdminId
  createdByRep         Representative? @relation("OrderCreatedByRep", fields: [createdByRepId], references: [id])
  notes                String?                                 // NEW — order notes / special instructions (§14.4)
  expectedDeliveryDate DateTime?                                // NEW
}
```

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | Two nullable columns on `Order` — the single highest-scrutiny table in the system, and exactly the reason this proposal treats it with the most caution of any change in this document |
| 2 | Why no effect on existing production data? | Every existing order's `orderNumber`, `dealerId`, `status`, `subtotal`, `discount`, `totalAmount`, every timestamp, and `createdByAdminId` are unchanged in name, type, nullability, and value |
| 3 | Why historical sales preserved? | `OrdersService`'s read paths (`findOne`, `findAllForAdmin`, `findAllForDealer`, `orderInclude`) are not modified — a historical order returns exactly the fields it always did, plus two new fields that are simply `null` for it |
| 4 | Why financial integrity preserved? | `createdByRepId` is never read by `assertWithinCreditLimit()`, `applyApproval()`, or any discount/invoice calculation — it is a pure attribution field, structurally identical in role to the existing, already-safe `createdByAdminId` |
| 5 | Why backward compatible? | `OrdersService.create()`'s `ADMIN` and `DEALER` branches (per `current_backend.md` §5.1) are not edited — the new `REPRESENTATIVE` branch is additive code, not a modification of shared logic (see §16.2) |
| 6 | Why no client changes needed? | The Admin's Order Approval / Orders List screens, and the Dealer Portal's own order views, continue to receive every field they already parse; `notes`/`expectedDeliveryDate`/`createdByRepId` are additional keys those screens simply don't read until deliberately wired up |

### 23.8 Future-phase join tables (Phase 3, not MVP — listed for completeness per §22)

```prisma
model RepFavoriteProduct {
  repId     String
  productId String
  createdAt DateTime @default(now())
  @@id([repId, productId])
}

model RepFavoriteCustomer {
  repId     String
  dealerId  String
  createdAt DateTime @default(now())
  @@id([repId, dealerId])
}

model CustomerWishlistItem {
  dealerId    String
  productId   String
  addedByRepId String?
  createdAt   DateTime @default(now())
  @@id([dealerId, productId])
}
```

### 23.9 `RepOrderDraft` / `RepOrderDraftItem` — the server-side cart (§14)

```prisma
model RepOrderDraft {
  id                   String   @id @default(uuid())
  repId                String
  representative       Representative @relation(fields: [repId], references: [id])
  dealerId             String?                     // nullable until Customer Selection (§15, step 1)
  dealer               Dealer?  @relation(fields: [dealerId], references: [id])
  notes                String?
  expectedDeliveryDate DateTime?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  items RepOrderDraftItem[]

  @@index([repId])
}

model RepOrderDraftItem {
  id        String   @id @default(uuid())
  draftId   String
  draft     RepOrderDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)
  productId String
  product   Product  @relation(fields: [productId], references: [id])
  quantity  Int

  @@index([draftId])
}
```

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | Both are brand-new tables with no relationship whatsoever to `Order`, `Invoice`, or `Payment` — a draft is deliberately *not* a financial record (§14.2) |
| 2 | Why no effect on existing production data? | Nothing pre-existing references or is referenced by these tables |
| 3 | Why historical sales preserved? | A draft never becomes a historical record by itself — only the act of `POST /rep-portal/orders` creates a real, permanent `Order` row, through the unmodified `OrdersService.create()` pipeline; an abandoned draft simply never enters sales history at all, exactly as an item sitting unsubmitted in a Dealer Portal cart does today |
| 4 | Why financial integrity preserved? | Drafts do not reserve stock, do not touch `assertWithinCreditLimit()`, and are invisible to every credit/inventory calculation until submitted — see §14.2 for the full reasoning behind deliberately keeping drafts out of `OrderStatus` |
| 5 | Why backward compatible? | No existing query anywhere in the codebase joins against `RepOrderDraft` — it cannot regress a calculation it is never included in |
| 6 | Why no client changes needed? | Entirely invisible to the Admin Panel and Dealer Portal, which have no concept of a "draft" today and gain none |

### 23.10 `ActivityLog` — the one nullability relaxation

```prisma
model ActivityLog {
  adminId String?                         // was required — now nullable
  admin   Admin?  @relation(fields: [adminId], references: [id])
  repId   String?                         // NEW
  rep     Representative? @relation(fields: [repId], references: [id])
  // application-level invariant: exactly one of adminId/repId is set
}
```

This is the only change to an existing column's constraint anywhere in this proposal, and it changes
nothing about what any existing row means — every admin-authored log entry today already has `adminId` set
and continues to.

**Safety justification**

| # | Question | Answer |
|---|---|---|
| 1 | Why is this safe? | `DROP NOT NULL` is a metadata-only operation in Postgres — it does not rewrite the table, does not scan existing rows, and does not require validating any existing value (every existing row already satisfies "not null," which is a strict superset of "nullable") |
| 2 | Why no effect on existing production data? | Every existing `ActivityLog` row keeps its exact `adminId` value; the relaxation only permits *new* rows to omit it |
| 3 | Why historical sales preserved? | `ActivityLog` is an audit trail, not a source of truth for sales/financial figures — no report or dashboard calculation reads from it |
| 4 | Why financial integrity preserved? | No financial calculation depends on `ActivityLog.adminId` being non-null |
| 5 | Why backward compatible? | `GET /activity-logs` and every existing admin-authored log entry render identically; the application-level invariant (exactly one of `adminId`/`repId` set) is enforced by the new write path, not by a database constraint whose removal could be "undone" incorrectly |
| 6 | Why no client changes needed? | The Admin's existing activity log screen displays admin-authored entries exactly as before; rep-authored entries are new rows it simply hasn't been built yet to filter/display, not a change to how existing rows appear |

This is the single most conservative possible way to allow a second actor type to log actions — it is
reversible in principle (re-adding `NOT NULL` is safe as long as every row satisfies it, which every
existing row does and always will, since nothing here ever clears an existing `adminId`).

### 23.11 Entity relationship summary (new/changed only)

```
Representative ──< Dealer (createdByRepId)
Representative ──< CustomerProfile (assignedRepId)
Representative ──< Order (createdByRepId)
Representative ──< CustomerNote (authorRepId)
Representative ──< RepOrderDraft
Representative ──< ActivityLog (repId)

Dealer 1──1 CustomerProfile
Dealer ──< CustomerNote
Dealer ──< RepOrderDraft (once customer is selected)

Brand (standalone — Product.brand stays a denormalized string, per §8.1)
Banner (standalone — homepage CMS)
Category ──self── Category (parentId, future subcategories)

RepOrderDraft ──< RepOrderDraftItem >── Product
```

---

## 24. API Design

New routes only. No existing route's request/response shape changes. `A` = Admin, `R` = Representative, `D`
= Dealer.

### 24.1 Auth extensions

| Route | Method | Role |
|---|---|---|
| `/auth/rep-login` | POST | public (issues `REPRESENTATIVE` JWT) |
| `/auth/forgot-password`, `/auth/reset-password` | POST | gain a third `role` branch, existing contract unchanged |

### 24.2 Representatives (admin CRUD, mirrors `/dealers`)

| Route | Method | Role |
|---|---|---|
| `/representatives` | POST | A |
| `/representatives` | GET | A |
| `/representatives/:id` | GET | A |
| `/representatives/:id` | PATCH | A |
| `/representatives/:id/status` | PATCH | A |
| `/representatives/:id/reset-password` | POST | A |

### 24.3 Rep Portal — Customers

| Route | Method | Role |
|---|---|---|
| `/rep-portal/customers` | GET | R (search, §11.1) |
| `/rep-portal/customers` | POST | R (create, §12; 409 on phone duplicate) |
| `/rep-portal/customers/:id` | GET | R (profile + timeline, §11.2–11.3) |
| `/rep-portal/customers/:id/status` | PATCH | R (§13) |
| `/rep-portal/customers/:id/notes` | POST | R (append a timeline note) |

### 24.4 Rep Portal — Drafts (the cart, §14)

| Route | Method | Role |
|---|---|---|
| `/rep-portal/drafts` | POST | R (start a new draft) |
| `/rep-portal/drafts` | GET | R (list this rep's open drafts) |
| `/rep-portal/drafts/:id` | GET | R |
| `/rep-portal/drafts/:id` | PATCH | R (items, dealerId, notes, expectedDeliveryDate) |
| `/rep-portal/drafts/:id` | DELETE | R |

### 24.5 Rep Portal — Orders

| Route | Method | Role |
|---|---|---|
| `/rep-portal/orders` | POST | R (submits a draft → real `Order`, §16) |
| `/rep-portal/orders` | GET | R (own orders, §16.3) |
| `/rep-portal/orders/:id` | GET | R |

### 24.6 Rep Portal — Catalog & Home

| Route | Method | Role |
|---|---|---|
| `/rep-portal/home` | GET | R (single aggregated homepage payload, §4.1/§28.1) |
| `/rep-portal/search` | GET | R (§6) |
| `/rep-portal/dashboard` | GET | R (§18) |

Product/category browsing reuses the **existing** `GET /products` and `GET /categories` endpoints with
`Role.REPRESENTATIVE` added to their read-only `@Roles(...)` lists (§5.3) — no duplicate catalog endpoints.

### 24.7 Brands (new module)

| Route | Method | Role |
|---|---|---|
| `/brands` | POST | A |
| `/brands` | GET | A, D, R |
| `/brands/:id` | GET | A, D, R |
| `/brands/:id` | PATCH | A |
| `/brands/:id` | DELETE | A |

### 24.8 Banners (new module)

| Route | Method | Role |
|---|---|---|
| `/banners` | POST | A (multipart image upload) |
| `/banners` | GET | A, R |
| `/banners/:id` | PATCH | A |
| `/banners/:id/status` | PATCH | A |
| `/banners/:id` | DELETE | A |

### 24.9 Admin dashboard extensions (§19)

| Route | Method | Role |
|---|---|---|
| `/dashboard/admin` | GET | A — **existing route, response gains new optional fields**, nothing removed |
| `/dashboard/admin/representatives` | GET | A — top reps / sales-by-rep / orders-by-rep detail view, kept as a separate route rather than growing the main dashboard payload indefinitely |

---

## 25. Migration Plan

Every migration below is additive (`CREATE TABLE`, `ALTER TABLE ... ADD COLUMN ... [DEFAULT ...]`,
`ALTER TYPE ... ADD VALUE`) — none require a table rewrite, none require downtime, and none require
backfilling existing rows with anything other than the stated defaults.

### Phase 0 — Schema foundation
1. `Role.REPRESENTATIVE`, `DealerSource`, `CustomerStatus`, `BannerLinkType` enums.
2. `Representative`, `CustomerProfile`, `CustomerNote`, `Brand`, `Banner`, `RepOrderDraft`,
   `RepOrderDraftItem` tables.
3. `Dealer.source` / `createdByRepId`; `Order.createdByRepId` / `notes` / `expectedDeliveryDate`;
   `Product.retailPrice` / `compareAtPrice` / `isFeatured`; `Category.imageUrl` / `iconUrl` / `sortOrder` /
   `isFeatured` / `slug` / `parentId`; `ActivityLog.repId` (+ `adminId` nullable).

Deployable independently of any application code change — the running Admin/Dealer application doesn't
reference any of these new tables/columns and is unaffected by their existence.

### Phase 1 — Core ordering loop (MVP)
4. `RepresentativesModule` (admin CRUD).
5. Auth: `rep-login`, forgot/reset third branch, `JwtStrategy` status check for reps.
6. `RepPortalModule`: customers (search/create/profile/status/notes), drafts, orders.
7. Extend `ProductsController`/`CategoriesController` read routes with `Role.REPRESENTATIVE`; rename
   `hideCostPriceForDealer` → `hideCostPrice`.
8. Resolve the open decisions in §29 — they shape DTO validation and default values directly, so resolving
   them here (rather than after the fact) avoids rework.

### Phase 2 — Storefront & CMS layer
9. `BrandsModule`, `BannersModule`, Category CMS additions to the existing admin category screen.
10. `/rep-portal/home`, `/rep-portal/search` aggregated endpoints.
11. Mailer additions (rep welcome/reset, rep order-approved/rejected).
12. Frontend build-out (§4–§15), hosted separately, `CORS_ORIGIN` updated.

### Phase 3 — Analytics, dashboards, and everything in §22
13. Admin dashboard extensions (§19), analytics endpoints (§20).
14. Whichever §22 items the business prioritizes — each is independently additive and can ship in any
    order without depending on the others.

### Zero-downtime guarantee

Because every change is additive, Phase 0 can be deployed to production **before** any Phase 1 code exists,
with the current Admin/Dealer application still running against the same database, unaware anything changed.
This decouples "ship the schema" from "ship the feature" and gives the team room to deploy and verify the
migration in isolation before any user-facing behavior depends on it.

### 25.5 Migration Safety Protocol

This protocol applies to every migration in Phase 0 and to any schema change proposed in a later phase.

**Allowed DDL operations (the only statement types this proposal ever requires):**

| Operation | Example | Why it's safe on a live table |
|---|---|---|
| `CREATE TABLE` | `Representative`, `CustomerProfile`, `Brand`, `Banner`, `RepOrderDraft`, ... | Cannot affect a row in any other table by definition |
| `ALTER TABLE ... ADD COLUMN ... NULL` | `Order.createdByRepId` | Metadata-only in Postgres — no table rewrite, no row scan, existing rows read back as `NULL` for the new column |
| `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT <value>` | `Dealer.source DEFAULT 'DEALER_PORTAL'` | Postgres 11+ stores the default as metadata rather than rewriting every row — the same fast, safe path as the nullable case above |
| `ALTER TABLE ... DROP NOT NULL` | `ActivityLog.adminId` (§23.10) | Metadata-only; every existing row already satisfies the relaxed constraint by construction |
| `ALTER TYPE ... ADD VALUE` | `Role.REPRESENTATIVE`, `DealerSource`, `CustomerStatus`, `BannerLinkType` | Appends to an enum's value list; existing values, existing columns using the enum, and existing rows are entirely unaffected |
| `CREATE INDEX` (new indexes only, e.g. `Dealer(source)`) | | Additive; can be built `CONCURRENTLY` in production to avoid locking writers |

**Explicitly forbidden — none of these appear anywhere in this proposal, and none should ever be introduced
without a separate, standalone review:**

`DROP TABLE` · `DROP COLUMN` · `RENAME TABLE`/`RENAME COLUMN` · `ALTER COLUMN ... TYPE` (narrowing or
incompatible widening) · `ALTER TABLE ... ADD COLUMN ... NOT NULL` **without** a default on a table with
existing rows · any `UPDATE`/`DELETE` against an existing production table as part of a "migration."

**Pre-deployment rehearsal (required before any Phase 0 migration touches production):**

1. Restore the most recent production backup into a staging database of comparable size — not a small
   synthetic dataset. The concern isn't whether an `ADD COLUMN` *works*, it's whether it completes in
   acceptable time and without lock contention against a table with real production row counts (`Order`,
   `OrderItem`, `InventoryLog`, and `ActivityLog` are the tables most likely to have the largest row counts
   and are therefore the ones most worth rehearsing against explicitly).
2. Apply the full Phase 0 migration set to that staging copy and time it end-to-end.
3. Run the verification checklist below against the staging copy, comparing every figure to the same query
   run against the pre-migration backup.
4. Only once staging verification passes cleanly does the same migration set get applied to production.

**Post-migration verification checklist (run in staging, then re-run in production immediately after
deployment):**

| Check | Method |
|---|---|
| Row counts unchanged on every existing table | `SELECT count(*)` per table, before vs. after — must match exactly |
| Financial totals unchanged | Re-run the exact aggregate queries `DashboardService.getAdminSummary()` and `SalesAnalysisService.getSummary()` use for all-time totals (net sales, total profit, outstanding balance) — must match the pre-migration figures to the cent, since no historical row changed |
| Sequence counters unchanged | `SELECT * FROM "Counter"` — every existing key's `value` must be identical; no new key has been introduced with a colliding name |
| Spot-check a sample of historical records | Pull 10–20 real `Order`/`Invoice`/`Payment` records spanning the dataset's date range by `id` and diff every field against a pre-migration snapshot of the same rows — must be byte-for-byte identical except for the new, `NULL`-by-default columns |
| Existing API contract unchanged | Run the existing (or a recorded) Admin Panel / Dealer Portal API test suite / Swagger-driven smoke test against the post-migration backend — every existing endpoint must return the same shape it did before |
| Application boots and existing screens load | Smoke-test the Admin Panel and Dealer Portal end-to-end against the migrated database before considering the migration complete |

**Rollback plan.** Because every operation in the allowed list is additive, the rollback for any step here
is simply *not proceeding to the next step* — a migration that has only added tables/columns/enum values
leaves the pre-existing schema and every pre-existing row completely intact if paused or abandoned midway.
Where a formal rollback script is still wanted for change-management sign-off, each addition has a trivial
inverse (`DROP TABLE` for a new table, `ALTER TABLE ... DROP COLUMN` for a new column) that is safe to keep
on hand *precisely because* nothing else in the system will have come to depend on the new object until the
corresponding application code is deployed in a later, separate step (§25's phase boundaries are deliberately
structured so schema always ships ahead of, and independently of, the code that uses it).

---

## 26. Implementation Checklist

### New backend modules
- [ ] `src/representatives/` (module, controller, service, dto — mirrors `src/dealers/`)
- [ ] `src/rep-portal/` — `rep-customers.{controller,service}.ts`, `rep-drafts.{controller,service}.ts`,
      `rep-orders.{controller,service}.ts`, `rep-home.controller.ts`, dto
- [ ] `src/brands/` (module, controller, service, dto — mirrors `src/categories/`)
- [ ] `src/banners/` (module, controller, service, dto — mirrors `src/categories/` + image upload like `src/products/`)

### Backend changes (additive only)
- [ ] `prisma/schema.prisma` — §23, full diff
- [ ] `src/auth/auth.service.ts`, `auth.controller.ts`, `jwt.strategy.ts` — §24.1
- [ ] `src/orders/orders.service.ts` — one new branch in `create()` (§16.2)
- [ ] `src/products/products.controller.ts`, `src/categories/categories.controller.ts` — add
      `Role.REPRESENTATIVE` to read routes; rename `hideCostPriceForDealer` → `hideCostPrice`
- [ ] `src/products/products.service.ts` — extend search `OR` clause with `model` (§6); price-selection
      logic for `retailPrice ?? wholesalePrice`
- [ ] `src/dashboard/dashboard.service.ts` — additive fields/endpoint (§19)
- [ ] `src/mailer/mailer.service.ts` — new methods only (§17)
- [ ] `src/app.module.ts` — register new modules

### Frontend (Representative Portal — new application)
- [ ] Auth: login, forgot/reset password
- [ ] Homepage (§4): hero slider, featured categories/brands, new arrivals, best sellers, offers
- [ ] Catalog: grid/list, product detail, filters (§5, §7)
- [ ] Search: instant search, recent searches (client-side), filters (§6)
- [ ] Brand pages, category pages (§8, §9)
- [ ] Customer search / profile / creation / timeline (§11–§13)
- [ ] Cart / draft management (§14)
- [ ] Checkout flow, all six steps (§15)
- [ ] Orders list, order detail with timeline (§16.3)
- [ ] Representative dashboard (§18)

### Admin Panel (existing app — additive screens only)
- [ ] Banner manager (§10.1)
- [ ] Brand manager (§10.1)
- [ ] Category screen: image/icon/sortOrder/featured fields added to the existing form
- [ ] Featured-products toggle on the existing product edit screen
- [ ] Representative management screen (mirrors existing Dealer management screen)
- [ ] Dashboard: rep-performance widgets (§19), as additions to the existing dashboard layout

### Ops
- [ ] `CORS_ORIGIN` updated with the Representative Portal's deployed domain
- [ ] Cloudinary folders: `banners`, `brands`, `customers`

---

## 27. UX Guidelines

- **Mobile-first.** Most rep usage will happen in the field, on a phone, standing in a shop. Every screen in
  §4–§16 should be designed at mobile width first, scaled up — not the reverse.
- **Fast over feature-rich on the critical path.** The path from login to a submitted order should be
  achievable in well under a minute for a rep who already knows what they want (existing customer, known
  products) — the browsing/discovery richness in §4–§10 is for the *other* case (a rep introducing a new
  product line to a shop), and shouldn't add friction to the fast path.
- **B2B-appropriate density, consumer-grade polish.** Product cards should carry more information at a
  glance than a typical consumer storefront (stock status, wholesale/retail price, availability) while still
  looking like a modern, premium application — the Alibaba-buyer-side / Amazon-Business reference point, not
  a spreadsheet with images.
- **The customer-selection step should never feel like a blocker.** Since every order requires attaching a
  shop (§15), the search-or-create flow needs to be fast and forgiving — instant search-as-you-type, a
  one-tap "+ New Shop" fallback, never a dead end.
- **Minimal, not sparse.** Cut chrome, not information density where it matters (price, stock, credit
  exposure) — the goal is a clean surface that still tells a rep everything they need to make a confident
  selling decision in the moment.
- **Consistent with, not identical to, the Dealer Portal.** Reusing UI patterns where the underlying data
  shape is genuinely the same (order detail/timeline, invoice display) saves design and engineering effort;
  diverging where the job is genuinely different (browsing/discovery, customer selection) is not
  inconsistency, it's fitting the tool to the task.

---

## 28. Performance & Scalability

### 28.1 One aggregated homepage call

`GET /rep-portal/home` returns banners, featured categories, featured brands, new arrivals, best sellers,
and offers in a single response rather than the naive eight separate round-trips the section list in §4.1
might otherwise suggest. This is the single highest-leverage performance decision in this proposal — first
paint on the highest-traffic screen in the app depends on it, and every one of the underlying queries is
already independently cheap (indexed lookups, or the same aggregation `DashboardService` runs today) — the
win is entirely from collapsing round-trips, not from any new caching layer.

### 28.2 Pagination everywhere

Every list endpoint in this proposal (customers, orders, drafts, brands) follows the existing
`paginate(data, total, page, limit)` convention already used by every list endpoint in the current codebase
— no new pagination pattern introduced, no endpoint that returns an unbounded result set.

### 28.3 Lazy loading & image optimization

Product/category/brand images are served from Cloudinary, which already supports on-the-fly responsive
transforms (width/format negotiation) — the frontend should request appropriately-sized variants per
breakpoint rather than full-resolution originals, and lazy-load below-the-fold product grid images. This is
a frontend request-shaping concern; no backend change is required, since Cloudinary already stores one
original and derives variants on request.

### 28.4 Caching

Homepage content (banners, featured categories/brands) changes rarely relative to how often it's read — a
short server-side or CDN-edge cache (measured in minutes, not hours, so an admin's CMS change reflects
quickly) is a reasonable Phase 2 addition once real traffic patterns are known, rather than a Phase 1
requirement to design against speculatively.

### 28.5 CDN readiness

The Representative Portal frontend, being a separately-hosted static/SSR application, is CDN-fronted by
construction on virtually any modern hosting platform (Vercel, Cloudflare, etc.) — no backend work is needed
to make this true.

---

## 29. Appendix A — Business Decisions Required

Carried forward and sharpened from the v1 draft — these are judgment calls only the business can make, not
things derivable from the existing code:

**29.1 — Pricing.** Should rep-portal customers be quoted `wholesalePrice` (simplest — matches how every
dealer is priced today) or the new `retailPrice` (§23.5)? The schema supports either without rework;
resolving this shapes the pricing-selection logic in `buildItemsAndSubtotal()`'s rep-channel branch.

**29.2 — Default credit posture for new shops.** A freshly-registered shop has no order history.
Recommended: `unlimitedCredit: true` by default, since `PENDING_APPROVAL` (§16.2) already gives the Admin a
manual checkpoint on every rep order before stock or invoice are touched — the credit-limit gate is a
backstop for repeat/high-volume dealers, not the primary control for a brand-new relationship.

**29.3 — Order approval vs auto-approval.** Recommended: `PENDING_APPROVAL`, mirroring a dealer's own
submission (§16.2) — full rationale given there.

**29.4 — Visibility scope.** Recommended: customer *search* is shared across all reps (avoids duplicate shop
records when two reps independently visit the same shop); "My Orders"/dashboard defaults to the rep's own
`createdByRepId`; full cross-rep visibility remains an Admin-only capability via §19's dashboard widgets.

**29.5 — Does a rep-authorized search also reach existing wholesale `Dealer` accounts** (`source:
DEALER_PORTAL`), or only shops the rep channel itself registered? Recommended default: rep-channel-only
(§11.1) — a real wholesale dealer relationship (their own login, their own negotiated credit terms) is a
different kind of relationship than a rep-managed walk-in shop, and mixing the two in one search result
risks a rep accidentally placing an order against a dealer's credit line without that dealer's knowledge.
Flagged explicitly because the query change to reverse this decision later is trivial — the business
relationship implications are not, so it's worth deciding deliberately rather than defaulting silently.

**29.6 — Commission.** Out of scope for this proposal (§22) unless the business wants it — flagged so it's a
deliberate omission, not an oversight.

**29.7 — `assignedRepId` vs `createdByRepId` as the "owner" of a customer relationship.** `Dealer.createdByRepId`
records who *registered* the shop (immutable, historical); `CustomerProfile.assignedRepId` records who
currently *owns* the relationship (mutable — reassignable if a rep leaves or territories change). Recommend
keeping both: `createdByRepId` for audit/attribution history, `assignedRepId` as the live routing field
every rep-facing "my customers" view should actually filter on.

---

## 30. Appendix B — Compatibility Guarantee, In Detail

A direct, exhaustive accounting of the claim in §1.3 and the guarantee table on page 1, organized by
**every business-critical subsystem the production database holds today** — for reviewers who want to
verify rather than take it on faith. Each subsystem is checked against the same six questions §1.3 promises
an answer to.

### 30.1 Products

| # | Question | Answer |
|---|---|---|
| 1 | Safe? | Three new nullable/defaulted columns (§23.5); no existing column touched |
| 2 | No effect on existing data? | `productCode`, `sku`, `barcode`, `costPrice`, `wholesalePrice`, `currentStock`, `warranty`, `status` — every field — is byte-for-byte unchanged |
| 3 | Historical sales preserved? | `OrderItem` already snapshots price at time of sale (`current_backend.md` §4.3) — independent of any future change to `Product` |
| 4 | Financial integrity preserved? | `wholesalePrice`, the only price the Admin/Dealer channel ever reads, is not touched |
| 5 | Backward compatible? | `ProductsService.findAll/findOne/update/setStatus/remove` — unmodified |
| 6 | No client changes needed? | Existing Product list/detail calls from Admin Panel and Dealer Portal render identically |

### 30.2 Categories

Covered in full in §23.6's safety justification. Summary: six new nullable/defaulted columns, the existing
rename-cascade and delete-guard logic untouched, `Product.category` (the field actually load-bearing for
sales data) never modified.

### 30.3 Dealers

Covered in full in §23.2's safety justification. Summary: two new columns, both defaulted/nullable; every
field the credit-limit, balance, and login logic depends on (`creditLimit`, `outstandingBalance`,
`unlimitedCredit`, `status`, `username`, `password`) is untouched; `DealersService`/`DealersController` are
not modified.

### 30.4 Suppliers, Purchases, Purchase Items

**Not touched at all** — no table, column, service method, or controller route in `src/suppliers` or
`src/purchases` is referenced anywhere in this proposal. The Representative Portal has no supplier-side or
procurement-side surface; this entire subsystem is out of scope by construction, not merely "unaffected in
practice."

### 30.5 Orders and Order Items

Covered in full in §23.7's safety justification for the schema, and §16 for the service-layer change. Summary:
- **Schema**: two new nullable columns on `Order`; `OrderItem` gains **zero** new columns and is not touched
  at all — the discount-allocation invariants (`allocatedDiscount`/`netLineTotal`/`netUnitPrice`, "store it,
  never recompute" per `current_backend.md` §4.3) are entirely unaffected because nothing about how an
  `OrderItem` is computed changes for any channel.
- **Service**: `OrdersService.create()` gains one new `else if (requester.role === Role.REPRESENTATIVE)`
  branch (§16.2). Every other method on `OrdersService` — `approve`, `reject`, `updateItems`,
  `updateAdminOrder`, `advanceStatus`, `completeDirectly`, `remove`, `resetOrderCounter` — is **not
  modified**, meaning a rep-placed order is approved, rejected, packed, delivered, completed, edited, or
  deleted through the *exact same code*, with the *exact same* row-locking, stock-reservation, and
  credit-limit behavior, that a dealer's order already goes through today.
- A historical order created before this feature ships has `createdByRepId = NULL`, `notes = NULL`,
  `expectedDeliveryDate = NULL` — reads back through `orderInclude` exactly as it always has, with three
  additional keys present in the JSON that were simply never there before and that no existing client reads.

### 30.6 Invoices

**`InvoicesService` is not modified at all.** A rep-placed order's invoice is generated by the same
`applyApproval()` code path (unchanged, §5.5 of `current_backend.md`) that generates every dealer order's
invoice — same `INV-<year>-<serial>` numbering, same `Counter` key (§30.10), same `dueDate`/`paymentStatus`
derivation. No new invoice field, no new invoice table, no new invoice logic exists anywhere in this
proposal.

### 30.7 Payments

**`PaymentsService` is not modified at all.** Collecting payment against a rep-placed order's invoice uses
the identical `POST /payments` flow, the identical row-locking/overpayment-guard/cheque-lifecycle logic, and
the identical `outstandingBalance` adjustment already in production for every dealer invoice — because from
`PaymentsService`'s point of view, there is no distinction between a dealer-originated invoice and a
rep-originated one; both are simply `Invoice` rows against a `Dealer`.

### 30.8 Inventory / Stock Movements

**`InventoryService.recordMovement()` is not modified at all.** Stock reservation for a rep-placed order's
approval uses the exact same atomic, race-condition-safe `UPDATE ... WHERE "currentStock" + delta >= 0`
statement (`current_backend.md` §5.4) that protects every purchase, sale, reservation, release, and manual
adjustment today. Every `InventoryLog` row this generates is indistinguishable in structure from one
generated by a dealer or admin order — the audit ledger (`GET /inventory/:productId/ledger`) requires no
changes to correctly include rep-channel movements.

### 30.9 Sales Returns, Purchase Returns, Reports, and Dashboard Statistics

- **Sales returns / purchase returns**: `SalesReturnsService`/`PurchaseReturnsService` are not modified. A
  sales return against a rep-placed order works identically to one against a dealer order — both operate on
  `Order.items`/`OrderItem.netUnitPrice`, fields that don't distinguish the order's channel.
- **Sales Analysis / Equity / Dashboard**: `SalesAnalysisService`, `EquityService`, and `DashboardService`'s
  existing formulas (`current_backend.md` §"Sales analysis", "Equity", "Dashboard") are not modified. A
  rep-placed `COMPLETED` order is counted by `SalesAnalysisService.getSummary()`'s existing
  `status: COMPLETED` query in exactly the same way a dealer's `COMPLETED` order is — no new `WHERE` clause,
  no new join, no new special case. This is intentional: profit/revenue reporting should **not** need to
  know or care which channel originated a sale, and the fact that it doesn't need modification to correctly
  include the new channel is itself evidence the integration is clean.
- **On "zero report inconsistencies," precisely stated**: this guarantee means the *definitions and
  formulas* behind every report are unchanged, and that *any report re-run against the same historical data
  produces the same number it always did*. It does **not** mean — and could not sensibly mean, for a live
  ERP — that aggregate totals stay frozen forever; a report run after this feature ships will naturally
  include new orders as new data, exactly as it already changes every time a new dealer order is completed
  today. The guarantee is about the *integrity of the calculation and of every pre-existing row*, not about
  suspending the business's growth.

### 30.10 Sequence Numbers

`nextSequenceNumber()`/`resetSequenceCounter()` (`current_backend.md` §6.4) are not modified. A rep-placed
order draws its `orderNumber` from the **same** `'order'` `Counter` key a dealer order draws from — through
the same, unmodified `OrdersService.create()` call to `nextSequenceNumber(tx, 'order', 'ORD')` — meaning
order numbers stay globally sequential across every channel exactly as invoice numbers already are across
every existing order source (dealer submission, admin direct-entry, admin backdated sale). No new counter
key is introduced for orders/invoices/returns; the only genuinely new sequence-adjacent concept in this
proposal is `RepOrderDraft`, which explicitly has **no** serial number at all (§14.2) — it isn't a
business record, so it was never going to consume or risk corrupting a business-record sequence.

### 30.11 Activity Logs

Covered in full in §23.10's safety justification. Summary: one existing constraint relaxed (`adminId`
nullable), one new nullable column (`repId`) added; every existing admin-authored row is unaffected in value
or in how it renders on the existing Activity Log screen.

### 30.12 API Contracts, Admin Panel, Dealer Portal, and Any Other Existing Consumer

| Existing surface | Touched? | How |
|---|---|---|
| Every existing REST endpoint's request shape | Not touched | No existing DTO field is removed, renamed, retyped, or made stricter |
| Every existing REST endpoint's response shape | Additive only | New fields may appear in a response (e.g. `Order.notes`); no existing field is removed or changes type |
| `ProductsController`/`CategoriesController` | One role added to existing `@Roles()` lists on **read-only** routes only | Every mutating route (`POST`/`PATCH`/`DELETE`) stays exactly as restricted as it is today |
| `RefreshToken`, `JwtStrategy`, `RolesGuard` | Not touched | Already generic over role by design (`current_backend.md` §3); a third role slots in with no structural change |
| Dealer Portal frontend | Not touched | Consumes only existing endpoints, none of which change shape |
| Admin Panel frontend | Not touched, except opt-in new screens (§10.1, §19, §26) | Every existing screen continues to work against an unchanged API surface; new screens are additive navigation entries, not replacements |
| Any other existing API consumer (mobile or otherwise) | Not touched | `current_backend.md` — the from-the-code survey this proposal is built against — found no mobile application or any other API consumer beyond the Admin Panel and Dealer Portal in the current system. This guarantee is nonetheless stated in the general form ("no existing endpoint's contract changes") rather than as an enumerated list of known clients, precisely so it holds for any consumer of this API — known or not, present or future — without needing to be revisited if one is later discovered or added |

### 30.13 The pattern, restated

Across every one of the thirteen subsystems above, the same answer to "why is this safe" recurs: **new
things are added beside the existing system, never inside it.** No existing table is renamed. No existing
column is removed. No existing service method's logic is edited — only new, role-gated branches are added
alongside untouched ones. No existing sequence, calculation, or report definition changes. That is the whole
architecture, restated one final time in the most falsifiable form this document offers: every claim above
names the exact file, table, or method it depends on, so it can be checked against the codebase directly
rather than taken on faith.

---

## 31. Version 2.1 — Representative Operations, Commission & Collections Layer

A second wave of requirements turns the Representative Portal from an ordering tool into a full staff
operations surface: reps are now managed as first-class Admin Panel entities (alongside Dealers), their
catalog and homepage are individually curated, they earn tracked commission, and they participate directly
in payment collection — all specified in exhaustive, per-feature detail (business flow, UI flow, database
design, backend architecture, API endpoints, permission model, admin/rep screens, notifications, security,
and compatibility justification, for each of fifteen feature areas) in `version2_changes_backend.md`, with
the corresponding `electromart_rep` frontend requirements in `additional_requirement_changes_rep_portal.md`.
This section is the executive summary; those two documents are authoritative for implementation.

### 31.1 What's added

| Capability | One-line summary |
|---|---|
| Representative Management | A full Admin Panel module — list/detail/create/edit/suspend/activate/block, mirroring Dealer Management |
| Account Creation & Login | Email-as-username, generated temp password, welcome email, forced first-login password change, rolling lockout after failed attempts |
| Product Assignment | Reps see only admin-assigned categories/products/brands/campaigns — not the full catalog by default |
| Banner Assignment | Per-rep homepage banner targeting with schedule/priority, falling back to the existing global list when unassigned |
| Inventory Visibility | Reps see only In Stock/Out of Stock, never a quantity — with an admin-controlled override independent of real stock |
| Commission Engine | Per-product percentage or fixed commission rules, date-ranged, with standing vs. campaign rates |
| Earnings Dashboard | A self-scoped "My Earnings" view — sales figures, commission earned/pending/paid, settlement history, statement export |
| Admin Commission Management | Settlement approval/rejection, recording how a settlement was paid, receipts |
| Accounting Integration | A paid settlement becomes a real `Expense` row — automatically included in Liquid Cash, Sales Analysis, and Equity with no changes to any of those calculations |
| Representative Activity Log | A dedicated, richer (IP/device) audit trail — rep read-only, admin read+delete |
| Customer Collection Management | Reps record what they collected in the field; only an admin's confirmation ever creates a real payment |
| Cheque Management | Reuses the existing cheque-status lifecycle as-is; adds an automatic rep-facing email when a cheque bounces |
| Collection Reminders | A grace-period-driven scheduled reminder email, reusing the existing invoice-overdue derivation |
| Reporting | Ten new admin reports — representative/collection/commission/settlement/cheque/product/category performance |

### 31.2 The architectural decisions that make this additive

Three decisions carry the whole safety argument, each made explicit and defended in full in
`version2_changes_backend.md` §2, §8, and §14 respectively — restated briefly here because they're the
parts most worth an architect double-checking before implementation begins:

1. **Commission is computed outside the order pipeline, not inside it.** `OrdersService.applyApproval()` —
   already guaranteed untouched in §30's compatibility audit — stays untouched. A new, independent scheduled
   job reads already-approved orders after the fact and writes commission ledger entries; it never calls
   into, and cannot affect, order approval itself. The cost is a few minutes of lag between approval and a
   commission line appearing; the benefit is a hard, provable zero-change guarantee on the highest-scrutiny
   code in the system.
2. **A representative's collection submission cannot move money.** It is a staging record an admin reviews;
   only the admin's confirmation action calls the existing, completely unmodified `PaymentsService.create()`
   — the same guarded function (row-locking, overpayment checks, balance updates) that already governs every
   payment in production. There is no new way for money to move in this system, only a new front door onto
   the same, unmodified door that already exists.
3. **Stock visibility is a response-serialization rule, not a data change.** `Product.currentStock` is never
   renamed, reinterpreted, or touched by any new write path — a representative's response simply never
   contains it, the same way `costPrice` is already stripped from every dealer-facing response today.

### 31.3 Schema footprint

Fourteen new tables, six new enums, and reverse-relation-only additions to `Dealer`, `Order`, `Invoice`,
`Payment`, `Product`, `Banner`, and `Expense` — zero existing columns added, renamed, or removed on any of
them. Full DDL in `version2_changes_backend.md` §1. This also revises two details of the not-yet-built
`Representative`/`ActivityLog.repId` sketch from §23 above — `Representative.status` becomes a dedicated
`RepresentativeStatus` enum rather than a reuse of `AccountStatus`, and representative auditing gets its own
dedicated `RepresentativeActivityLog` table rather than the shared `ActivityLog` — both explained in
`version2_changes_backend.md` §3.3 and §13.3, and both zero-risk because neither table has been built yet.

### 31.4 Migration phasing

Follows the same additive-DDL-first, independently-deployable discipline as §25: **Phase 0** (schema only,
deployable before any application code) → **Phase 1** (representative lifecycle: management, login, product
assignment, inventory visibility) → **Phase 2** (money: commission, settlements, accounting integration,
collections) → **Phase 3** (banner assignment, rich activity log, cheque-return email, reminders, reporting,
earnings dashboard UI). Full detail in `version2_changes_backend.md` §19.

### 31.5 The same guarantee, once more

Every claim in `version2_changes_backend.md` §20's safety audit reduces to the same sentence this whole
document keeps returning to: **new things are added beside the existing system, or they call into it exactly
the way an admin already does today — never inside it, never around it.** Zero production data loss, zero
historical data touched, zero breaking API changes, zero downtime migration, full backward compatibility —
proven per-feature in the companion document, not merely asserted here.
