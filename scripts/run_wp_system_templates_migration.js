/**
 * Create wp_system_templates and seed from helpers/wpSystemTemplateSeedData.json
 * Usage: node scripts/run_wp_system_templates_migration.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { seedSystemTemplatesFromFile } from "../services/wpSystemTemplateService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260911_wp_system_templates.sql"
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
        await pool.query(statement);
    }
    console.log("Migration OK: wp_system_templates created");

    const result = await seedSystemTemplatesFromFile({ username: "migration" });
    console.log("Seed result:", result);
    process.exit(0);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
