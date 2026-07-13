import "dotenv/config";
import { NEW_BRANCH_ID, OLD_APP_ID, OLD_BRANCH_ID } from "./config.js";
import { closePools, getStagingPool, getTargetPool } from "./db.js";
import { createLogger } from "./logger.js";
import {
    buildStaffMappingRow,
    buildStaffProfileRow,
    buildStaffUserRow,
    loadStagingEmployees,
    loadStagingProfilesByUsername,
    parseStaffArgs,
    profileExists,
    staffMappingExists,
    userExists,
} from "./staff-shared.js";

async function upsertStaffMember(target, { userRow, profileRow, mappingRow, dryRun }) {
    if (dryRun) {
        return {
            createdUser: true,
            createdProfile: true,
            createdMapping: true,
            skipped: false,
        };
    }

    const conn = await target.getConnection();
    try {
        await conn.beginTransaction();

        const hasUser = await userExists(conn, userRow.username);
        const hasProfile = await profileExists(conn, profileRow.username);
        const hasMapping = await staffMappingExists(conn, mappingRow.branch_id, mappingRow.username);

        if (hasUser && hasProfile && hasMapping) {
            await conn.rollback();
            return {
                createdUser: false,
                createdProfile: false,
                createdMapping: false,
                skipped: true,
            };
        }

        let createdUser = false;
        let createdProfile = false;
        let createdMapping = false;

        if (!hasUser) {
            await conn.query(
                `INSERT INTO users (username, create_by, status, remark, create_date)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    userRow.username,
                    userRow.create_by,
                    userRow.status,
                    userRow.remark,
                    userRow.create_date,
                ]
            );
            createdUser = true;
        }

        if (!hasProfile) {
            await conn.query(
                `INSERT INTO profile (
                    profile_id, username, create_by, user_type, name, care_of, guardian_name,
                    date_of_birth, gender, mobile, country_code, email, state, district, city,
                    village_town, pincode, address_line_1, address_line_2, status, create_date
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    profileRow.profile_id,
                    profileRow.username,
                    profileRow.create_by,
                    profileRow.user_type,
                    profileRow.name,
                    profileRow.care_of,
                    profileRow.guardian_name,
                    profileRow.date_of_birth,
                    profileRow.gender,
                    profileRow.mobile,
                    profileRow.country_code,
                    profileRow.email,
                    profileRow.state,
                    profileRow.district,
                    profileRow.city,
                    profileRow.village_town,
                    profileRow.pincode,
                    profileRow.address_line_1,
                    profileRow.address_line_2,
                    profileRow.status,
                    profileRow.create_date,
                ]
            );
            createdProfile = true;
        }

        if (!hasMapping) {
            await conn.query(
                `INSERT INTO branch_mapping (
                    map_id, branch_id, username, designation, create_by, modify_by, type,
                    is_accepted, invitation_token, status, is_deleted, permission_role_id,
                    create_date, modify_date
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    mappingRow.map_id,
                    mappingRow.branch_id,
                    mappingRow.username,
                    mappingRow.designation,
                    mappingRow.create_by,
                    mappingRow.modify_by,
                    mappingRow.type,
                    mappingRow.is_accepted,
                    mappingRow.invitation_token,
                    mappingRow.status,
                    mappingRow.is_deleted,
                    mappingRow.permission_role_id,
                    mappingRow.create_date,
                    mappingRow.modify_date,
                ]
            );
            createdMapping = true;
        }

        await conn.commit();
        return {
            createdUser,
            createdProfile,
            createdMapping,
            skipped: false,
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function main() {
    const { dryRun } = parseStaffArgs();
    const logger = createLogger({ dryRun });

    logger.info("Staff import: v3 employees → v5 users/profile/branch_mapping (idempotent)", {
        branchId: NEW_BRANCH_ID,
        oldAppId: OLD_APP_ID,
        oldBranchId: OLD_BRANCH_ID,
        dryRun,
    });

    const staging = getStagingPool();
    const target = getTargetPool();

    let createdUsers = 0;
    let createdProfiles = 0;
    let createdMappings = 0;
    let skipped = 0;
    let failed = 0;

    try {
        const employees = await loadStagingEmployees(staging);
        if (!employees.length) {
            throw new Error("No v3 employee rows found in staging. Run npm run migrate:v3:import first.");
        }

        const profileByUsername = await loadStagingProfilesByUsername(staging);
        logger.stat("staff.import.source_employees", employees.length);

        for (const ou of employees) {
            const prof = profileByUsername.get(ou.username) || { username: ou.username };
            const userRow = buildStaffUserRow(ou);
            const profileRow = buildStaffProfileRow(prof, ou);
            const mappingRow = buildStaffMappingRow(ou, prof);

            try {
                const result = await upsertStaffMember(target, {
                    userRow,
                    profileRow,
                    mappingRow,
                    dryRun,
                });

                if (result.skipped) {
                    skipped += 1;
                    logger.info("Staff already complete", { username: ou.username });
                } else {
                    if (result.createdUser) createdUsers += 1;
                    if (result.createdProfile) createdProfiles += 1;
                    if (result.createdMapping) createdMappings += 1;
                }
            } catch (err) {
                failed += 1;
                logger.error("Failed to import staff", { username: ou.username, error: err.message });
            }
        }

        logger.stat("staff.import.created_users", createdUsers);
        logger.stat("staff.import.created_profiles", createdProfiles);
        logger.stat("staff.import.created_mappings", createdMappings);
        logger.stat("staff.import.skipped_complete", skipped);
        logger.stat("staff.import.failed", failed);

        if (dryRun) {
            logger.info("Staff import dry-run complete. No rows were written.");
        } else {
            logger.info("Staff import complete.");
        }
    } finally {
        const reportPath = logger.flush();
        logger.info("Report written", { reportPath });
        await closePools();
    }

    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
