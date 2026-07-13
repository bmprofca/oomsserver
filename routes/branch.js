// routes/branchRoutes.js
import express from "express";
import pool from "../db.js";
import { UNIQUE_RANDOM_STRING, RANDOM_STRING, SHORT_ID_LENGTH } from "../helpers/function.js";
import { initializeBranchDefaults } from "../services/branchSetupService.js";
import { resolveSoftwareUserByContact } from "../helpers/authProfile.js";

const router = express.Router();

const auth = async (req, res, next) => {
    let conn;

    try {
        // FIX: Check multiple header formats
        const username = req.headers.username ||
            req.headers['username'] ||
            req.headers['user-name'] ||
            req.headers['UserName'];

        const token = req.headers.token ||
            req.headers['token'] ||
            req.headers['authorization']?.replace('Bearer ', '');

        if (!username || !token) {
            return res.status(401).json({
                success: false,
                message: "Missing authentication headers",
                debug: { username: !!username, token: !!token }
            });
        }

        conn = await pool.getConnection();

        // Resolve software user by username or active profile contact
        const [users] = await conn.query(
            `SELECT u.username, p.email, p.mobile
             FROM users u
             LEFT JOIN profile p ON p.username = u.username AND p.status = '1'
             WHERE (u.username = ? OR p.email = ? OR p.mobile = ?)
               AND u.status = '1'`,
            [username, username, username]
        );

        if (users.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: `User not found: ${username}`,
                debug: { searchedUsername: username }
            });
        }

        // Use the actual username from database
        const dbUsername = users[0].username;

        // Verify token exists and is valid
        const [tokens] = await conn.query(
            `SELECT * FROM tokens 
             WHERE token = ? 
               AND username = ? 
               AND status = '1' 
               AND expire_date > NOW()`,
            [token, dbUsername]  // FIX: Use database username
        );


        if (tokens.length === 0) {
            conn.release();
            return res.status(401).json({
                success: false,
                message: "Session expired. Please login again.",
                debug: { tokenValid: false }
            });
        }

        conn.release();

        // Set user info in request
        req.username = dbUsername;  // Use username from database
        req.token = token;
        req.userEmail = users[0].email || users[0].mobile;


        next();

    } catch (error) {
        console.error('Auth middleware error:', error);
        if (conn) conn.release();
        return res.status(500).json({
            success: false,
            message: "Authentication error",
            error: error.message
        });
    }
};


