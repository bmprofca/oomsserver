/**
 * Add performance indexes for task list, reports, invoices, transactions, etc.
 *
 * Safe / idempotent: skips indexes that already exist.
 *
 * Run from SERVER/:
 *   node database/scripts/add-performance-indexes.js
 */
import "dotenv/config";
import pool from "../../db.js";

/**
 * @type {{ table: string, name: string, columns: string, unique?: boolean }[]}
 */
const INDEXES = [
    // ── tasks (list + reports + detail lookups) ─────────────────────
    { table: "tasks", name: "idx_tasks_task_id", columns: "(task_id)" },
    { table: "tasks", name: "idx_tasks_branch_task", columns: "(branch_id, task_id)" },
    { table: "tasks", name: "idx_tasks_branch_created", columns: "(branch_id, create_date, id)" },
    { table: "tasks", name: "idx_tasks_branch_status_due", columns: "(branch_id, status, due_date)" },
    { table: "tasks", name: "idx_tasks_branch_service", columns: "(branch_id, service_id)" },
    { table: "tasks", name: "idx_tasks_branch_firm", columns: "(branch_id, firm_id)" },
    { table: "tasks", name: "idx_tasks_branch_username", columns: "(branch_id, username)" },
    { table: "tasks", name: "idx_tasks_branch_billing", columns: "(branch_id, billing_status, status)" },
    { table: "tasks", name: "idx_tasks_invoice", columns: "(invoice_id)" },

    // ── task_staffs (staffwise summary + assignment joins) ───────────
    { table: "task_staffs", name: "idx_task_staffs_branch_user", columns: "(branch_id, username, is_deleted)" },
    { table: "task_staffs", name: "idx_task_staffs_task", columns: "(task_id, branch_id, is_deleted)" },
    { table: "task_staffs", name: "idx_task_staffs_assign", columns: "(assign_id)" },

    // ── invoice / billing ───────────────────────────────────────────
    { table: "invoice", name: "idx_invoice_invoice_id", columns: "(invoice_id)" },
    { table: "invoice", name: "idx_invoice_branch_invoice", columns: "(branch_id, invoice_id)" },
    { table: "invoice", name: "idx_invoice_branch_created", columns: "(branch_id, create_date)" },
    { table: "invoice", name: "idx_invoice_branch_type_created", columns: "(branch_id, type, create_date)" },

    // ── transactions (ledger / dashboard / reports) ──────────────────
    { table: "transactions", name: "idx_txn_branch_date", columns: "(branch_id, transaction_date)" },
    { table: "transactions", name: "idx_txn_branch_invoice", columns: "(branch_id, invoice_id)" },
    { table: "transactions", name: "idx_txn_branch_txnid", columns: "(branch_id, transaction_id)" },
    { table: "transactions", name: "idx_txn_branch_type_date", columns: "(branch_id, transaction_type, transaction_date)" },
    { table: "transactions", name: "idx_txn_party1", columns: "(branch_id, party1_type, party1_id, transaction_date)" },
    { table: "transactions", name: "idx_txn_party2", columns: "(branch_id, party2_type, party2_id, transaction_date)" },

    // ── sale entries / items ────────────────────────────────────────
    { table: "sale_entries", name: "idx_sale_entries_branch_invoice", columns: "(branch_id, invoice_id)" },
    { table: "sale_entries", name: "idx_sale_entries_invoice", columns: "(invoice_id)" },
    { table: "sale_entries", name: "idx_sale_entries_sale", columns: "(sale_id)" },
    { table: "sale_entries", name: "idx_sale_entries_branch_firm", columns: "(branch_id, firm_id)" },
    { table: "sale_items", name: "idx_sale_items_branch_invoice", columns: "(branch_id, invoice_id)" },
    { table: "sale_items", name: "idx_sale_items_invoice", columns: "(invoice_id)" },
    { table: "sale_items", name: "idx_sale_items_sale", columns: "(sale_id)" },

    // ── branch_services ─────────────────────────────────────────────
    { table: "branch_services", name: "idx_branch_services_lookup", columns: "(branch_id, service_id, is_deleted)" },

    // ── compliance ──────────────────────────────────────────────────
    { table: "compliance_schedules", name: "idx_cs_assignment_status_due", columns: "(assignment_id, status, due_date)" },
    { table: "compliance_schedules", name: "idx_cs_due_status", columns: "(due_date, status)" },
    { table: "compliance_schedules", name: "idx_cs_invoice", columns: "(invoice_id)" },
    { table: "compliance_assignments", name: "idx_ca_service", columns: "(service_id)" },
    { table: "compliance_assignments", name: "idx_ca_employee", columns: "(employee_username)" },
    { table: "compliance_firms", name: "idx_cf_branch_service", columns: "(branch_id(64), service_id(64), is_deleted)" },
    { table: "compliance_firms", name: "idx_cf_branch_firm", columns: "(branch_id(64), firm_id(64), is_deleted)" },

    // ── notes / subtask ─────────────────────────────────────────────
    { table: "notes", name: "idx_notes_note_id", columns: "(note_id)" },
    { table: "notes", name: "idx_notes_task", columns: "(task_id, note_type, is_deleted)" },
    { table: "notes", name: "idx_notes_branch_task", columns: "(branch_id, note_type, task_id, is_deleted)" },
    { table: "subtask", name: "idx_subtask_id", columns: "(subtask_id)" },
    { table: "subtask", name: "idx_subtask_task", columns: "(task_id, branch_id, is_deleted)" },
    { table: "subtask", name: "idx_subtask_branch_task", columns: "(branch_id, task_id, is_deleted)" },

    // ── auth / staff mapping / profile ──────────────────────────────
    { table: "branch_mapping", name: "idx_bm_branch_user", columns: "(branch_id, username, is_deleted)" },
    { table: "branch_mapping", name: "idx_bm_branch_active", columns: "(branch_id, is_deleted, status, is_accepted)" },
    { table: "branch_mapping", name: "idx_bm_username", columns: "(username, branch_id)" },
    { table: "profile", name: "idx_profile_username", columns: "(username)" },
    { table: "profile", name: "idx_profile_type_status", columns: "(user_type, status)" },
];

