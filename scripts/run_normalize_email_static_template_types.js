import pool from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260907_normalize_email_static_template_types.sql"
);

async function main() {
    let sql = fs.readFileSync(sqlPath, "utf8");
    sql = sql
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");

    const statements = sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);

    for (const statement of statements) {
        const [result] = await pool.query(statement);
        console.log("Updated rows:", result?.affectedRows);
    }

    const [rows] = await pool.query(
        "SELECT template_type, COUNT(*) AS n FROM email_static_templates GROUP BY template_type ORDER BY template_type"
    );
    console.table(rows);
    process.exit(0);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