router.post("/create", auth, async (req, res) => {
    let conn;

    try {
        const {
            name: nameField,
            branch_name,
            legal_name,
            logo,
            sign,
            address_line_1,
            address_line_2,
            city,
            state,
            country,
            pincode,
            invoice_address,
            pan,
            gst,
            mobile_1,
            mobile_2,
            email_1,
            email_2,
            branch_code,
            branch_id: branchIdField,
        } = req.body;

        const creatorUsername = req.username;
        const currentTime = new Date();
        const name = (nameField || branch_name || "").trim();
        const legalName = (legal_name || "").trim();

        if (!name || !legalName) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: name and legal_name",
            });
        }

        const explicitBranchId = (branchIdField || branch_code || "").trim();

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [userCheck] = await conn.query(
            "SELECT username FROM users WHERE username = ? AND status = '1'",
            [creatorUsername]
        );

        if (userCheck.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: `User '${creatorUsername}' not found`,
            });
        }

        let branch_id = explicitBranchId;
        if (!branch_id) {
            branch_id = await UNIQUE_RANDOM_STRING("branch_list", "branch_id", {
                length: SHORT_ID_LENGTH,
                conn,
                where: "is_deleted = '0'",
            });
        } else {
            const [existingBranch] = await conn.query(
                "SELECT branch_id FROM branch_list WHERE branch_id = ? AND is_deleted = '0'",
                [branch_id]
            );

            if (existingBranch.length > 0) {
                await conn.rollback();
                return res.status(409).json({
                    success: false,
                    message: "Branch ID already exists",
                });
            }
        }

        const map_id = await UNIQUE_RANDOM_STRING("branch_mapping", "map_id", {
            length: SHORT_ID_LENGTH,
            prefix: `MAP_${Date.now()}_`,
            conn,
        });
        const trimOrNull = (value) => {
            const trimmed = typeof value === "string" ? value.trim() : value;
            return trimmed || null;
        };
        const clipUrl = (value) => {
            const trimmed = trimOrNull(value);
            return trimmed ? trimmed.slice(0, 100) : null;
        };

        await conn.query(
            `INSERT INTO branch_list (
                branch_id, name, legal_name, username, logo, sign,
                create_by, modify_by, status,
                address_line_1, address_line_2, city, state, country, pincode,
                invoice_address, pan, is_pan_verified, gst, gst_rate, is_gst_verified,
                mobile_1, mobile_2, email_1, email_2,
                create_date, modify_date, is_deleted, deleted_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                branch_id,
                name,
                legalName,
                creatorUsername,
                clipUrl(logo),
                clipUrl(sign),
                creatorUsername,
                creatorUsername,
                "1",
                trimOrNull(address_line_1),
                trimOrNull(address_line_2),
                trimOrNull(city),
                trimOrNull(state),
                trimOrNull(country) || "India",
                trimOrNull(pincode),
                trimOrNull(invoice_address),
                trimOrNull(pan),
                "0",
                trimOrNull(gst),
                0,
                "0",
                trimOrNull(mobile_1),
                trimOrNull(mobile_2),
                trimOrNull(email_1),
                trimOrNull(email_2),
                currentTime,
                currentTime,
                "0",
                null,
            ]
        );

        await conn.query(
            `INSERT INTO branch_mapping (
                map_id, branch_id, username, designation,
                create_by, modify_by, type, is_accepted,
                invitation_token, status, is_deleted, deleted_by,
                create_date, modify_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                map_id,
                branch_id,
                creatorUsername,
                null,
                creatorUsername,
                creatorUsername,
                "admin",
                "1",
                null,
                "1",
                "0",
                null,
                currentTime,
                currentTime,
            ]
        );

        const setupSummary = await initializeBranchDefaults({
            branchId: branch_id,
            createdBy: creatorUsername,
            connection: conn,
        });

        await conn.commit();

        return res.status(201).json({
            success: true,
            message: "Branch created successfully",
            data: {
                branch_id,
                branch_name: name,
                name,
                owned: true,
                setup: setupSummary,
            },
        });
    } catch (err) {
        if (conn) {
            await conn.rollback();
        }
        console.error("CREATE BRANCH ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create branch",
            error: err.message,
        });
    } finally {
        if (conn) conn.release();
    }
});

router.get("/onboarding", auth, async (req, res) => {
    let conn;

    try {
        const username = req.username;
        conn = await pool.getConnection();

        const [branches] = await conn.query(
            `SELECT
                bl.branch_id,
                bl.name as branch_name,
                bm.type,
                CASE WHEN bl.username = ? THEN 1 ELSE 0 END as is_owner
             FROM branch_list bl
             INNER JOIN branch_mapping bm ON bl.branch_id = bm.branch_id
             WHERE bm.username = ?
               AND bm.is_accepted = '1'
               AND bm.status = '1'
               AND bm.is_deleted = '0'
               AND bl.is_deleted = '0'
             ORDER BY bm.create_date DESC`,
            [username, username]
        );

        const [invitations] = await conn.query(
            `SELECT
                bm.map_id,
                bm.branch_id,
                bl.name as branch_name,
                bm.type as role,
                bm.designation,
                bm.create_by as invited_by,
                bm.create_date as invited_date,
                bm.invitation_token
             FROM branch_mapping bm
             LEFT JOIN branch_list bl ON bl.branch_id = bm.branch_id
             WHERE bm.username = ?
               AND bm.is_accepted = '0'
               AND bm.status = '1'
               AND bm.is_deleted = '0'
               AND (bl.is_deleted = '0' OR bl.is_deleted IS NULL)
             ORDER BY bm.create_date DESC`,
            [username]
        );

        for (const invitation of invitations) {
            const [inviter] = await conn.query(
                `SELECT p.email AS invited_by_name
                 FROM profile p
                 WHERE p.username = ? AND p.status = '1'
                 LIMIT 1`,
                [invitation.invited_by]
            );
            invitation.invited_by_name = inviter[0]?.invited_by_name || invitation.invited_by;
        }

        const normalizedBranches = branches.map((branch) => ({
            branch_id: branch.branch_id,
            name: branch.branch_name,
            branch_name: branch.branch_name,
            owned: branch.type === "admin" || branch.is_owner === 1,
            role: branch.type,
        }));

        return res.status(200).json({
            success: true,
            data: {
                has_branch: normalizedBranches.length > 0,
                branches: normalizedBranches,
                pending_invitations: invitations,
                pending_count: invitations.length,
            },
        });
    } catch (err) {
        console.error("GET BRANCH ONBOARDING ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to load branch onboarding status",
        });
    } finally {
        if (conn) conn.release();
    }
});

