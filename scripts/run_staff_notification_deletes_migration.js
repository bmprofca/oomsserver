/**
 * Create staff_notification_deletes for header notification delete/hide.
 * Usage: node scripts/run_staff_notification_deletes_migration.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260921_staff_notification_deletes.sql"
);

function splitStatements(sql) {
    const withoutLineComments = String(sql || "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
    return withoutLineComments
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
}

async function main() {
    const raw = fs.readFileSync(sqlPath, "utf8");
    const statements = splitStatements(raw);

    for (const statement of statements) {
        console.log("Running:", statement.slice(0, 80).replace(/\s+/g, " "), "…");
        await pool.query(statement);
    }

    console.log("staff_notification_deletes migration complete");
    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
