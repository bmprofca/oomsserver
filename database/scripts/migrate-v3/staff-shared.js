import { NEW_BRANCH_ID } from "./config.js";
import { mapIdFor, profileIdFor, queryBranchRows } from "./utils.js";

export function parseStaffArgs(argv = process.argv) {
    return {
        dryRun: argv.includes("--dry-run"),
        force: argv.includes("--force"),
    };
}

export async function loadStagingEmployees(staging) {
    const rows = await queryBranchRows(staging, "users", {
        reversed: true,
        extraWhere: "LOWER(TRIM(user_type)) = ?",
        extraParams: ["employee"],
    });
    return rows;
}

export async function loadStagingProfilesByUsername(staging) {
    const profiles = await queryBranchRows(staging, "profile");
    return new Map(profiles.map((p) => [p.username, p]));
}

export async function findClientProtectedUsernames(target, branchId, usernames) {
    if (!usernames.length) return new Set();
    const placeholders = usernames.map(() => "?").join(", ");
    const [rows] = await target.query(
        `SELECT username FROM clients
         WHERE branch_id = ? AND username IN (${placeholders})`,
        [branchId, ...usernames]
    );
    return new Set(rows.map((r) => r.username));
}

export function buildStaffUserRow(ou) {
    return {
        username: ou.username,
        create_by: ou.create_by || ou.username,
        status: ou.status ?? "1",
        remark: ou.remark || "Migrated staff from v3",
        create_date: ou.create_date || new Date(),
    };
}

export function normalizeMobile(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "").slice(-10);
    return digits || null;
}

export function buildStaffProfileRow(prof, ou) {
    const username = prof?.username || ou?.username;
    return {
        profile_id: profileIdFor(username),
        username,
        create_by: prof?.create_by || ou?.create_by || username,
        user_type: "staff",
        name: prof?.name || username,
        care_of: prof?.guardian_type || null,
        guardian_name: prof?.guardian_name || null,
        date_of_birth: prof?.dob && !String(prof.dob).startsWith("0000") ? prof.dob : null,
        gender: prof?.gender || null,
        mobile: normalizeMobile(prof?.mobile),
        country_code: prof?.mobile_country_code ? `+${String(prof.mobile_country_code).replace(/\D/g, "")}` : "+91",
        email: prof?.email || null,
        state: prof?.state || null,
        district: prof?.dist || null,
        city: prof?.town || null,
        village_town: prof?.town || null,
        pincode: prof?.pincode || null,
        address_line_1: prof?.address_line_1 || null,
        address_line_2: prof?.address_line_2 || null,
        status: prof?.status ?? "1",
        create_date: prof?.create_date || ou?.create_date || new Date(),
    };
}

export function buildStaffMappingRow(ou, prof) {
    const username = ou.username;
    const createDate = ou.create_date || new Date();
    return {
        map_id: mapIdFor(username),
        branch_id: NEW_BRANCH_ID,
        username,
        designation: prof?.designation || null,
        create_by: ou.create_by || username,
        modify_by: ou.create_by || username,
        type: "staff",
        is_accepted: "1",
        invitation_token: null,
        status: "1",
        is_deleted: "0",
        permission_role_id: ou.permission_id || null,
        create_date: createDate,
        modify_date: createDate,
    };
}

export async function deleteByUsernames(target, { table, column, usernames, extraWhere = "", extraParams = [], dryRun }) {
    if (!usernames.length) return 0;
    const placeholders = usernames.map(() => "?").join(", ");
    const sql = `DELETE FROM \`${table}\` WHERE \`${column}\` IN (${placeholders})${extraWhere ? ` AND (${extraWhere})` : ""}`;
    const params = [...usernames, ...extraParams];
    if (dryRun) {
        const [rows] = await target.query(
            `SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE \`${column}\` IN (${placeholders})${extraWhere ? ` AND (${extraWhere})` : ""}`,
            params
        );
        return Number(rows[0]?.cnt) || 0;
    }
    const [result] = await target.query(sql, params);
    return result.affectedRows || 0;
}

export async function userExists(conn, username) {
    const [rows] = await conn.query(
        "SELECT username FROM users WHERE username = ? LIMIT 1",
        [username]
    );
    return rows.length > 0;
}

export async function profileExists(conn, username) {
    const [rows] = await conn.query(
        "SELECT username FROM profile WHERE username = ? LIMIT 1",
        [username]
    );
    return rows.length > 0;
}

export async function staffMappingExists(conn, branchId, username) {
    const [rows] = await conn.query(
        `SELECT map_id FROM branch_mapping
         WHERE branch_id = ? AND username = ? AND type = 'staff'
           AND (is_deleted = '0' OR is_deleted = 0)
         LIMIT 1`,
        [branchId, username]
    );
    return rows.length > 0;
}
