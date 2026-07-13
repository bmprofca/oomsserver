import "dotenv/config";
import { NEW_BRANCH_ID } from "./config.js";
import { closePools, getTargetPool } from "./db.js";
import { createLogger } from "./logger.js";

function parseArgs(argv = process.argv) {
    const branchArg = argv.find((a) => a.startsWith("--branch-id="));
    return {
        dryRun: argv.includes("--dry-run"),
        force: argv.includes("--force"),
        allBranches: argv.includes("--all-branches"),
        branchId: branchArg ? branchArg.split("=")[1] : NEW_BRANCH_ID,
    };
}

const STEPS = [
    { label: "attendance_break", table: "attendance_break" },
    { label: "attendance", table: "attendance" },
    { label: "salary_adjustments", table: "salary_adjustments" },
    { label: "staff_salary", table: "staff_salary" },
    { label: "employee_weekly_off", table: "employee_weekly_off" },
];

async function countRows(pool, table, branchId, allBranches) {
    const sql = allBranches
        ? `SELECT COUNT(*) AS cnt FROM \`${table}\``
        : `SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE branch_id = ?`;
    const params = allBranches ? [] : [branchId];
    const [rows] = await pool.query(sql, params);
    return Number(rows[0]?.cnt) || 0;
}

async function deleteRows(pool, table, branchId, allBranches, dryRun) {
    const sql = allBranches
        ? `DELETE FROM \`${table}\``
        : `DELETE FROM \`${table}\` WHERE branch_id = ?`;
    const params = allBranches ? [] : [branchId];

    if (dryRun) {
        return countRows(pool, table, branchId, allBranches);
    }

    const [result] = await pool.query(sql, params);
    return result.affectedRows;
}

async function main() {
    const { dryRun, force, allBranches, branchId } = parseArgs();
    const logger = createLogger({ dryRun: dryRun || !force });
    const pool = getTargetPool();

    const scope = allBranches ? "ALL branches" : `branch ${branchId}`;
    logger.info("Attendance reset", { scope, dryRun: dryRun || !force, force, allBranches });

    if (!force && !dryRun) {
        logger.warn("Pass --force to delete rows, or --dry-run to preview counts only.");
    }

    const effectiveDryRun = dryRun || !force;

    try {
        for (const step of STEPS) {
            const before = await countRows(pool, step.table, branchId, allBranches);
            const affected = await deleteRows(pool, step.table, branchId, allBranches, effectiveDryRun);
            logger.stat(`attendance.reset.${step.label}`, effectiveDryRun ? before : affected);
        }

        if (effectiveDryRun) {
            logger.info("Dry-run complete. Re-run with --force to apply deletes.");
        } else {
            logger.info("Attendance reset complete.");
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
