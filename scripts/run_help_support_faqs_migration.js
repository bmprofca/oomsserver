/**
 * Ensure help_support_platform_config + help_support_faqs exist.
 * Usage: node scripts/run_help_support_faqs_migration.js
 */
import { ensureHelpSupportConfigTable } from "../helpers/helpSupportConfig.js";
import {
    ensureHelpSupportFaqsTable,
    ensureHelpSupportIntroTextColumn,
    seedDefaultFaqsIfEmpty,
} from "../helpers/helpSupportFaqs.js";
import pool from "../db.js";

async function main() {
    await ensureHelpSupportConfigTable();
    await ensureHelpSupportIntroTextColumn();
    await ensureHelpSupportFaqsTable();
    await seedDefaultFaqsIfEmpty("system");
    console.log("help_support config + faqs ready (defaults seeded if empty)");
    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
