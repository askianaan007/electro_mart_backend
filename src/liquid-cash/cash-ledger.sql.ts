import { Prisma } from '@prisma/client';

/**
 * The Liquid Cash ledger, as one SQL CTE named `combined`. Every figure on
 * the Liquid Cash page, the dashboard and the balance sheet's cash line is a
 * SUM over these rows, so they can't disagree (docs/LIQUID_CASH_ACCOUNTING_CONTRACT.md).
 *
 * Revisioned sources (dealer/supplier payments, investments, expenses,
 * refunds) are replayed as a timeline per record: its states are the stored
 * before-images (PaymentRevision / LedgerRevision snapshots, oldest first)
 * followed by the current row — or an "absent" state if it's deleted. The
 * first state is one row on its own date; every later state that changes the
 * cash effect adds a correction row, dated when that change was made, for
 * the difference. Prior rows (and their running balances) therefore never
 * move when something is edited, returned, deleted or undone, and the rows
 * still telescope to exactly the current state's effect.
 *
 * This is a derived ledger, not an immutable table: it is only as complete
 * as the revisions kept. Changes made before revisions were recorded (before
 * PaymentRevision for dealer payments, LedgerRevision for everything else)
 * show only their current state.
 */

const ts = (expr: string) =>
  Prisma.raw(`((${expr})::timestamptz AT TIME ZONE 'UTC')`);

/**
 * A source's states. Each SELECT must produce, in order:
 *   eid, ord (0 = before-image, 1 = current/absent), ended_at, rev_id,
 *   ended_by, signed_amount, mode, cs, posted_at, cleared_at, is_void,
 *   description, reference, created_at
 * `nullChequeCounts`: whether a CHEQUE with no status counts as cleared
 * (true only for investments recorded before cheque tracking).
 */
function revisioned(
  type: string,
  states: Prisma.Sql,
  nullChequeCounts: boolean,
): Prisma.Sql {
  const unclearedCheque = nullChequeCounts
    ? Prisma.sql`mode = 'CHEQUE' AND cs IS NOT NULL AND cs <> 'CLEARED'`
    : Prisma.sql`mode = 'CHEQUE' AND cs IS DISTINCT FROM 'CLEARED'`;
  return Prisma.sql`
    SELECT
      CASE WHEN seq = 1 THEN eid ELSE eid || ':' || started_rev END AS id,
      eid AS "sourceId",
      ${type}::text AS type,
      CASE
        WHEN seq = 1 THEN 'RECORDED'
        WHEN started_by = 'CHEQUE_STATUS' THEN 'CHEQUE_' || COALESCE(cs, 'NONE')
        WHEN started_by = 'UPDATED' THEN 'EDITED'
        WHEN started_by = 'DELETED' THEN 'DELETED'
        WHEN started_by = 'UNDO' THEN 'UNDONE'
        WHEN started_by = 'RESTORED' THEN 'RESTORED'
        WHEN started_by = 'CANCELLED' THEN 'CANCELLED'
        ELSE started_by
      END AS event,
      CASE WHEN mode = 'CHEQUE' AND NOT is_void THEN cs ELSE NULL END AS status,
      CASE
        WHEN seq > 1 THEN started_at
        WHEN eff <> 0 AND mode = 'CHEQUE' AND cs = 'CLEARED'
          THEN COALESCE(cleared_at, posted_at)
        ELSE posted_at
      END AS date,
      COALESCE(description, prev_description) AS description,
      COALESCE(mode, prev_mode) AS mode,
      COALESCE(reference, prev_reference) AS reference,
      CASE WHEN seq = 1 THEN signed_amount ELSE eff - prev_eff END AS "faceAmount",
      CASE WHEN seq = 1 THEN eff ELSE eff - prev_eff END AS amount,
      CASE WHEN seq = 1 THEN created_at ELSE started_at END AS "createdAt"
    FROM (
      SELECT e.*,
        ROW_NUMBER() OVER w AS seq,
        LAG(ended_at) OVER w AS started_at,
        LAG(ended_by) OVER w AS started_by,
        LAG(rev_id) OVER w AS started_rev,
        LAG(eff) OVER w AS prev_eff,
        LAG(description) OVER w AS prev_description,
        LAG(mode) OVER w AS prev_mode,
        LAG(reference) OVER w AS prev_reference
      FROM (
        SELECT st.*,
          CASE
            WHEN is_void THEN 0::numeric
            WHEN ${unclearedCheque} THEN 0::numeric
            ELSE signed_amount
          END AS eff
        FROM (${states}) st
      ) e
      WINDOW w AS (PARTITION BY eid ORDER BY ord, ended_at, rev_id)
    ) x
    WHERE seq = 1 OR eff - prev_eff <> 0
  `;
}

/** Entities with before-images but no current row are deleted: close their timeline. */
function absentTail(revisionTable: Prisma.Sql, currentTable: string) {
  return Prisma.sql`
    SELECT r.eid, 1, NULL::timestamp, NULL::text, NULL::text,
      0::numeric, NULL::text, NULL::text, NULL::timestamp, NULL::timestamp, true,
      NULL::text, NULL::text, NULL::timestamp
    FROM (SELECT DISTINCT eid FROM (${revisionTable}) rt) r
    WHERE NOT EXISTS (SELECT 1 FROM ${Prisma.raw(`"${currentTable}"`)} c WHERE c.id = r.eid)
  `;
}

