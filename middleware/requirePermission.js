import pool from "../db.js";
import { resolveUserAccess, hasPermission } from "../helpers/permissionCheck.js";

/**
 * Server-side branch permission gate for new roadmap mutations.
 * Admins retain the existing full-access behavior; all other users must have
 * the active permission in their branch role or custom permissions.
 */
export function requirePermission(permission) {
    return async (req, res, next) => {
        try {
            const username = String(
                req.headers["username"] || req.headers["Username"] || ""
            ).trim();
            const access = await resolveUserAccess(pool, username, req.branch_id);

            if (!hasPermission(access, permission)) {
                return res.status(403).json({
                    success: false,
                    code: "PERMISSION_REQUIRED",
                    permission,
                    message: "You do not have permission to perform this action",
                });
            }

            req.userAccess = access;
            return next();
        } catch (error) {
            console.error("Permission check error:", error?.message || error);
            return res.status(500).json({
                success: false,
                code: "PERMISSION_CHECK_FAILED",
                message: "Unable to verify permissions",
            });
        }
    };
}
