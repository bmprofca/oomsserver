/**
 * Create OOMS System SMS tables and campaign channel_source columns.
 * Usage: node scripts/run_sms_system_channel_migration.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260914_sms_system_channel.sql"
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

async function columnExists(table, column) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [table, column]
    );
    return Number(rows[0]?.cnt) > 0;
}

async function main() {
    const raw = fs.readFileSync(sqlPath, "utf8");
    const statements = splitStatements(raw);

    for (const statement of statements) {
        const isAlterCampaigns =
            /ALTER TABLE\s+`?sms_fast2sms_campaigns`?/i.test(statement) &&
            /channel_source/i.test(statement);
        const isAlterSchedules =
            /ALTER TABLE\s+`?sms_fast2sms_campaign_schedules`?/i.test(statement) &&
            /channel_source/i.test(statement);

        if (isAlterCampaigns && (await columnExists("sms_fast2sms_campaigns", "channel_source"))) {
            console.log("Skip: sms_fast2sms_campaigns.channel_source already exists");
            continue;
        }
        if (
            isAlterSchedules &&
            (await columnExists("sms_fast2sms_campaign_schedules", "channel_source"))
        ) {
            console.log("Skip: sms_fast2sms_campaign_schedules.channel_source already exists");
            continue;
        }

        await pool.query(statement);
        console.log("OK:", statement.slice(0, 72).replace(/\s+/g, " ") + "…");
    }

    console.log("Migration OK: OOMS System SMS channel");
    process.exit(0);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
