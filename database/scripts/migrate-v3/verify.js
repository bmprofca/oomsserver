import { NEW_BRANCH_ID, OLD_APP_ID, OLD_BRANCH_ID } from "./config.js";
import { stagingTable } from "./db.js";
import {
    buildTransactionFromInvoice,
    countDebtorsFromBalanceMap,
    fetchAllClientBalances,
    fetchAllClientBalancesFromStagingLedger,
    fetchLegacyDashboardBalances,
    loadStagingClientUsernameSet,
    queryBranchRows,
    sumClientBalanceFromTransactions,
} from "./utils.js";
import {
    clientBalanceCountParams,
    clientBalanceCountSql,
} from "../../../helpers/clientBalanceSql.js";

const CHECKS = [
    { label: "clients", sql: `SELECT COUNT(*) AS cnt FROM clients WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "firms", sql: `SELECT COUNT(*) AS cnt FROM firms WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "tasks", sql: `SELECT COUNT(*) AS cnt FROM tasks WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "transactions", sql: `SELECT COUNT(*) AS cnt FROM transactions WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "invoice", sql: `SELECT COUNT(*) AS cnt FROM invoice WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "invoice_distinct", sql: `SELECT COUNT(DISTINCT invoice_id) AS cnt FROM invoice WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "sale_entries", sql: `SELECT COUNT(*) AS cnt FROM sale_entries WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "purchase_entries", sql: `SELECT COUNT(*) AS cnt FROM purchase_entries WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "purchase_items", sql: `SELECT COUNT(*) AS cnt FROM purchase_items WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "attendance", sql: `SELECT COUNT(*) AS cnt FROM attendance WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "documents", sql: `SELECT COUNT(*) AS cnt FROM documents WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
    { label: "branch_mapping", sql: `SELECT COUNT(*) AS cnt FROM branch_mapping WHERE branch_id = ?`, params: [NEW_BRANCH_ID] },
];

const STAGING_CHECKS = [
    { label: "staging_users", sql: `SELECT COUNT(*) AS cnt FROM \`${stagingTable("users")}\` WHERE app_id = ? AND branch_id = ?`, params: [OLD_APP_ID, OLD_BRANCH_ID] },
    { label: "staging_firms", sql: `SELECT COUNT(*) AS cnt FROM \`${stagingTable("firms")}\` WHERE app_id = ? AND branch_id = ?`, params: [OLD_APP_ID, OLD_BRANCH_ID] },
    { label: "staging_tasks", sql: `SELECT COUNT(*) AS cnt FROM \`${stagingTable("tasks")}\` WHERE app_id = ? AND branch_id = ?`, params: [OLD_APP_ID, OLD_BRANCH_ID] },
    { label: "staging_ledger", sql: `SELECT COUNT(*) AS cnt FROM \`${stagingTable("ledger")}\` WHERE app_id = ? AND branch_id = ?`, params: [OLD_APP_ID, OLD_BRANCH_ID] },
    { label: "staging_invoice", sql: `SELECT COUNT(*) AS cnt FROM \`${stagingTable("invoice")}\` WHERE app_id = ? AND branch_id = ?`, params: [OLD_APP_ID, OLD_BRANCH_ID] },
    {
        label: "staging_purchase_invoice",
        sql: `SELECT COUNT(*) AS cnt FROM \`${stagingTable("invoice")}\` WHERE app_id = ? AND branch_id = ? AND LOWER(TRIM(type)) IN ('purchase', 'asset purchase')`,
        params: [OLD_APP_ID, OLD_BRANCH_ID],
    },
];

