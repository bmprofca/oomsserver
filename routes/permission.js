import express from 'express';
const router = express.Router();

import pool, { poolQuery } from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, SHORT_ID_LENGTH } from "../helpers/function.js";

// Helper to check if a user is an admin in the branch
async function isBranchAdmin(username, branchId) {
    const [rows] = await pool.query(
        "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'admin' AND is_deleted = '0' LIMIT 1",
        [username, branchId]
    );
    return rows.length > 0;
}

// Helper to resolve a branch mapping from any identifier (username, map_id, email, mobile)
async function resolveTargetMapping(identifier, branchId) {
    const input = String(identifier || '').trim();
    if (!input) return null;

    // 1. Check if identifier is directly the username or map_id in branch_mapping
    const [direct] = await pool.query(
        `SELECT username, map_id, type, permission_role_id, custom_permissions 
         FROM branch_mapping 
         WHERE (username = ? OR map_id = ?) AND branch_id = ? AND is_deleted = '0' LIMIT 1`,
        [input, input, branchId]
    );
    if (direct.length > 0) {
        return direct[0];
    }

    // 2. If not found, resolve from users/profile tables
    const [lookup] = await pool.query(
        `SELECT u.username FROM users u
         LEFT JOIN profile p ON p.username = u.username
         WHERE (u.username = ? OR u.login_id = ? OR p.email = ? OR p.mobile = ?) LIMIT 1`,
        [input, input, input, input]
    );

    if (lookup.length > 0) {
        const resolvedUsername = lookup[0].username;
        const [resolved] = await pool.query(
            `SELECT username, map_id, type, permission_role_id, custom_permissions 
             FROM branch_mapping 
             WHERE username = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1`,
            [resolvedUsername, branchId]
        );
        if (resolved.length > 0) {
            return resolved[0];
        }
    }

    return null;
}


// 1. GET /options - Retrieve all available permission options (global)
router.get('/options', auth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, p_option_id, name, status FROM permission_option WHERE status = '1' ORDER BY name ASC"
        );
        
        res.status(200).json({
            success: true,
            message: 'Permission options retrieved successfully',
            data: rows.map(opt => ({
                id: opt.id,
                p_option_id: opt.p_option_id,
                name: opt.name,
                status: opt.status
            })),
            total: rows.length
        });
    } catch (error) {
        console.error('Error fetching permission options:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve permission options',
            error: error.message
        });
    }
});

// Helper to parse role permissions safely
function parsePermissions(permissionsAssigned) {
    if (!permissionsAssigned) return [];
    try {
        const parsed = typeof permissionsAssigned === 'string'
            ? JSON.parse(permissionsAssigned)
            : permissionsAssigned;
        if (parsed && parsed.permissions && Array.isArray(parsed.permissions)) {
            return parsed.permissions;
        } else if (Array.isArray(parsed)) {
            return parsed;
        }
    } catch (e) {
        console.warn("Failed to parse permissions string:", e);
    }
    return [];
}

// 2. GET /list - Retrieve all roles for a branch
const listRolesHandler = async (req, res) => {
    try {
        const branch_id = req.branch_id;
        
        const [rows] = await pool.query(
            `SELECT permission_role_id, name, permissions_assigned, remark, create_date, create_by, modify_date, modify_by 
             FROM permission_role 
             WHERE branch_id = ? 
             ORDER BY name ASC`,
            [branch_id]
        );
        
        const rolesWithPermissions = rows.map(role => ({
            permission_role_id: role.permission_role_id,
            name: role.name,
            permissions: parsePermissions(role.permissions_assigned),
            remark: role.remark,
            create_date: role.create_date,
            create_by: role.create_by,
            modify_date: role.modify_date,
            modify_by: role.modify_by
        }));
        
        res.status(200).json({
            success: true,
            message: 'Permission roles retrieved successfully',
            data: rolesWithPermissions,
            total: rolesWithPermissions.length
        });
    } catch (error) {
        console.error('Error fetching permission roles:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve permission roles',
            error: error.message
        });
    }
};

