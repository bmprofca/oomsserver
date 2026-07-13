import "dotenv/config";
import { NEW_BRANCH_ID, OLD_APP_ID, OLD_BRANCH_ID } from "./config.js";
import { closePools, getStagingPool, getTargetPool } from "./db.js";
import { createLogger } from "./logger.js";
import { loadStagingEmployees } from "./staff-shared.js";

async function main() {
    const logger = createLogger({ dryRun: false });

    logger.info("Staff verify", {
        branchId: NEW_BRANCH_ID,
        oldAppId: OLD_APP_ID,
        oldBranchId: OLD_BRANCH_ID,
    });

    const staging = getStagingPool();
    const target = getTargetPool();

    try {
        const employees = await loadStagingEmployees(staging);
        const usernames = employees.map((e) => e.username).filter(Boolean);

        logger.stat("staff.verify.v3_employees", usernames.length);

        const [mappingRows] = await target.query(
            `SELECT username FROM branch_mapping
             WHERE branch_id = ? AND type = 'staff' AND (is_deleted = '0' OR is_deleted = 0)`,
            [NEW_BRANCH_ID]
        );
        const mappingSet = new Set(mappingRows.map((r) => r.username));
        logger.stat("staff.verify.v5_branch_mapping_staff", mappingSet.size);

        const placeholders = usernames.map(() => "?").join(", ");
        const empty = { users: [], profile: [], branch_mapping: [], wrong_profile_type: [] };

        if (usernames.length) {
            const [userRows] = await target.query(
                `SELECT username FROM users WHERE username IN (${placeholders})`,
                usernames
            );
            const userSet = new Set(userRows.map((r) => r.username));

            const [profileRows] = await target.query(
                `SELECT username, user_type FROM profile WHERE username IN (${placeholders})`,
                usernames
            );
            const profileMap = new Map(profileRows.map((r) => [r.username, r.user_type]));

            for (const username of usernames) {
                if (!userSet.has(username)) empty.users.push(username);
                if (!profileMap.has(username)) empty.profile.push(username);
                else if (String(profileMap.get(username)).toLowerCase() !== "staff") {
                    empty.wrong_profile_type.push({ username, user_type: profileMap.get(username) });
                }
                if (!mappingSet.has(username)) empty.branch_mapping.push(username);
            }
        }

        logger.stat("staff.verify.missing_users", empty.users.length);
        logger.stat("staff.verify.missing_profile", empty.profile.length);
        logger.stat("staff.verify.missing_branch_mapping", empty.branch_mapping.length);
        logger.stat("staff.verify.wrong_profile_type", empty.wrong_profile_type.length);

        if (empty.users.length) {
            logger.warn("Missing users (sample)", { usernames: empty.users.slice(0, 10) });
        }
        if (empty.profile.length) {
            logger.warn("Missing profile (sample)", { usernames: empty.profile.slice(0, 10) });
        }
        if (empty.branch_mapping.length) {
            logger.warn("Missing branch_mapping (sample)", { usernames: empty.branch_mapping.slice(0, 10) });
        }
        if (empty.wrong_profile_type.length) {
            logger.warn("Wrong profile.user_type (sample)", { rows: empty.wrong_profile_type.slice(0, 10) });
        }

        const ok =
            empty.users.length === 0 &&
            empty.profile.length === 0 &&
            empty.branch_mapping.length === 0 &&
            empty.wrong_profile_type.length === 0;

        if (ok) {
            logger.info("Staff verification passed — all v3 employees have users, profile (staff), and branch_mapping (staff). Attendance was not checked.");
        } else {
            logger.error("Staff verification failed. Run npm run migrate:v3:staff-import after ensuring staging data is loaded.");
            process.exitCode = 1;
        }

        logger.info("Sample migrated staff usernames", { usernames: usernames.slice(0, 5) });
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
