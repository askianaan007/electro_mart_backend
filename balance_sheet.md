# Balance Sheet — Final Audit Correction, Accounting Validation & Implementation Specification

Prepared: 2026-08-17 (final revision of this document). This supersedes both prior versions
(2026-08-16 initial analysis, 2026-08-17 re-audit). **No production code was changed to produce this
revision** — every change below is to this document only. `BalanceSheetService`/`Controller`/DTOs remain
unimplemented by design, pending the accounting decisions flagged in §5 and §10.

---

## 1. Executive Summary

The backend has no general ledger. Every financial figure is computed live from raw transactional tables by
a small set of independent, already-correct "position" services (`LiquidCashService`, `CreditBalanceService`,
`EquityService`, `SalesAnalysisService`). Building a Balance Sheet means **composing** these, adding exactly
two new aggregates (inventory valuation, commission payable), and — this is the part both prior versions of
this document underserved — **reconciling, not hiding**, one structural timing gap in the existing order
pipeline.

Three findings from the prior re-audit are re-confirmed and now traced to their exact source line
(§9): a pending **dealer** cheque already leaves Accounts Receivable (not just "eventually," immediately on
recording) while not yet being real cash, and a pending **supplier** cheque does the mirror-image thing to
Accounts Payable. Both need their own asset/liability line — this is settled, not up for debate.

What changes in this revision:

1. **The reconciliation model is no longer a single boolean.** §13 derives, from the actual order/inventory
   code (not by assumption), an exact formula for the one known timing difference the system produces, and
   defines `rawDifference`, `knownTimingDifference`, and `unexplainedDifference` as three independently
   computable numbers — with a worked example using the verified sign convention (assets are understated by
   this gap, never overstated — see §13.2 for why the signs in this document differ from the illustrative
   example in the request that commissioned it).
2. **Commission Payable is corrected from "included liability" to "memorandum-only."** The prior revision of
   this document included `commissionPayable` inside `totalLiabilities` with only a disclosure warning
   attached — but nothing on the Asset or Equity side is ever reduced to match it while it's
   `PENDING`/`APPROVED` (§10), so including it would make the Balance Sheet **structurally, permanently**
   unbalanced by that amount any time commission is outstanding — a normal, near-constant state, not a rare
   edge case. §7.3/§10 now specify **Option B**: `commissionPayable` is computed and exposed, but excluded
   from every official total (`totalLiabilities`, `liabilitiesAndEquity`, `rawDifference`) and reported only
   under a dedicated `memorandum` section — exactly like the `unsupported` categories are excluded, but for a
   different, explicitly stated reason (real data, deliberately off-equation, not "no data model exists").
3. **Equity terminology is corrected.** §8 stops calling the signed investment aggregate "Investor Capital"
   and instead splits it, reliably, into `capitalContributions` / `ownerWithdrawals` by the sign of
   `Investment.amount` — verified computable, not invented. "Retained Earnings" is renamed
   `accumulatedEarnings` throughout, since the system has no period-close mechanism to justify the
   traditional term (§8.3).

---

## 2. Audit scope — files re-verified this pass

Every claim in this document is sourced to a specific file/line read or grepped in this session or the prior
one (both are cited where relevant — this revision does not re-derive facts that were already correctly
established, only corrects/extends them).

**Newly traced this pass** (not fully pinned down before):
- `src/orders/orders.service.ts:267-302` (`applyApproval`, the single shared choke point for
  `InventoryLogType.RESERVE`) and its two call sites (`approve()` at `:968-994`, and the admin
  auto-approve/backdated-completion branch of `create()`) — this is what makes the §13 reconciliation formula
  precise rather than approximate.
- `src/sales-returns/sales-returns.service.ts:48-49, :140-141` — both mutation entry points hard-require
  `order.status === OrderStatus.COMPLETED`, confirming a sales return can **never** exist against an order
  still `APPROVED`/`PACKED`/`DELIVERED` — this is what lets §13's formula skip a returns adjustment entirely
  for that order subset.
- `src/equity/equity.service.ts:32-35, :142` re-read specifically to confirm `totalInvestment` is an
  unfiltered signed sum (no `WHERE amount > 0`), and that the existing `getHistory()` view already treats
  sign as the authoritative contribution/withdrawal signal — this licenses the §8 terminology split.

**Re-confirmed, unchanged from the 2026-08-17 re-audit** (full citations there, not repeated in full here):
`LiquidCashService`, `CreditBalanceService`, `PaymentsService.create()`/`updateChequeStatus()`,
`purchases.service.ts`'s transport-charge business rule, `CreatePaymentDto.invoiceId` being required (not
optional), the commission `PENDING→APPROVED→SETTLED` trace in `settlements.service.ts`, and the test-suite
inventory (`find src -name "*.spec.ts"` → 4 files, zero financial coverage).

**Out of scope for this pass, unchanged claims**: `credits.service.ts` (per-supplier mirror of
`CreditBalanceService`), representative/rep-portal modules (no direct Balance Sheet footprint — their money
movements are already captured through `Order`/`Payment`/`Expense`/`CommissionLedgerEntry`, which this
document does cover).

---

## 3. Current backend financial architecture

```
LiquidCashService     → Cash & Bank, pending dealer/supplier cheques (§6, §9)
CreditBalanceService  → Accounts Payable, pending supplier cheque settlements (§7, §9)
EquityService         → Capital contributions/withdrawals, accumulated earnings (§8)
SalesAnalysisService  → Gross profit (COMPLETED orders only, COGS-based) — feeds EquityService (§8.3)
InventoryService      → Stock quantities and movement ledger — no valuation (§11)
PaymentsService        → The single writer of Payment rows; owns AR (Dealer.outstandingBalance) mutation
                          logic and cheque-status transitions (§9)
OrdersService          → Owns AR timing (only COMPLETED books it) and the RESERVE inventory movement (§12)
SalesReturnsService     → Credit-note-style AR reduction, COMPLETED-only (§2, §13)
CommissionReconciliation
  + SettlementsService → Commission earned → payable → (settlement) → paid → Expense (§10)
DashboardService        → Consumer of the above, not a source of truth for anything new
```

No module in this list duplicates another's formula. The Balance Sheet's job is composition, plus exactly
two new aggregates (§11 inventory valuation, §10 commission payable) and the reconciliation layer (§13) that
neither of the two prior documents specified precisely enough to implement.

---

## 4. Final gap report