router.get('/list', auth, validateBranch, listRolesHandler);
router.get('/role/list', auth, validateBranch, listRolesHandler);

// 3. POST /role/create - Create a permission role
router.post('/role/create', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const current_username = req.headers["username"] || req.headers["Username"] || '';
        
        // Authorization check: Must be a branch admin
        const isAdmin = await isBranchAdmin(current_username, branch_id);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized: Only branch administrators can create permission roles'
            });
        }

        const { name, permissions, remark } = req.body || {};
        
        if (!name || String(name).trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: name'
            });
        }

        if (!permissions || !Array.isArray(permissions)) {
            return res.status(400).json({
                success: false,
                message: 'Missing or invalid parameter: permissions must be an array of strings'
            });
        }

        const permission_role_id = await UNIQUE_RANDOM_STRING("permission_role", "permission_role_id", {
            length: SHORT_ID_LENGTH,
            prefix: `PR_${Date.now()}_`,
        });
        const permissions_assigned_json = JSON.stringify(permissions);

        await pool.query(
            `INSERT INTO permission_role (branch_id, permission_role_id, name, permissions_assigned, remark, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [branch_id, permission_role_id, name.trim(), permissions_assigned_json, remark || null, current_username, current_username]
        );

        res.status(201).json({
            success: true,
            message: 'Role created successfully',
            data: {
                permission_role_id,
                name: name.trim(),
                permissions,
                remark: remark || null
            }
        });
    } catch (error) {
        console.error('Error creating permission role:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create permission role',
            error: error.message
        });
    }
});

// 4. PUT /role/update - Update a permission role
router.put('/role/update', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const current_username = req.headers["username"] || req.headers["Username"] || '';
        
        // Authorization check: Must be a branch admin
        const isAdmin = await isBranchAdmin(current_username, branch_id);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized: Only branch administrators can update permission roles'
            });
        }

        const { permission_role_id, name, permissions, remark } = req.body || {};

        if (!permission_role_id) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: permission_role_id'
            });
        }

        // Verify role exists in the branch
        const [existing] = await pool.query(
            "SELECT id FROM permission_role WHERE permission_role_id = ? AND branch_id = ? LIMIT 1",
            [permission_role_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Permission role not found'
            });
        }

        // Build dynamic update
        const updates = [];
        const params = [];

        if (name !== undefined) {
            updates.push("name = ?");
            params.push(String(name).trim());
        }

        if (permissions !== undefined) {
            if (!Array.isArray(permissions)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid parameter: permissions must be an array of strings'
                });
            }
            updates.push("permissions_assigned = ?");
            params.push(JSON.stringify(permissions));
        }

        if (remark !== undefined) {
            updates.push("remark = ?");
            params.push(remark);
        }

        if (updates.length > 0) {
            updates.push("modify_by = ?");
            params.push(current_username);

            params.push(permission_role_id);
            params.push(branch_id);

            await pool.query(
                `UPDATE permission_role SET ${updates.join(', ')} WHERE permission_role_id = ? AND branch_id = ?`,
                params
            );
        }

        res.status(200).json({
            success: true,
            message: 'Role updated successfully'
        });
    } catch (error) {
        console.error('Error updating permission role:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update permission role',
            error: error.message
        });
    }
});

// 5. DELETE /role/delete - Delete a permission role
router.delete('/role/delete', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const current_username = req.headers["username"] || req.headers["Username"] || '';
        
        // Authorization check: Must be a branch admin
        const isAdmin = await isBranchAdmin(current_username, branch_id);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized: Only branch administrators can delete permission roles'
            });
        }

        const { permission_role_id } = req.body || {};

        if (!permission_role_id) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: permission_role_id'
            });
        }

        // Verify role exists in the branch
        const [existing] = await pool.query(
            "SELECT id FROM permission_role WHERE permission_role_id = ? AND branch_id = ? LIMIT 1",
            [permission_role_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Permission role not found'
            });
        }

        // Begin transaction to safely update branch_mapping and delete the role
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // Nullify reference in branch_mapping
            await connection.query(
                "UPDATE branch_mapping SET permission_role_id = NULL WHERE permission_role_id = ? AND branch_id = ?",
                [permission_role_id, branch_id]
            );

            // Delete the role
            await connection.query(
                "DELETE FROM permission_role WHERE permission_role_id = ? AND branch_id = ?",
                [permission_role_id, branch_id]
            );

            await connection.commit();
        } catch (txError) {
            await connection.rollback();
            throw txError;
        } finally {
            connection.release();
        }

        res.status(200).json({
            success: true,
            message: 'Role deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting permission role:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete permission role',
            error: error.message
        });
    }
});

// 6. POST /assign - Assign permission role and/or custom permissions directly to a user in a branch
router.post('/assign', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const current_username = req.headers["username"] || req.headers["Username"] || '';

        // Authorization check: Must be a branch admin
        const isAdmin = await isBranchAdmin(current_username, branch_id);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized: Only branch administrators can assign user permissions'
            });
        }

        const { username, permission_role_id, custom_permissions } = req.body || {};

        if (!username || String(username).trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: username'
            });
        }

        // Verify the target user is mapped to this branch (resolves username, map_id, email, mobile)
        const targetMapping = await resolveTargetMapping(username, branch_id);

        if (!targetMapping) {
            return res.status(404).json({
                success: false,
                message: 'User is not mapped to this branch or mapping is inactive'
            });
        }

        // Verify permission_role_id if provided (and not 'admin')
        if (permission_role_id && permission_role_id !== 'admin') {
            const [roleCheck] = await pool.query(
                "SELECT id FROM permission_role WHERE permission_role_id = ? AND branch_id = ? LIMIT 1",
                [permission_role_id, branch_id]
            );
            if (roleCheck.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Assigned permission role not found'
                });
            }
        }

        // Validate custom permissions list if provided
        if (custom_permissions !== undefined && custom_permissions !== null) {
            if (!Array.isArray(custom_permissions)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid parameter: custom_permissions must be an array of strings'
                });
            }
        }

        let finalRoleVal = permission_role_id || null;
        let finalCustomVal = custom_permissions ? JSON.stringify(custom_permissions) : null;
        let typeVal = targetMapping.type;

        if (permission_role_id === 'admin') {
            typeVal = 'admin';
            finalRoleVal = null;
            finalCustomVal = null;
        } else if (targetMapping.type === 'admin') {
            typeVal = 'staff';
        }

        await pool.query(
            `UPDATE branch_mapping 
             SET type = ?, permission_role_id = ?, custom_permissions = ?, modify_by = ? 
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'`,
            [typeVal, finalRoleVal, finalCustomVal, current_username, targetMapping.username, branch_id]
        );

        res.status(200).json({
            success: true,
            message: 'User permissions assigned successfully'
        });
    } catch (error) {
        console.error('Error assigning user permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to assign user permissions',
            error: error.message
        });
    }
});

