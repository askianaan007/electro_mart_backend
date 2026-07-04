**ELECTRO MART**

**ERP & Dealer Ordering System**

*Software Requirements Document — Minimal Build Version*

| Document Type | Software Requirements Document (SRD) |
| --- | --- |
| Prepared For | Electro Mart |
| Scope | Minimal Viable ERP (Phase 1) |
| Status | Draft for Developer / Designer Handoff |

# 1. Project Overview

Electro Mart is a wholesale electronics distributor (TVs and appliances). Inventory, purchases, sales, collections, and accounting are currently tracked in Excel.

The goal of Phase 1 is a small, focused system with two things only:

- A private ordering portal for approved dealers (no public sign-up).
- A simple back-office for the admin to approve orders, track stock, and record payments.

This is not a public e-commerce store. Dealers cannot register themselves — only the admin creates dealer accounts. Every order needs admin approval before it becomes a confirmed sale. This keeps pricing, stock, and credit fully under the owner's control.

## Who Uses It

| User | What They Do |
| --- | --- |
| Admin (Owner) | Manages products, stock, dealers, orders, payments, and reports. |
| Dealer (Retail Customer) | Logs in, browses products, places order requests, tracks status, views invoices. |

# 2. Core Flow — Order Approval (Most Important Part)

This is the heart of the system. Everything else supports this one flow. Follow it step by step:

**1. Dealer logs in**
Using the username/password created by the admin.

↓

**2. Dealer browses products**
Sees name, image, wholesale price, and stock availability.

↓

**3. Dealer adds items to cart and submits order**
Order status is set to 'Pending Approval'. Nothing is confirmed yet.

↓

**4. Admin is notified**
New order appears on the admin dashboard, plus an email alert.

↓

**5. Admin reviews the order**
Checks stock, price, and dealer's credit/outstanding balance.

| ✓ Approved | ✗ Rejected |
| --- | --- |
| Stock is reserved, an invoice is generated, and the dealer is notified. | Dealer is notified with a short reason. No stock or invoice changes. |

**1. Order is packed and delivered**
Admin marks status as Packed → Delivered.

↓

**2. Order marked Completed**
Stock is deducted for good, invoice moves to Sales record, and outstanding balance updates.

## Order Status Values

Keep this list short — 6 statuses is enough for a minimal build:

- Pending Approval
- Approved
- Rejected
- Packed
- Delivered
- Completed

# 3. Supporting Flow — Inventory

Stock only moves in two directions. Keep the logic simple:

**1. Purchase recorded**
Admin logs a new purchase from a supplier → stock quantity increases.

↓

**2. Dealer order is approved**
Stock for those items is reserved (held, not yet removed).

↓

**3. Order marked Delivered / Completed**
Reserved stock is deducted from available inventory for good.

↓

**4. Reports update automatically**
Stock levels, low-stock alerts, and sales figures refresh.

# 4. What to Build — Minimal Module List

This is intentionally kept small. Build these 7 modules first. Everything else (barcode scanning, WhatsApp alerts, multi-branch, etc.) is a later phase, not Phase 1.

**1. Login**
- Admin login (email + password)
- Dealer login (username + password, account created by admin only)

**2. Dealer Management**
- Admin creates / edits / deactivates dealer accounts
- Basic info: business name, contact, address, credit limit, outstanding balance

**3. Product & Stock**
- Admin adds/edits products: code, name, category, price, current stock
- Stock auto-updates from purchases and completed orders
- Low-stock alert on dashboard

**4. Ordering Portal (Dealer side)**
- Browse products, view price and stock
- Add to cart, submit order
- Track order status, view past orders and invoices

**5. Order Approval (Admin side)**
- View pending orders
- Approve or reject with a short reason
- Update status: Packed → Delivered → Completed

**6. Sales & Payments**
- Auto-generate invoice on approval
- Track paid / pending / overdue per dealer
- Simple outstanding balance per dealer

**7. Dashboard & Basic Reports**
- Admin: today's orders, pending approvals, low stock, outstanding payments
- Dealer: their own pending orders, balance, recent invoices
- Reports: daily/monthly sales, stock list, outstanding customers

# 5. Notifications (Keep It Simple)

Only email is needed for Phase 1 — no SMS or WhatsApp yet.

| Who Gets Notified | When |
| --- | --- |
| Admin | New order submitted, stock running low |
| Dealer | Order approved, order rejected, invoice ready |

# 6. Suggested Improvements (Small, Worth Adding)

These are not extra modules — just small rules inside the modules above that prevent common problems:

