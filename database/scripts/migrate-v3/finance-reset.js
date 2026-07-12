import "dotenv/config";
import mysql from "mysql2/promise";
import { NEW_BRANCH_ID } from "./config.js";

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

async function main() {
    const branchId = NEW_BRANCH_ID;
    console.log(`Finance reset for branch ${branchId}`);

    const steps = [
        {
            label: "purchase_items",
            sql: `DELETE FROM purchase_items WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "purchase_entries",
            sql: `DELETE FROM purchase_entries WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "sale_items",
            sql: `DELETE FROM sale_items WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "sale_entries",
            sql: `DELETE FROM sale_entries WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "expense_entries_items",
            sql: `DELETE FROM expense_entries_items WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "expense_entries",
            sql: `DELETE FROM expense_entries WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "journal_entries",
            sql: `DELETE FROM journal_entries WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "contra_entries",
            sql: `DELETE FROM contra_entries WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "transactions",
            sql: `DELETE FROM transactions WHERE branch_id = ?`,
            params: [branchId],
        },
        {
            label: "invoice",
            sql: `DELETE FROM invoice WHERE branch_id = ?`,
            params: [branchId],
        },
    ];

    for (const step of steps) {
        const [result] = await pool.query(step.sql, step.params);
        console.log(`  ${step.label}: ${result.affectedRows} rows deleted`);
    }

    console.log("Finance reset complete.");
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