// 7. GET /user-permissions - Resolve and fetch active permissions of a user in a branch
router.get('/user-permissions', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const current_username = req.headers["username"] || req.headers["Username"] || '';
        
        // If username is supplied in query, use it; otherwise use the current user
        const targetUsername = req.query.username ? String(req.query.username).trim() : current_username;

        // Retrieve user mapping details (resolves username, map_id, email, mobile)
        const targetMapping = await resolveTargetMapping(targetUsername, branch_id);

        if (!targetMapping) {
            return res.status(404).json({
                success: false,
                message: `User '${targetUsername}' is not mapped to this branch`
            });
        }

        const userMap = targetMapping;

        // Fetch all active system permission options from db
        const [options] = await pool.query(
            "SELECT p_option_id FROM permission_option WHERE status = '1'"
        );
        const activeOptionIds = new Set(options.map(opt => opt.p_option_id));

        let resolvedPermissions = new Set();
        const effectiveRoleId = (userMap.type === 'admin' || userMap.permission_role_id === 'admin') ? 'admin' : userMap.permission_role_id;

        if (effectiveRoleId === 'admin') {
            // Admin receives all active permissions automatically
            activeOptionIds.forEach(id => resolvedPermissions.add(id));
        } else {
            // Default permission accessible for all: Office Assistance
            if (activeOptionIds.has('office_assistance_access')) {
                resolvedPermissions.add('office_assistance_access');
            }

            // 1. Merge permissions from their assigned role
            if (effectiveRoleId) {
                const [roleRows] = await pool.query(
                    "SELECT permissions_assigned FROM permission_role WHERE permission_role_id = ? AND branch_id = ? LIMIT 1",
                    [effectiveRoleId, branch_id]
                );
                if (roleRows.length > 0) {
                    const rolePerms = parsePermissions(roleRows[0].permissions_assigned);
                    rolePerms.forEach(perm => {
                        if (activeOptionIds.has(perm)) {
                            resolvedPermissions.add(perm);
                        }
                    });
                }
            }

            // 2. Merge direct custom permissions
            if (userMap.custom_permissions) {
                const customPerms = parsePermissions(userMap.custom_permissions);
                customPerms.forEach(perm => {
                    if (activeOptionIds.has(perm)) {
                        resolvedPermissions.add(perm);
                    }
                });
            }
        }

        // Fetch assigned role name if exists
        let roleName = null;
        if (effectiveRoleId) {
            if (effectiveRoleId === 'admin') {
                roleName = 'Administrator';
            } else {
                const [roleMeta] = await pool.query(
                    "SELECT name FROM permission_role WHERE permission_role_id = ? AND branch_id = ? LIMIT 1",
                    [effectiveRoleId, branch_id]
                );
                roleName = roleMeta?.[0]?.name || null;
            }
        }

        const customPermissionsArray = userMap.custom_permissions ? parsePermissions(userMap.custom_permissions) : [];

        res.status(200).json({
            success: true,
            username: targetUsername,
            type: userMap.type,
            permission_role_id: effectiveRoleId,
            permission_role_name: roleName,
            permissions: Array.from(resolvedPermissions),
            data: {
                permission_role_id: effectiveRoleId,
                custom_permissions: customPermissionsArray
            }
        });

    } catch (error) {
        console.error('Error resolving user permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to resolve user permissions',
            error: error.message
        });
    }
});

