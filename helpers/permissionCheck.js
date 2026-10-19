import { parsePermissions, fetchPermissionRoleById } from "./permissionRole.js";

/**
 * Resolve every permission key a user holds in one branch, using the same rules as the
 * per-route checkUserPermission copies (routes/report.js, task.js, followup.js):
 *  - branch_mapping.type = 'admin' gets everything
 *  - otherwise custom_permissions + the assigned permission_role
 *  - a key only counts while it is active in permission_option
 *
 * @param {{query: Function}} db mysql2 pool (or a test double)
 * @returns {Promise<{isMapped: boolean, isAdmin: boolean, type: string|null, permissions: Set<string>}>}
 */
export async function resolveUserAccess(db, username, branchId) {
    const empty = { isMapped: false, isAdmin: false, type: null, permissions: new Set() };
    if (!username || !branchId) return empty;

    const [mappings] = await db.query(
        `SELECT type, permission_role_id, custom_permissions
         FROM branch_mapping
         WHERE username = ? AND branch_id = ? AND is_deleted = '0'
           AND status = '1' AND is_accepted = '1'
         LIMIT 1`,
        [username, branchId]
    );
    const mapping = mappings?.[0];
    if (!mapping) return empty;

    if (mapping.type === "admin") {
        return { isMapped: true, isAdmin: true, type: "admin", permissions: new Set() };
    }

    const assigned = new Set(parsePermissions(mapping.custom_permissions));
    if (mapping.permission_role_id) {
        const role = await fetchPermissionRoleById(db, mapping.permission_role_id, branchId);
        for (const key of parsePermissions(role?.permissions_assigned)) assigned.add(key);
    }

    const permissions = new Set();
    if (assigned.size > 0) {
        const keys = [...assigned];
        const [active] = await db.query(
            `SELECT p_option_id FROM permission_option
             WHERE status = '1' AND p_option_id IN (${keys.map(() => "?").join(", ")})`,
            keys
        );
        for (const row of active || []) permissions.add(row.p_option_id);
    }

    return { isMapped: true, isAdmin: false, type: mapping.type, permissions };
}

/** True when the resolved access holds the key (admins hold every key). */
export function hasPermission(access, key) {
    return Boolean(access?.isAdmin || access?.permissions?.has(key));
}
