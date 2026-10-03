import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.resolve(
    __dirname,
    "../migrations/20261003_livekit_call_settings.sql"
);

try {
    const migration = await fs.readFile(migrationPath, "utf8");
    const statement = migration
        .replace(/--.*$/gm, "")
        .trim()
        .replace(/;+\s*$/, "");

    if (!/^CREATE TABLE IF NOT EXISTS `in_app_voice_call_settings`/i.test(statement)) {
        throw new Error("Unexpected SQL in the LiveKit settings migration");
    }

    await pool.query(statement);
    const [rows] = await pool.query(
        `SELECT TABLE_NAME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'in_app_voice_call_settings'
         LIMIT 1`
    );
    if (!rows.length) {
        throw new Error("The database did not report the LiveKit settings table");
    }

    console.log(
        `Verified in_app_voice_call_settings exists in database ${process.env.DB_NAME}`
    );
} catch (error) {
    console.error("Failed to create/verify in_app_voice_call_settings:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
