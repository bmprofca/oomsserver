import "dotenv/config";
import { NEW_BRANCH_ID } from "./config.js";
import { getStagingPool, getTargetPool, closePools } from "./db.js";
import {
    buildTransactionFromInvoice,
    countDebtorsFromBalanceMap,
    fetchAllClientBalances,
    fetchAllClientBalancesFromStagingLedger,
    fetchLegacyDashboardBalances,
    loadStagingClientUsernameSet,
    loadStagingPartyTypeByUsername,
    queryBranchRows,
    sumClientBalanceFromTransactions,
} from "./utils.js";

const THRESHOLD = 0.02;

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
    const partyTypeByUsername = await loadStagingPartyTypeByUsername(staging);
    const partyOptions = { clientUsernameSet, partyTypeByUsername };

    return invoices.map((inv) => {
        const paymentId = inv.payment_id || inv.invoice_id;
        return buildTransactionFromInvoice(
            inv,
            ledgerByPayment.get(paymentId) || [],
            journalByPayment.get(paymentId),
            partyOptions
        );
    });
}

function debtorsFromMap(map, clientSet = null) {
    const debtors = [];
    for (const [username, balance] of map) {
        if (balance <= THRESHOLD) continue;
        if (clientSet && !clientSet.has(username)) continue;
        debtors.push({ username, balance: Number(balance.toFixed(2)) });
    }
    debtors.sort((a, b) => b.balance - a.balance);
    return debtors;
}

function diffSets(aList, bList) {
    const aSet = new Set(aList.map((d) => d.username));
    const bSet = new Set(bList.map((d) => d.username));
    return {
        onlyA: aList.filter((d) => !bSet.has(d.username)),
        onlyB: bList.filter((d) => !aSet.has(d.username)),
    };
}

async function main() {
    const staging = getStagingPool();
    const target = getTargetPool();
    const branchId = NEW_BRANCH_ID;

    const [clientRows] = await target.query(
        `SELECT username FROM clients
         WHERE branch_id = ? AND user_type = 'client'
           AND (is_deleted = '0' OR is_deleted = 0)`,
        [branchId]
    );
    const clientSet = new Set(clientRows.map((r) => r.username));

    const legacyMap = await fetchLegacyDashboardBalances(target, branchId);
    const getBalanceMap = await fetchAllClientBalances(target, branchId);
    const stagingLedgerMap = await fetchAllClientBalancesFromStagingLedger(staging);

    const expectedTxns = await buildExpectedTransactions(staging);
    const invoiceDerivedMap = new Map();
    for (const username of clientSet) {
        invoiceDerivedMap.set(username, sumClientBalanceFromTransactions(expectedTxns, username));
    }

    const methodA = debtorsFromMap(legacyMap);
    const methodB = debtorsFromMap(getBalanceMap);
    const methodC = debtorsFromMap(getBalanceMap, clientSet);
    const methodD = debtorsFromMap(stagingLedgerMap, clientSet);
    const methodE = debtorsFromMap(invoiceDerivedMap, clientSet);

    const { count: legacyCount } = countDebtorsFromBalanceMap(legacyMap);
    const { count: gbCount } = countDebtorsFromBalanceMap(getBalanceMap);

    console.log("=== Debtor count diagnosis (branch %s) ===\n", branchId);
    console.log("Method A — legacy dashboard SQL (all txn parties):     ", methodA.length, `(raw map count: ${legacyCount})`);
    console.log("Method B — GET_BALANCE SQL (all txn parties):          ", methodB.length, `(raw map count: ${gbCount})`);
    console.log("Method C — GET_BALANCE + clients.user_type=client:   ", methodC.length);
    console.log("Method D — staging ledger balance + clients filter:    ", methodD.length);
    console.log("Method E — invoice-derived expected + clients filter:", methodE.length);

    const falseDebtors = methodA.filter((d) => !clientSet.has(d.username));
    const missedByDashboard = methodC.filter((d) => !methodA.some((x) => x.username === d.username));
    const extraVsCorrect = diffSets(methodA, methodC);

    console.log("\n--- False debtors (in A, not in clients table):", falseDebtors.length);
    falseDebtors.slice(0, 10).forEach((d) => console.log(" ", d.username, d.balance));

    console.log("\n--- Extra in dashboard vs correct (A not in C):", extraVsCorrect.onlyA.length);
    extraVsCorrect.onlyA.slice(0, 15).forEach((d) => {
        const correct = getBalanceMap.get(d.username) ?? 0;
        console.log(" ", d.username, `dashboard=${d.balance}`, `correct=${Number(correct.toFixed(2))}`);
    });

    console.log("\n--- Missed by dashboard (in C not in A):", missedByDashboard.length);
    missedByDashboard.slice(0, 15).forEach((d) => console.log(" ", d.username, d.balance));

    console.log("\n--- Top balance diffs (dashboard vs GET_BALANCE) ---");
    const diffs = [];
    for (const username of new Set([...legacyMap.keys(), ...getBalanceMap.keys()])) {
        const dash = legacyMap.get(username) ?? 0;
        const correct = getBalanceMap.get(username) ?? 0;
        const diff = Math.abs(dash - correct);
        if (diff > THRESHOLD) {
            diffs.push({ username, dashboard: Number(dash.toFixed(2)), correct: Number(correct.toFixed(2)), diff: Number(diff.toFixed(2)) });
        }
    }
    diffs.sort((a, b) => b.diff - a.diff);
    diffs.slice(0, 20).forEach((d) => console.log(` ${d.username}: dashboard=${d.dashboard} correct=${d.correct} diff=${d.diff}`));

    await closePools();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
