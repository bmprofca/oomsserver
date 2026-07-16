/**
 * One-off: zero GST for branch_id 123456 (catalog + historical tasks/sales).
 *
 * Recalc rule (tax-exclusive): keep fees/subtotal; tax_rate/value → 0; totals ↓.
 *
 * Run from SERVER/:
 *   node database/scripts/zero-gst-branch-123456.js
 */
import "dotenv/config";
import pool from "../../db.js";
import { resolveSaleEntriesBranchId } from "../../helpers/saleEntriesBranch.js";

const BRANCH_ID = "123456";

const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
};

const round2 = (v) => Number(n(v).toFixed(2));

function recalcInvoiceTotals(row) {
    const subtotal = round2(row.subtotal);
    const discountValue = Math.min(round2(row.discount_value), subtotal);
    const additionalCharge = round2(row.additional_charge);
    const taxable = round2(subtotal - discountValue);
    const total = round2(taxable + additionalCharge);
    const hadRoundOff = Math.abs(n(row.round_off)) > 0.0001;
    const grandTotal = hadRoundOff ? Math.floor(total) : total;
    const roundOff = round2(grandTotal - total);
    return {
        tax_rate: 0,
        tax_value: 0,
        total,
        grand_total: grandTotal,
        round_off: roundOff,
    };
}

async function tableExists(conn, tableName) {
    const [rows] = await conn.query(
        `SELECT 1 AS ok
         FROM information_schema.tables
         WHERE table_schema = DATABASE()
           AND table_name = ?
         LIMIT 1`,
        [tableName],
    );
    return rows.length > 0;
}

async function countNonZeroTax(conn, sql, params = [BRANCH_ID]) {
    const [rows] = await conn.query(sql, params);
    return n(rows?.[0]?.cnt);
}

async function runUpdate(conn, label, sql, params = [BRANCH_ID]) {
    const [result] = await conn.query(sql, params);
    const affected = result?.affectedRows ?? 0;
    console.log(`  ${label}: ${affected} row(s) updated`);
    return affected;
}

async function zeroBranchServices(conn) {
    console.log("\n[1] branch_services");
    const before = await countNonZeroTax(
        conn,
        `SELECT COUNT(*) AS cnt FROM branch_services
         WHERE branch_id = ?
           AND (IFNULL(gst_rate, 0) <> 0 OR IFNULL(gst_value, 0) <> 0)`,
    );
    console.log(`  non-zero gst before: ${before}`);
    await runUpdate(
        conn,
        "SET gst_rate=0, gst_value=0",
        `UPDATE branch_services
         SET gst_rate = 0, gst_value = 0
         WHERE branch_id = ?
           AND (IFNULL(gst_rate, 0) <> 0
             OR IFNULL(gst_value, 0) <> 0
             OR gst_rate IS NULL
             OR gst_value IS NULL)`,
    );
}

async function zeroTasks(conn) {
    console.log("\n[2] tasks");
    const before = await countNonZeroTax(
        conn,
        `SELECT COUNT(*) AS cnt FROM tasks
         WHERE branch_id = ?
           AND (IFNULL(tax_rate, 0) <> 0
             OR IFNULL(tax_value, 0) <> 0
             OR IFNULL(total, 0) <> IFNULL(fees, 0))`,
    );
    console.log(`  needing recalc before: ${before}`);
    await runUpdate(
        conn,
        "SET tax_rate=0, tax_value=0, total=fees",
        `UPDATE tasks
         SET tax_rate = 0,
             tax_value = 0,
             total = fees
         WHERE branch_id = ?
           AND (IFNULL(tax_rate, 0) <> 0
             OR IFNULL(tax_value, 0) <> 0
             OR IFNULL(total, 0) <> IFNULL(fees, 0))`,
    );
}

