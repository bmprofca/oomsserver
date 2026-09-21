/**
 * Rename wallet/razorpay purpose columns to remark.
 * Usage: node scripts/run_wallet_purpose_to_remark_migration.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260921_wallet_purpose_to_remark.sql"
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
    for (const statement of splitStatements(raw)) {
        console.log("Running:", statement.slice(0, 90).replace(/\s+/g, " "), "…");
        try {
            await pool.query(statement);
        } catch (error) {
            // Ignore if already renamed
            if (
                error?.code === "ER_BAD_FIELD_ERROR" ||
                String(error?.message || "").includes("Unknown column 'purpose'")
            ) {
                console.warn("Skip (already migrated?):", error.message);
                continue;
            }
            throw error;
        }
    }
    console.log("wallet purpose→remark migration complete");
    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
