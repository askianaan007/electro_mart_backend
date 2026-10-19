# Liquid Cash accounting contract

The rules every cash-affecting feature follows. Code that moves money must
satisfy these, and the integration tests (`test/integration`, run with
`npm run test:integration`) check them after every scenario.

## 1. One ledger

Liquid Cash is not stored anywhere. It is derived by one SQL CTE,
`CASH_LEDGER_CTE` (`src/liquid-cash/cash-ledger.sql.ts`). The Liquid Cash
summary, its history, the dashboard's cash figures and the balance sheet's
`cashAndBank` all sum over the same rows, so they cannot disagree.

| Source | `type` | Sign | Counts when |
|---|---|---|---|
| Investment / withdrawal (`Investment`) | `INVESTMENT` | + deposit, − withdrawal | Cash or bank transfer: on `investmentDate`. Cheque: once `CLEARED`, dated by `chequeStatusUpdatedAt`. A legacy cheque with no status counts as before (it was entered as cleared). |
| Dealer payment (`Payment`) | `DEALER_PAYMENT` | + | Cash or bank transfer: on `paymentDate`. Cheque: once `CLEARED`, dated by `chequeStatusUpdatedAt`. |
| Supplier settlement (`SupplierPayment`) | `SUPPLIER_PAYMENT` | − | Same rule as dealer payments. |
| Expense (`Expense`), including commission payouts | `EXPENSE` | − | On `expenseDate`. A settlement paid by cheque creates its expense only when the cheque clears. |
| Refund (`Refund`) | `REFUND` | − to a dealer, + from a supplier | Same cheque rule. A cancelled refund stops counting. |
| Cash adjustment (`CashAdjustment`) | `ADJUSTMENT` | signed | On `adjustmentDate` (opening balance, corrections, settlement-payout reversals). |

A pending or returned cheque still appears in the history, with amount 0, so
it stays visible. The figures still waiting on the bank are reported
separately and never netted against each other: `pendingIn` (dealer,
investment and supplier-refund cheques) and `pendingOut` (supplier,
withdrawal and dealer-refund cheques).

## 2. History is append-only in effect

Edits, cheque-status changes, deletes, undo/restore and cancellations never
move an earlier row or its running balance:

- Before a change, the row's previous state is saved: `PaymentRevision` for
  dealer payments, `LedgerRevision` for everything else.
- The ledger replays each record as the timeline of its states. The first
  state is one row on its own date. Every later state that changes the cash
  effect adds a correction row, dated when the change was made (`event` =
  `EDITED`, `CHEQUE_CLEARED`, `DELETED`, `RESTORED`, …), for the difference.
- A change that doesn't move cash (for example PENDING → RETURNED) adds no row.
- Changes made before revisions were recorded show only their current state.

## 3. Dates

- Business dates are Sri Lankan calendar dates (Asia/Colombo, fixed UTC+05:30),
  computed in `src/common/utils/business-date.ts`. They never depend on the
  server's or the database session's time zone. Raw SQL binds instants with
  `sqlUtc()`.
- A date filter `from … to` is inclusive of both whole days:
  `[00:00 Colombo on from, 00:00 Colombo after to)`.
- Posting dates (payment, settlement, expense, investment, refund,
  adjustment) cannot be later than today in Colombo. A post-dated cheque's
  `chequeDate` may be in the future.
- Legacy rows dated in the future are kept out of `balance` and reported as
  `scheduled` until their date.

## 4. Cheque status changes

The only legal changes, per kind (`src/common/utils/cheque-transitions.ts`):

| Kind | Allowed |
|---|---|
| Dealer | any change, to record bank reversals and re-presented cheques. Leaving RETURNED re-checks the invoice can take it. |
| Supplier, investment | PENDING → CLEARED / RETURNED. Reverting to PENDING is allowed within 1 day only. CLEARED ↔ RETURNED is never allowed directly. A supplier RETURNED → PENDING revert re-checks the payable. |
| Settlement, refund | PENDING → CLEARED / RETURNED, then final. |

## 5. Write-safety rules

- Every check-then-write on a counterparty runs in one transaction, holding
  that row's lock (`SELECT … FOR UPDATE`): invoice, dealer, supplier,
  representative, investor, settlement or refund.
- State transitions are conditional updates (`updateMany … where status = X`)
  whose count must match.
- Balances change by atomic `increment` / `decrement`, never by a value read
  earlier.
- An identical entry for the same counterparty, amount, mode and day within
  10 minutes is refused with `409 {error: 'POSSIBLE_DUPLICATE'}`. The client
  may resend with `confirmDuplicate: true`.
- Amounts: at most 2 decimal places, above 0 (an investment may be negative
  for a withdrawal, never 0), and at most 1,000,000,000.
- Bounds:
  - No overpaying an invoice or a supplier.
  - A purchase edit or delete may not leave a supplier overpaid.
  - A withdrawal may not exceed the investor's equity less their pending
    withdrawal cheques.
  - A refund may not exceed the party's credit.
- A commission payout expense cannot be edited or deleted. It is corrected
  only by reversing the settlement's payment, which posts a
  `SETTLEMENT_REVERSAL` adjustment and leaves the expense in place.
- There is at most one active opening balance. It must be dated on or before
  the first cash entry, and needs the admin password and an evidence
  reference. A wrong opening balance is reversed (a new row) and re-entered.

## 6. Invariants (checked by `test/support/invariants.ts`)

- **I1** `summary.balance` = Σ `amount` over non-future history rows.
- **I2** The newest non-future row's `balanceAfter` = `summary.balance`.
- **I3** Each row's `balanceAfter` = the previous row's `balanceAfter` + `amount`.
- **I4** Each dealer's `outstandingBalance` = Σ invoices − Σ counted payments
  (not returned cheques) + Σ counted dealer refunds − Σ sales returns.
- **I5** Supplier balance = purchases − returns + replacements − counted
  settlements − transport charges + counted supplier refunds
  (`supplierBalance()`). The credit-balance ledger's last `balanceAfter`
  equals it.
- **I6** The dashboard's `netCashFlow` for a month = the Liquid Cash change over
  that month. `operatingCashFlow` = `netCashFlow` − investments, withdrawals
  and adjustments.
- **I7** Balance sheet: `cashAndBank` = Liquid Cash. Every cheque in transit sits
  on exactly one side (`chequesInHand`, `refundChequesReceivable`,
  `supplierChequesIssued`, `refundChequesIssued`). Cash adjustments sit in
  equity. `unexplainedDifference` is 0 once the named known differences are
  taken out.

## 7. Open business decisions

These are reported, not decided in code:

- **Transport charges (LC-08):** deducted from what we owe the supplier, with
  no other entry. The balance sheet reports the total as
  `knownTransportChargeDifference`. If the business pays transporters itself,
  record those payments as cash outflows. If the supplier pays and invoices
  net, reduce the purchase cost instead.
- **Settlement reversal:** reversing a paid settlement returns its lines to
  PENDING, so the commission can be settled again. This assumes the
  representative returned the money.
- **Collections:** a confirmed collection's payment is dated on the day of
  confirmation, not the day the representative collected it.
- **Equity sharing:** profit shares ignore when an investor joined.