async function zeroSaleItems(conn) {
    console.log("\n[3] sale_items");
    const before = await countNonZeroTax(
        conn,
        `SELECT COUNT(*) AS cnt FROM sale_items
         WHERE branch_id = ?
           AND (IFNULL(tax_perc, 0) <> 0
             OR IFNULL(tax_value, 0) <> 0
             OR IFNULL(total, 0) <> IFNULL(fees, 0))`,
    );
    console.log(`  needing recalc before: ${before}`);
    await runUpdate(
        conn,
        "SET tax_perc=0, tax_value=0, total=fees",
        `UPDATE sale_items
         SET tax_perc = 0,
             tax_value = 0,
             total = fees
         WHERE branch_id = ?
           AND (IFNULL(tax_perc, 0) <> 0
             OR IFNULL(tax_value, 0) <> 0
             OR IFNULL(total, 0) <> IFNULL(fees, 0))`,
    );
}

async function recalcSaleInvoices(conn) {
    console.log("\n[4] invoice (type=sale)");

    const [beforeRows] = await conn.query(
        `SELECT invoice_id, invoice_no, tax_rate, tax_value, grand_total, subtotal,
                discount_value, additional_charge, round_off, total
         FROM invoice
         WHERE branch_id = ?
           AND type = 'sale'
           AND (
                IFNULL(tax_rate, 0) <> 0
             OR IFNULL(tax_value, 0) <> 0
             OR ABS(
                  IFNULL(grand_total, 0)
                  - CASE
                      WHEN ABS(IFNULL(round_off, 0)) > 0.0001
                        THEN FLOOR(
                          ROUND(
                            IFNULL(subtotal, 0)
                            - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
                            + IFNULL(additional_charge, 0)
                          , 2)
                        )
                      ELSE ROUND(
                        IFNULL(subtotal, 0)
                        - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
                        + IFNULL(additional_charge, 0)
                      , 2)
                    END
                ) > 0.009
           )`,
        [BRANCH_ID],
    );
    console.log(`  sale invoices needing update: ${beforeRows.length}`);

    const changed = beforeRows.map((row) => {
        const next = recalcInvoiceTotals(row);
        return {
            invoice_id: row.invoice_id,
            invoice_no: row.invoice_no,
            old_tax_rate: n(row.tax_rate),
            old_tax_value: n(row.tax_value),
            old_grand_total: round2(row.grand_total),
            new_grand_total: next.grand_total,
        };
    });

    const [result] = await conn.query(
        `UPDATE invoice
         SET
           tax_rate = 0,
           tax_value = 0,
           total = ROUND(
             IFNULL(subtotal, 0)
             - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
             + IFNULL(additional_charge, 0)
           , 2),
           grand_total = CASE
             WHEN ABS(IFNULL(round_off, 0)) > 0.0001 THEN FLOOR(
               ROUND(
                 IFNULL(subtotal, 0)
                 - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
                 + IFNULL(additional_charge, 0)
               , 2)
             )
             ELSE ROUND(
               IFNULL(subtotal, 0)
               - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
               + IFNULL(additional_charge, 0)
             , 2)
           END,
           round_off = CASE
             WHEN ABS(IFNULL(round_off, 0)) > 0.0001 THEN (
               FLOOR(
                 ROUND(
                   IFNULL(subtotal, 0)
                   - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
                   + IFNULL(additional_charge, 0)
                 , 2)
               )
               - ROUND(
                 IFNULL(subtotal, 0)
                 - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
                 + IFNULL(additional_charge, 0)
               , 2)
             )
             ELSE 0
           END
         WHERE branch_id = ?
           AND type = 'sale'
           AND (
                IFNULL(tax_rate, 0) <> 0
             OR IFNULL(tax_value, 0) <> 0
             OR ABS(
                  IFNULL(grand_total, 0)
                  - CASE
                      WHEN ABS(IFNULL(round_off, 0)) > 0.0001
                        THEN FLOOR(
                          ROUND(
                            IFNULL(subtotal, 0)
                            - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
                            + IFNULL(additional_charge, 0)
                          , 2)
                        )
                      ELSE ROUND(
                        IFNULL(subtotal, 0)
                        - LEAST(IFNULL(discount_value, 0), IFNULL(subtotal, 0))
                        + IFNULL(additional_charge, 0)
                      , 2)
                    END
                ) > 0.009
           )`,
        [BRANCH_ID],
    );

    console.log(`  sale invoices updated: ${result?.affectedRows ?? 0}`);
    return changed;
}