// 8. GET /check - Check if a user has a specific permission in a branch
router.get('/check', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const current_username = req.headers["username"] || req.headers["Username"] || '';
        
        // If username is supplied in query, use it; otherwise use the current user
        const targetUsername = req.query.username ? String(req.query.username).trim() : current_username;
        const permission = req.query.permission ? String(req.query.permission).trim() : '';

        if (!permission) {
            return res.status(400).json({
                success: false,
                message: 'Missing required query parameter: permission'
            });
        }

        // Retrieve user mapping details (resolves username, map_id, email, mobile)
        const targetMapping = await resolveTargetMapping(targetUsername, branch_id);

        if (!targetMapping) {
            return res.status(404).json({
                success: false,
                message: `User '${targetUsername}' is not mapped to this branch`
            });
        }

        const userMap = targetMapping;

        // Admin receives all active permissions automatically
        if (userMap.type === 'admin' || userMap.permission_role_id === 'admin') {
            // Verify permission is active in the master list
            const [optCheck] = await pool.query(
                "SELECT id FROM permission_option WHERE p_option_id = ? AND status = '1' LIMIT 1",
                [permission]
            );
            const exists = optCheck.length > 0;
            return res.status(200).json({
                success: true,
                has_permission: exists,
                username: targetUsername,
                branch_id,
                permission
            });
        }

        // Office Assistance permission is always true for mapped branch users
        if (permission === 'office_assistance_access') {
            return res.status(200).json({
                success: true,
                has_permission: true,
                username: targetUsername,
                branch_id,
                permission
            });
        }

        // Verify permission is active in the master list
        const [optCheck] = await pool.query(
            "SELECT id FROM permission_option WHERE p_option_id = ? AND status = '1' LIMIT 1",
            [permission]
        );
        if (optCheck.length === 0) {
            return res.status(200).json({
                success: true,
                has_permission: false,
                username: targetUsername,
                branch_id,
                permission,
                message: `Permission option '${permission}' is not active or does not exist`
            });
        }

        // 1. Check direct custom permissions
        if (userMap.custom_permissions) {
            const customPerms = parsePermissions(userMap.custom_permissions);
            if (customPerms.includes(permission)) {
                return res.status(200).json({
                    success: true,
                    has_permission: true,
                    username: targetUsername,
                    branch_id,
                    permission
                });
            }
        }

        // 2. Check permissions from their assigned role
        if (userMap.permission_role_id) {
            const [roleRows] = await pool.query(
                "SELECT permissions_assigned FROM permission_role WHERE permission_role_id = ? AND branch_id = ? LIMIT 1",
                [userMap.permission_role_id, branch_id]
            );
            if (roleRows.length > 0) {
                const rolePerms = parsePermissions(roleRows[0].permissions_assigned);
                if (rolePerms.includes(permission)) {
                    return res.status(200).json({
                        success: true,
                        has_permission: true,
                        username: targetUsername,
                        branch_id,
                        permission
                    });
                }
            }
        }

        // Default: false
        return res.status(200).json({
            success: true,
            has_permission: false,
            username: targetUsername,
            branch_id,
            permission
        });

    } catch (error) {
        console.error('Error checking user permission:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check user permission',
            error: error.message
        });
    }
});

