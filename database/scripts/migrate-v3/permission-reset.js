import "dotenv/config";
import { closePools, getTargetPool } from "./db.js";
import { createLogger } from "./logger.js";
import {
    DEFAULT_GLOBAL_ROLES,
    DEFAULT_PERMISSION_OPTIONS,
} from "../../../helpers/permissionDefaults.js";

function parseArgs(argv = process.argv) {
    return {
        dryRun: argv.includes("--dry-run"),
        force: argv.includes("--force"),
    };
}

async function ensurePermissionOptions(pool, dryRun, logger) {
    let inserted = 0;
    for (const option of DEFAULT_PERMISSION_OPTIONS) {
        const [existing] = await pool.query(
            "SELECT id FROM permission_option WHERE p_option_id = ? LIMIT 1",
            [option.p_option_id]
        );
        if (existing.length) continue;
        if (!dryRun) {
            await pool.query(
                "INSERT INTO permission_option (p_option_id, name, status) VALUES (?, ?, '1')",
                [option.p_option_id, option.name]
            );
        }
        inserted++;
    }
    logger.stat("permission.reset.options_inserted", inserted);
}

async function resetPermissionRoles(pool, dryRun, logger) {
    const [roleCountRows] = await pool.query("SELECT COUNT(*) AS cnt FROM permission_role");
    const existingCount = Number(roleCountRows[0]?.cnt) || 0;
    logger.stat("permission.reset.roles_before", existingCount);

    if (!dryRun) {
        await pool.query("UPDATE branch_mapping SET permission_role_id = NULL WHERE permission_role_id IS NOT NULL");
        const [deleteResult] = await pool.query("DELETE FROM permission_role");
        logger.stat("permission.reset.roles_deleted", deleteResult.affectedRows);
    } else {
        logger.stat("permission.reset.roles_deleted", existingCount);
    }

    let inserted = 0;
    for (const role of DEFAULT_GLOBAL_ROLES) {
        if (!dryRun) {
            await pool.query(
                `INSERT INTO permission_role (
                    branch_id, permission_role_id, name, permissions_assigned, remark,
                    create_by, modify_by, create_date, modify_date
                ) VALUES (NULL, ?, ?, ?, ?, 'system', 'system', NOW(), NOW())`,
                [
                    role.permission_role_id,
                    role.name,
                    JSON.stringify(role.permissions),
                    role.remark,
                ]
            );
        }
        inserted++;
        logger.info(`Global role: ${role.name}`, {
            permission_role_id: role.permission_role_id,
            permission_count: role.permissions.length,
        });
    }
    logger.stat("permission.reset.global_roles_inserted", inserted);
}

async function main() {
    const { dryRun, force } = parseArgs();
    const logger = createLogger({ dryRun: dryRun || !force });
    const pool = getTargetPool();

    logger.info("Permission reset", { dryRun: dryRun || !force, force });

    if (!force && !dryRun) {
        logger.warn("Pass --force to apply changes, or --dry-run to preview.");
    }

    const effectiveDryRun = dryRun || !force;

    try {
        await ensurePermissionOptions(pool, effectiveDryRun, logger);
        await resetPermissionRoles(pool, effectiveDryRun, logger);

        if (effectiveDryRun) {
            logger.info("Dry-run complete. Re-run with --force to apply.");
        } else {
            logger.info("Permission reset complete.");
        }
    } finally {
        const reportPath = logger.flush();
        logger.info("Report written", { reportPath });
        await closePools();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
