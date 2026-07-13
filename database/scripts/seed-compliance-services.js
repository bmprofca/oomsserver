/**
 * Seed active compliance services and bootstrap branch_services.
 *
 * Usage:
 *   node database/scripts/seed-compliance-services.js           # dry-run
 *   node database/scripts/seed-compliance-services.js --apply   # execute
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = path.join(__dirname, "../migrations/20260713_compliance_service_mapping.json");
const APPLY = process.argv.includes("--apply");

function loadMapping() {
    const raw = fs.readFileSync(MAPPING_PATH, "utf8");
    const mapping = JSON.parse(raw);
    if (!Array.isArray(mapping) || mapping.length === 0) {
        throw new Error("Mapping file is empty or invalid");
    }
    return mapping;
}

async function preflight(conn, mapping) {
    const errors = [];
    const newIds = new Set();

    for (const entry of mapping) {
        if (newIds.has(entry.compliance_service_id)) {
            errors.push(`Duplicate compliance_service_id in mapping: ${entry.compliance_service_id}`);
        }
        newIds.add(entry.compliance_service_id);

        const [existingNew] = await conn.query(
            "SELECT service_id FROM services WHERE service_id = ? LIMIT 1",
            [entry.compliance_service_id]
        );
        if (existingNew.length) {
            errors.push(`compliance_service_id already exists: ${entry.compliance_service_id}`);
        }

        const [source] = await conn.query(
            "SELECT service_id, name, sac_code, default_amount, remark FROM services WHERE service_id = ? LIMIT 1",
            [entry.source_general_service_id]
        );
        if (!source.length) {
            errors.push(`Source general service not found: ${entry.source_general_service_id}`);
        }
    }

    if (errors.length) {
        throw new Error(`Pre-flight failed:\n${errors.join("\n")}`);
    }

    console.log(`Pre-flight OK: ${mapping.length} compliance services ready to seed`);
}

async function seedOne(conn, entry, dryRun) {
    const [sourceRows] = await conn.query(
        `SELECT service_id, name, sac_code, default_amount, remark
         FROM services WHERE service_id = ? LIMIT 1`,
        [entry.source_general_service_id]
    );
    const source = sourceRows[0];

    if (!dryRun) {
        await conn.query(
            `INSERT INTO services
             (service_id, name, sac_code, type, frequency, default_amount, default_due_date, remark, status)
             VALUES (?, ?, ?, 'compliance', ?, ?, ?, ?, 1)`,
            [
                entry.compliance_service_id,
                entry.name || source.name,
                source.sac_code,
                entry.frequency,
                source.default_amount ?? 0,
                entry.default_due_date,
                source.remark || entry.name,
            ]
        );
    }

    let branchCount = 0;
    if (dryRun) {
        const [rows] = await conn.query(
            `SELECT COUNT(*) AS c FROM branch_services
             WHERE service_id = ? AND is_deleted = '0'`,
            [entry.source_general_service_id]
        );
        branchCount = Number(rows[0]?.c || 0);
    } else {
        const [result] = await conn.query(
            `INSERT INTO branch_services
             (branch_id, service_id, fees, gst_rate, gst_value, due_date, remark, create_by, modify_by, is_deleted)
             SELECT bs.branch_id, ?, bs.fees, bs.gst_rate, bs.gst_value, bs.due_date, bs.remark, bs.create_by, bs.modify_by, '0'
             FROM branch_services bs
             WHERE bs.service_id = ? AND bs.is_deleted = '0'
               AND NOT EXISTS (
                   SELECT 1 FROM branch_services bs2
                   WHERE bs2.branch_id = bs.branch_id
                     AND bs2.service_id = ?
                     AND bs2.is_deleted = '0'
               )`,
            [entry.compliance_service_id, entry.source_general_service_id, entry.compliance_service_id]
        );
        branchCount = result.affectedRows;
    }

    return { compliance_service_id: entry.compliance_service_id, branch_services: branchCount };
}

async function postflight(conn) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS c FROM services WHERE type = 'compliance' AND status = 1`
    );
    const count = Number(rows[0]?.c || 0);
    if (count < 8) {
        throw new Error(`Expected at least 8 active compliance services, found ${count}`);
    }
    const [list] = await conn.query(
        `SELECT service_id, name, type, status, frequency FROM services WHERE type = 'compliance' ORDER BY name`
    );
    console.log("Active compliance services:", JSON.stringify(list, null, 2));
}

async function main() {
    const mapping = loadMapping();
    const conn = await pool.getConnection();

    try {
        console.log(APPLY ? "=== APPLY MODE ===" : "=== DRY RUN ===");
        await preflight(conn, mapping);

        if (!APPLY) {
            for (const entry of mapping) {
                const stats = await seedOne(conn, entry, true);
                console.log(`  Would add ${stats.compliance_service_id} (+ ${stats.branch_services} branch_services)`);
            }
            console.log("\nDry run complete. Run with --apply to execute.");
            return;
        }

        await conn.beginTransaction();
        const results = [];
        for (const entry of mapping) {
            const stats = await seedOne(conn, entry, false);
            results.push(stats);
            console.log(`Seeded ${stats.compliance_service_id} (+ ${stats.branch_services} branch_services)`);
        }
        await postflight(conn);
        await conn.commit();

        console.log("\nSeed completed successfully.");
        console.log("Summary:", results);
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