async function buildExpectedTransactions(staging) {
    const invoices = await queryBranchRows(staging, "invoice");
    const ledgerRows = await queryBranchRows(staging, "ledger");
    const journals = await queryBranchRows(staging, "journals");

    const ledgerByPayment = new Map();
    for (const row of ledgerRows) {
        if (!ledgerByPayment.has(row.payment_id)) ledgerByPayment.set(row.payment_id, []);
        ledgerByPayment.get(row.payment_id).push(row);
    }
    const journalByPayment = new Map(journals.map((j) => [j.journal_id, j]));
    const clientUsernameSet = await loadStagingClientUsernameSet(staging);

    return invoices.map((inv) => {
        const paymentId = inv.payment_id || inv.invoice_id;
        return buildTransactionFromInvoice(
            inv,
            ledgerByPayment.get(paymentId) || [],
            journalByPayment.get(paymentId),
            { clientUsernameSet }
        );
    });
}

export async function runVerification({ staging, target, logger }) {
    logger.info("Running verification checklist");

    const [branch] = await target.query(`SELECT branch_id, name FROM branch_list WHERE branch_id = ? LIMIT 1`, [NEW_BRANCH_ID]);
    if (!branch.length) {
        logger.error(`Target branch ${NEW_BRANCH_ID} not found in branch_list`);
    } else {
        logger.info(`Target branch found: ${branch[0].name}`);
    }

    let stagingInvoiceCount = 0;
    let stagingPurchaseInvoiceCount = 0;
    for (const check of STAGING_CHECKS) {
        const [rows] = await staging.query(check.sql, check.params);
        logger.stat(`verify.staging.${check.label}`, rows[0].cnt);
        if (check.label === "staging_invoice") stagingInvoiceCount = Number(rows[0].cnt);
        if (check.label === "staging_purchase_invoice") stagingPurchaseInvoiceCount = Number(rows[0].cnt);
    }

    let targetInvoiceCount = 0;
    let targetTxnCount = 0;
    let targetPurchaseEntryCount = 0;
    for (const check of CHECKS) {
        const [rows] = await target.query(check.sql, check.params);
        logger.stat(`verify.target.${check.label}`, rows[0].cnt);
        if (check.label === "invoice") targetInvoiceCount = Number(rows[0].cnt);
        if (check.label === "transactions") targetTxnCount = Number(rows[0].cnt);
        if (check.label === "purchase_entries") targetPurchaseEntryCount = Number(rows[0].cnt);
    }

    if (stagingInvoiceCount === targetInvoiceCount && targetInvoiceCount === targetTxnCount) {
        logger.info(`Finance counts aligned: ${stagingInvoiceCount} invoices = ${targetTxnCount} transactions`);
    } else {
        logger.warn("Finance count mismatch", {
            staging_invoice: stagingInvoiceCount,
            target_invoice: targetInvoiceCount,
            target_transactions: targetTxnCount,
        });
    }

    if (stagingPurchaseInvoiceCount === targetPurchaseEntryCount) {
        logger.info(`Purchase entries aligned: ${stagingPurchaseInvoiceCount} staging purchase invoices = ${targetPurchaseEntryCount} purchase_entries`);
    } else {
        logger.warn("Purchase entry count mismatch", {
            staging_purchase_invoices: stagingPurchaseInvoiceCount,
            target_purchase_entries: targetPurchaseEntryCount,
        });
    }

    const [[purchaseTxnCheck]] = await target.query(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN party2_id IS NOT NULL AND party2_id != '' THEN 1 ELSE 0 END) AS with_party2
         FROM transactions
         WHERE branch_id = ? AND transaction_type = 'purchase'`,
        [NEW_BRANCH_ID]
    );
    logger.stat("verify.purchase_transactions", Number(purchaseTxnCheck?.total) || 0);
    logger.stat("verify.purchase_transactions_with_party2", Number(purchaseTxnCheck?.with_party2) || 0);
    if (Number(purchaseTxnCheck?.with_party2) > 0) {
        logger.warn("Purchase transactions should have party2_id null", {
            with_party2: Number(purchaseTxnCheck.with_party2),
        });
    } else {
        logger.info("All purchase transactions have party2_id null (v5 model)");
    }

    const expectedTxns = await buildExpectedTransactions(staging);
    const [clients] = await target.query(
        `SELECT username FROM clients WHERE branch_id = ? AND user_type = 'client'`,
        [NEW_BRANCH_ID]
    );

    const actualBalances = await fetchAllClientBalances(target, NEW_BRANCH_ID);
    let mismatchCount = 0;
    const sampleMismatches = [];

    for (const client of clients) {
        const expected = sumClientBalanceFromTransactions(expectedTxns, client.username);
        const actual = actualBalances.get(client.username) ?? 0;
        const diff = Math.abs(Number(expected.toFixed(2)) - Number(actual.toFixed(2)));
        if (diff > 0.02) {
            mismatchCount++;
            if (sampleMismatches.length < 10) {
                sampleMismatches.push({
                    username: client.username,
                    expected: Number(expected.toFixed(2)),
                    actual: Number(actual.toFixed(2)),
                    diff: Number(diff.toFixed(2)),
                });
            }
        }
    }

    logger.stat("verify.balance_mismatched_clients", mismatchCount);
    logger.stat("verify.balance_checked_clients", clients.length);
    if (sampleMismatches.length) {
        logger.warn("Balance mismatches (sample up to 10)", sampleMismatches);
    } else {
        logger.info("All client balances match expected values");
    }

    // Spot-check Jahed Ali opening balance
    const JAHEB = "APP2025_BRN2025_1745485392223_16046819";
    const obTxn = expectedTxns.find(
        (t) => t.transaction_type === "opening balance" && t.party1_id === JAHEB
    );
    logger.stat("verify.jahed_opening_balance_present", obTxn ? 1 : 0);
    if (obTxn) {
        logger.info("Jahed Ali opening balance (expected)", { amount: obTxn.amount, transaction_id: obTxn.transaction_id });
    }

    const [jahedObRows] = await target.query(
        `SELECT transaction_id, amount FROM transactions
         WHERE branch_id = ? AND transaction_type = 'opening balance' AND party1_id = ? LIMIT 1`,
        [NEW_BRANCH_ID, JAHEB]
    );
    if (jahedObRows.length) {
        logger.info("Jahed Ali opening balance (target)", jahedObRows[0]);
    } else {
        logger.warn("Jahed Ali opening balance missing in target transactions");
    }

    const [jahedSales] = await target.query(
        `SELECT COUNT(*) AS cnt, SUM(amount) AS total FROM transactions
         WHERE branch_id = ? AND transaction_type = 'sale' AND party2_id = ? AND amount > 0`,
        [NEW_BRANCH_ID, JAHEB]
    );
    logger.stat("verify.jahed_sale_count", jahedSales[0]?.cnt ?? 0);
    logger.stat("verify.jahed_sale_total", jahedSales[0]?.total ?? 0);

    const jahedExpected = sumClientBalanceFromTransactions(expectedTxns, JAHEB);
    const jahedActual = actualBalances.get(JAHEB) ?? 0;
    logger.info("Jahed Ali balance", {
        expected: Number(jahedExpected.toFixed(2)),
        actual: Number(jahedActual.toFixed(2)),
        match: Math.abs(jahedExpected - jahedActual) <= 0.02,
    });

    const [debitCredit] = await staging.query(
        `SELECT payment_id,
                SUM(CASE WHEN type = '0' THEN amount ELSE 0 END) AS debit_total,
                SUM(CASE WHEN type = '1' THEN amount ELSE 0 END) AS credit_total
         FROM \`${stagingTable("ledger")}\`
         WHERE app_id = ? AND branch_id = ?
         GROUP BY payment_id
         HAVING ABS(debit_total - credit_total) > 0.01
         LIMIT 5`,
        [OLD_APP_ID, OLD_BRANCH_ID]
    );
    logger.stat("verify.ledger_imbalanced_groups_sample", debitCredit.length);
    if (debitCredit.length) {
        logger.warn("Single-sided ledger groups exist in staging (expected for sale/OB/expense)", { sample: debitCredit.length });
    }

    // Debtor count regression (balance > 0)
    const stagingLedgerBalances = await fetchAllClientBalancesFromStagingLedger(staging);
    const legacyDashboardBalances = await fetchLegacyDashboardBalances(target, NEW_BRANCH_ID);
    const clientUsernameSet = new Set(clients.map((c) => c.username));

    const stagingDebtorsClientsOnly = { count: 0, total: 0 };
    for (const [username, balance] of stagingLedgerBalances) {
        if (balance > 0.02 && clientUsernameSet.has(username)) {
            stagingDebtorsClientsOnly.count++;
            stagingDebtorsClientsOnly.total += balance;
        }
    }

    const stagingDebtors = countDebtorsFromBalanceMap(stagingLedgerBalances);
    let getBalanceDebtors = { count: 0, total: 0 };
    let getBalanceDebtorsClientsOnly = { count: 0, total: 0 };
    for (const [username, balance] of actualBalances) {
        if (balance > 0.02) {
            getBalanceDebtors.count++;
            getBalanceDebtors.total += balance;
            if (clientUsernameSet.has(username)) {
                getBalanceDebtorsClientsOnly.count++;
                getBalanceDebtorsClientsOnly.total += balance;
            }
        }
    }
    const legacyDebtors = countDebtorsFromBalanceMap(legacyDashboardBalances);
    const legacyDebtorsClientsOnly = { count: 0, total: 0 };
    for (const [username, balance] of legacyDashboardBalances) {
        if (balance > 0.02 && clientUsernameSet.has(username)) {
            legacyDebtorsClientsOnly.count++;
            legacyDebtorsClientsOnly.total += balance;
        }
    }

    const [[dashboardDebtorRow]] = await target.query(
        clientBalanceCountSql("debtor"),
        clientBalanceCountParams(NEW_BRANCH_ID)
    );

    logger.stat("verify.debtors_staging_ledger", stagingDebtorsClientsOnly.count);
    logger.stat("verify.debtors_staging_ledger_all_parties", stagingDebtors.count);
    logger.stat("verify.debtors_get_balance_all", getBalanceDebtors.count);
    logger.stat("verify.debtors_get_balance_clients", getBalanceDebtorsClientsOnly.count);
    logger.stat("verify.debtors_legacy_dashboard", legacyDebtors.count);
    logger.stat("verify.debtors_dashboard_fixed", Number(dashboardDebtorRow?.total_count) || 0);

    if (Math.abs(getBalanceDebtorsClientsOnly.count - (Number(dashboardDebtorRow?.total_count) || 0)) > 1) {
        logger.warn("Debtor count mismatch between GET_BALANCE and fixed dashboard SQL", {
            get_balance_clients: getBalanceDebtorsClientsOnly.count,
            dashboard_fixed: Number(dashboardDebtorRow?.total_count) || 0,
        });
    } else {
        logger.info("Debtor counts aligned (GET_BALANCE clients = fixed dashboard SQL)");
    }

    if (Math.abs(stagingDebtorsClientsOnly.count - getBalanceDebtorsClientsOnly.count) > 1) {
        logger.warn("Debtor count differs from staging ledger baseline", {
            staging_ledger_clients: stagingDebtorsClientsOnly.count,
            get_balance_clients: getBalanceDebtorsClientsOnly.count,
            diff: getBalanceDebtorsClientsOnly.count - stagingDebtorsClientsOnly.count,
        });
    } else {
        logger.info("Debtor counts match staging ledger baseline", {
            staging_ledger_clients: stagingDebtorsClientsOnly.count,
            get_balance_clients: getBalanceDebtorsClientsOnly.count,
            dashboard_fixed: Number(dashboardDebtorRow?.total_count) || 0,
        });
    }

    logger.info("Verification complete");
}