async function syncSaleEntriesAndTransactions(conn) {
    console.log("\n[5] sale_entries + sale transactions");
    const saleEntriesBranchId = await resolveSaleEntriesBranchId(conn, BRANCH_ID);
    console.log(`  sale_entries branch_id resolved: ${saleEntriesBranchId ?? "(null)"}`);

    let entriesUpdated = 0;
    if (saleEntriesBranchId != null) {
        const [er] = await conn.query(
            `UPDATE sale_entries se
             INNER JOIN invoice i
               ON i.invoice_id = se.invoice_id
              AND i.branch_id = ?
              AND i.type = 'sale'
             SET se.total = i.grand_total
             WHERE se.branch_id = ?
               AND IFNULL(se.total, 0) <> IFNULL(i.grand_total, 0)`,
            [BRANCH_ID, saleEntriesBranchId],
        );
        entriesUpdated = er?.affectedRows ?? 0;
    }

    const [tr] = await conn.query(
        `UPDATE transactions t
         INNER JOIN invoice i
           ON i.invoice_id = t.invoice_id
          AND i.branch_id = t.branch_id
          AND i.type = 'sale'
         SET t.amount = i.grand_total
         WHERE t.branch_id = ?
           AND LOWER(t.transaction_type) = 'sale'
           AND IFNULL(t.amount, 0) <> IFNULL(i.grand_total, 0)`,
        [BRANCH_ID],
    );

    console.log(`  sale_entries updated: ${entriesUpdated}`);
    console.log(`  sale transactions updated: ${tr?.affectedRows ?? 0}`);
}

async function zeroRelatedTables(conn) {
    console.log("\n[6] related tables (if present)");

    if (await tableExists(conn, "compliance_firms")) {
        const [cntRows] = await conn.query(
            `SELECT COUNT(*) AS cnt FROM compliance_firms
             WHERE branch_id = ?
               AND (IFNULL(tax_rate, 0) <> 0 OR IFNULL(tax_value, 0) <> 0)`,
            [BRANCH_ID],
        );
        const cnt = n(cntRows?.[0]?.cnt);
        console.log(`  compliance_firms needing zero: ${cnt}`);
        if (cnt > 0) {
            await runUpdate(
                conn,
                "compliance_firms tax → 0",
                `UPDATE compliance_firms
                 SET tax_rate = 0, tax_value = 0
                 WHERE branch_id = ?
                   AND (IFNULL(tax_rate, 0) <> 0 OR IFNULL(tax_value, 0) <> 0)`,
            );
        }
    } else {
        console.log("  compliance_firms: table missing, skip");
    }

    if (await tableExists(conn, "service_requests")) {
        const [cntRows] = await conn.query(
            `SELECT COUNT(*) AS cnt FROM service_requests
             WHERE branch_id = ?
               AND (IFNULL(tax_rate, 0) <> 0
                 OR IFNULL(tax_value, 0) <> 0
                 OR IFNULL(amount, 0) <> IFNULL(fees, 0))`,
            [BRANCH_ID],
        );
        const cnt = n(cntRows?.[0]?.cnt);
        console.log(`  service_requests needing zero: ${cnt}`);
        if (cnt > 0) {
            await runUpdate(
                conn,
                "service_requests tax → 0, amount=fees",
                `UPDATE service_requests
                 SET tax_rate = 0,
                     tax_value = 0,
                     amount = fees
                 WHERE branch_id = ?
                   AND (IFNULL(tax_rate, 0) <> 0
                     OR IFNULL(tax_value, 0) <> 0
                     OR IFNULL(amount, 0) <> IFNULL(fees, 0))`,
            );
        }
    } else {
        console.log("  service_requests: table missing, skip");
    }

    if (await tableExists(conn, "quotation_items")) {
        const [cntRows] = await conn.query(
            `SELECT COUNT(*) AS cnt FROM quotation_items
             WHERE branch_id = ?
               AND (IFNULL(tax_rate, 0) <> 0
                 OR IFNULL(tax_value, 0) <> 0
                 OR IFNULL(total, 0) <> IFNULL(fees, 0))`,
            [BRANCH_ID],
        );
        const cnt = n(cntRows?.[0]?.cnt);
        console.log(`  quotation_items needing zero: ${cnt}`);
        if (cnt > 0) {
            await runUpdate(
                conn,
                "quotation_items tax → 0, total=fees",
                `UPDATE quotation_items
                 SET tax_rate = 0,
                     tax_value = 0,
                     total = fees
                 WHERE branch_id = ?
                   AND (IFNULL(tax_rate, 0) <> 0
                     OR IFNULL(tax_value, 0) <> 0
                     OR IFNULL(total, 0) <> IFNULL(fees, 0))`,
            );
        }
    } else {
        console.log("  quotation_items: table missing, skip");
    }
}

