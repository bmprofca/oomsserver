import "dotenv/config";
import { NEW_BRANCH_ID } from "./config.js";
import { closePools, getStagingPool, getTargetPool } from "./db.js";
import { loadStagingPartyTypeByUsername, mapTransactionType, queryBranchRows, resolveClientId, resolveUsernamePartyType } from "./utils.js";

/**
 * Normalize opening balance rows to v5 convention (matches transactions.js set route):
 * - debit (receivable): party on party2, amount positive
 * - credit (payable): party on party1, amount positive
 *
 * Uses staging ledger type per invoice so credit/debit is correct in a single pass.
 */
export async function fixOpeningBalances({ target, staging, branchId = NEW_BRANCH_ID, logger = console } = {}) {
    const clientUsernameSet = new Set();
    const partyTypeByUsername = staging ? await loadStagingPartyTypeByUsername(staging) : new Map();
    const partyOptions = { clientUsernameSet, partyTypeByUsername };

    const invoices = staging
        ? (await queryBranchRows(staging, "invoice")).filter(
              (inv) => mapTransactionType(inv.type) === "opening balance"
          )
        : [];

    const ledgerRows = staging ? await queryBranchRows(staging, "ledger") : [];
    const ledgerByPayment = new Map();
    for (const row of ledgerRows) {
        if (!ledgerByPayment.has(row.payment_id)) ledgerByPayment.set(row.payment_id, []);
        ledgerByPayment.get(row.payment_id).push(row);
    }

    const [[before]] = await target.query(
        `SELECT
            SUM(amount < 0) AS negative_amount,
            SUM(party1_id IS NOT NULL AND party1_id != '' AND (party2_id IS NULL OR party2_id = '')) AS party1_only,
            SUM(party2_id IS NOT NULL AND party2_id != '' AND (party1_id IS NULL OR party1_id = '')) AS party2_only
         FROM transactions
         WHERE branch_id = ? AND transaction_type = 'opening balance'`,
        [branchId]
    );
    logger.log?.("Before:", before) ?? logger.info?.("Before:", before);

    let updated = 0;

    if (invoices.length) {
        for (const inv of invoices) {
            const paymentId = inv.payment_id || inv.invoice_id;
            const transaction_id = paymentId;
            const led = ledgerByPayment.get(paymentId) || [];
            const row = led[0];
            const absAmt = Math.abs(Number(row?.amount ?? inv.grand_total ?? inv.total ?? 0));
            const obPartyId = resolveClientId(inv, led);
            const partyType = obPartyId ? resolveUsernamePartyType(obPartyId, partyOptions) : "client";
            const isCredit = String(row?.type) === "1";

            const party1_type = isCredit ? partyType : null;
            const party1_id = isCredit ? obPartyId : null;
            const party2_type = isCredit ? null : partyType;
            const party2_id = isCredit ? null : obPartyId;

            const [result] = await target.query(
                `UPDATE transactions
                 SET amount = ?,
                     party1_type = ?,
                     party1_id = ?,
                     party2_type = ?,
                     party2_id = ?
                 WHERE branch_id = ?
                   AND transaction_type = 'opening balance'
                   AND transaction_id = ?`,
                [absAmt, party1_type, party1_id, party2_type, party2_id, branchId, transaction_id]
            );
            updated += result.affectedRows || 0;
        }
    } else {
        // Fallback when staging unavailable: single-pass using signed amount on party1
        const [result] = await target.query(
            `UPDATE transactions
             SET amount = ABS(amount),
                 party1_type = IF(amount < 0, party1_type, NULL),
                 party1_id = IF(amount < 0, party1_id, NULL),
                 party2_type = IF(amount < 0, NULL, party1_type),
                 party2_id = IF(amount < 0, NULL, party1_id)
             WHERE branch_id = ?
               AND transaction_type = 'opening balance'
               AND party1_id IS NOT NULL
               AND party1_id != ''
               AND (party2_id IS NULL OR party2_id = '')`,
            [branchId]
        );
        updated += result.affectedRows || 0;
    }

    const [[after]] = await target.query(
        `SELECT
            SUM(amount < 0) AS negative_amount,
            SUM(party1_id IS NOT NULL AND party1_id != '' AND (party2_id IS NULL OR party2_id = '')) AS credit_on_party1,
            SUM(party2_id IS NOT NULL AND party2_id != '' AND (party1_id IS NULL OR party1_id = '')) AS debit_on_party2
         FROM transactions
         WHERE branch_id = ? AND transaction_type = 'opening balance'`,
        [branchId]
    );
    logger.log?.(`Updated ${updated} opening balance rows`) ?? logger.info?.(`Updated ${updated} opening balance rows`);
    logger.log?.("After:", after) ?? logger.info?.("After:", after);

    return { updated, before, after };
}

async function main() {
    const staging = getStagingPool();
    const target = getTargetPool();
    console.log(`Normalizing opening balance rows for branch ${NEW_BRANCH_ID}`);
    try {
        await fixOpeningBalances({ staging, target, branchId: NEW_BRANCH_ID, logger: console });
        console.log("Opening balance normalization complete.");
    } finally {
        await closePools();
    }
}

const isDirectRun = process.argv[1]?.endsWith("fix-opening-balances.js");
if (isDirectRun) {
    main().catch((err) => {
        console.error("Opening balance fix failed:", err);
        process.exit(1);
    });
}
