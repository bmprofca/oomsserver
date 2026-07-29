/**
 * Drop attendance feature tables (`attendance`, `attendance_break`).
 *
 * Run from SERVER/:
 *   node database/scripts/drop-attendance-tables.js
 */
import "dotenv/config";
import pool from "../../db.js";

const TABLES = ["attendance_break", "attendance"];

async function main() {
    const conn = await pool.getConnection();
    try {
        const dbName = process.env.DB_NAME;
        console.log(`Database: ${dbName}`);
        console.log("Dropping attendance tables...\n");

        await conn.query("SET FOREIGN_KEY_CHECKS = 0");

        for (const name of TABLES) {
            const [exists] = await conn.query(
                `SELECT TABLE_NAME AS name
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ?
                   AND TABLE_NAME = ?
                 LIMIT 1`,
                [dbName, name]
            );

            if (!exists.length) {
                console.log(`  skip (not found): ${name}`);
                continue;
            }

            await conn.query(`DROP TABLE IF EXISTS \`${name.replace(/`/g, "``")}\``);
            console.log(`  dropped: ${name}`);
        }

        await conn.query("SET FOREIGN_KEY_CHECKS = 1");

        const [remaining] = await conn.query(
            `SELECT TABLE_NAME AS name
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME IN (?, ?)`,
            [dbName, "attendance", "attendance_break"]
        );

        console.log(`\nDone. Remaining attendance tables: ${remaining.length}`);
        for (const row of remaining) {
            console.log(`  still present: ${row.name}`);
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
