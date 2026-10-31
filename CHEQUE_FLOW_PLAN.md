# Monthly Cheque Flow Management: analysis and plan

Status: **plan only, no code written yet.** Built from the requirements, your sheet `CHEQUE FLOW (1).xlsx`, and the current backend and frontend code.

---

## 1. The main decision: a separate register, isolated from ERP money

The ERP already records cheques in four places:

| Table | What it is | Statuses |
|---|---|---|
| `Payment` (mode CHEQUE) | Dealer cheques against invoices | PENDING / CLEARED / RETURNED |
| `SupplierPayment` (mode CHEQUE) | Supplier settlement cheques | PENDING / CLEARED / RETURNED |
| `Refund`, `Investment` | Refund and capital cheques | same |

These rows drive Liquid Cash, dealer balances, the wallet, Credit Balance and the Balance Sheet. Changing them changes money.

**Recommendation: the Cheque Flow page is its own register.** It gets one new table, written only by this feature:

- Adding, editing, deleting, importing or changing a status here **never** touches `Payment`, `SupplierPayment`, invoices, dealer balances, Liquid Cash, Credit Balance or the Balance Sheet.
- No existing table gets a new column or a foreign key.
- The migration only **adds** things. Removing the feature means dropping 2 new tables, and nothing else notices.

The cost is that a customer cheque may exist twice: once as a real payment on an invoice, once in this register for planning. That matches how you work today (the sheet is separate from the ERP). Section 9 lists an optional phase-2 "link to ERP payment" that removes the double entry without giving up isolation.

---

## 2. What the sheet tells us (import requirements)

Layout: customer block in columns **A–H**, supplier block in **J–P**, side by side. The headers are on row 3, and there's a block per month.

| Found in the sheet | How the import handles it |
|---|---|
| Month header rows (`D4 = 2026-09-01`, `L4 = "September"`) with `=SUM(...)` subtotals in H/P | Skipped. A row with a date and/or a formula total but **no party name and no cheque number** is a subtotal or header row, never a transaction. |
| Empty numbered rows (`A21 = 10`, `A31..A33`) | Skipped (no party, no amount). |
| Cheque numbers saved as numbers (`91919`, `170722`) and as text (`'000718'`, `'#091942 '`) | Stored as **text**. `#` and spaces are stripped for the duplicate key; the displayed value keeps the leading zeros. When Excel has already dropped a leading zero (`91919` sitting next to `091938`), the preview flags it and the number can be corrected before saving. |
| Missing cheque number (`B5`) | Allowed. Duplicate check falls back to *party + date + amount*. |
| Date written as a formula (`L8 = +L7+7`) | The cell's computed value is read. |
| Status `Pass` / `Pending` | `Pass`, `Passed`, `Cleared` → **CLEARED**. `Bounce`, `Return`, `Returned` → **BOUNCED**. `Cancel` → **CANCELLED**. Anything else → error shown in the preview. |
| No cleared-date column | Imported CLEARED rows get no cleared date. The preview offers "use cheque date as cleared date" (off by default). |
| Inconsistent bank names (`Commercial ` with a trailing space, `Amana bank` vs `Amana Bank`) | Trimmed. A normalised key matches banks case-insensitively, so filters group them together. |
| Several invoices in one cell (`INV-2026-00035 & 054`, `#0148`) | Kept as free text in *Invoice reference*. |
| Scratch formulas in column S (`=66000/0.86`) | Ignored (not mapped). |

Sizing: the sample has about 30 customer and 15 supplier cheques over 5 months. Even years of this data is tiny, so every summary can be computed live with SQL and no caching is needed.

---

## 3. Database (one additive migration)

