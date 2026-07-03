import pool from "../db.js";

async function checkToken(username, token, userType = "user") {
    try {
        // OTP login saves token to `tokens` table, while Google login/register uses `login_token`.
        // Support both for compatibility.
        let rows = [];

        try {
            const [tokenRows] = await pool.query(
                "SELECT tokens.id, users.status AS user_status FROM tokens JOIN users ON users.username = tokens.username WHERE tokens.token = ? AND tokens.username = ? AND tokens.status = ? AND users.type = ?",
                [token, username, "1", userType]
            );
            rows = tokenRows;
        } catch (e) {
            // ignore and try legacy table below
        }

        if (!rows.length) {
            try {
                const [legacyRows] = await pool.query(
                    "SELECT login_token.id, users.status AS user_status FROM login_token JOIN users ON users.username = login_token.username WHERE login_token.token = ? AND login_token.username = ? AND login_token.status = ? AND users.type = ?",
                    [token, username, "1", userType]
                );
                rows = legacyRows;
            } catch (e) {
                // login_token table doesn't exist or query failed, ignore
            }
        }

        if (rows.length == 1) {
            var user_status = rows[0]?.user_status;
            if (user_status == '1') {
                return true;
            } else {
                return false;
            }
        } else {
            return false;
        }

    } catch (err) {
        console.error("Token check error:", err);
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

    const isValid = await checkToken(username, token, "user");

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
        
        let targetUsername = username;
        
        // Resolve the subscription of the active branch admin/owner
        if (branch) {
            const [ownerRows] = await pool.query(
                "SELECT username FROM branch_mapping WHERE branch_id = ? AND type = 'admin' AND is_deleted = '0' LIMIT 1",
                [branch]
            );
            if (ownerRows.length > 0) {
                targetUsername = ownerRows[0].username;
            }
        }
        
        const [rows] = await pool.query(
            "SELECT is_subscribed, subscription_plan, subscription_expires_at FROM users WHERE username = ? LIMIT 1",
            [targetUsername]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User account not found"
            });
        }
        
        const user = rows[0];
        const isSubscribed = user.is_subscribed === 'yes';
        const hasExpired = user.subscription_expires_at && new Date(user.subscription_expires_at) < new Date();
        
        req.subscription = {
            is_subscribed: isSubscribed && !hasExpired ? 'yes' : 'no',
            subscription_plan: isSubscribed && !hasExpired ? user.subscription_plan : 'None',
            subscription_expires_at: user.subscription_expires_at
        };
        
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
        const isSubscribed = req.subscription?.is_subscribed === 'yes';
        const plan = req.subscription?.subscription_plan || 'None';
        
        if (!isSubscribed) {
            return res.status(403).json({
                success: false,
                message: "Active subscription required. Please subscribe to a plan.",
                code: "SUBSCRIPTION_REQUIRED"
            });
        }
        
        if (!allowedPlans.includes(plan)) {
            return res.status(403).json({
                success: false,
                message: `This feature is not available in your current plan (${plan}). Please upgrade your plan.`,
                code: "PLAN_UPGRADE_REQUIRED"
            });
        }
        
        next();
    };
}

export { auth, checkToken, CheckUserProjectMaping, validateBranch, checkSubscription, requirePlan }