async function tableExists(conn, tableName) {
    const [rows] = await conn.query("SHOW TABLES LIKE ?", [tableName]);
    return rows.length > 0;
}

async function indexExists(conn, schema, tableName, indexName) {
    const [rows] = await conn.query(
        `SELECT 1
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND INDEX_NAME = ?
         LIMIT 1`,
        [schema, tableName, indexName],
    );
    return rows.length > 0;
}

async function main() {
    const schema = process.env.DB_NAME;
    const conn = await pool.getConnection();
    let created = 0;
    let skipped = 0;
    let failed = 0;

    console.log(`Database: ${schema}`);
    console.log(`Planning ${INDEXES.length} indexes...\n`);

    try {
        for (const spec of INDEXES) {
            if (!(await tableExists(conn, spec.table))) {
                console.log(`SKIP  ${spec.name} (table ${spec.table} missing)`);
                skipped += 1;
                continue;
            }

            if (await indexExists(conn, schema, spec.table, spec.name)) {
                console.log(`SKIP  ${spec.table}.${spec.name} (exists)`);
                skipped += 1;
                continue;
            }

            const unique = spec.unique ? "UNIQUE " : "";
            const sql = `ALTER TABLE \`${spec.table}\` ADD ${unique}INDEX \`${spec.name}\` ${spec.columns}`;

            try {
                const started = Date.now();
                await conn.query(sql);
                const ms = Date.now() - started;
                console.log(`OK    ${spec.table}.${spec.name} ${spec.columns} (${ms}ms)`);
                created += 1;
            } catch (err) {
                failed += 1;
                console.error(`FAIL  ${spec.table}.${spec.name}: ${err.message}`);
            }
        }
    } finally {
        conn.release();
        await pool.end();
    }

    console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
