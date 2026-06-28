import "dotenv/config";
import pool from "../db.js";

async function truncateAllTables() {
    const conn = await pool.getConnection();

    try {
        const dbName = process.env.DB_NAME;
        const [tables] = await conn.query(
            `SELECT TABLE_NAME AS name
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
               AND TABLE_TYPE = 'BASE TABLE'`,
            [dbName]
        );

        if (!tables.length) {
            console.log("No tables found.");
            return;
        }

        console.log(`Database: ${dbName}`);
        console.log(`Truncating ${tables.length} table(s)...`);

        await conn.query("SET FOREIGN_KEY_CHECKS = 0");

        for (const { name } of tables) {
            await conn.query(`TRUNCATE TABLE \`${name}\``);
            console.log(`  cleared: ${name}`);
        }

        await conn.query("SET FOREIGN_KEY_CHECKS = 1");
        console.log("Done. All tables are empty.");
    } finally {
        conn.release();
        await pool.end();
    }
}

truncateAllTables().catch((err) => {
    console.error("Failed to truncate tables:", err.message);
    process.exit(1);
});