```prisma
enum ChequeFlowDirection { RECEIVABLE  PAYABLE }        // customer | supplier
enum ChequeFlowStatus    { PENDING  CLEARED  BOUNCED  CANCELLED }

model ChequeFlowEntry {
  id             String              @id @default(uuid())
  direction      ChequeFlowDirection
  chequeNumber   String?             // text: keeps leading zeros
  chequeKey      String              @default("") // normalised: no '#', spaces; '' when none
  bankName       String
  bankKey        String              // lower-case, trimmed, single spaces
  chequeDate     DateTime            @db.Date   // calendar date, no time zone drift
  partyName      String              // customer or supplier name (free text)
  partyKey       String
  invoiceRef     String?
  amount         Decimal             @db.Decimal(14, 2)
  status         ChequeFlowStatus    @default(PENDING)
  clearedDate    DateTime?           @db.Date
  remarks        String?
  importBatchId  String?
  importBatch    ChequeFlowImport?   @relation(fields: [importBatchId], references: [id], onDelete: SetNull)
  createdById    String
  updatedById    String?
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt
  deletedAt      DateTime?           // soft delete: "delete" is recoverable
  deletedById    String?

  @@index([chequeDate])
  @@index([direction, status, chequeDate])
  @@index([bankKey])
  @@index([partyKey])
}

model ChequeFlowImport {
  id         String   @id @default(uuid())
  fileName   String
  adminId    String
  mapping    Json     // the column mapping used, for audit
  inserted   Int
  skipped    Int      // duplicates and subtotal rows
  createdAt  DateTime @default(now())
  entries    ChequeFlowEntry[]
}
```

- `adminId` / `createdById` are plain strings, not foreign keys, so the new tables have **no FK into existing tables**. Deleting or editing anything existing can never be blocked by this feature.
- `@db.Date` stores the cheque date as a calendar date. Grouping by month is then `date_trunc('month', "chequeDate")`, with no off-by-one-day risk between Colombo and UTC (the problem `business-date.ts` exists to solve).

**Hand-written SQL in the same migration** (guards, like the serials migration):
- `CHECK (amount > 0)`
- `CHECK (status = 'CLEARED' OR "clearedDate" IS NULL)`, so only cleared cheques carry a cleared date
- `CHECK ("clearedDate" IS NULL OR "clearedDate" >= "chequeDate" - 31)`, a sanity bound against typos
- `CHECK (char_length("partyName") BETWEEN 1 AND 120)`, plus similar bounds on other text
- Partial unique index against duplicates:
  `UNIQUE (direction, "bankKey", "chequeKey") WHERE "deletedAt" IS NULL AND "chequeKey" <> ''`.
  A bounced cheque that is re-presented is the *same* row with its status changed back, so this never blocks real use.

**Month moves automatically.** Months are never stored, only derived from `chequeDate`, so editing the date moves the row to the right month.

---

## 4. Definitions (one source, used by cards, tables, chart and export)

For a month (or all months), per side:

| Figure | Definition |
|---|---|
| **Total** | PENDING + CLEARED (active cheques) |
| **Pending** | status PENDING. Customer side = still to receive, supplier side = still to pay |
| **Cleared** | status CLEARED. Shown as "Cleared receipts" and "Cleared payments" |
| **Bounced** / **Cancelled** | Shown separately. **Excluded** from Total, Pending and Cleared |
| **Net pending cheque flow** | Pending customer − Pending supplier. Green if ≥ 0. Red and labelled **"Additional funds required"** if < 0. Caption: *"Compares pending cheques only — does not include your bank balance."* |
| **Overdue** | PENDING and `chequeDate < today` (Colombo date) |
| **Due today** / **next 7 days** | PENDING with `chequeDate = today` / `today < chequeDate ≤ today+7` |

**Never auto-cleared.** A cheque only becomes CLEARED when you mark it. A passed date only makes it *overdue*.

---

