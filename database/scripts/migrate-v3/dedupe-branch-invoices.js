import "dotenv/config";
import mysql from "mysql2/promise";
import { NEW_BRANCH_ID } from "./config.js";

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

async function main() {
    const [before] = await pool.query(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT invoice_id) AS distinct_ids
         FROM invoice WHERE branch_id = ?`,
        [NEW_BRANCH_ID]
    );
    console.log("Before:", before[0]);

    const [result] = await pool.query(
        `DELETE i1 FROM invoice i1
         INNER JOIN invoice i2
           ON i1.invoice_id = i2.invoice_id
          AND i1.branch_id = i2.branch_id
          AND i1.id > i2.id
         WHERE i1.branch_id = ?`,
        [NEW_BRANCH_ID]
    );
    console.log("Removed duplicate rows:", result.affectedRows);

    const [after] = await pool.query(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT invoice_id) AS distinct_ids
         FROM invoice WHERE branch_id = ?`,
        [NEW_BRANCH_ID]
    );
    console.log("After:", after[0]);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
