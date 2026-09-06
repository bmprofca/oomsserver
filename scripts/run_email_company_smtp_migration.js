/**
 * One-off: create email_company_smtp_config for platform mail.
 * Usage: node scripts/run_email_company_smtp_migration.js
 */
import pool from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260906_email_company_smtp_config.sql"
);

async function main() {
    let sql = fs.readFileSync(sqlPath, "utf8");
    // Strip SQL line comments before splitting statements.
    sql = sql
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");

    const statements = sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);

    for (const statement of statements) {
        await pool.query(statement);
    }
    console.log("Migration OK: email_company_smtp_config created");
    process.exit(0);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
