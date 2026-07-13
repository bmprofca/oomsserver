/**
 * Rename opaque APP2025_BRN2025_* service IDs to readable slugs.
 *
 * Usage:
 *   node database/scripts/rename-service-ids.js           # dry-run (default)
 *   node database/scripts/rename-service-ids.js --apply   # execute migration
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = path.join(__dirname, "../migrations/20260713_service_id_slug_mapping.json");
const APPLY = process.argv.includes("--apply");

const CHILD_TABLES = [
    "branch_services",
    "tasks",
    "subtask",
    "task_details",
    "sale_items",
    "quotation_items",
    "purchase_items",
    "compliance_assignments",
    "compliance_firms",
    "service_requests",
    "agent_margin",
];

function loadMapping() {
    const raw = fs.readFileSync(MAPPING_PATH, "utf8");
    const mapping = JSON.parse(raw);
    if (!Array.isArray(mapping) || mapping.length === 0) {
        throw new Error("Mapping file is empty or invalid");
    }
    return mapping;
}

async function tableExists(conn, tableName) {
    const [rows] = await conn.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ?
         LIMIT 1`,
        [tableName]
    );
    return rows.length > 0;
}

async function countOpaqueRefs(conn, tableName) {
    if (!(await tableExists(conn, tableName))) {
        return null;
    }
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS c FROM \`${tableName}\` WHERE service_id LIKE 'APP2025_%'`
    );
    return Number(rows[0]?.c || 0);
}

async function preflight(conn, mapping) {
    const errors = [];
    const newIds = new Set();
    const oldIds = new Set();

    for (const entry of mapping) {
        if (!entry.old_service_id || !entry.new_service_id) {
            errors.push(`Invalid mapping entry: ${JSON.stringify(entry)}`);
            continue;
        }
        if (newIds.has(entry.new_service_id)) {
            errors.push(`Duplicate new_service_id in mapping: ${entry.new_service_id}`);
        }
        if (oldIds.has(entry.old_service_id)) {
            errors.push(`Duplicate old_service_id in mapping: ${entry.old_service_id}`);
        }
        newIds.add(entry.new_service_id);
        oldIds.add(entry.old_service_id);
    }

    for (const entry of mapping) {
        const [rows] = await conn.query(
            "SELECT service_id FROM services WHERE service_id = ? LIMIT 1",
            [entry.old_service_id]
        );
        if (!rows.length) {
            errors.push(`Old service_id not found in services: ${entry.old_service_id} (${entry.name})`);
        }
    }

    for (const newId of newIds) {
        const [rows] = await conn.query(
            "SELECT service_id FROM services WHERE service_id = ? AND service_id NOT LIKE 'APP2025_%' LIMIT 1",
            [newId]
        );
        if (rows.length) {
            errors.push(`New service_id already exists (non-APP id): ${newId}`);
        }
    }

    if (errors.length) {
        throw new Error(`Pre-flight failed:\n${errors.join("\n")}`);
    }

    console.log(`Pre-flight OK: ${mapping.length} mappings validated`);
}

async function renameOne(conn, oldId, newId, name, dryRun) {
    const stats = { oldId, newId, name, tables: {} };

    for (const table of CHILD_TABLES) {
        if (!(await tableExists(conn, table))) {
            stats.tables[table] = { skipped: true };
            continue;
        }
        if (dryRun) {
            const count = await countOpaqueRefsForId(conn, table, oldId);
            stats.tables[table] = { wouldUpdate: count };
        } else {
            const [result] = await conn.query(
                `UPDATE \`${table}\` SET service_id = ? WHERE service_id = ?`,
                [newId, oldId]
            );
            stats.tables[table] = { updated: result.affectedRows };
        }
    }

    if (dryRun) {
        stats.tables.services = { wouldUpdate: 1 };
    } else {
        const [result] = await conn.query(
            "UPDATE services SET service_id = ? WHERE service_id = ?",
            [newId, oldId]
        );
        stats.tables.services = { updated: result.affectedRows };
        if (result.affectedRows !== 1) {
            throw new Error(`Expected 1 services row updated for ${oldId}, got ${result.affectedRows}`);
        }
    }

    return stats;
}

async function countOpaqueRefsForId(conn, tableName, serviceId) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS c FROM \`${tableName}\` WHERE service_id = ?`,
        [serviceId]
    );
    return Number(rows[0]?.c || 0);
}

async function postflight(conn) {
    const errors = [];
    const tables = [...CHILD_TABLES, "services"];

    for (const table of tables) {
        const count = await countOpaqueRefs(conn, table);
        if (count === null) continue;
        if (count > 0) {
            errors.push(`${table}: ${count} APP2025_% references remain`);
        } else {
            console.log(`  ${table}: 0 opaque refs`);
        }
    }

    if (errors.length) {
        throw new Error(`Post-flight failed:\n${errors.join("\n")}`);
    }

    const [svcCount] = await conn.query("SELECT COUNT(*) AS c FROM services");
    console.log(`  services total: ${svcCount[0].c}`);
}

async function main() {
    const mapping = loadMapping();
    const conn = await pool.getConnection();

    try {
        console.log(APPLY ? "=== APPLY MODE ===" : "=== DRY RUN ===");
        await preflight(conn, mapping);

        if (!APPLY) {
            let totalWouldUpdate = 0;
            for (const entry of mapping) {
                const stats = await renameOne(conn, entry.old_service_id, entry.new_service_id, entry.name, true);
                const rowTotal = Object.values(stats.tables).reduce(
                    (sum, t) => sum + (t.wouldUpdate || 0),
                    0
                );
                totalWouldUpdate += rowTotal;
                if (rowTotal > 0) {
                    console.log(`  ${entry.old_service_id} -> ${entry.new_service_id}: ${rowTotal} rows`);
                }
            }
            console.log(`\nDry run complete. ${totalWouldUpdate} total rows would be updated.`);
            console.log("Run with --apply to execute.");
            return;
        }

        await conn.beginTransaction();

        const allStats = [];
        for (const entry of mapping) {
            const stats = await renameOne(
                conn,
                entry.old_service_id,
                entry.new_service_id,
                entry.name,
                false
            );
            allStats.push(stats);
            console.log(`Renamed: ${entry.name} -> ${entry.new_service_id}`);
        }

        await postflight(conn);
        await conn.commit();

        console.log("\nMigration completed successfully.");
        const summary = allStats.reduce((acc, s) => {
            for (const [table, info] of Object.entries(s.tables)) {
                acc[table] = (acc[table] || 0) + (info.updated || 0);
            }
            return acc;
        }, {});
        console.log("Summary by table:", summary);
    } catch (err) {
        if (APPLY) {
            try {
                await conn.rollback();
                console.error("Transaction rolled back.");
            } catch {
                // ignore
            }
        }
        console.error(err.message || err);
        process.exitCode = 1;
    } finally {
        conn.release();
        await pool.end();
    }
}

main();
