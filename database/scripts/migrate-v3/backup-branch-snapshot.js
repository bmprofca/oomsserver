import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import { NEW_BRANCH_ID } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TABLES = [
    "clients",
    "firms",
    "tasks",
    "transactions",
    "invoice",
    "branch_mapping",
    "attendance",
    "documents",
    "sale_entries",
    "purchase_entries",
    "purchase_items",
    "expense_entries",
];

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    const snapshot = {
        branch_id: NEW_BRANCH_ID,
        database: process.env.DB_NAME,
        host: process.env.DB_HOST,
        captured_at: new Date().toISOString(),
        note: "Row-count snapshot after migration. Take a full DB backup via hosting panel before go-live.",
        counts: {},
    };

    for (const table of TABLES) {
        const [rows] = await pool.query(`SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE branch_id = ?`, [NEW_BRANCH_ID]);
        snapshot.counts[table] = Number(rows[0].cnt);
    }

    const outDir = path.join(__dirname, "..", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `branch-${NEW_BRANCH_ID}-snapshot.json`);
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`Snapshot saved: ${outPath}`);
    console.log(JSON.stringify(snapshot.counts, null, 2));
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