// Get Branch by ID - GET /branch/:branch_id
router.get("/:branch_id", auth, async (req, res) => {
    let conn;

    try {
        const { branch_id } = req.params;
        const username = req.username;

        conn = await pool.getConnection();

        // Check if user has access to this branch through mapping
        const [access] = await conn.query(
            `SELECT * FROM branch_mapping 
             WHERE branch_id = ? 
               AND username = ? 
               AND is_accepted = '1' 
               AND status = '1' 
               AND is_deleted = '0'`,
            [branch_id, username]
        );

        if (access.length === 0) {
            return res.status(403).json({
                success: false,
                message: "User is not mapped to this branch or mapping is not active"
            });
        }

        // Fetch branch details
        const [branches] = await conn.query(
            `SELECT 
                branch_id, name as branch_name,
                address_line_1, address_line_2, city, state, country, pincode,
                invoice_address, pan, gst, gst_rate,
                mobile_1, mobile_2, email_1, email_2,
                username as created_by, create_date, status
             FROM branch_list 
             WHERE branch_id = ? AND is_deleted = '0'`,
            [branch_id]
        );

        if (branches.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Branch not found"
            });
        }

        return res.status(200).json({
            success: true,
            data: branches[0]
        });

    } catch (err) {
        console.error("GET BRANCH ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branch"
        });
    } finally {
        if (conn) conn.release();
    }
});

// Update Branch - PUT /branch/:branch_id
router.put("/:branch_id", auth, async (req, res) => {
    let conn;

    try {
        const { branch_id } = req.params;
        const username = req.username;
        const updates = req.body;

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Check if user has admin access to this branch
        const [access] = await conn.query(
            `SELECT * FROM branch_mapping 
             WHERE branch_id = ? 
               AND username = ? 
               AND type = 'admin' 
               AND is_accepted = '1' 
               AND status = '1' 
               AND is_deleted = '0'`,
            [branch_id, username]
        );

        if (access.length === 0) {
            await conn.rollback();
            return res.status(403).json({
                success: false,
                message: "You don't have permission to update this branch"
            });
        }

        // Build dynamic update query
        const allowedFields = [
            'name', 'address_line_1', 'address_line_2', 'city', 'state',
            'country', 'pincode', 'invoice_address', 'pan', 'gst', 'gst_rate',
            'mobile_1', 'mobile_2', 'email_1', 'email_2', 'status'
        ];

        const updateFields = [];
        const updateValues = [];

        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                updateFields.push(`${field} = ?`);
                updateValues.push(updates[field]);
            }
        }

        if (updateFields.length === 0) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "No fields to update"
            });
        }

        updateFields.push("modify_by = ?");
        updateValues.push(username);

        updateFields.push("modify_date = CURRENT_TIMESTAMP");

        const query = `UPDATE branch_list SET ${updateFields.join(", ")} WHERE branch_id = ? AND is_deleted = '0'`;
        updateValues.push(branch_id);

        await conn.query(query, updateValues);
        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Branch updated successfully"
        });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error("UPDATE BRANCH ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update branch"
        });
    } finally {
        if (conn) conn.release();
    }
});

