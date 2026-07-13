import "dotenv/config";
import { NEW_BRANCH_ID, OLD_APP_ID, OLD_BRANCH_ID } from "./config.js";
import { closePools, getStagingPool, getTargetPool } from "./db.js";
import { createLogger } from "./logger.js";
import {
    deleteByUsernames,
    findClientProtectedUsernames,
    loadStagingEmployees,
    parseStaffArgs,
} from "./staff-shared.js";

async function main() {
    const { dryRun, force } = parseStaffArgs();
    const logger = createLogger({ dryRun: dryRun || !force });

    logger.info("Staff reset: v5 staff cleanup for branch", {
        branchId: NEW_BRANCH_ID,
        oldAppId: OLD_APP_ID,
        oldBranchId: OLD_BRANCH_ID,
        dryRun: dryRun || !force,
        force,
    });

    const staging = getStagingPool();
    const target = getTargetPool();

    try {
        const employees = await loadStagingEmployees(staging);
        if (!employees.length) {
            throw new Error("No v3 employee rows found in staging. Run npm run migrate:v3:import first.");
        }

        const allUsernames = employees.map((e) => e.username).filter(Boolean);
        const protectedSet = await findClientProtectedUsernames(target, NEW_BRANCH_ID, allUsernames);
        const usernames = allUsernames.filter((u) => !protectedSet.has(u));

        if (protectedSet.size) {
            logger.warn("Skipping usernames that also exist in clients", {
                count: protectedSet.size,
                usernames: [...protectedSet].slice(0, 10),
            });
        }

        logger.stat("staff.reset.candidates", usernames.length);

        const steps = [
            {
                label: "branch_mapping",
                table: "branch_mapping",
                column: "username",
                extraWhere: "branch_id = ? AND type = 'staff'",
                extraParams: [NEW_BRANCH_ID],
            },
            {
                label: "tokens",
                table: "tokens",
                column: "username",
            },
            {
                label: "profile",
                table: "profile",
                column: "username",
            },
            {
                label: "users",
                table: "users",
                column: "username",
            },
        ];

        if (!force && !dryRun) {
            logger.warn("Dry-run mode (no --force). Pass --force to delete rows.");
        }

        const effectiveDryRun = dryRun || !force;

        for (const step of steps) {
            const deleted = await deleteByUsernames(target, {
                table: step.table,
                column: step.column,
                usernames,
                extraWhere: step.extraWhere,
                extraParams: step.extraParams,
                dryRun: effectiveDryRun,
            });
            logger.stat(`staff.reset.${step.label}`, deleted);
        }

        if (effectiveDryRun) {
            logger.info("Staff reset dry-run complete. Re-run with --force to apply deletes.");
        } else {
            logger.info("Staff reset complete.");
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