async function printVerification(conn, changedInvoices) {
    console.log("\n[7] verification — leftover non-zero tax");

    const checks = [
        [
            "branch_services",
            `SELECT COUNT(*) AS cnt, MAX(gst_rate) AS max_rate, MAX(gst_value) AS max_val
             FROM branch_services WHERE branch_id = ?
               AND (IFNULL(gst_rate, 0) <> 0 OR IFNULL(gst_value, 0) <> 0)`,
        ],
        [
            "tasks",
            `SELECT COUNT(*) AS cnt, MAX(tax_rate) AS max_rate, MAX(tax_value) AS max_val
             FROM tasks WHERE branch_id = ?
               AND (IFNULL(tax_rate, 0) <> 0 OR IFNULL(tax_value, 0) <> 0)`,
        ],
        [
            "sale_items",
            `SELECT COUNT(*) AS cnt, MAX(tax_perc) AS max_rate, MAX(tax_value) AS max_val
             FROM sale_items WHERE branch_id = ?
               AND (IFNULL(tax_perc, 0) <> 0 OR IFNULL(tax_value, 0) <> 0)`,
        ],
        [
            "invoice(sale)",
            `SELECT COUNT(*) AS cnt, MAX(tax_rate) AS max_rate, MAX(tax_value) AS max_val
             FROM invoice WHERE branch_id = ? AND type = 'sale'
               AND (IFNULL(tax_rate, 0) <> 0 OR IFNULL(tax_value, 0) <> 0)`,
        ],
    ];

    for (const [label, sql] of checks) {
        const [rows] = await conn.query(sql, [BRANCH_ID]);
        const r = rows[0] || {};
        console.log(
            `  ${label}: leftover=${n(r.cnt)} max_rate=${r.max_rate ?? 0} max_val=${r.max_val ?? 0}`,
        );
    }

    const [maxes] = await conn.query(
        `SELECT
            (SELECT MAX(IFNULL(gst_rate,0)) FROM branch_services WHERE branch_id = ?) AS bs_gst,
            (SELECT MAX(IFNULL(tax_rate,0)) FROM tasks WHERE branch_id = ?) AS task_tax,
            (SELECT MAX(IFNULL(tax_perc,0)) FROM sale_items WHERE branch_id = ?) AS item_tax,
            (SELECT MAX(IFNULL(tax_rate,0)) FROM invoice WHERE branch_id = ? AND type = 'sale') AS inv_tax`,
        [BRANCH_ID, BRANCH_ID, BRANCH_ID, BRANCH_ID],
    );
    console.log("  MAX rates:", maxes?.[0]);

    console.log("\n[8] payment overpay risk (party-level)");
    const saleEntriesBranchId = await resolveSaleEntriesBranchId(conn, BRANCH_ID);
    if (saleEntriesBranchId == null) {
        console.log("  Skip overpay check: sale_entries branch_id unresolved.");
        return;
    }

    const [partyRisk] = await conn.query(
        `SELECT party_type, party_id, sales_total, received_total,
                ROUND(received_total - sales_total, 2) AS over_by
         FROM (
            SELECT
                se.party_type,
                se.party_id,
                ROUND(SUM(i.grand_total), 2) AS sales_total,
                ROUND((
                    SELECT COALESCE(SUM(ABS(t.amount)), 0)
                    FROM transactions t
                    WHERE t.branch_id = ?
                      AND LOWER(t.transaction_type) IN ('receive', 'received', 'payment receive')
                      AND (
                            (t.party1_type = se.party_type AND t.party1_id = se.party_id)
                         OR (t.party2_type = se.party_type AND t.party2_id = se.party_id)
                      )
                ), 2) AS received_total
             FROM sale_entries se
             INNER JOIN invoice i
               ON i.invoice_id = se.invoice_id
              AND i.branch_id = ?
              AND i.type = 'sale'
             WHERE se.branch_id = ?
             GROUP BY se.party_type, se.party_id
         ) x
         WHERE received_total > sales_total
         ORDER BY (received_total - sales_total) DESC
         LIMIT 50`,
        [BRANCH_ID, BRANCH_ID, saleEntriesBranchId],
    );

    if (!partyRisk.length) {
        console.log("  No party with receives > post-GST sale totals (top check).");
    } else {
        console.log(`  ${partyRisk.length} party(ies) where receives exceed sale totals:`);
        for (const row of partyRisk) {
            console.log(
                `    ${row.party_type}/${row.party_id}: sales=${row.sales_total} received=${row.received_total} over=${round2(n(row.received_total) - n(row.sales_total))}`,
            );
        }
    }

    if (changedInvoices.length) {
        console.log(`\n  Sample of changed invoices (up to 15 of ${changedInvoices.length}):`);
        for (const inv of changedInvoices.slice(0, 15)) {
            console.log(
                `    ${inv.invoice_no || inv.invoice_id}: tax ${inv.old_tax_rate}% / ${inv.old_tax_value} → 0; grand ${inv.old_grand_total} → ${inv.new_grand_total}`,
            );
        }
    }
}