const dealerPaymentStates = Prisma.sql`
  SELECT
    r."paymentId" AS eid,
    0 AS ord,
    r."createdAt" AS ended_at,
    r.id AS rev_id,
    r.action AS ended_by,
    (r.snapshot->>'amount')::numeric AS signed_amount,
    r.snapshot->>'mode' AS mode,
    r.snapshot->>'chequeStatus' AS cs,
    ${ts(`r.snapshot->>'paymentDate'`)} AS posted_at,
    ${ts(`r.snapshot->>'chequeStatusUpdatedAt'`)} AS cleared_at,
    COALESCE((r.snapshot->>'absent')::boolean, false) AS is_void,
    (d."businessName" || CASE WHEN COALESCE(r.snapshot->>'reference', '') <> '' THEN ' — ' || (r.snapshot->>'reference') ELSE '' END) AS description,
    r.snapshot->>'reference' AS reference,
    ${ts(`r.snapshot->>'createdAt'`)} AS created_at
  FROM "PaymentRevision" r
  LEFT JOIN "Dealer" d ON d.id = r.snapshot->>'dealerId'
  UNION ALL
  SELECT p.id, 1, NULL, NULL, NULL,
    p.amount, p.mode::text, p."chequeStatus"::text,
    p."paymentDate", p."chequeStatusUpdatedAt", false,
    (d."businessName" || CASE WHEN COALESCE(p.reference, '') <> '' THEN ' — ' || p.reference ELSE '' END),
    p.reference, p."createdAt"
  FROM "Payment" p
  JOIN "Dealer" d ON d.id = p."dealerId"
  UNION ALL
  ${absentTail(Prisma.sql`SELECT "paymentId" AS eid FROM "PaymentRevision"`, 'Payment')}
`;

function ledgerRevisions(entityType: string) {
  return Prisma.sql`SELECT * FROM "LedgerRevision" WHERE "entityType" = ${entityType}`;
}

const supplierPaymentStates = Prisma.sql`
  SELECT
    r."entityId" AS eid,
    0 AS ord,
    r."createdAt" AS ended_at,
    r.id AS rev_id,
    r.action AS ended_by,
    -(r.snapshot->>'amount')::numeric AS signed_amount,
    r.snapshot->>'mode' AS mode,
    r.snapshot->>'chequeStatus' AS cs,
    ${ts(`r.snapshot->>'paymentDate'`)} AS posted_at,
    ${ts(`r.snapshot->>'chequeStatusUpdatedAt'`)} AS cleared_at,
    false AS is_void,
    (s.name || CASE WHEN COALESCE(r.snapshot->>'reference', '') <> '' THEN ' — ' || (r.snapshot->>'reference') ELSE '' END) AS description,
    r.snapshot->>'reference' AS reference,
    ${ts(`r.snapshot->>'createdAt'`)} AS created_at
  FROM (${ledgerRevisions('SUPPLIER_PAYMENT')}) r
  LEFT JOIN "Supplier" s ON s.id = r.snapshot->>'supplierId'
  UNION ALL
  SELECT sp.id, 1, NULL, NULL, NULL,
    -sp.amount, sp.mode::text, sp."chequeStatus"::text,
    sp."paymentDate", sp."chequeStatusUpdatedAt", false,
    (s.name || CASE WHEN COALESCE(sp.reference, '') <> '' THEN ' — ' || sp.reference ELSE '' END),
    sp.reference, sp."createdAt"
  FROM "SupplierPayment" sp
  JOIN "Supplier" s ON s.id = sp."supplierId"
  UNION ALL
  ${absentTail(Prisma.sql`SELECT "entityId" AS eid FROM (${ledgerRevisions('SUPPLIER_PAYMENT')}) x`, 'SupplierPayment')}
`;

const investmentStates = Prisma.sql`
  SELECT
    r."entityId" AS eid,
    0 AS ord,
    r."createdAt" AS ended_at,
    r.id AS rev_id,
    r.action AS ended_by,
    (r.snapshot->>'amount')::numeric AS signed_amount,
    r.snapshot->>'mode' AS mode,
    r.snapshot->>'chequeStatus' AS cs,
    ${ts(`r.snapshot->>'investmentDate'`)} AS posted_at,
    ${ts(`r.snapshot->>'chequeStatusUpdatedAt'`)} AS cleared_at,
    false AS is_void,
    (inv.name || ' — ' || (r.snapshot->>'reason')) AS description,
    r.snapshot->>'chequeNumber' AS reference,
    ${ts(`r.snapshot->>'createdAt'`)} AS created_at
  FROM (${ledgerRevisions('INVESTMENT')}) r
  LEFT JOIN "Investor" inv ON inv.id = r.snapshot->>'investorId'
  UNION ALL
  SELECT i.id, 1, NULL, NULL, NULL,
    i.amount, i.mode::text, i."chequeStatus"::text,
    i."investmentDate", i."chequeStatusUpdatedAt", false,
    (inv.name || ' — ' || i.reason),
    i."chequeNumber", i."createdAt"
  FROM "Investment" i
  JOIN "Investor" inv ON inv.id = i."investorId"
  UNION ALL
  ${absentTail(Prisma.sql`SELECT "entityId" AS eid FROM (${ledgerRevisions('INVESTMENT')}) x`, 'Investment')}
`;

