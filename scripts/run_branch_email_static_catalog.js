import pool from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ensureBranchStaticCatalog } from "../helpers/emailStaticTemplateTypes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260907_branch_email_static_catalog.sql"
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
        try {
            const [result] = await pool.query(statement);
            console.log("OK", statement.slice(0, 70).replace(/\s+/g, " "), "→", result?.affectedRows ?? "done");
        } catch (error) {
            if (error.code === "ER_DUP_KEYNAME" || error.errno === 1061) {
                console.log("Index already exists, skipping unique key");
                continue;
            }
            throw error;
        }
    }

    let branches = [];
    try {
        const [rows] = await pool.query(
            `SELECT DISTINCT branch_id FROM (
                SELECT branch_id FROM branch_list WHERE is_deleted = '0'
                UNION
                SELECT branch_id FROM email_static_templates
                UNION
                SELECT branch_id FROM email_configs
             ) b
             WHERE branch_id IS NOT NULL AND TRIM(branch_id) <> ''`
        );
        branches = rows;
    } catch {
        const [rows] = await pool.query(
            `SELECT DISTINCT branch_id FROM email_static_templates
             UNION
             SELECT DISTINCT branch_id FROM email_configs`
        );
        branches = rows;
    }

    for (const row of branches) {
        const seeded = await ensureBranchStaticCatalog(row.branch_id, "migration");
        console.log(`Catalog ready for ${row.branch_id}: ${seeded.length} types`);
    }

    const [rows] = await pool.query(
        `SELECT branch_id, template_type, status, COUNT(*) AS n
         FROM email_static_templates
         GROUP BY branch_id, template_type, status
         ORDER BY branch_id, template_type`
    );
    console.table(rows);
    process.exit(0);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
