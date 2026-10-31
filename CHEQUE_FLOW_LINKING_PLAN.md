# Cheque Flow — linking ERP cheques (analysis & plan)

Status: **implemented (option A, live read-through)** — 2026-10-31. Follows `CHEQUE_FLOW_PLAN.md`.

Built: `src/cheque-flow/cheque-flow.sources.ts` (adapters), merged reads in
`cheque-flow.service.ts`, duplicate guard (manual add / restore / import),
`SupplierPayment.bankName` (migration `20261101120000_supplier_payment_bank_name`),
tests `test/integration/cheque-flow-linked.int-spec.ts`. Refund cheques included;
rep commission, investor and unapproved collection cheques left out.

Goal: every customer cheque recorded in **Payments** and every supplier cheque
recorded in **Credits → settlements** shows on `/admin/cheque-flow`
automatically, with the right status, so the Excel upload is no longer needed —
without any risk to existing money data.

---

## 1. Where cheques are recorded today

| Source (page) | Table | Direction | Written by |
|---|---|---|---|
| Payments → Record payment (mode Cheque) | `Payment` | Customer → us (RECEIVABLE) | `payments.service` create / update / updateChequeStatus / remove / undo |
| Rep collections → Approve (cheque) | `Payment` (via `createInTransaction`) | RECEIVABLE | `collections.service` |
| Order delete (removes its invoice's payments) | `Payment` (deleteMany) | RECEIVABLE | `dealers.service` |
| Credits → supplier → Add settlement (mode Cheque) | `SupplierPayment` | Us → supplier (PAYABLE) | `credits.service` createSettlement / updateChequeStatus / deleteSettlement |
| Refunds (cheque) | `Refund` | dealer refund = PAYABLE, supplier refund = RECEIVABLE | `refunds` |
| Rep commission settlement (cheque) | `RepresentativeSettlement` | PAYABLE (to rep) | `commission` |
| Investments (cheque) | `Investment` | RECEIVABLE (from investor) | `investments` |

Production check (read-only, 2026-10-31): **0 cheques in all of these tables and
0 Cheque Flow entries** — so there is nothing to back-fill and no duplicates to
untangle today.

### Field mapping

| Cheque Flow field | `Payment` (customer) | `SupplierPayment` (supplier) |
|---|---|---|
| Cheque no. | `chequeNumber` | **`reference`** (the form labels it "Cheque number") |
| Bank | `bankName` | **missing — no column** |
| Cheque date | `chequeDate` (fallback `paymentDate`) | `chequeDepositDate` |
| Name | `dealer.businessName` | `supplier.name` |
| Invoice ref | `invoice.invoiceNumber` (null = advance) | — (settlements aren't tied to a purchase) |
| Amount | `amount` | `amount` |
| Status | PENDING / CLEARED / **RETURNED → Bounced** | same |
| Cleared date | `chequeStatusUpdatedAt` when CLEARED (the day it was marked) | same |
| Remarks | `remarks` | `remarks` |
| Cancelled | — (a deleted payment simply disappears) | — |

Gap: supplier settlements have **no bank name**. Fix = add one nullable column
(see §4).

---

## 2. Options

### A. Live read-through (recommended)
Cheque Flow reads ERP cheques **directly from `Payment` / `SupplierPayment` at
query time** and merges them with its own manual rows. Nothing is copied.

- ✅ Zero writes to the ERP from Cheque Flow → cannot corrupt balances.
- ✅ Never out of date: a cheque recorded, edited, bounced, undone or deleted
  anywhere in the app is reflected on the next load. No code path can be
  "missed" (collections approval, undo, order delete all just work).
- ✅ No back-fill, no sync job.
- ⚠️ Status changes made *from* Cheque Flow on a linked row must go through the
  existing endpoints (`PATCH /payments/:id/cheque-status`,
  `PATCH /credits/settlements/:id/cheque-status`) so the existing
  balance / wallet / liquid-cash rules run exactly as on those pages. Edit and
  delete of linked rows open the source page instead (one place owns money).
- ⚠️ Summary / timeline / chart / filters must combine 3 sources. Volumes are
  small (hundreds–thousands of cheques), so merge in the service with the same
  filters applied to each source.

### B. Mirror / sync rows
Every payments / credits write also writes a `ChequeFlowEntry` in the same
transaction (`sourceType`, `sourceId`).

- ✅ One table, simple queries.
- ❌ Touches the core money transactions in ~10 places (create, update, status,
  undo, delete, collections approve, order delete…). Any path missed now or
  added later silently drifts. A failure in the mirror write would roll back a
  real payment.
- ❌ Needs a reconciliation job to catch drift.

### C. One-off "pull from ERP" button
Copies ERP cheques into Cheque Flow on demand. Simple, but stale immediately and
statuses diverge — doesn't meet "maintain this page".

**Recommendation: A.**

---

## 3. Design for option A

### Rows
Each item in the list gets `source`:
- `MANUAL` — Cheque Flow's own row (today's behaviour, fully editable).
- `PAYMENT` — from `Payment` (badge "Payments", link to the dealer/payment).
- `SETTLEMENT` — from `SupplierPayment` (badge "Credits", link to the supplier).

Ids are prefixed (`pay_<uuid>`, `set_<uuid>`) so the UI can't confuse sources.

### Actions on linked rows
| Action | Linked row behaviour |
|---|---|
| Mark cleared | calls the existing ERP cheque-status endpoint (same rules: clears into Liquid Cash) |
| Bounced | ERP status RETURNED (reverses balance exactly like Payments/Credits page; customer over-payment rule `excessToWallet` keeps its dialog) |
| Back to pending | ERP endpoint (it already refuses unsafe re-presentations) |
| Cancelled | not offered — ERP has no "cancelled"; delete on the source page |
| Edit / Delete | "Open in Payments / Credits" link |

Cleared date: ERP stores *when it was marked*; the dialog won't ask for a date on
linked rows (or we add a nullable `chequeClearedDate` later — not needed now).

### Duplicates between manual and ERP rows
Same direction + same cheque key (+ bank when both known) = same cheque.
- Creating a manual cheque that already exists in Payments/Credits → refused
  with "Already recorded in Payments — open it there".
- An *existing* manual/imported row that later also gets recorded in the ERP →
  the ERP row wins; the manual one is shown greyed "Duplicate of payment …",
  excluded from totals, with a one-click "remove manual copy" (soft delete).
- Recording a payment in Payments/Credits is **never** blocked by Cheque Flow.

### Optional extra sources (your choice)
- Refund cheques (customer refund = payable, supplier refund = receivable).
- Rep commission cheques (payable).
- Investor cheques (receivable).
Default proposal: include **refunds**; leave commission & investments out (not
customer/supplier). Each is a small, read-only addition later.

### Rep collections not yet approved
`CollectionSubmission` cheques (rep collected, admin hasn't approved) are not
payments yet. Option: show them in a separate "Awaiting approval" strip, not in
totals. Default: leave out.

---

## 4. Database changes (all additive, nothing existing altered)

1. `SupplierPayment.bankName String?` (nullable) — so supplier cheques have a
   bank. Old rows stay null and display "—". Settlement form gets an optional
   "Bank" field when mode = Cheque.
2. *(Optional)* indexes for the read-through filters:
   `Payment(mode, chequeDate)`, `SupplierPayment(mode, chequeDepositDate)`.
   Pure index adds; no data rewrite.

No changes to `ChequeFlowEntry` are required for option A.
Migration is additive and safe with `prisma migrate deploy`; existing rows are
untouched.

---

## 5. Safety rules
- Cheque Flow never writes `Payment`, `SupplierPayment`, `Invoice`, `Dealer`,
  `Supplier`, wallets or Liquid Cash directly — only via the existing service
  methods that the Payments/Credits pages already use (same transactions, same
  locks, same audit/revision rows).
- Admin-only, as now.
- Integration tests: record / bounce / undo / delete a payment and a settlement
  → Cheque Flow reflects it; status change from Cheque Flow produces the same
  dealer/supplier balances and Liquid Cash as doing it on the source page;
  duplicate guard both ways; ERP tables fingerprint unchanged by Cheque Flow
  reads.

## 6. Work estimate
Backend: source adapters + merged list/summary/timeline/monthly/alerts/options,
status proxy, duplicate guard, migration (1 column), tests.
Frontend: source badge + links, action rules per source, settlement form bank
field, duplicate messages. Exports/print include linked rows automatically.
