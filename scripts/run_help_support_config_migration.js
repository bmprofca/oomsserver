/**
 * Ensure help_support_platform_config exists.
 * Usage: node scripts/run_help_support_config_migration.js
 */
import { ensureHelpSupportConfigTable } from "../helpers/helpSupportConfig.js";
import pool from "../db.js";

async function main() {
    await ensureHelpSupportConfigTable();
    console.log("help_support_platform_config ready");
    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
