import "dotenv/config";
import {
    ALL_PHASE_KEYS,
    OLD_APP_ID,
    OLD_BRANCH_ID,
    NEW_BRANCH_ID,
    PHASES,
    STAGING_DB_NAME,
    STAGING_TABLE_PREFIX,
} from "./migrate-v3/config.js";
import { closePools, getStagingPool, getTargetPool } from "./migrate-v3/db.js";
import { createLogger } from "./migrate-v3/logger.js";
import { runPhaseA } from "./migrate-v3/phases/phaseA.js";
import { runPhaseB } from "./migrate-v3/phases/phaseB.js";
import { runPhaseC } from "./migrate-v3/phases/phaseC.js";
import { runPhaseD } from "./migrate-v3/phases/phaseD.js";
import { runPhaseE } from "./migrate-v3/phases/phaseE.js";
import { runVerification } from "./migrate-v3/verify.js";

const PHASE_RUNNERS = {
    a: runPhaseA,
    b: runPhaseB,
    c: runPhaseC,
    d: runPhaseD,
    e: runPhaseE,
};

function parseArgs(argv) {
    const args = {
        phases: [...ALL_PHASE_KEYS],
        dryRun: false,
        verifyOnly: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") args.dryRun = true;
        else if (arg === "--verify") args.verifyOnly = true;
        else if (arg.startsWith("--module=")) {
            const mod = arg.split("=")[1];
            args.phases = mod.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
        }
    }
    return args;
}

async function assertStagingReady(staging) {
    const [rows] = await staging.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables
         WHERE table_schema = ? AND table_name LIKE ?`,
        [STAGING_DB_NAME, `${STAGING_TABLE_PREFIX}%`]
    );
    if (Number(rows[0]?.cnt) === 0) {
        throw new Error(
            `No staging tables found (${STAGING_TABLE_PREFIX}*). Run: npm run migrate:v3:import`
        );
    }
}

async function main() {
    const { phases, dryRun, verifyOnly } = parseArgs(process.argv);
    const logger = createLogger({ dryRun });

    logger.info("APP2025/BRN2025 → branch 123456 migration", {
        oldAppId: OLD_APP_ID,
        oldBranchId: OLD_BRANCH_ID,
        newBranchId: NEW_BRANCH_ID,
        stagingDb: STAGING_DB_NAME,
        targetDb: process.env.DB_NAME,
        phases: phases.map((p) => PHASES[p] || p),
        dryRun,
        verifyOnly,
    });

    const staging = getStagingPool();
    const target = getTargetPool();

    try {
        await assertStagingReady(staging);

        if (!verifyOnly) {
            const ctx = {
                staging,
                target,
                logger,
                dryRun,
                oldAppId: OLD_APP_ID,
                oldBranchId: OLD_BRANCH_ID,
                newBranchId: NEW_BRANCH_ID,
                saleEntriesBranchId: null,
            };

            for (const phaseKey of phases) {
                const runner = PHASE_RUNNERS[phaseKey];
                if (!runner) {
                    logger.warn(`Unknown phase "${phaseKey}", skipping`);
                    continue;
                }
                logger.info(`--- Phase ${phaseKey.toUpperCase()} (${PHASES[phaseKey]}) ---`);
                await runner(ctx);
            }
        }

        await runVerification({ staging, target, logger });
        const reportPath = logger.flush();
        logger.info(`Report saved: ${reportPath}`);
    } finally {
        await closePools();
    }
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