| # | Line | Status | Where it's settled in this document |
|---|---|---|---|
| 1 | Cash & Bank | EXISTS, correct as-is | §6.1 |
| 2 | Accounts Receivable | EXISTS, **known timing gap, now formalized** | §6.2, §12, §13 |
| 3 | Cheques in Hand (dealer) | MISSING from any API today, **required, not optional** | §6.3, §9 |
| 4 | Inventory value | MISSING, one new aggregate | §6.4, §11 |
| 5 | Accounts Payable | EXISTS, correct as-is (transport-charge rule verified) | §7.1 |
| 6 | Supplier Cheques Issued | MISSING from any API today, **required, mirrors #3** | §7.2, §9 |
| 7 | Commission Payable | MISSING, one new aggregate, **decided: memorandum-only, excluded from official totals** | §7.3, §10 |
| 8 | Equity — capital contributions | EXISTS, **renamed from "Investor Capital"** | §8.1 |
| 9 | Equity — owner withdrawals | EXISTS (same table, sign-split), **was previously invisible, not absent** | §8.2 |
| 10 | Equity — accumulated earnings | EXISTS (derived), **renamed from "Retained Earnings"** | §8.3 |
| 11 | Supplier Advances | UNSUPPORTED | §14 |
| 12 | Prepaid Expenses | UNSUPPORTED | §14 |
| 13 | Fixed Assets / Depreciation | UNSUPPORTED | §14 |
| 14 | Tax Payable | UNSUPPORTED | §14 |
| 15 | Accrued Expenses | UNSUPPORTED | §14 |
| 16 | Customer Advances | UNSUPPORTED **in practice** (schema allows, API blocks — §2 of prior audit) | §14 |
| 17 | Business Loans | UNSUPPORTED | §14 |
| 18 | `isBalanced: boolean` alone as the reconciliation output | **INCORRECT design, replaced** | §13, §18 |

---

## 5. Verified accounting basis

Confirmed **hybrid**, traced through actual write paths (unchanged conclusion from the prior re-audit, kept
here because §10 depends on it):

- **Trade receivables/payables are accrual-style**: a `Purchase` creates Accounts Payable the instant it's
  recorded; a cheque (either direction) is treated as settled the instant it's *written*, only reversed if
  it bounces. AR follows the same "written = committed" rule (§9) — not, as originally assumed, the same
  "only counts once cleared" rule Liquid Cash uses.
- **Expenses (including commission payouts) are cash-basis**: `Expense` rows are only ever created at the
  literal moment money leaves — `ExpensesService.create()` or `SettlementsService.createSettlementExpense()`
  (called only from `pay()`), never earlier.

