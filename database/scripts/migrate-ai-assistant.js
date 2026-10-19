import "dotenv/config";
import pool from "../../db.js";
import { ensureAiTables } from "../../ai/schema.js";

// Optional: the API creates these tables on first use. Applies ONLY the AI tables
// (database/migrate.js replays every .sql file).
try {
    await ensureAiTables(pool);
    console.log("Verified AI assistant tables.");
} catch (error) {
    console.error("Failed to create AI assistant tables:", error?.code || error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