- Credit check: block a new order if it pushes the dealer over their credit limit.
- Stock reservation: hold stock the moment an order is approved, so two dealers can't order the last unit.
- Simple activity log: record who approved/rejected each order and when.

# 7. Suggested Tech Stack (Simple & Cheap to Run)

| Layer | Recommendation |
| --- | --- |
| Frontend | Next.js (works well for both admin panel and dealer portal) |
| Backend | Laravel or NestJS |
| Database | PostgreSQL |
| File Storage | Cloudflare R2 or AWS S3 (product images, invoices) |
| Login Security | JWT tokens + role-based access (Admin vs Dealer) |

*Note: A mobile app, barcode scanning, WhatsApp notifications, and multi-branch support are good future upgrades — but keeping Phase 1 to a web-only admin + dealer portal will get the system live faster and cheaper.*



**ELECTRO MART**

**Screen List & Wireframe Element Guide**

*Companion to the SRD — Phase 1 (Minimal Build)*

This document lists every screen needed for Phase 1, grouped by Admin Panel and Dealer Portal, plus the exact UI elements each screen needs. Hand this directly to a designer to build wireframes — each screen card below can become one wireframe frame.

## How to Read Each Screen Card

- Number + Name — the screen title (use as the wireframe frame name).
- Purpose — one line describing what the screen is for.
- Element rows — grouped by section (Header, Body, Actions, etc.) with the exact fields/buttons/components to place.

## Screen Count Summary

| Admin Panel | Dealer Portal |
| --- | --- |
| 12 screens | 8 screens |

*Plus 2 shared screens (Login, Forgot Password) used by both sides — 22 total wireframes for Phase 1.*

---

## SHARED SCREENS (Used by Both Admin & Dealer)

### 1. Login Screen
*Single entry point; system detects role after login and routes accordingly.*

| Section | Elements |
| --- | --- |
| Header | • Electro Mart logo<br>• App name / tagline |
| Form | • Email or Username field<br>• Password field (show/hide toggle)<br>• "Forgot Password?" link<br>• Login button |
| Footer | • Error message area (invalid credentials)<br>• Version/copyright text (optional) |

### 2. Forgot Password Screen
*Lets a dealer or admin reset a forgotten password via email.*

| Section | Elements |
| --- | --- |
| Form | • Email input field<br>• "Send Reset Link" button<br>• Back to Login link |
| Confirmation State | • Success message: "Reset link sent to your email" |

---

## ADMIN PANEL — 12 Screens

### 3. Admin Dashboard
*Landing screen after admin login; snapshot of the whole business.*