**Decision, now resolved (§10)**: unlike Accounts Payable — where a `Purchase` simultaneously creates the
liability *and* a matching asset (`Inventory`, via the same transaction's stock increase), unpaid commission
has **no matching asset-side or equity-side entry anywhere in the system** while it's `PENDING`/`APPROVED`
(§5, §10). Including it inside `totalLiabilities` would therefore not be a *timing* difference like §12's
order gap (which self-resolves the moment the order completes) — it would be a **standing, structural**
difference that never resolves within the Balance Sheet's own equation, for as long as any commission is
outstanding (which, given the 5-minute reconciliation cron and the settlement batching cadence, is expected
to be true almost continuously in production). §10 resolves this as **Option B**: `commissionPayable` is
computed and disclosed, but kept out of every official total.

---

## 6. Assets

### 6.1 Cash & Bank
`LiquidCashService.getSummary().balance` — `ΣInvestment.amount + ΣPayment.amount[cleared] −
ΣSupplierPayment.amount[cleared] − ΣExpense.amount`, cleared = `mode≠CHEQUE OR chequeStatus=CLEARED`.
Unchanged, correct, reused as-is.

### 6.2 Accounts Receivable
`Σ Dealer.outstandingBalance`. A maintained column, not derived at read time — mutated by `OrdersService`
(+= `invoice.grandTotal` only at `COMPLETED`), `PaymentsService` (-= `amount` at payment *creation*,
regardless of cheque status — §9), and `SalesReturnsService` (-= `totalAmount`, `COMPLETED`-only). Correct
and self-consistent; its one real limitation is the `APPROVED→COMPLETED` window, formalized in §13 rather
than treated as an unexplained error.

### 6.3 Cheques in Hand (dealer, pending) — required asset line
`LiquidCashService.getSummary().pendingDealerCheques` = `Σ Payment.amount WHERE mode=CHEQUE AND
chequeStatus=PENDING`. Required because AR (§6.2) already excludes this money the instant the cheque is
recorded (§9.1), and Cash (§6.1) doesn't include it until `CLEARED` — without this line the money is absent
from both. **Not optional, not a double-count risk** — settled finding, kept from the prior re-audit.

### 6.4 Inventory value — still the one missing aggregate
```sql
SELECT SUM("currentStock" * "costPrice") AS value FROM "Product"
```
No existing service computes this (re-confirmed by grep this pass, unchanged). `currentStock` is
authoritatively maintained by `InventoryService.recordMovement()` (`src/inventory/inventory.service.ts:32-88`)
across every movement type — purchase, sale, adjustment, reserve, release — so once built, this figure needs
no separate reconciliation against movement history; it's automatically correct because it reads the same
column every other stock-aware feature in the app already trusts. Values at `Product.costPrice` — a single,
current, mutable field, not a historical per-lot cost. See §11.3 for the explicit costing-method caveat this
implies.

---

## 7. Liabilities

### 7.1 Accounts Payable
`CreditBalanceService.getSummary().balance` — `ΣPurchase.totalValue − ΣPurchase.transportCharges −
ΣPurchaseReturn.totalAmount − ΣSupplierPayment.amount[effective]`, effective = `NOT (mode=CHEQUE AND
chequeStatus=RETURNED)`. The transport-charge subtraction is a verified, intentional business rule (supplier
absorbs it as a negotiated reduction of what they're owed — confirmed by the literal log message in
`purchases.service.ts:90-92`), not a bug. Unchanged, correct, reused as-is.

### 7.2 Supplier Cheques Issued — required liability line
`CreditBalanceService.getSummary().pendingChequeSettlements` = `Σ SupplierPayment.amount WHERE mode=CHEQUE
AND chequeStatus=PENDING`. Mirrors §6.3 exactly: AP is already reduced the instant a supplier cheque is
written (§9.2), while Cash doesn't decrease until it clears — omitting this line overstates Cash relative to
the true remaining obligation during that window. **Not optional** — this was the gap the prior document's
first pass missed entirely (it flagged the number as "informational only, already netted into AP" without
noticing the Cash-side consequence).

### 7.3 Commission Payable — real, but memorandum-only (excluded from official totals)
`Σ CommissionLedgerEntry.amount WHERE status IN (PENDING, APPROVED)`. Real, independently trackable, and
zero double-counting risk in isolation (`RepresentativeSettlement` only becomes an `Expense` — and therefore
only touches Cash/Equity — once `PAID`). **Not included in `totalLiabilities`** (§10 explains why in full):
under the system's current cash-basis expense recognition, this liability has no matching reduction anywhere
in Assets or Equity while it's outstanding, so summing it into `totalLiabilities` would make
`rawDifference` permanently nonzero by exactly this amount — a structural imbalance, not the transient §12/§13
timing gap the reconciliation model is designed to explain. It is still computed and exposed, under a
dedicated `memorandum` section (§17), with an `accountingWarnings` entry explaining the exclusion.

---

## 8. Equity — corrected terminology

`EquityService.getSummary()` remains the sole source; this section only changes how its output is *labeled*
and *decomposed* in the Balance Sheet API, not how it's computed.

### 8.1 Capital Contributions (was: "Investor Capital")
```
capitalContributions = Σ Investment.amount WHERE amount > 0
```
Reliable and computable — `equity.service.ts:142`'s own `CASE WHEN amount < 0 THEN 'WITHDRAWAL' ELSE
'INVESTMENT'` already treats sign as the authoritative signal for exactly this split, so this isn't a new
interpretation, just a query using the same rule the codebase already committed to.

### 8.2 Owner / Investor Withdrawals — was invisible in the prior document, not absent from the data
```
ownerWithdrawals = Σ Investment.amount WHERE amount < 0     (a negative number)
```
Because `EquityService.getSummary()`'s `totalInvestment` is an **unfiltered** signed sum
(`equity.service.ts:32-35`, `groupBy` with no `WHERE amount > 0`), a withdrawal already flows through into
`totalInvestment`/`totalEquity` correctly today with zero extra code — the prior document's
`investorCapital: equity.totals.totalInvestment` field name was the only thing wrong, not the math. This
revision exposes the two components separately so a negative `Investment` row is legible on the Balance
Sheet as a withdrawal rather than silently netted into an unlabeled "capital" figure.

**Limitation, stated explicitly per the request's instruction not to invent categories beyond what the sign
can support**: the schema cannot distinguish *why* a withdrawal happened (a return of capital vs. a profit
distribution vs. a correction of a data-entry error) — only that `amount < 0`. If that distinction ever
matters, it requires a new field (e.g. `Investment.category`), not something derivable today.

### 8.3 Accumulated Earnings (was: "Retained Earnings")
```
accumulatedEarnings = totalProfit − totalExpenses
```
`totalProfit` is **gross** profit from `SalesAnalysisService.getSummary({}).totalProfit` (COMPLETED orders
only, COGS-based), never `netProfit`, to avoid subtracting `totalExpenses` twice (`equity.service.ts:36-39`
comment, re-verified). **Renamed** from "Retained Earnings" because that term implies a period-close /
opening-balance mechanism this system does not have:
- No opening retained-earnings balance is stored anywhere.
- No period-closing process exists (`current_backend.md`'s full endpoint reference confirms no "close month"
  / "close fiscal year" operation exists in any module).
- No historical retained-earnings snapshot exists — this is a single, live, all-time number, recomputed on
  every request, not the running-total-carried-forward figure "retained earnings" conventionally means.

`totalEquity = capitalContributions + ownerWithdrawals + accumulatedEarnings` — identical total to before,
purely decomposed for clarity, zero new computation, zero risk of drift from `EquityService`.

---

## 9. Cheque accounting — the full traced mechanism (kept, now cross-referenced instead of duplicated)

### 9.1 Dealer side
```
Invoice created (order APPROVED) → AR = grandTotal
Dealer cheque recorded (chequeStatus: PENDING)
  → PaymentsService.create() unconditionally runs
    outstandingBalance = outstandingBalance.sub(amount)      (payments.service.ts:117)
  → AR decreases immediately; Cash (§6.1) unaffected (only counts CLEARED cheques)
  → Cheques in Hand (§6.3) now includes this amount
Cheque CLEARED
  → no further outstandingBalance write (payments.service.ts's updateChequeStatus only
    mutates outstandingBalance on the PENDING↔RETURNED boundary, :352-365)
  → Cash increases; Cheques in Hand naturally excludes it (its WHERE clause is chequeStatus=PENDING)
Cheque RETURNED
  → delta = +amount added back to outstandingBalance (:360-364) — AR restored, as if never recorded
```
No double-count at any step: the money is in exactly one of {AR, Cheques in Hand, Cash} (or, if returned,
back in AR) at all times.

### 9.2 Supplier side — exact mirror
```
Purchase recorded → AP = totalValue (minus transport-charge deduction, §7.1)
Supplier cheque written (chequeStatus: PENDING)
  → AP decreases immediately (CreditBalanceService's "effective" filter already excludes it, §7.1)
  → Cash unaffected until CLEARED
  → Supplier Cheques Issued (§7.2) now includes this amount
Cheque CLEARED → Cash decreases; Supplier Cheques Issued excludes it
Cheque RETURNED → AP restored (CreditBalanceService's filter re-includes it)
```

Both sides use the identical "written = committed" convention — confirmed, not assumed, by reading the
actual mutation code on both sides (§2).

---

## 10. Commission accounting — Phase 1 decision, stated explicitly

Verified flow (`settlements.service.ts`, re-traced this pass at the same line numbers as the prior audit):

```
Order approved → CommissionReconciliationService cron writes CommissionLedgerEntry.status = PENDING
      ↓
SettlementsService.create() batches matching PENDING lines → status = APPROVED, settlementId assigned
      ↓ (reject() releases back to PENDING, settlementId: null — no financial effect)
SettlementsService.pay() → createSettlementExpense() → tx.expense.create() (the same call ExpensesService
      uses) → RepresentativeSettlement.status = PAID → CommissionLedgerEntry.status = SETTLED
      ↓
Only at this final step does the amount touch Expense / Cash / Equity.
```

**Commission Payable (§7.3) exists in the ledger before Commission Expense is ever recognized anywhere else
in the system.** This is not a bug to fix inside the Balance Sheet feature — it's the system's existing,
intentional cash-basis treatment of expenses (§5). But it means the liability and its matching reduction are
**never simultaneously visible** to the rest of the accounting surface: from the moment commission is earned
until the moment it's paid, `EquityService`/`ExpensesService` know nothing about it at all.

### The two options, and which one this specification chooses

**Option A — full accrual.** Recognize a commission expense (and reduce `accumulatedEarnings`) the moment a
`CommissionLedgerEntry` becomes `PENDING`, not when it's `PAID`. This would make `commissionPayable` fully
consistent with `accountsPayable`'s existing treatment (§7.1) and could then be safely included in
`totalLiabilities` with `totalEquity` correctly reduced to match — no imbalance, by construction, no
disclosure needed.

*What it would actually require*, traced against real code, not hand-waved: (a) a new accrual write path —
either inside `CommissionReconciliationService`'s cron or a new one — that books an `Expense`-equivalent the
moment a line becomes `PENDING`; (b) `EquityService.getSummary()`'s `totalExpenses` (currently
`Σ Expense.amount`, unfiltered — `equity.service.ts:41`) would need to either read from a broadened source or
have accrued-but-unpaid commission added to it *everywhere* that figure is used, not just here —
`DashboardService`, `SalesAnalysisService`'s consumers, the Equity page itself; (c) `SettlementsService.pay()`
would then need to **not** create a second `Expense` when the cash actually moves (today's
`createSettlementExpense()` is the only place this happens — accruing earlier and paying later would double-
book the expense unless `pay()` is changed to a pure cash/liability-clearing entry instead). This is a
cross-cutting accounting-policy change touching four services outside the Balance Sheet module's boundary,
not a Balance Sheet implementation detail — **not undertaken here**, and not to be triggered as a silent side
effect of shipping this feature (§20 restates this explicitly).

**Option B — memorandum-only (chosen for this specification).** Compute `commissionPayable` exactly as
before (§7.3's formula), but **exclude it from `totalLiabilities`, `liabilitiesAndEquity`, and
`rawDifference`** entirely. Report it under a dedicated top-level `memorandum` object (§17), with an
`accountingWarnings` entry explaining why. Equity is untouched — no plug, no forced match, nothing invented.
The Balance Sheet's official Assets/Liabilities/Equity equation only ever contains items that are matched by
construction (§7.1's Purchase↔Inventory pairing, §9's cheque symmetry, §12/§13's self-resolving order-timing
gap) or fully independent of each other (Cash, the signed Equity components) — commission payable, under the
current architecture, is neither, so it sits outside the equation rather than breaking it.

### Why Option B, not Option A, for this specification

Option A is the *more accounting-correct* end state, but implementing it would mean the Balance Sheet feature
silently changes when commission expense hits `accumulatedEarnings` for the **entire application** — the
Dashboard's profit figure, the Equity page, Sales Analysis's downstream consumers — not just its own output.
That is explicitly forbidden by this task's scope (§20 of the originating request: do not modify commission
accounting, do not modify order accounting, do not modify payment behavior). Option B requires zero changes
to any existing service and never produces a false `UNBALANCED` reading from a condition (outstanding
commission) that is normal, expected, and near-constant in production — which is the actual defect being
corrected in this revision.

### Required disclosure (Option B)

```json
{
  "memorandum": {
    "commissionPayable": {
      "value": 0,
      "includedInTotals": false,
      "asOfCount": 0
    }
  },
  "accountingWarnings": [
    "commissionPayable is a real, computed liability (unpaid representative commission) but is excluded from totalLiabilities and the balance-sheet equation, because the system currently recognizes commission expense only when the settlement is paid (cash basis) — there is no corresponding reduction to accumulatedEarnings while commission is PENDING/APPROVED. See §10 for the full accrual-vs-cash-basis analysis and the Option A alternative this specification did not choose."
  ]
}
```

### If Option A is wanted later
The three changes listed above (new accrual write path, `EquityService.totalExpenses` broadened consistently
everywhere it's read, `pay()` changed to a liability-clearing entry rather than a second expense) are a
prerequisite, cross-cutting accounting-policy project — not a Balance Sheet task. Once done, `commissionPayable`
moves from `memorandum` into `liabilities.current` with zero change to the number itself, only to which total
it participates in.

---

## 11. Inventory valuation — Phase 1 scope and its explicit costing caveat

### 11.1 Formula (unchanged from §6.4)
`SUM(Product.currentStock × Product.costPrice)`, live, database-wide.

### 11.2 Movement correctness — re-verified
`InventoryService.recordMovement()` (`inventory.service.ts:32-88`) is confirmed the **sole** writer of
`Product.currentStock`, using an atomic conditional `UPDATE ... WHERE currentStock + delta >= 0` (not a
read-then-write) specifically to prevent a race between two concurrent movements from both passing a
non-negative check against the same stale read (`:46-59`, comment explains this explicitly). Every call site
across the codebase — purchases (`PURCHASE`), completed sales (`SALE`), returns (`ADJUSTMENT`), manual
corrections (`ADJUSTMENT`), and order reservation/release (`RESERVE`/`RELEASE`) — funnels through this one
function. There is no code path that mutates `currentStock` directly. This means the §11.1 aggregate is
trustworthy the moment it's built, with no separate reconciliation pass needed against `InventoryLog`.

### 11.3 Costing method caveat — stated explicitly, not implemented
`Product.costPrice` is a **single, current, mutable field** — not a historical cost basis per purchase lot.
If a product's cost changes between purchases (a very normal occurrence for a wholesale distributor), every
unit of that product currently in stock is valued at today's `costPrice`, regardless of what was actually
paid for the specific units on hand. This is a real limitation for financial accuracy, not a Balance-Sheet
implementation bug:

> **Future accounting improvement**: weighted-average or FIFO inventory costing may be required if
> `Product.costPrice` does not represent the true historical cost of the units currently held. This would
> require a new data model (e.g. per-`PurchaseItem` cost lots consumed in FIFO order as `SALE`/`RESERVE`
> movements happen) — **out of scope for this Balance Sheet feature**, and not to be implemented as part of
> it. Phase 1 ships with current-cost valuation and this caveat surfaced in the API (§17's `warnings`).

---

## 12. AR/AP timing — the one structural gap, precisely scoped

Re-confirmed this pass at the exact function level (§2): `applyApproval()`
(`orders.service.ts:267-302`) is the **only** place `InventoryLogType.RESERVE` fires, called from exactly two
places — `approve()` (the normal PENDING_APPROVAL→APPROVED transition) and the admin
auto-approve/backdated-completion branch of `create()` (which reserves stock **and** completes the order
**and** books AR **and** makes it eligible for `SalesAnalysisService`'s profit calculation, all in the same
transaction — no gap for that path).

The gap exists **only** for orders that go through the multi-step pipeline: `PENDING_APPROVAL → APPROVED`
(stock reserved here, invoice created here) `→ PACKED → DELIVERED → COMPLETED` (AR booked here, only here;
profit recognized here, only here, since `SalesAnalysisService.buildWhere()` filters `status: COMPLETED`).
For any order currently sitting in `APPROVED`/`PACKED`/`DELIVERED`:
- **Inventory (§6.4) is already reduced** by the cost of its reserved items.
- **AR (§6.2) does not yet include** its invoice's `grandTotal`.
- **Accumulated Earnings (§8.3) does not yet include** its margin.

Sales returns cannot exist against such an order (§2, `sales-returns.service.ts:48-49/:140-141` hard-require
`COMPLETED`), so the quantity used below is exactly the quantity currently reserved — no adjustment needed
for partial returns on this subset.

---

## 13. Reconciliation model

### 13.1 Why a single `isBalanced: boolean` is wrong (this document's central correction)

§12's gap is not a bug — it's a real, expected, quantifiable consequence of how `OrdersService` recognizes
revenue. A Balance Sheet that reports `isBalanced: false` with no further explanation whenever any order is
mid-fulfillment would be **useless to an administrator** (it would almost always be false, for a completely
benign reason) or, worse, would tempt a future implementer into "fixing" it with a plug (§8's forbidden
pattern). The correct design computes the expected gap from real data and separates it from anything
actually unexplained.

### 13.2 The exact formula, derived (not assumed) from §12

Let:
```
rawDifference = totalAssets − (totalLiabilities + totalEquity)
```

For every order with `status IN (APPROVED, PACKED, DELIVERED)`, §12 established that Assets are short by
that order's reserved cost value with **no** offsetting decrease anywhere in Liabilities or Equity (that
order contributes 0 to AR and 0 to Accumulated Earnings until it completes). Define:
```
X = Σ over Orders WHERE status IN (APPROVED, PACKED, DELIVERED)
      Σ over that order's OrderItems (quantity × Product.costPrice)
```
computed as:
```sql
SELECT SUM(oi.quantity * p."costPrice") AS value
FROM "OrderItem" oi
JOIN "Order" o ON o.id = oi."orderId"
JOIN "Product" p ON p.id = oi."productId"
WHERE o.status IN ('APPROVED', 'PACKED', 'DELIVERED')
```
`X` is always `≥ 0` by construction (a sum of quantities × costs). Then:
```
knownTimingDifference = −X
unexplainedDifference = rawDifference − knownTimingDifference   (= rawDifference + X)
```

**Sign note, stated explicitly because the request's illustrative example used different signs**: in this
system, this specific gap always makes Assets *understated* relative to Liabilities+Equity, never
overstated — so under normal operation (no other bugs), `rawDifference` and `knownTimingDifference` are both
**zero or negative**, and they should be equal to each other (making `unexplainedDifference ≈ 0`). A
positive `unexplainedDifference` beyond tolerance, or any `rawDifference` component the formula above
doesn't account for, is a genuine anomaly worth investigating — not something to relabel as "known."

Query notes: uses **current** `OrderItem.quantity`, not a replay of `InventoryLog` history — correct because
an item-edit on an in-flight order already RELEASEs the old quantity and RESERVEs the new one in the same
transaction (`orders.service.ts:777-838`, re-confirmed this pass), so `OrderItem.quantity` at query time
always matches what's actually currently held out of stock for that order. No historical ledger replay is
needed for this formula to be exact.

### 13.3 Status derivation

```
tolerance = 0.01

if |rawDifference| < tolerance:
    status = BALANCED
elif |unexplainedDifference| < tolerance:
    status = BALANCED_WITH_KNOWN_TIMING_DIFFERENCE
else:
    status = UNBALANCED
```

### 13.4 Worked examples

**Case A — one order stuck at APPROVED, nothing else wrong:**
```
rawDifference:          −18,500      (Assets short by exactly this order's reserved cost)
knownTimingDifference:  −18,500
unexplainedDifference:        0
status: BALANCED_WITH_KNOWN_TIMING_DIFFERENCE
```

**Case B — the same order, plus an unrelated data problem:**
```
rawDifference:          −24,000
knownTimingDifference:  −18,500
unexplainedDifference:   −5,500      (rawDifference − knownTimingDifference)
status: UNBALANCED   → surfaced with unexplainedDifference = −5,500 for investigation
```

### 13.5 Response shape (integrates with §17)

```json
{
  "summary": {
    "totalAssets": 0,
    "totalLiabilities": 0,
    "totalEquity": 0,
    "liabilitiesAndEquity": 0,
    "rawDifference": 0
  },
  "reconciliation": {
    "knownTimingDifference": 0,
    "unexplainedDifference": 0,
    "inFlightOrderCount": 0,
    "status": "BALANCED | BALANCED_WITH_KNOWN_TIMING_DIFFERENCE | UNBALANCED"
  }
}
```
`inFlightOrderCount` (a straightforward `COUNT` alongside the `SUM` in §13.2's query) is included so an
administrator seeing `BALANCED_WITH_KNOWN_TIMING_DIFFERENCE` can immediately understand *how many* orders
are responsible, not just the dollar figure.

**`memorandum` items (§10) never enter this arithmetic.** `commissionPayable` is deliberately excluded from
`totalLiabilities` and therefore from `rawDifference`/`knownTimingDifference`/`unexplainedDifference` —
§13.2's formula only ever needs to explain the `APPROVED→COMPLETED` order-timing gap, because that's the only
remaining item in the entire equation that isn't matched by construction (§10's "Why Option B" reasoning).

---

## 14. Unsupported categories — unchanged list, kept explicit

No speculative models are proposed for implementation. Each reports as `null` in the API (§17), listed by
name in `unsupported`, and is excluded from every total (§16.4's no-plug rule extends to "don't quietly sum
in a null as zero").

| Category | Why unsupported | Minimum future model |
|---|---|---|
| Tax Payable | No tax field anywhere in the schema | `taxRate`/`taxAmount` on `Invoice`/`Purchase`, or a `TaxLedger` |
| Accrued Expenses | `Expense` has no incurred-vs-paid date split; both writers fire only at payment time | `Expense.status: ACCRUED\|PAID`, or a standalone `AccruedExpense` table |
| Business Loans | No model | `Loan`: principal, rate, disbursement date, schedule, outstanding balance |
| Supplier Advances | No model for pre-purchase payment to a supplier | `SupplierAdvance` table, or a nullable `Purchase.advancePaymentId` |
| Prepaid Expenses | Same root cause as Accrued Expenses | `Expense.coversFrom`/`coversTo`, amortized against `asOf` |
| Fixed Assets / Depreciation | No model at all | `FixedAsset`: id, name, category, purchaseDate, purchaseCost, usefulLife, depreciationMethod, accumulatedDepreciation, disposalDate, status |
| Customer Advances | Schema allows (`Payment.invoiceId` nullable) but `CreatePaymentDto.invoiceId` is required — unreachable via any current endpoint | Make `invoiceId` optional on the DTO and add the branch in `PaymentsService.create()`, or a dedicated `DealerAdvance` model |

---

## 15. Historical `asOf` — confirmed still live-only

| Component | Date-filterable today? |
|---|---|
| Cash | No — `getCurrentBalance()`/`getSummary()` take no date param |
| AR | No — live running column, no snapshot history |
| Inventory | No — `InventoryLog.balanceAfter` could theoretically support per-product point-in-time reconstruction, but that's O(products) individual lookups, not a simple aggregate, and no such query exists |
| AP | No — same limitation as Cash |
| Commission Payable | **Partially** — `CommissionLedgerEntry.createdAt` exists, a date filter here is trivial, unlike the other four |
| Equity | No — `EquityService.getSummary()` is all-time only |

Conclusion unchanged: **build live-only**. `BalanceSheetService.getSummary()` takes no date parameter in
Phase 1 (§16), keeping `getSummary(asOf?: Date)` open as a non-breaking future addition once the underlying
services (plural — this can't be solved by the Balance Sheet module alone) grow the same capability.

---

## 16. Final `BalanceSheetService` design — specification only, not implemented

```ts
// src/balance-sheet/balance-sheet.service.ts — NOT CREATED. Spec only.
@Injectable()
export class BalanceSheetService {
  constructor(
    private prisma: PrismaService,
    private liquidCashService: LiquidCashService,        // §6.1, §6.3
    private creditBalanceService: CreditBalanceService,   // §7.1, §7.2
    private equityService: EquityService,                 // §8
  ) {}

  async getSummary() {
    const [
      liquidCash, creditBalance, equity,
      arAgg, inventoryAgg, commissionPayableAgg, timingAgg,
    ] = await Promise.all([
      this.liquidCashService.getSummary(),
      this.creditBalanceService.getSummary(),
      this.equityService.getSummary(),
      this.prisma.dealer.aggregate({ _sum: { outstandingBalance: true } }),
      this.prisma.$queryRaw<{ value: Prisma.Decimal | null }[]>`
        SELECT SUM("currentStock" * "costPrice") AS value FROM "Product"
      `,
      this.prisma.commissionLedgerEntry.aggregate({
        where: { status: { in: ['PENDING', 'APPROVED'] } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.$queryRaw<{ value: Prisma.Decimal | null; count: bigint }[]>`
        SELECT SUM(oi.quantity * p."costPrice") AS value, COUNT(DISTINCT o.id) AS count
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Product" p ON p.id = oi."productId"
        WHERE o.status IN ('APPROVED', 'PACKED', 'DELIVERED')
      `,
    ]);

    // 6.1 / 6.3 — Assets
    const cashAndBank = liquidCash.balance;
    const chequesInHand = liquidCash.pendingDealerCheques;
    const accountsReceivable = Number(arAgg._sum.outstandingBalance ?? 0);
    const inventory = Number(inventoryAgg[0]?.value ?? 0);
    const totalCurrentAssets = cashAndBank + accountsReceivable + chequesInHand + inventory;
    const totalAssets = totalCurrentAssets; // no non-current assets supported (§14)

    // 7.1 / 7.2 — Liabilities (official totals — matched-by-construction items only, §10)
    const accountsPayable = creditBalance.balance;
    const supplierChequesIssued = creditBalance.pendingChequeSettlements;
    const totalCurrentLiabilities = accountsPayable + supplierChequesIssued;
    const totalLiabilities = totalCurrentLiabilities; // no non-current liabilities supported (§14)

    // 7.3 / §10 — Commission Payable: real, but memorandum-only, Option B.
    // Deliberately NOT added into totalCurrentLiabilities/totalLiabilities — see §10 for why
    // (no matching Asset/Equity reduction exists under the current cash-basis expense model).
    const commissionPayable = Number(commissionPayableAgg._sum.amount ?? 0);
    const commissionPayableCount = commissionPayableAgg._count ?? 0;

    // 8 — Equity, independently sourced (never derived from Assets/Liabilities — §16.4)
    const capitalContributions = /* Σ Investment.amount WHERE amount > 0, §8.1 */ 0;
    const ownerWithdrawals = /* Σ Investment.amount WHERE amount < 0, §8.2 */ 0;
    const accumulatedEarnings = equity.totals.totalProfit.sub(equity.totals.totalExpenses);
    const totalEquity = equity.totals.totalEquity; // = capitalContributions + ownerWithdrawals + accumulatedEarnings

    // 13 — Reconciliation
    const liabilitiesAndEquity = totalLiabilities + totalEquity;
    const rawDifference = totalAssets - liabilitiesAndEquity;
    const knownTimingDifference = -Number(timingAgg[0]?.value ?? 0);
    const unexplainedDifference = rawDifference - knownTimingDifference;
    const inFlightOrderCount = Number(timingAgg[0]?.count ?? 0);
    const TOLERANCE = 0.01;
    const status =
      Math.abs(rawDifference) < TOLERANCE ? 'BALANCED'
      : Math.abs(unexplainedDifference) < TOLERANCE ? 'BALANCED_WITH_KNOWN_TIMING_DIFFERENCE'
      : 'UNBALANCED';

    return { /* assembled per §17 */ };
  }
}
```

### 16.4 No-plug rule (restated, unconditional)
`totalEquity` is read **only** from `EquityService` — never computed as `totalAssets − totalLiabilities`, in
this method or any future revision of it. `unexplainedDifference` is reported as-is, including when nonzero;
it is never absorbed into `totalEquity` or any other line to force `status = BALANCED`. This rule is also why
`commissionPayable` is handled the way §10 specifies rather than the alternative that was tried and rejected
in the prior revision of this document: including it inside `totalLiabilities` *without* a matching change to
`totalEquity` was itself a violation of this rule in spirit — it made the equation permanently fail to close
by a real, computable amount, which is functionally the same defect as a plug, just in the opposite direction
(the discrepancy was foisted onto `unexplainedDifference` instead of being resolved or honestly excluded).
Excluding it from the equation via `memorandum` (§10, §17) is the only option that neither invents a matching
entry nor leaves a permanent, misleading `UNBALANCED` reading. The entire purpose of §13 is to make
discrepancies legible, not to eliminate them by construction — and equally, not to manufacture a permanent
false alarm out of a normal operating condition.

---

## 17. Final API contract

`GET /balance-sheet` — live snapshot only (§15).

```json
{
  "asOf": "2026-08-17T00:00:00.000Z",

  "assets": {
    "current": {
      "cashAndBank": 0,
      "accountsReceivable": 0,
      "chequesInHand": 0,
      "inventory": 0,
      "supplierAdvances": null,
      "prepaidExpenses": null,
      "otherCurrentAssets": null,
      "totalCurrentAssets": 0
    },
    "nonCurrent": {
      "fixedAssets": null,
      "accumulatedDepreciation": null,
      "totalNonCurrentAssets": 0
    },
    "totalAssets": 0
  },

  "liabilities": {
    "current": {
      "accountsPayable": 0,
      "supplierChequesIssued": 0,
      "taxPayable": null,
      "accruedExpenses": null,
      "customerAdvances": null,
      "totalCurrentLiabilities": 0
    },
    "nonCurrent": {
      "loans": null,
      "totalNonCurrentLiabilities": 0
    },
    "totalLiabilities": 0
  },

  "equity": {
    "capitalContributions": 0,
    "ownerWithdrawals": 0,
    "accumulatedEarnings": 0,
    "totalEquity": 0
  },

  "summary": {
    "totalAssets": 0,
    "totalLiabilities": 0,
    "totalEquity": 0,
    "liabilitiesAndEquity": 0,
    "rawDifference": 0
  },

  "reconciliation": {
    "knownTimingDifference": 0,
    "unexplainedDifference": 0,
    "inFlightOrderCount": 0,
    "status": "BALANCED_WITH_KNOWN_TIMING_DIFFERENCE"
  },

  "memorandum": {
    "commissionPayable": {
      "value": 0,
      "includedInTotals": false,
      "pendingOrApprovedLineCount": 0
    }
  },

  "accountingWarnings": [
    "commissionPayable (see memorandum) is excluded from totalLiabilities and the balance-sheet equation — the system currently recognizes commission expense only when the settlement is paid (cash basis), so there is no corresponding reduction to accumulatedEarnings while commission is PENDING/APPROVED. See §10 for the full analysis and the accrual-basis alternative (Option A) this specification did not choose.",
    "Inventory is valued at Product.costPrice (current cost), not a per-lot historical cost basis — see the inventory-costing limitation."
  ],

  "unsupported": [
    "assets.current.supplierAdvances", "assets.current.prepaidExpenses", "assets.current.otherCurrentAssets",
    "assets.nonCurrent.fixedAssets", "assets.nonCurrent.accumulatedDepreciation",
    "liabilities.current.taxPayable", "liabilities.current.accruedExpenses", "liabilities.current.customerAdvances",
    "liabilities.nonCurrent.loans"
  ]
}
```

---

## 18. Error / warning / reconciliation states

Four independent signal channels, deliberately not collapsed into one flag:

1. **`unsupported`** (§14, §17) — categories with no data model. Always `null` in the response body, never
   defaulted to `0`.
2. **`memorandum`** (§10, §17) — categories *with* real, correctly-computed data that are deliberately
   excluded from every official total because the current architecture cannot match them against an
   offsetting entry elsewhere in the equation. Distinct from `unsupported`: the number is real and shown, it
   simply doesn't participate in `totalLiabilities`/`rawDifference`. Today this holds exactly one item,
   `commissionPayable` (§10) — a future accrual-basis change (Option A) would move it out of `memorandum` and
   into `liabilities.current` with no change to the value itself.
3. **`accountingWarnings`** (§10, §11.3) — free-text disclosures explaining *why* a `memorandum` exclusion or
   a valuation simplification (e.g. §11.3's current-cost inventory) exists, for any consumer that doesn't
   already know to check `memorandum`/the docs.
4. **`reconciliation.status`** (§13) — `BALANCED` / `BALANCED_WITH_KNOWN_TIMING_DIFFERENCE` / `UNBALANCED`.
   Only the third state should ever prompt investigation; the second is expected, routine output any time an
   order is mid-fulfillment and should be styled as informational (not an error) by any consuming frontend.
   Because `commissionPayable` is now excluded from the equation entirely (§10), an outstanding commission
   balance **never** causes either non-`BALANCED` state on its own — only the `APPROVED→COMPLETED` order gap
   does.

---

## 19. Testing strategy (specification — not implemented; greenfield, §2 confirms zero existing coverage)

### Cash
Cash payment · cleared dealer cheque · pending dealer cheque (excluded from Cash, included in Cheques in
Hand) · returned dealer cheque (excluded from both, AR restored) · pending supplier cheque (excluded from
Cash, included in Supplier Cheques Issued) · cleared supplier cheque · returned supplier cheque (AP restored)

### AR
Unpaid invoice · partial payment · fully paid invoice · pending dealer cheque (AR already reduced, §9.1) ·
returned dealer cheque (AR restored, §9.1)

### Inventory
Purchase increases value · completed sale decreases it · sales return reverses it (COMPLETED-only, §12) ·
purchase return reverses it · manual adjustment moves it · reservation (`APPROVED`) decreases it before the
order completes; release (item edit / cancellation) restores it

### AP
Purchase increases it · transport charge reduces it (§7.1) · supplier payment (any mode) reduces it
immediately · supplier cheque reduces it immediately, pre-clearing (§9.2) · returned supplier cheque restores
it · purchase return reduces it

### Commission
`PENDING` counts toward `commissionPayable` · `APPROVED` still counts · `SETTLED` does not (moved to
`Expense`, no longer in the `IN (PENDING, APPROVED)` filter) · expense recognition happens only at `pay()`,
never earlier, under current architecture (assert no `Expense` row exists for a `PENDING`/`APPROVED` line) ·
**`commissionPayable` never appears in `totalLiabilities`** — assert `liabilities.totalLiabilities` is
identical with and without outstanding `PENDING`/`APPROVED` lines in an otherwise-identical fixture · the
value is present under `memorandum.commissionPayable.value` with `includedInTotals: false` whenever any
`PENDING`/`APPROVED` line exists · `accountingWarnings` contains the commission-exclusion message whenever
`memorandum.commissionPayable.value > 0`, and is absent (or omits that entry) when it's `0` · **critically**:
assert `reconciliation.status` stays `BALANCED` (not `UNBALANCED` or
`BALANCED_WITH_KNOWN_TIMING_DIFFERENCE`) in a fixture with substantial outstanding commission and no other
discrepancy — this is the regression test for the exact defect this revision corrects

### Equity
Positive investment increases `capitalContributions` · negative investment (withdrawal) increases the
magnitude of `ownerWithdrawals`, decreases `totalEquity` · profit increases `accumulatedEarnings` · expense
decreases `accumulatedEarnings` exactly once (assert no double-subtraction — construct a fixture where naive
double-counting would produce a specific wrong number, and assert the actual result differs from it)

### Balance Sheet integration
1. Fully balanced clean fixture (no in-flight orders) → `status = BALANCED`, `rawDifference ≈ 0`.
2. Pending dealer cheque only → `chequesInHand` reflects it, `status` still `BALANCED` (AR/Cash correctly
   offset by construction, no timing gap involved).
3. Pending supplier cheque only → same, liability side.
4. Commission payable only, nothing settled → `memorandum.commissionPayable.value > 0`,
   `memorandum.commissionPayable.includedInTotals = false`, the commission `accountingWarnings` entry is
   present, `liabilities.totalLiabilities` is **unaffected** by the outstanding amount, and
   `status = BALANCED` — this is the direct fix for the defect the prior revision had (that revision would
   have produced a permanent `UNBALANCED` or spurious `unexplainedDifference` here).
5. Inventory-only fixture (stock purchased, nothing sold) → asset increases, matched by the AP increase from
   the purchase — `status = BALANCED`.
6. Withdrawal fixture → `ownerWithdrawals` reflects it, `totalEquity` decreases, still `BALANCED`.
7. **One order stuck at `APPROVED`** → `rawDifference < 0`, `knownTimingDifference` computed from §13.2's
   query matches `rawDifference` exactly, `unexplainedDifference ≈ 0`, `status =
   BALANCED_WITH_KNOWN_TIMING_DIFFERENCE`, `inFlightOrderCount = 1`.
8. **Same as #7, plus a deliberately injected unrelated discrepancy** (e.g. directly mutate
   `Dealer.outstandingBalance` in the test fixture without a corresponding transaction) → `unexplainedDifference`
   is nonzero and equals exactly the injected amount, `status = UNBALANCED`.
9. Explicit assertion that `reconciliation.unexplainedDifference` in case 8 equals the injected discrepancy
   to the cent (tolerance-checked, not just "is nonzero") — this is the test that actually validates §13.2's
   formula, not just its presence.
10. **Equity-as-plug guard**: assert `totalEquity` in every fixture above equals
    `EquityService.getSummary()`'s independently-computed total called directly in the test — i.e. assert the
    Balance Sheet's equity figure was never back-derived from `totalAssets − totalLiabilities` by comparing
    it byte-for-byte against a second, independent call to the real source.

---

## 20. Implementation order (for the next phase — not started)

1. Add the two new aggregates as small, focused additions: inventory valuation (§6.4/§11) and commission
   payable (§7.3/§10) — neither touches an existing service's public behavior. Commission payable is computed
   for `memorandum` only (§10) — it must **not** be summed into any liabilities aggregate at this step.
2. Add the §13.2 reconciliation query. Confirm it is the *only* source of `knownTimingDifference` —
   `commissionPayable` must never contribute to it (§13.5).
3. Build `BalanceSheetModule`/`Service`/`Controller`/DTOs per §16-§17, composing `LiquidCashService`,
   `CreditBalanceService`, `EquityService` exactly as specified — no changes to any of the three. Verify the
   response's `liabilities.totalLiabilities` excludes `commissionPayable` and that it instead appears only
   under `memorandum`.
4. Write the §19 test suite against a seeded test database (this is genuinely new test infrastructure, not
   an extension of an existing pattern — budget for that separately, §2) — **including the regression test**
   asserting `reconciliation.status = BALANCED` under a fixture with substantial outstanding commission and
   no other discrepancy (§19, Commission section).
5. Run existing TypeScript/Prisma checks and the full existing test suite to confirm zero regressions to
   any consumer of `LiquidCashService`/`CreditBalanceService`/`EquityService` (none of their public
   signatures change).
6. The Commission Payable accounting-basis question is **resolved for this specification** (§10, Option B —
   memorandum-only, excluded from totals). Confirm this choice with the user before shipping if the business
   would prefer Option A (full accrual) instead — that remains a legitimate, larger, separate project (§10),
   not a blocker for implementing Option B now.

---

## 21. Remaining risks and future improvements

- **The `APPROVED→COMPLETED` timing gap is a property of `OrdersService`'s revenue-recognition point.** §13
  makes it legible; it does not eliminate it. Any future change to *when* AR/profit is recognized (e.g.
  booking AR at `APPROVED` instead of `COMPLETED`) is an `OrdersService` change with system-wide
  consequences (credit-limit checks, dashboard KPIs, sales analysis) — explicitly out of scope here and not
  recommended as a side effect of shipping a Balance Sheet.
- **Inventory costing** (§11.3) uses current cost, not historical lot cost — a real limitation for a
  wholesale distributor with fluctuating supplier prices, deferred by design.
- **Commission Payable is deliberately kept out of the official Balance Sheet totals** (§10, Option B) —
  it's real, disclosed under `memorandum`, and explained in `accountingWarnings`, but does not affect
  `totalLiabilities` or `reconciliation.status`. If the business later wants full commission accrual (Option
  A, §10), that's a legitimate, larger project — new accrual write path, `EquityService.totalExpenses`
  broadened consistently everywhere it's read, and `SettlementsService.pay()` changed to a liability-clearing
  entry instead of a second expense — explicitly not undertaken as part of this specification.
- **No historical `asOf` capability** for five of six major components (§15) — live-only for the foreseeable
  future unless the underlying services are separately extended.
- **Six categories remain fully unsupported** (§14) pending an actual business requirement — no speculative
  models are proposed for implementation.
- **Test infrastructure for financial services is greenfield** (§2, §19) — this is a cost worth planning for
  explicitly, not something that piggybacks for free on existing coverage, because there isn't any.