const expenseStates = Prisma.sql`
  SELECT
    r."entityId" AS eid,
    0 AS ord,
    r."createdAt" AS ended_at,
    r.id AS rev_id,
    r.action AS ended_by,
    -(r.snapshot->>'amount')::numeric AS signed_amount,
    NULL::text AS mode,
    NULL::text AS cs,
    ${ts(`r.snapshot->>'expenseDate'`)} AS posted_at,
    NULL::timestamp AS cleared_at,
    false AS is_void,
    r.snapshot->>'description' AS description,
    NULL::text AS reference,
    ${ts(`r.snapshot->>'createdAt'`)} AS created_at
  FROM (${ledgerRevisions('EXPENSE')}) r
  UNION ALL
  SELECT e.id, 1, NULL, NULL, NULL,
    -e.amount, NULL::text, NULL::text,
    e."expenseDate", NULL::timestamp, false,
    e.description, NULL::text, e."createdAt"
  FROM "Expense" e
  UNION ALL
  ${absentTail(Prisma.sql`SELECT "entityId" AS eid FROM (${ledgerRevisions('EXPENSE')}) x`, 'Expense')}
`;

// Dealer refund: cash paid out (negative). Supplier refund: cash received (positive).
const refundStates = Prisma.sql`
  SELECT
    r."entityId" AS eid,
    0 AS ord,
    r."createdAt" AS ended_at,
    r.id AS rev_id,
    r.action AS ended_by,
    CASE WHEN r.snapshot->>'party' = 'DEALER' THEN -1 ELSE 1 END * (r.snapshot->>'amount')::numeric AS signed_amount,
    r.snapshot->>'mode' AS mode,
    r.snapshot->>'chequeStatus' AS cs,
    ${ts(`r.snapshot->>'refundDate'`)} AS posted_at,
    ${ts(`r.snapshot->>'chequeStatusUpdatedAt'`)} AS cleared_at,
    (r.snapshot->>'cancelledAt') IS NOT NULL AS is_void,
    (COALESCE(d."businessName", s.name) || ' — Refund ' || (r.snapshot->>'refundNumber')) AS description,
    r.snapshot->>'refundNumber' AS reference,
    ${ts(`r.snapshot->>'createdAt'`)} AS created_at
  FROM (${ledgerRevisions('REFUND')}) r
  LEFT JOIN "Dealer" d ON d.id = r.snapshot->>'dealerId'
  LEFT JOIN "Supplier" s ON s.id = r.snapshot->>'supplierId'
  UNION ALL
  SELECT rf.id, 1, NULL, NULL, NULL,
    CASE WHEN rf.party = 'DEALER' THEN -rf.amount ELSE rf.amount END,
    rf.mode::text, rf."chequeStatus"::text,
    rf."refundDate", rf."chequeStatusUpdatedAt", rf."cancelledAt" IS NOT NULL,
    (COALESCE(d."businessName", s.name) || ' — Refund ' || rf."refundNumber"),
    rf."refundNumber", rf."createdAt"
  FROM "Refund" rf
  LEFT JOIN "Dealer" d ON d.id = rf."dealerId"
  LEFT JOIN "Supplier" s ON s.id = rf."supplierId"
`;

export const CASH_LEDGER_CTE = Prisma.sql`
  WITH combined AS (
    ${revisioned('INVESTMENT', investmentStates, true)}
    UNION ALL
    ${revisioned('DEALER_PAYMENT', dealerPaymentStates, false)}
    UNION ALL
    ${revisioned('SUPPLIER_PAYMENT', supplierPaymentStates, false)}
    UNION ALL
    ${revisioned('EXPENSE', expenseStates, false)}
    UNION ALL
    ${revisioned('REFUND', refundStates, false)}
    UNION ALL
    SELECT
      a.id AS id,
      a.id AS "sourceId",
      'ADJUSTMENT'::text AS type,
      CASE WHEN a."reversalOfId" IS NOT NULL THEN a.type::text || '_REVERSAL' ELSE a.type::text END AS event,
      NULL::text AS status,
      a."adjustmentDate" AS date,
      a.reason AS description,
      NULL::text AS mode,
      a."adjustmentNumber" AS reference,
      a.amount AS "faceAmount",
      a.amount AS amount,
      a."createdAt" AS "createdAt"
    FROM "CashAdjustment" a
  ),
  ledger AS (
    SELECT *,
      SUM(amount) OVER (
        ORDER BY date ASC, "createdAt" ASC, id ASC
        ROWS UNBOUNDED PRECEDING
      ) AS "balanceAfter"
    FROM combined
  )
`;