| Section | Elements |
| --- | --- |
| Top Bar | • Logo<br>• Search bar (global)<br>• Notification bell icon with count badge<br>• Admin profile avatar + dropdown (Profile, Logout) |
| Side Menu | • Dashboard<br>• Orders<br>• Products<br>• Inventory<br>• Dealers<br>• Purchases<br>• Sales & Invoices<br>• Payments/Collections<br>• Suppliers<br>• Reports<br>• Settings |
| KPI Cards | • Today's Sales (amount)<br>• Today's Orders (count)<br>• Pending Approvals (count, highlighted)<br>• Low Stock Items (count, warning color)<br>• Outstanding Payments (amount) |
| Charts | • Monthly Revenue line/bar chart<br>• Top Selling Products chart |
| Lists | • Recent Orders table (Order #, Dealer, Amount, Status)<br>• Recent Activity feed |

### 4. Dealer List Screen
*Admin views and manages all dealer accounts.*

| Section | Elements |
| --- | --- |
| Top Bar | • Page title "Dealers"<br>• Search box (by name/phone)<br>• Filter (Status: Active/Inactive)<br>• "+ Add Dealer" button |
| Table | • Business Name<br>• Owner Name<br>• Phone<br>• Credit Limit<br>• Outstanding Balance<br>• Status badge (Active/Inactive)<br>• Action icons (View, Edit, Deactivate) |
| Footer | • Pagination controls |

### 5. Add / Edit Dealer Screen
*Form to create a new dealer account or update existing details.*

| Section | Elements |
| --- | --- |
| Form Fields | • Business Name<br>• Owner Name<br>• Phone Number<br>• Email<br>• Address<br>• District (dropdown)<br>• Username (auto-suggested or manual)<br>• Temporary Password (auto-generate option)<br>• Credit Limit (amount)<br>• Status toggle (Active/Inactive) |
| Actions | • Save button<br>• Cancel button<br>• Delete/Deactivate (edit mode only) |

### 6. Dealer Profile / Detail Screen
*Admin drills into one dealer's full history.*

| Section | Elements |
| --- | --- |
| Header | • Business name + status badge<br>• Edit button |
| Summary Cards | • Credit Limit<br>• Outstanding Balance<br>• Total Orders<br>• Total Purchases (lifetime) |
| Tabs | • Order History<br>• Invoices<br>• Payment History<br>• Ledger |

### 7. Product List Screen
*Admin manages the product catalog.*

| Section | Elements |
| --- | --- |
| Top Bar | • Page title "Products"<br>• Search box<br>• Category filter dropdown<br>• "+ Add Product" button |
| Table / Grid | • Product image thumbnail<br>• Product Code / SKU<br>• Name<br>• Category<br>• Wholesale Price<br>• Current Stock (with low-stock highlight)<br>• Status badge<br>• Action icons (Edit, Delete) |
| Footer | • Pagination controls |

### 8. Add / Edit Product Screen
*Form to create or update a product.*

| Section | Elements |
| --- | --- |
| Form Fields | • Product Code<br>• SKU / Barcode<br>• Product Name<br>• Brand<br>• Category (dropdown)<br>• Model<br>• Description (text area)<br>• Product Image upload<br>• Cost Price<br>• Wholesale Price<br>• Selling Price<br>• Current Stock (view-only if editing)<br>• Minimum Stock threshold<br>• Warranty period<br>• Status toggle (Active/Inactive) |
| Actions | • Save button<br>• Cancel button |

### 9. Inventory Screen
*Admin tracks stock movement and levels.*

| Section | Elements |
| --- | --- |
| Top Bar | • Page title "Inventory"<br>• Search/filter by product<br>• "+ Stock Adjustment" button |
| Table | • Product Name / Code<br>• Current Quantity<br>• Minimum Stock<br>• Status (In Stock / Low Stock / Out of Stock badge)<br>• Last Updated date |
| Side Panel / Tab | • Inventory Ledger (Date, Type: Purchase/Sale/Adjustment, Qty In, Qty Out, Balance) |

### 10. Purchase Entry Screen
*Admin records a new stock purchase from a supplier.*

| Section | Elements |
| --- | --- |
| Header Fields | • Supplier (dropdown)<br>• Invoice Number<br>• Purchase Date (date picker) |
| Line Items Table | • Product (searchable dropdown)<br>• Quantity<br>• Unit Cost<br>• Line Total (auto-calculated)<br>• "+ Add Item" row button<br>• Remove line icon |
| Summary | • Total Purchase Value (auto-calculated) |
| Actions | • Save Purchase button<br>• Cancel button |

### 11. Order Approval Screen (Core Screen)
*Admin reviews and acts on a dealer's submitted order.*

| Section | Elements |
| --- | --- |
| Header | • Order Number<br>• Dealer name + link to profile<br>• Order Date<br>• Status badge (Pending Approval) |
| Dealer Info Panel | • Credit Limit<br>• Current Outstanding Balance<br>• Warning banner if order exceeds credit limit |
| Order Items Table | • Product Name<br>• Quantity Requested<br>• Unit Price<br>• Available Stock (for comparison)<br>• Line Total |
| Summary | • Subtotal<br>• Discount (if any)<br>• Total Order Value |
| Actions | • Approve button (primary, green)<br>• Reject button (red) — opens reason input<br>• Request Modification button (optional) |

### 12. Orders List Screen (Admin)
*Admin sees all orders across every status.*

| Section | Elements |
| --- | --- |
| Top Bar | • Page title "Orders"<br>• Status filter tabs (All, Pending, Approved, Rejected, Packed, Delivered, Completed)<br>• Search by Order # or Dealer |
| Table | • Order Number<br>• Dealer Name<br>• Date<br>• Total Amount<br>• Status badge (color-coded)<br>• Action icon (View/Update Status) |

### 13. Invoice / Sales Record Screen
*View of a generated invoice tied to a completed or approved order.*

| Section | Elements |
| --- | --- |
| Header | • Electro Mart letterhead / logo<br>• Invoice Number<br>• Invoice Date<br>• Dealer billing details |
| Items Table | • Product<br>• Qty<br>• Unit Price<br>• Discount<br>• Line Total |
| Summary | • Subtotal<br>• Discount Total<br>• Grand Total<br>• Payment Status badge (Paid/Pending/Overdue) |
| Actions | • Download PDF button<br>• Print button<br>• Mark as Paid button |

### 14. Payments / Collections Screen
*Admin tracks money coming in against invoices.*

| Section | Elements |
| --- | --- |
| Top Bar | • Page title "Collections"<br>• Filter by Status (Paid/Pending/Overdue/Partial)<br>• Filter by Dealer |
| Table | • Invoice Reference<br>• Dealer Name<br>• Amount<br>• Due Date<br>• Status badge<br>• "Record Payment" action icon |
| Record Payment Modal | • Amount Received<br>• Payment Mode (Cash/Cheque/Bank Transfer)<br>• Payment Date<br>• Reference/Cheque Number<br>• Save button |

---

## DEALER PORTAL — 8 Screens

### 15. Dealer Dashboard
*Landing screen after dealer login.*

| Section | Elements |
| --- | --- |
| Top Bar | • Logo<br>• Notification bell icon<br>• Profile avatar + dropdown (Profile, Logout) |
| Side / Bottom Menu | • Dashboard<br>• Products<br>• Cart<br>• My Orders<br>• Invoices<br>• Profile |
| Summary Cards | • Outstanding Balance<br>• Credit Limit (remaining)<br>• Pending Orders (count) |
| Lists | • Recent Orders (Order #, Date, Status, Amount)<br>• Current Promotions / Offers banner |

### 16. Product Catalog Screen
*Dealer browses available products.*

| Section | Elements |
| --- | --- |
| Top Bar | • Search bar<br>• Category filter chips/dropdown<br>• Sort (Price, Name) |
| Product Grid | • Product image<br>• Product name<br>• Wholesale price<br>• Stock availability badge (In Stock / Low / Out of Stock)<br>• "Add to Cart" button with quantity stepper |

### 17. Product Detail Screen
*Dealer views full details of one product before ordering.*

| Section | Elements |
| --- | --- |
| Image Area | • Product photo (large) |
| Info Panel | • Product Name<br>• Category / Brand<br>• Description<br>• Wholesale Price<br>• Stock Availability<br>• Warranty info |
| Actions | • Quantity selector<br>• "Add to Cart" button |

### 18. Cart Screen
*Dealer reviews items before submitting an order.*

| Section | Elements |
| --- | --- |
| Items List | • Product thumbnail + name<br>• Unit price<br>• Quantity stepper (editable)<br>• Line total<br>• Remove item icon |
| Summary Panel | • Subtotal<br>• Estimated total<br>• Outstanding balance reminder (if near credit limit) |
| Actions | • "Submit Order" button (primary)<br>• "Continue Shopping" link |

### 19. Order Confirmation Screen
*Brief confirmation shown right after an order is submitted.*

| Section | Elements |
| --- | --- |
| Content | • Success icon/illustration<br>• "Order Submitted — Pending Approval" message<br>• Order Number<br>• "View Order" button<br>• "Back to Dashboard" button |

### 20. My Orders List Screen
*Dealer tracks all their past and current orders.*

| Section | Elements |
| --- | --- |
| Top Bar | • Status filter tabs (All, Pending, Approved, Rejected, Delivered, Completed) |
| Table / Cards | • Order Number<br>• Date<br>• Total Amount<br>• Status badge (color-coded)<br>• "View Details" action |

### 21. Order Detail Screen (Dealer)
*Dealer views the full status and items of one order.*

| Section | Elements |
| --- | --- |
| Header | • Order Number<br>• Status badge + timeline (Pending → Approved → Packed → Delivered → Completed)<br>• Rejection reason banner (if rejected) |
| Items Table | • Product<br>• Quantity<br>• Unit Price<br>• Line Total |
| Footer | • Total Amount<br>• "Download Invoice" button (once approved) |

### 22. Invoices & Payments Screen (Dealer)
*Dealer views billing history and what they owe.*

| Section | Elements |
| --- | --- |
| Summary Cards | • Total Outstanding Balance<br>• Credit Limit |
| Table | • Invoice Number<br>• Date<br>• Amount<br>• Payment Status badge (Paid/Pending/Overdue)<br>• "Download" icon |

---

## Wireframe Notes

### Reusable Components (Build Once, Use Everywhere)

- Status badge (color-coded: grey = pending, green = approved/paid, red = rejected/overdue, blue = in progress)
- Data table with search + filter + pagination (used on 8+ screens)
- Modal / dialog for quick actions (Record Payment, Reject Reason, Stock Adjustment)
- Empty states (e.g. "No orders yet", "Cart is empty")
- Toast/snackbar for save confirmations and errors

### Priority Order for Wireframing

If designing in stages, build in this order — it matches how a dealer's first order flows through the system:

- 1. Login → 2. Dealer Dashboard → 3. Product Catalog → 4. Cart → 5. Order Confirmation
- 6. Admin Dashboard → 7. Order Approval Screen → 8. Orders List (Admin)
- 9. My Orders (Dealer) → 10. Order Detail (Dealer) → 11. Invoice Screen
- Remaining screens (Products, Inventory, Purchases, Dealers, Payments) can follow after the core loop is approved.