// Get all branches for current user
router.get("/user/branches", auth, async (req, res) => {
    let conn;

    try {
        const username = req.username;

        conn = await pool.getConnection();

        const [branches] = await conn.query(
            `SELECT 
                bl.branch_id, 
                bl.name as branch_name,
                bl.address_line_1, 
                bl.city, 
                bl.state, 
                bl.country,
                bl.mobile_1, 
                bl.email_1,
                bm.type, 
                bm.is_accepted, 
                bm.create_date as joined_date,
                CASE WHEN bl.username = ? THEN 1 ELSE 0 END as is_owner
             FROM branch_list bl
             INNER JOIN branch_mapping bm ON bl.branch_id = bm.branch_id
             WHERE bm.username = ? 
               AND bm.is_accepted = '1' 
               AND bm.status = '1' 
               AND bm.is_deleted = '0'
               AND bl.is_deleted = '0'
             ORDER BY bm.create_date DESC`,
            [username, username]
        );

        return res.status(200).json({
            success: true,
            data: branches
        });

    } catch (err) {
        console.error("GET USER BRANCHES ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branches"
        });
    } finally {
        if (conn) conn.release();
    }
});

// Get my invitations - FIXED query
router.get("/invitations/my-invitations", auth, async (req, res) => {
    let conn;

    try {
        const username = req.username;

        console.log('Fetching invitations for user:', username);

        conn = await pool.getConnection();

        // FIXED: Changed 'bl.branch_code' to 'bl.branch_id'
        const [invitations] = await conn.query(
            `SELECT 
                bm.map_id,
                bm.branch_id, 
                bl.name as branch_name, 
                bl.branch_id as branch_code,  -- Use branch_id as branch_code
                bl.address_line_1,
                bl.city,
                bl.state,
                bm.type as role,
                bm.designation,
                bm.create_by as invited_by,
                bm.create_date as invited_date,
                bm.invitation_token,
                bm.is_accepted,
                bm.status
             FROM branch_mapping bm
             LEFT JOIN branch_list bl ON bl.branch_id = bm.branch_id
             WHERE bm.username = ? 
               AND bm.is_accepted = '0' 
               AND bm.status = '1' 
               AND bm.is_deleted = '0'
               AND (bl.is_deleted = '0' OR bl.is_deleted IS NULL)
             ORDER BY bm.create_date DESC`,
            [username]
        );

        // Get inviter names
        for (let invitation of invitations) {
            const [inviter] = await conn.query(
                `SELECT p.email AS invited_by_name
                 FROM profile p
                 WHERE p.username = ? AND p.status = '1'
                 LIMIT 1`,
                [invitation.invited_by]
            );
            invitation.invited_by_name = inviter[0]?.invited_by_name || invitation.invited_by;
        }

        return res.status(200).json({
            success: true,
            message: invitations.length > 0 ? "Pending invitations found" : "No pending invitations",
            data: {
                total_invitations: invitations.length,
                invitations: invitations
            }
        });

    } catch (err) {
        console.error("GET USER INVITATIONS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch invitations",
            error: err.message
        });
    } finally {
        if (conn) conn.release();
    }
});

// Accept branch invitation
router.post("/invitations/accept/:token", async (req, res) => {
    let conn;

    try {
        const { token } = req.params;
        const { username } = req.body;

        if (!token || !username) {
            return res.status(400).json({
                success: false,
                message: "Token and username are required"
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Find invitation
        const [invitation] = await conn.query(
            `SELECT * FROM branch_mapping 
             WHERE invitation_token = ? 
               AND username = ? 
               AND is_accepted = '0' 
               AND status = '1' 
               AND is_deleted = '0'`,
            [token, username]
        );

        if (invitation.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Invalid or expired invitation"
            });
        }

        // Update invitation to accepted
        await conn.query(
            `UPDATE branch_mapping 
             SET is_accepted = '1', modify_date = CURRENT_TIMESTAMP 
             WHERE invitation_token = ?`,
            [token]
        );

        // Get branch details
        const [branch] = await conn.query(
            `SELECT branch_id, name as branch_name 
             FROM branch_list 
             WHERE branch_id = ? AND is_deleted = '0'`,
            [invitation[0].branch_id]
        );

        await conn.commit();

        const branchRole = invitation[0].type;
        const isOwner = branchRole === "admin";

        return res.status(200).json({
            success: true,
            message: "Invitation accepted successfully",
            data: {
                branch_id: branch[0].branch_id,
                branch_name: branch[0].branch_name,
                name: branch[0].branch_name,
                role: branchRole,
                owned: isOwner,
            }
        });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error("ACCEPT INVITATION ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to accept invitation"
        });
    } finally {
        if (conn) conn.release();
    }
});