async function main() {
    console.log(`Zero GST for branch_id=${BRANCH_ID}`);
    // Per-step commits: avoids long locks on remote MySQL and survives partial progress.
    const conn = await pool.getConnection();
    try {
        await conn.query("SET SESSION innodb_lock_wait_timeout = 120");

        const [branchRows] = await conn.query(
            `SELECT branch_id, name FROM branch_list WHERE branch_id = ? LIMIT 1`,
            [BRANCH_ID],
        );
        if (!branchRows.length) {
            throw new Error(`Branch ${BRANCH_ID} not found in branch_list`);
        }
        console.log(`Branch OK: ${branchRows[0].name || BRANCH_ID}`);

        const steps = [
            ["branch_services", zeroBranchServices],
            ["tasks", zeroTasks],
            ["sale_items", zeroSaleItems],
            ["invoices", recalcSaleInvoices],
            ["sale sync", syncSaleEntriesAndTransactions],
            ["related tables", zeroRelatedTables],
        ];

        let changedInvoices = [];
        for (const [label, fn] of steps) {
            await conn.beginTransaction();
            try {
                const result = await fn(conn);
                if (label === "invoices") changedInvoices = result || [];
                await conn.commit();
                console.log(`  ✓ committed: ${label}`);
            } catch (err) {
                await conn.rollback();
                console.error(`  ✗ rolled back: ${label}`);
                throw err;
            }
        }

        await printVerification(conn, changedInvoices);
        console.log("\nDone.");
    } finally {
        conn.release();
    }
}

main()
    .catch((err) => {
        console.error("zero-gst-branch-123456 failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await pool.end();
        } catch {
            /* ignore */
        }
    });
