/**
 * Drop agent assignment columns / agent_margin on the connected DB (.env).
 * Idempotent: skips missing table/columns.
 *
 * Run from SERVER/:
 *   node database/scripts/drop-agent-assignment-columns.js
 */
import "dotenv/config";
import pool from "../../db.js";

const DROPS = [
    { table: "tasks", columns: ["has_agent", "agent_id", "agent_billing_type", "agent_percentage"] },
    { table: "compliance_firms", columns: ["agent"] },
    { table: "clients", columns: ["agent"] },
    { table: "service_requests", columns: ["agent"] },
];

async function tableExists(conn, table) {
    const [rows] = await conn.query(
        `SELECT 1 AS ok
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
         LIMIT 1`,
        [table]
    );
    return rows.length > 0;
}

async function columnExists(conn, table, column) {
    const [rows] = await conn.query(
        `SELECT 1 AS ok
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?
         LIMIT 1`,
        [table, column]
    );
    return rows.length > 0;
}

async function main() {
    const conn = await pool.getConnection();
    const [[dbRow]] = await conn.query("SELECT DATABASE() AS db");
    console.log(`Connected database: ${dbRow?.db || "(unknown)"}`);

    const dropped = [];
    const skipped = [];

    try {
        if (await tableExists(conn, "agent_margin")) {
            await conn.query("DROP TABLE `agent_margin`");
            dropped.push("agent_margin (table)");
            console.log("drop  table agent_margin");
        } else {
            skipped.push("agent_margin (table)");
            console.log("skip  table agent_margin (missing)");
        }

        for (const { table, columns } of DROPS) {
            if (!(await tableExists(conn, table))) {
                skipped.push(`${table}.*`);
                console.log(`skip  ${table} (table missing)`);
                continue;
            }
            for (const column of columns) {
                if (!(await columnExists(conn, table, column))) {
                    skipped.push(`${table}.${column}`);
                    console.log(`skip  ${table}.${column} (missing)`);
                    continue;
                }
                await conn.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
                dropped.push(`${table}.${column}`);
                console.log(`drop  ${table}.${column}`);
            }
        }

        console.log("\nDone.");
        console.log(`Dropped: ${dropped.length}`);
        console.log(`Skipped: ${skipped.length}`);
        if (dropped.length) {
            console.log("Dropped items:");
            dropped.forEach((item) => console.log(`  - ${item}`));
        }
    } finally {
        conn.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
});
