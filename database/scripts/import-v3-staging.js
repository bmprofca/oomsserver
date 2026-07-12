import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_SQL_DUMP, STAGING_TABLE_PREFIX } from "./migrate-v3/config.js";
import { getRootConnection } from "./migrate-v3/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const args = { dump: DEFAULT_SQL_DUMP, force: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--dump" && argv[i + 1]) args.dump = path.resolve(argv[++i]);
        if (argv[i] === "--force") args.force = true;
    }
    return args;
}

function transformSqlForStaging(sql, prefix) {
    let out = sql;
    out = out.replace(/CREATE TABLE `([^`]+)`/g, (_, table) => `CREATE TABLE \`${prefix}${table}\``);
    out = out.replace(/INSERT INTO `([^`]+)`/g, (_, table) => `INSERT INTO \`${prefix}${table}\``);
    out = out.replace(/ALTER TABLE `([^`]+)`/g, (_, table) => `ALTER TABLE \`${prefix}${table}\``);
    out = out.replace(/REFERENCES `([^`]+)`/g, (_, table) => `REFERENCES \`${prefix}${table}\``);
    return out;
}

async function dropStagingTables(conn, prefix) {
    const [tables] = await conn.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name LIKE ?`,
        [`${prefix}%`]
    );
    if (!tables.length) return 0;
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const row of tables) {
        const tableName = row.TABLE_NAME || row.table_name;
        await conn.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    return tables.length;
}

async function main() {
    const { dump, force } = parseArgs(process.argv);
    if (!fs.existsSync(dump)) {
        console.error(`SQL dump not found: ${dump}`);
        process.exit(1);
    }

    const targetDb = process.env.DB_NAME;
    console.log(`Importing ${dump} into "${targetDb}" with table prefix "${STAGING_TABLE_PREFIX}"...`);

    const conn = await getRootConnection();
    try {
        await conn.changeUser({ database: targetDb });

        const [existing] = await conn.query(
            `SELECT COUNT(*) AS cnt FROM information_schema.tables
             WHERE table_schema = ? AND table_name LIKE ?`,
            [targetDb, `${STAGING_TABLE_PREFIX}%`]
        );

        if (Number(existing[0]?.cnt) > 0 && !force) {
            console.log(
                `Found ${existing[0].cnt} staging tables (${STAGING_TABLE_PREFIX}*). Use --force to recreate.`
            );
            return;
        }

        if (force) {
            const dropped = await dropStagingTables(conn, STAGING_TABLE_PREFIX);
            console.log(`Dropped ${dropped} existing staging tables.`);
        }

        const rawSql = fs.readFileSync(dump, "utf8");
        const sql = transformSqlForStaging(rawSql, STAGING_TABLE_PREFIX);
        console.log(`Executing SQL (${(sql.length / 1024 / 1024).toFixed(1)} MB)...`);
        await conn.query({ sql, timeout: 0 });

        const [countRows] = await conn.query(
            `SELECT COUNT(*) AS cnt FROM information_schema.tables
             WHERE table_schema = ? AND table_name LIKE ?`,
            [targetDb, `${STAGING_TABLE_PREFIX}%`]
        );
        console.log(`Import complete. Staging tables: ${countRows[0].cnt}`);
    } finally {
        await conn.end();
    }
}

main().catch((err) => {
    console.error("Staging import failed:", err);
    process.exit(1);
});
