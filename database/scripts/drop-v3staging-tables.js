/**
 * Drop leftover v3 migration staging tables (v3staging_*).
 *
 * Run from SERVER/:
 *   node database/scripts/drop-v3staging-tables.js
 */
import "dotenv/config";
import pool from "../../db.js";

const PREFIX = "v3staging";

async function main() {
    const conn = await pool.getConnection();
    try {
        const dbName = process.env.DB_NAME;
        console.log(`Database: ${dbName}`);
        console.log(`Looking for tables starting with "${PREFIX}"...\n`);

        const [tables] = await conn.query(
            `SELECT TABLE_NAME AS name
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME LIKE ?
             ORDER BY TABLE_NAME`,
            [dbName, `${PREFIX}%`],
        );

        if (!tables.length) {
            console.log("No matching tables found.");
            return;
        }

        console.log(`Found ${tables.length} table(s):`);
        for (const t of tables) {
            console.log(`  - ${t.name}`);
        }
        console.log("");

        await conn.query("SET FOREIGN_KEY_CHECKS = 0");

        let dropped = 0;
        for (const t of tables) {
            const name = String(t.name || "");
            if (!name.toLowerCase().startsWith(PREFIX.toLowerCase())) {
                console.warn(`SKIP (unexpected name): ${name}`);
                continue;
            }

            await conn.query(`DROP TABLE IF EXISTS \`${name.replace(/`/g, "``")}\``);
            dropped += 1;
            console.log(`  dropped: ${name}`);
        }

        await conn.query("SET FOREIGN_KEY_CHECKS = 1");

        const [remaining] = await conn.query(
            `SELECT TABLE_NAME AS name
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME LIKE ?`,
            [dbName, `${PREFIX}%`],
        );

        console.log(`\nDone. Dropped ${dropped}. Remaining matching tables: ${remaining.length}`);
        if (remaining.length) {
            for (const r of remaining) {
                console.log(`  still present: ${r.name}`);
            }
        }
    } finally {
        conn.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