## 5. Backend: `src/cheque-flow/` (ADMIN only, same guards as `expenses`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/cheque-flow` | Entries. `month=YYYY-MM` or `all=true` (grouped by month), `direction`, `status[]`, `bank`, `party`, `search`. Sorted by cheque date. |
| GET | `/cheque-flow/summary` | Section 4 card figures for the same filters, plus `filtered: true` when any filter beyond the month is set. |
| GET | `/cheque-flow/timeline?month=` | Per date: expected receipts, expected payments, cumulative net. `shortfall` = the cumulative net is negative on that day (payments fall before receipts). |
| GET | `/cheque-flow/alerts` | Overdue (all months: stays visible whatever month is selected), due today, next 7 days. |
| GET | `/cheque-flow/monthly?from=&to=` | Chart series: receipts vs payments per month (pending + cleared, split). |
| GET | `/cheque-flow/options` | Distinct banks, customers and suppliers for the filters, plus ERP dealer/supplier names for autocomplete. |
| POST | `/cheque-flow` | Create. |
| PATCH | `/cheque-flow/:id` | Edit (all fields). |
| PATCH | `/cheque-flow/:id/status` | `{status, clearedDate?}`. CLEARED requires a date (defaults to today in the UI). Leaving CLEARED clears the date. |
| DELETE | `/cheque-flow/:id` | Soft delete (after the confirmation dialog). |
| POST | `/cheque-flow/:id/restore` | Undo a delete (used by the toast's Undo). |
| POST | `/cheque-flow/import/preview` | Validates mapped rows: errors, duplicates against the DB, duplicates within the file. **Writes nothing.** |
| POST | `/cheque-flow/import` | Saves the accepted rows in **one transaction** with an idempotency key, so a double click can't import twice. Duplicates are skipped, never overwritten. |
| DELETE | `/cheque-flow/import/:id` | Undo a whole import (soft-deletes its rows). |

- Money uses `Prisma.Decimal` and `@IsMoneyAmount`, as in the rest of the codebase. Dates go through `business-date.ts`, and future dates are allowed (post-dated cheques are the point).
- Every write goes to `ActivityLog` (`CREATED_CHEQUE_FLOW`, `CHEQUE_FLOW_STATUS`, `IMPORTED_CHEQUE_FLOW`, …) for the audit trail.
- Summary, timeline and alerts are each **one SQL query** using `SUM(...) FILTER (WHERE …)`. That keeps them fast over the high Neon latency.

---

## 6. Frontend: `/admin/cheque-flow` (in the Finance nav group)

**Order on the page, top to bottom:**

1. **Header:** title; month control (◀ month ▶, month select, year select, "All months" toggle); buttons **Add cheque**, **Import**, **Export Excel**, **Print**.
2. **Filter bar:** search, bank, customer, supplier, status. When anything is filtered, a **"Filtered totals"** badge appears on the cards and table footers, with a one-tap "Clear".
3. **Seven summary cards:** customer total / pending / cleared, supplier total / pending / cleared, and the **Net pending** card (green, or red with "Additional funds required" and the bank-balance caption). Bounced and cancelled amounts appear as a small line under each side's total.
4. **Alerts strip** (red / amber): *Overdue from earlier months* (always shown when any exist, whatever month is selected), *Due today*, *Next 7 days*. Each row jumps to its cheque.
5. **Two tables**:
   - **Desktop (`lg`+):** side by side, 50/50 (`grid lg:grid-cols-2`). Green header for **Customer cheques**, orange for **Supplier cheques**. Sorted by cheque date.
   - Each table has a sticky footer with monthly totals (pending, cleared, total; bounced and cancelled shown separately).
   - Rows that are overdue / due today / due within 7 days are tinted red / amber / soft amber.
   - Row actions: Mark cleared (asks for the date), Bounced, Cancelled, Edit, Delete.
   - **Mobile:** a segmented switch (*Customer · Supplier · Both*). Rows become cards using the same pattern as the Credit Balance and Payments pages, with no horizontal scrolling.
6. **Date-wise timeline** for the month: date, receipts (green), payments (orange), cumulative net. Shortfall days are highlighted red with "Payments before receipts". On mobile it's a compact list.
7. **Chart:** monthly receipts vs payments (Recharts bar chart, already a dependency) with a net line, 12 months around the selected month.

**"All months" view:** one section per month, each with its two tables and footer totals, collapsible on mobile.

**Add / Edit dialog:** react-hook-form + zod, like the existing forms.
- Cheque number is a text input (`inputMode="numeric"`, which keeps the zeros).
- Bank and party names autocomplete from earlier entries and ERP dealers/suppliers.
- *Cleared date* appears only when the status is Cleared.
- On mobile the dialog is full-screen, with the save button pinned at the bottom.

**Import wizard** (dialog, 3 steps, mobile-friendly):
1. Choose the file. It's parsed **in the browser**, and the customer/supplier blocks are detected automatically from the header row.
2. **Column mapping** per side, pre-filled from the headers and adjustable through selects.
3. **Preview table:** each row shows ✓ ready / ⟳ duplicate (skipped) / ✕ error (with the reason). Subtotal and header rows are listed as "skipped (subtotal)", never imported. Cells can be fixed inline (e.g. a lost leading zero). Then **Save N cheques**.

**Live updates:** every mutation invalidates the `chequeFlow` React Query keys, so the cards, tables, alerts, timeline and chart all refresh at once.

**Export and print:**
- **Excel:** produces a workbook in your sheet's layout (customer block | gap | supplier block, a block per month with totals rows), plus a "Summary" sheet. When filtered, the file says so in its title row.
- **Print:** a print stylesheet (A4 landscape, both tables side by side, cards on top). This avoids a second PDF code path.

**Library:** `exceljs` (read and write), loaded only when Import or Export is used, so the page doesn't get heavier. The `xlsx` (SheetJS) npm package is avoided: its npm build is outdated and has known vulnerabilities.

**Colours:**
- Customer and receipts use the existing `success` (green) tokens.
- Supplier and payments use a new `--orange` token, with light and dark variants.
- Overdue and shortfall use `destructive` (red).

---

## 7. Safety: current data is never affected

1. **Additive migration only.** It creates 2 tables, 2 enums, indexes and checks. There's no `ALTER` on any existing table, no data backfill, and no FK into existing tables.
2. **Code isolation.** The new module reads only its own tables. The one exception is `options`, which reads dealer and supplier *names* for autocomplete. No existing service is changed, apart from registering the module in `app.module.ts` and adding the nav item.
3. **Tests:**
   - Unit tests: the import row parser (cheque-number text, subtotal detection, status mapping, formula dates), using a **synthetic** fixture shaped like your sheet, not your real customer data.
   - Unit tests: the Section 4 arithmetic.
   - Integration tests on a disposable local Postgres (the existing harness): CRUD, month move on date edit, bounced/cancelled excluded, never auto-cleared, duplicate refusal, double-click import idempotent, undo import.
   - A **fingerprint test** proving no existing row in any table changed.
4. **Migration rehearsal:** apply the whole migration chain to a fresh DB and to the test copy, then confirm `prisma migrate diff` shows no drift (done the same way for the wallet).
5. **Rollback:** the frontend can hide the nav item. Fully undoing it means dropping `ChequeFlowEntry`, `ChequeFlowImport` and the 2 enums; nothing else depends on them.

### About the database you shared (`ep-round-forest…`)

Checked **read-only**:
- It's at **21 of 30 migrations** (the last is `20260804204708_add_rep_portal_v1_v2_1`).
- Dealers, suppliers, payments and invoices all have **0 rows**.
- It's an **old, empty schema, not a copy of current production.**

To use it for testing I'd run `prisma migrate deploy` on it (this brings it to 30 + the new migration). You said that's fine. **It won't tell us anything about production data** unless you load a current copy into it. Production's cheques aren't involved here anyway, since this feature only adds new tables.

The connection string, including its password, was pasted into chat. It won't be written into any file or commit. Rotate that password when testing is finished.

---

## 8. Build order

| Phase | Work | Check |
|---|---|---|
| 1 | Prisma models + additive migration + module (CRUD, status, soft delete/restore) | Integration tests; migrate diff = no drift |
| 2 | Summary, alerts, timeline, monthly, options endpoints | Arithmetic tests, including bounced/cancelled exclusion and overdue across months |
| 3 | Page: month control, cards, side-by-side tables / mobile cards, add/edit/status/delete | tsc, lint, phone-width check (375px) |
| 4 | Alerts strip, timeline, chart, filters + "Filtered" labelling, All-months view | Visual check: desktop + mobile |
| 5 | Import wizard (mapping, preview, duplicates, undo import) | Import your real sheet into the **test** DB: 30 + 15 cheques expected, 0 subtotal rows, re-import = 0 new |
| 6 | Excel export + print | Open the exported file; print preview |

---

## 9. Decisions for you (defaults in **bold**)

1. **Link to ERP cheques?**
   - **v1: no, separate register.**
   - Phase 2 option: a "From ERP" button that copies dealer/supplier cheques already in the system into the register as linked rows (stores the payment id). Each cheque is then entered once, and the register's status *shows* the ERP status. It still never writes back.
2. **Imported "Pass" rows with no cleared date:** **leave the date empty** (alternative: use the cheque date).
3. **Delete:** **soft delete, restorable** (alternative: permanent).
4. **Who can use it:** **admins only** (representatives and dealers never see it).
5. **Monthly net:** **only cheques dated in that month**, with older overdue cheques shown in the alert section. Alternative: carry unpaid overdue cheques into the current month's net.