const TASK_GET_IN_PERMISSION = {
    p_option_id: "task_get_in",
    name: "Task Get In",
};

async function ensureDefaultPermissionOptions() {
    try {
        const [existing] = await poolQuery(
            "SELECT id FROM permission_option WHERE p_option_id = ? LIMIT 1",
            [TASK_GET_IN_PERMISSION.p_option_id],
            { retries: 3, delayMs: 1000 }
        );

        if (!existing.length) {
            await poolQuery(
                "INSERT INTO permission_option (p_option_id, name, status) VALUES (?, ?, '1')",
                [TASK_GET_IN_PERMISSION.p_option_id, TASK_GET_IN_PERMISSION.name],
                { retries: 3, delayMs: 1000 }
            );
        }
    } catch (error) {
        console.error("Error ensuring default permission options:", error.message || error);
    }
}

setTimeout(() => {
    ensureDefaultPermissionOptions();
}, 3000);

// 9. POST /option/create - Register a new permission option (admin only)
router.post("/option/create", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const current_username = req.headers["username"] || req.headers["Username"] || "";

        const isAdmin = await isBranchAdmin(current_username, branch_id);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: Only branch administrators can create permission options",
            });
        }

        const { p_option_id, name } = req.body || {};

        if (!p_option_id || String(p_option_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Missing required parameter: p_option_id",
            });
        }

        if (!name || String(name).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Missing required parameter: name",
            });
        }

        const optionId = String(p_option_id).trim();
        const optionName = String(name).trim();

        const [existing] = await pool.query(
            "SELECT id, p_option_id, name, status FROM permission_option WHERE p_option_id = ? LIMIT 1",
            [optionId]
        );

        if (existing.length) {
            return res.status(409).json({
                success: false,
                message: "Permission option already exists",
                data: existing[0],
            });
        }

        await pool.query(
            "INSERT INTO permission_option (p_option_id, name, status) VALUES (?, ?, '1')",
            [optionId, optionName]
        );

        return res.status(200).json({
            success: true,
            message: "Permission option created successfully",
            data: {
                p_option_id: optionId,
                name: optionName,
                status: "1",
            },
        });
    } catch (error) {
        console.error("Error creating permission option:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create permission option",
            error: error.message,
        });
    }
});

export default router;