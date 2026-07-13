import pool from "../db.js";
import { getSubscriptionStatus, hasFeatureAccess } from "../services/subscriptionService.js";

async function queryTokenRows(username, token, extraJoin = "", extraWhere = "", extraParams = []) {
    const baseParams = [token, username, "1", ...extraParams];

    try {
        const [tokenRows] = await pool.query(
            `SELECT tokens.id, users.status AS user_status
             FROM tokens
             JOIN users ON users.username = tokens.username
             ${extraJoin}
             WHERE tokens.token = ?
               AND tokens.username = ?
               AND tokens.status = ?
               ${extraWhere}`,
            baseParams
        );
        if (tokenRows.length) {
            return tokenRows;
        }
    } catch (_) {
        // try legacy table below
    }

    try {
        const [legacyRows] = await pool.query(
            `SELECT login_token.id, users.status AS user_status
             FROM login_token
             JOIN users ON users.username = login_token.username
             ${extraJoin}
             WHERE login_token.token = ?
               AND login_token.username = ?
               AND login_token.status = ?
               ${extraWhere}`,
            baseParams
        );
        return legacyRows;
    } catch (_) {
        return [];
    }
}

async function checkToken(username, token) {
    try {
        const rows = await queryTokenRows(username, token);

        if (rows.length === 1) {
            return rows[0]?.user_status === "1";
        }
        return false;
    } catch (err) {
        console.error("Token check error:", err);
        return false;
    }
}

async function checkAdminToken(username, token) {
    try {
        const rows = await queryTokenRows(
            username,
            token,
            `INNER JOIN profile p ON p.username = users.username
                AND p.status = '1'
                AND p.user_type = 'platform_admin'`,
            "AND users.status = '1'"
        );

        if (rows.length === 1) {
            return rows[0]?.user_status === "1";
        }
        return false;
    } catch (err) {
        console.error("Admin token check error:", err);
        return false;
    }
}

// Express middleware
async function auth(req, res, next) {
    const token = req.headers["token"] || req.headers["Token"] || '';
    const username = req.headers["username"] || req.headers["Username"] || '';

    if (!token || !username) {
        return res.status(401).json({
            success: false,
            message: "Session expired"
        });
    }

    const isValid = await checkToken(username, token);

    if (!isValid) {
        return res.status(401).json({
            success: false,
            message: "Session expired"
        });
    }

    next();
}

// Express middleware / helper used across routes
async function CheckUserProjectMaping(username, project_id) {

    const [row] = await pool.query(
        "SELECT * FROM project_mapping WHERE username = ? AND project_id = ? AND is_deleted = ?",
        [username, project_id, '0']
    );

    if (row.length == 1) {
        return true;
    } else {
        return false;
    }
}

// Express middleware to validate branch from headers and check user mapping
async function validateBranch(req, res, next) {
    try {
        // Get branch from headers or query parameters (supporting query fallback for compatibility)
        const branch = req.headers["branch"] || req.headers["Branch"] || req.query.branch_id || '';
        const username = req.headers["username"] || req.headers["Username"] || '';

        // Validate branch is provided
        if (!branch || String(branch).trim() === '') {
            return res.status(400).json({
                success: false,
                message: "Missing required branch context (pass 'branch' header or 'branch_id' query parameter)"
            });
        }

        const branch_id = String(branch).trim();

        // Validate branch_id exists in branch_list
        const [branchRows] = await pool.query(
            "SELECT branch_id FROM branch_list WHERE branch_id = ? AND (is_deleted = '0' OR is_deleted = 0) LIMIT 1",
            [branch_id]
        ).catch(async () => {
            // Fallback if is_deleted column doesn't exist
            const [rows] = await pool.query(
                "SELECT branch_id FROM branch_list WHERE branch_id = ? LIMIT 1",
                [branch_id]
            );
            return [rows];
        });

        if (!branchRows || branchRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Invalid branch. Branch not found."
            });
        }

        // Check if user is mapped to this branch with required conditions
        // is_accepted = '1', status = '1', is_deleted = '0'
        const [mappingRows] = await pool.query(
            "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND is_accepted = '1' AND status = '1' AND is_deleted = '0' LIMIT 1",
            [username, branch_id]
        ).catch(async () => {
            // Fallback if columns don't exist
            const [rows] = await pool.query(
                "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? LIMIT 1",
                [username, branch_id]
            );
            return [rows];
        });

        if (!mappingRows || mappingRows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "User is not mapped to this branch or mapping is not active"
            });
        }

        // Also set as a custom property on req for reliable access
        req.branch_id = branch_id;

        next();
    } catch (error) {
        console.error("Branch validation error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to validate branch",
            error: error.message
        });
    }
}

async function checkSubscription(req, res, next) {
    try {
        const username = req.headers["username"] || req.headers["Username"] || '';
        const branch = req.headers["branch"] || req.headers["Branch"] || req.query.branch_id || '';
        
        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Session expired or username missing"
            });
        }

        const [rows] = await pool.query(
            "SELECT username FROM users WHERE username = ? LIMIT 1",
            [username]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User account not found"
            });
        }

        if (!branch || String(branch).trim() === '') {
            req.subscription = await getSubscriptionStatus('');
            return next();
        }

        req.subscription = await getSubscriptionStatus(String(branch).trim());
        
        next();
    } catch (err) {
        console.error("Subscription validation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to validate subscription status",
            error: err.message
        });
    }
}

function requirePlan(allowedPlans) {
    return (req, res, next) => {
        const activePlanNames = (req.subscription?.active_plans || [])
            .filter((plan) => plan.is_active)
            .map((plan) => plan.plan_name);

        const hasAllowedPlan = allowedPlans.some((plan) => activePlanNames.includes(plan));
        const isSubscribed = req.subscription?.is_subscribed === 'yes';

        if (!isSubscribed) {
            return res.status(403).json({
                success: false,
                message: "Active subscription required. Please subscribe to a plan.",
                code: "SUBSCRIPTION_REQUIRED"
            });
        }

        if (!hasAllowedPlan) {
            const plan = req.subscription?.subscription_plan || 'None';
            return res.status(403).json({
                success: false,
                message: `This feature is not available in your current plan (${plan}). Please upgrade your plan.`,
                code: "PLAN_UPGRADE_REQUIRED"
            });
        }

        next();
    };
}

function requireFeature(featureKey) {
    return (req, res, next) => {
        const isSubscribed = req.subscription?.is_subscribed === 'yes';

        if (!isSubscribed) {
            return res.status(403).json({
                success: false,
                message: "Active subscription required. Please subscribe to a plan.",
                code: "SUBSCRIPTION_REQUIRED",
            });
        }

        if (!hasFeatureAccess(req.subscription, featureKey)) {
            const plan = req.subscription?.subscription_plan || 'None';
            return res.status(403).json({
                success: false,
                message: `This feature is not available in your current plan (${plan}). Please upgrade your plan.`,
                code: "PLAN_UPGRADE_REQUIRED",
                feature: featureKey,
            });
        }

        next();
    };
}

export { auth, checkToken, checkAdminToken, CheckUserProjectMaping, validateBranch, checkSubscription, requirePlan, requireFeature }
