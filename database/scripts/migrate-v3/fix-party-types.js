import "dotenv/config";
import { NEW_BRANCH_ID } from "./config.js";
import { closePools, getTargetPool } from "./db.js";

const PERSON_PARTY_TYPES = ["client", "ca", "agent"];

const REPAIR_STEPS = [
    {
        label: "transactions.party1_type",
        sql: `UPDATE transactions t
              INNER JOIN clients c
                ON c.username = t.party1_id AND c.branch_id = t.branch_id
              SET t.party1_type = c.user_type
              WHERE t.branch_id = ?
                AND c.user_type IN ('client', 'ca', 'agent')
                AND t.party1_type != c.user_type`,
    },
    {
        label: "transactions.party2_type",
        sql: `UPDATE transactions t
              INNER JOIN clients c
                ON c.username = t.party2_id AND c.branch_id = t.branch_id
              SET t.party2_type = c.user_type
              WHERE t.branch_id = ?
                AND c.user_type IN ('client', 'ca', 'agent')
                AND t.party2_type != c.user_type`,
    },
    {
        label: "journal_entries.party1_type",
        sql: `UPDATE journal_entries j
              INNER JOIN clients c
                ON c.username = j.party1_id AND c.branch_id = j.branch_id
              SET j.party1_type = c.user_type
              WHERE j.branch_id = ?
                AND c.user_type IN ('client', 'ca', 'agent')
                AND j.party1_type != c.user_type`,
    },
    {
        label: "journal_entries.party2_type",
        sql: `UPDATE journal_entries j
              INNER JOIN clients c
                ON c.username = j.party2_id AND c.branch_id = j.branch_id
              SET j.party2_type = c.user_type
              WHERE j.branch_id = ?
                AND c.user_type IN ('client', 'ca', 'agent')
                AND j.party2_type != c.user_type`,
    },
    {
        label: "sale_entries.party_type",
        sql: `UPDATE sale_entries s
              INNER JOIN clients c
                ON c.username = s.party_id AND c.branch_id = s.branch_id
              SET s.party_type = c.user_type
              WHERE s.branch_id = ?
                AND c.user_type IN ('client', 'ca', 'agent')
                AND s.party_type != c.user_type`,
    },
    {
        label: "purchase_entries.party_type",
        sql: `UPDATE purchase_entries p
              INNER JOIN clients c
                ON c.username = p.party_id AND c.branch_id = p.branch_id
              SET p.party_type = c.user_type
              WHERE p.branch_id = ?
                AND c.user_type IN ('client', 'ca', 'agent')
                AND p.party_type != c.user_type`,
    },
    {
        label: "expense_entries.party_type",
        sql: `UPDATE expense_entries e
              INNER JOIN clients c
                ON c.username = e.party_id AND c.branch_id = e.branch_id
              SET e.party_type = c.user_type
              WHERE e.branch_id = ?
                AND c.user_type IN ('client', 'ca', 'agent')
                AND e.party_type != c.user_type`,
    },
];

async function reportMisclassified(target, branchId) {
    const [[txnStaffCa]] = await target.query(
        `SELECT COUNT(*) AS cnt
         FROM transactions t
         INNER JOIN clients c ON c.username = t.party1_id AND c.branch_id = t.branch_id
         WHERE t.branch_id = ? AND c.user_type = 'ca' AND t.party1_type = 'staff'`,
        [branchId]
    );
    const [[txnStaffCaP2]] = await target.query(
        `SELECT COUNT(*) AS cnt
         FROM transactions t
         INNER JOIN clients c ON c.username = t.party2_id AND c.branch_id = t.branch_id
         WHERE t.branch_id = ? AND c.user_type = 'ca' AND t.party2_type = 'staff'`,
        [branchId]
    );
    console.log(`  Remaining CA rows as staff (party1): ${txnStaffCa?.cnt ?? 0}`);
    console.log(`  Remaining CA rows as staff (party2): ${txnStaffCaP2?.cnt ?? 0}`);
}

async function main() {
    const branchId = NEW_BRANCH_ID;
    const target = getTargetPool();

    console.log(`Fixing party types for branch ${branchId} using clients.user_type`);

    try {
        const [cas] = await target.query(
            `SELECT username, user_type FROM clients
             WHERE branch_id = ? AND user_type IN ('client', 'ca', 'agent')`,
            [branchId]
        );
        const caCount = cas.filter((r) => r.user_type === "ca").length;
        const agentCount = cas.filter((r) => r.user_type === "agent").length;
        console.log(`Person parties in clients: ${cas.length} (ca=${caCount}, agent=${agentCount})`);

        console.log("\nBefore repair:");
        await reportMisclassified(target, branchId);

        let totalFixed = 0;
        for (const step of REPAIR_STEPS) {
            const [result] = await target.query(step.sql, [branchId]);
            const affected = result.affectedRows || 0;
            totalFixed += affected;
            console.log(`  ${step.label}: ${affected} rows updated`);
        }

        console.log(`\nTotal rows updated: ${totalFixed}`);
        console.log("\nAfter repair:");
        await reportMisclassified(target, branchId);
        console.log("\nParty type repair complete.");
    } finally {
        await closePools();
    }
}

main().catch((err) => {
    console.error("Party type repair failed:", err);
    process.exit(1);
});
