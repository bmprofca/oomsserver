import pool from "../db.js";
import { resolveUserAccess } from "../helpers/permissionCheck.js";

/**
 * Executive Summary is intentionally branch-admin-only. A staff member with a
 * report permission must not be able to read or mutate this feature.
 */
export async function requireBranchAdmin(req, res, next) {
    try {
        const username = String(
            req.headers["username"] || req.headers["Username"] || ""
        ).trim();
        const branchId = String(req.branch_id || "").trim();
        const access = await resolveUserAccess(pool, username, branchId);

        if (!access.isAdmin) {
            return res.status(403).json({
                success: false,
                code: "BRANCH_ADMIN_REQUIRED",
                message: "Executive Summary is available only to branch administrators",
            });
        }

        req.userAccess = access;
        return next();
    } catch (error) {
        console.error("Branch admin check error:", error?.message || error);
        return res.status(500).json({
            success: false,
            code: "BRANCH_ADMIN_CHECK_FAILED",
            message: "Unable to verify branch administrator access",
        });
    }
}