// Verify invitation token - FIXED
router.get("/invitations/verify/:token", async (req, res) => {
    let conn;

    try {
        const { token } = req.params;

        conn = await pool.getConnection();

        // FIXED: Changed 'bl.branch_code' to 'bl.branch_id'
        const [invitations] = await conn.query(
            `SELECT 
                bm.branch_id, 
                bl.name as branch_name, 
                bl.branch_id as branch_code,  -- Use branch_id as branch_code
                bm.type as role,
                bm.username as invited_user,
                p.email as invited_email,
                bm.create_by as invited_by,
                bm.designation
             FROM branch_mapping bm
             LEFT JOIN branch_list bl ON bl.branch_id = bm.branch_id
             LEFT JOIN profile p ON p.username = bm.username AND p.status = '1'
             LEFT JOIN users u ON u.username = bm.username
             WHERE bm.invitation_token = ? 
               AND bm.is_accepted = '0' 
               AND bm.status = '1' 
               AND bm.is_deleted = '0'
               AND bl.is_deleted = '0'`,
            [token]
        );

        if (invitations.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Invalid or expired invitation"
            });
        }

        const [inviter] = await conn.query(
            `SELECT p.email AS invited_by_name
             FROM profile p
             WHERE p.username = ? AND p.status = '1'
             LIMIT 1`,
            [invitations[0].invited_by]
        );

        return res.status(200).json({
            success: true,
            data: {
                ...invitations[0],
                invited_by_name: inviter[0]?.invited_by_name || invitations[0].invited_by
            }
        });

    } catch (err) {
        console.error("VERIFY INVITATION ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to verify invitation"
        });
    } finally {
        if (conn) conn.release();
    }
});

router.post("/:branch_id/invite", auth, async (req, res) => {
    let conn;

    try {
        const { branch_id } = req.params;
        const { email, role, designation } = req.body;
        const invitedBy = req.username;

        if (!branch_id || !email) {
            return res.status(400).json({
                success: false,
                message: "Branch ID and email are required"
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Check if inviter has admin access
        const [adminAccess] = await conn.query(
            `SELECT * FROM branch_mapping 
             WHERE branch_id = ? 
               AND username = ? 
               AND type = 'admin' 
               AND is_accepted = '1' 
               AND status = '1' 
               AND is_deleted = '0'`,
            [branch_id, invitedBy]
        );

        if (adminAccess.length === 0) {
            await conn.rollback();
            return res.status(403).json({
                success: false,
                message: "Only branch admins can invite users"
            });
        }

        const resolvedUser = await resolveSoftwareUserByContact(conn, email);

        if (!resolvedUser) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "User not found with this email or mobile"
            });
        }

        const invitedUsername = resolvedUser.username;

        // Check if already mapped
        const [existingMapping] = await conn.query(
            `SELECT * FROM branch_mapping 
             WHERE branch_id = ? AND username = ? AND is_deleted = '0'`,
            [branch_id, invitedUsername]
        );

        if (existingMapping.length > 0) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: "User already has access to this branch"
            });
        }

        // Create mapping for invited user
        const currentTime = new Date();
        const map_id = await UNIQUE_RANDOM_STRING("branch_mapping", "map_id", {
            length: SHORT_ID_LENGTH,
            prefix: `MAP_${Date.now()}_`,
            conn,
        });
        const invitation_token = RANDOM_STRING(50);

        await conn.query(
            `INSERT INTO branch_mapping (
                map_id, branch_id, username, type, designation, is_accepted, 
                invitation_token, status, create_date, create_by, is_deleted
            ) VALUES (?, ?, ?, ?, ?, '0', ?, '1', ?, ?, '0')`,
            [map_id, branch_id, invitedUsername, role || 'staff', designation || null,
                invitation_token, currentTime, invitedBy]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Invitation sent successfully",
            invitation_token: invitation_token
        });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error("INVITE USER ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to invite user"
        });
    } finally {
        if (conn) conn.release();
    }
});

export default router;