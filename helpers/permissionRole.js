export function parsePermissions(permissionsAssigned) {
    if (!permissionsAssigned) return [];
    try {
        const parsed = typeof permissionsAssigned === "string"
            ? JSON.parse(permissionsAssigned)
            : permissionsAssigned;
        if (parsed && parsed.permissions && Array.isArray(parsed.permissions)) {
            return parsed.permissions;
        }
        if (Array.isArray(parsed)) {
            return parsed;
        }
    } catch (e) {
        console.warn("Failed to parse permissions string:", e);
    }
    return [];
}

export async function fetchPermissionRoleById(pool, permissionRoleId, branchId) {
    if (!permissionRoleId) return null;

    const [branchRows] = await pool.query(
        `SELECT permission_role_id, name, permissions_assigned, branch_id, remark
         FROM permission_role
         WHERE permission_role_id = ? AND branch_id = ?
         LIMIT 1`,
        [permissionRoleId, branchId]
    );
    if (branchRows.length > 0) {
        return branchRows[0];
    }

    const [globalRows] = await pool.query(
        `SELECT permission_role_id, name, permissions_assigned, branch_id, remark
         FROM permission_role
         WHERE permission_role_id = ? AND branch_id IS NULL
         LIMIT 1`,
        [permissionRoleId]
    );
    return globalRows[0] || null;
}
