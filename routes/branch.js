// routes/branchRoutes.js
import express from "express";
import pool from "../db.js";
import { RANDOM_STRING } from "../helpers/function.js";

const router = express.Router();
// ==================== AUTH MIDDLEWARE ====================
// branchRoutes.js - Update auth middleware

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
        
        console.log('=== AUTH MIDDLEWARE ===');
        console.log('All headers:', JSON.stringify(req.headers, null, 2));
        console.log('Username from header:', username);
        console.log('Token from header:', token ? 'Present' : 'Missing');
        
        if (!username || !token) {
            return res.status(401).json({
                success: false,
                message: "Missing authentication headers",
                debug: { username: !!username, token: !!token }
            });
        }
        
        conn = await pool.getConnection();
        
        // FIX: Try to find user by username OR login_id (email)
        const [users] = await conn.query(
            `SELECT username, login_id, status FROM users 
             WHERE (username = ? OR login_id = ?) AND status = '1'`,
            [username, username]  // Try both username and email
        );
        
        console.log('User found in database:', users.length > 0);
        
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
        
        console.log('Token valid:', tokens.length > 0);
        
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
        req.userEmail = users[0].login_id;
        
        console.log('Auth successful for user:', req.username);
        
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
// ==================== API ====================
// Complete corrected CREATE API


router.post("/create", auth, async (req, res) => {
    let conn;
    
    try {
        const {
            branch_name,
            branch_code,
            address_line_1,
            address_line_2,
            city,
            state,
            country,
            pincode,
            invoice_address,
            pan,
            gst,
            gst_rate,
            mobile_1,
            mobile_2,
            email_1,
            email_2,
            is_head_office
        } = req.body;
        
        // Get creator username from auth middleware
        const creatorUsername = req.username;
        const currentTime = new Date();
        
        console.log('=== CREATE BRANCH ===');
        console.log('Creator Username:', creatorUsername);
        console.log('Branch Name:', branch_name);
        console.log('Branch Code:', branch_code);
        
        // Validate required fields
        if (!branch_name || !branch_code || !address_line_1 || !city || !state) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: branch_name, branch_code, address_line_1, city, state"
            });
        }
        
        conn = await pool.getConnection();
        await conn.beginTransaction();
        
        // Double check user exists in users table
        const [userCheck] = await conn.query(
            "SELECT username, login_id, status FROM users WHERE username = ? AND status = '1'",
            [creatorUsername]
        );
        
        if (userCheck.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: `User '${creatorUsername}' not found in users table`
            });
        }
        console.log('User verification successful for:', creatorUsername);
        console.log('User verified:', userCheck[0]);
        
        const branch_id = branch_code;
        
        // Check if branch_id already exists
        const [existingBranch] = await conn.query(
            "SELECT branch_id FROM branch_list WHERE branch_id = ? AND is_deleted = '0'",
            [branch_id]
        );
        
        if (existingBranch.length > 0) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: "Branch ID already exists. Please use a different branch code."
            });
        }
        
        // Generate unique IDs
        const map_id = `MAP_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const profile_id = `PROF_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        
        // 1. INSERT INTO profile table (using same branch data)
        await conn.query(
            `INSERT INTO profile (
                profile_id, username, create_by, user_type, name,
                care_of, guardian_name, date_of_birth, gender, mobile,
                country_code, email, pan_number, country, state,
                city, district, village_town, address_line_1,
                address_line_2, pincode, image, status, create_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                profile_id,                          // profile_id
                creatorUsername,                     // username
                creatorUsername,                     // create_by
                'branch_admin',                      // user_type
                branch_name,                         // name (from branch)
                null,                                // care_of
                null,                                // guardian_name
                null,                                // date_of_birth
                null,                                // gender
                mobile_1,                            // mobile (from branch)
                '+91',                               // country_code
                email_1,                             // email (from branch)
                pan,                                 // pan_number (from branch)
                country || 'India',                  // country (from branch)
                state,                               // state (from branch)
                city,                                // city (from branch)
                city,                                // district (using city from branch)
                null,                                // village_town
                address_line_1,                      // address_line_1 (from branch)
                address_line_2 || null,              // address_line_2 (from branch)
                pincode || null,                     // pincode (from branch)
                null,                                // image
                '1',                                 // status
                currentTime                          // create_date
            ]
        );
        
        console.log('Profile inserted for user:', creatorUsername);
        
        // 2. INSERT INTO branch_list
        await conn.query(
            `INSERT INTO branch_list (
                branch_id, name, username, logo, sign, 
                create_by, modify_by, status,
                address_line_1, address_line_2, city, state, country, pincode, 
                invoice_address, pan, is_pan_verified, gst, gst_rate, is_gst_verified,
                mobile_1, mobile_2, email_1, email_2, 
                create_date, modify_date, is_deleted, deleted_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                branch_id,                           // branch_id
                branch_name,                         // name
                creatorUsername,                     // username (creator's username)
                null,                                // logo
                null,                                // sign
                creatorUsername,                     // create_by (creator)
                creatorUsername,                     // modify_by (creator)
                '1',                                 // status (active)
                address_line_1,                      // address_line_1
                address_line_2 || null,              // address_line_2
                city,                                // city
                state,                               // state
                country || 'India',                  // country
                pincode || null,                     // pincode
                invoice_address || null,             // invoice_address
                pan || null,                         // pan
                '0',                                 // is_pan_verified
                gst || null,                         // gst
                gst_rate || 0,                       // gst_rate
                '0',                                 // is_gst_verified
                mobile_1,                            // mobile_1
                mobile_2 || null,                    // mobile_2
                email_1 || null,                     // email_1
                email_2 || null,                     // email_2
                currentTime,                         // create_date
                currentTime,                         // modify_date
                '0',                                 // is_deleted
                null                                 // deleted_by
            ]
        );
        
        console.log('Branch inserted into branch_list');
        
        // 3. INSERT INTO branch_mapping
        await conn.query(
            `INSERT INTO branch_mapping (
                map_id, branch_id, username, designation, 
                create_by, modify_by, type, is_accepted, 
                invitation_token, status, is_deleted, deleted_by, 
                create_date, modify_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                map_id,                              // map_id
                branch_id,                           // branch_id
                creatorUsername,                     // username
                null,                                // designation
                creatorUsername,                     // create_by
                creatorUsername,                     // modify_by
                'admin',                             // type
                '1',                                 // is_accepted
                null,                                // invitation_token
                '1',                                 // status
                '0',                                 // is_deleted
                null,                                // deleted_by
                currentTime,                         // create_date
                currentTime                          // modify_date
            ]
        );
        
        console.log('Branch mapping inserted for user:', creatorUsername);
        
        await conn.commit();
        
        // Fetch created branch with all info
        const [newBranch] = await conn.query(
            `SELECT 
                bl.branch_id, 
                bl.name as branch_name,
                bl.username as owner_username,
                bl.create_by,
                bl.create_date,
                bl.modify_by,
                bl.modify_date,
                bl.city, 
                bl.state, 
                bl.country,
                bl.mobile_1, 
                bl.email_1,
                bl.pan,
                bl.address_line_1,
                bl.pincode,
                bm.type as user_role,
                bm.is_accepted
             FROM branch_list bl
             LEFT JOIN branch_mapping bm ON bl.branch_id = bm.branch_id 
                AND bm.username = ? 
                AND bm.is_deleted = '0'
             WHERE bl.branch_id = ? AND bl.is_deleted = '0'`,
            [creatorUsername, branch_id]
        );
        
        // Fetch the created profile
        const [newProfile] = await conn.query(
            `SELECT 
                profile_id, 
                name, 
                email, 
                mobile, 
                pan_number,
                address_line_1,
                city,
                state,
                country,
                pincode,
                user_type,
                create_date
             FROM profile 
             WHERE username = ? AND status = '1'`,
            [creatorUsername]
        );
        
        console.log('Branch and Profile creation completed successfully');
        
        return res.status(201).json({
            success: true,
            message: "Branch created successfully with profile",
            data: {
                branch: {
                    branch_id: newBranch[0].branch_id,
                    branch_name: newBranch[0].branch_name,
                    owner_username: newBranch[0].owner_username,
                    created_by: newBranch[0].create_by,
                    created_date: newBranch[0].create_date,
                    modified_by: newBranch[0].modify_by,
                    modified_date: newBranch[0].modify_date,
                    address_line_1: newBranch[0].address_line_1,
                    city: newBranch[0].city,
                    state: newBranch[0].state,
                    country: newBranch[0].country,
                    pincode: newBranch[0].pincode,
                    mobile: newBranch[0].mobile_1,
                    email: newBranch[0].email_1,
                    pan: newBranch[0].pan,
                    user_role: newBranch[0].user_role,
                    is_accepted: newBranch[0].is_accepted
                },
                profile: newProfile[0] || null
            }
        });
        
    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("CREATE BRANCH ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create branch",
            error: err.message
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
                "SELECT login_id as invited_by_name FROM users WHERE username = ?",
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
// Invite user to branch


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
        
        return res.status(200).json({
            success: true,
            message: "Invitation accepted successfully",
            data: {
                branch_id: branch[0].branch_id,
                branch_name: branch[0].branch_name,
                role: invitation[0].type
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
                u.login_id as invited_email,
                bm.create_by as invited_by,
                bm.designation
             FROM branch_mapping bm
             LEFT JOIN branch_list bl ON bl.branch_id = bm.branch_id
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
            "SELECT login_id as invited_by_name FROM users WHERE username = ?",
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
        
        // Find user by email
        const [user] = await conn.query(
            "SELECT username FROM users WHERE login_id = ? AND status = '1'",
            [email]
        );
        
        if (user.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "User not found with this email"
            });
        }
        
        const invitedUsername = user[0].username;
        
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
        const map_id = `MAP_${Date.now()}_${RANDOM_STRING(6)}`;
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

//old without profile creation
// router.post("/create", auth, async (req, res) => {
//     let conn;
    
//     try {
//         const {
//             branch_name,
//             branch_code,
//             address_line_1,
//             address_line_2,
//             city,
//             state,
//             country,
//             pincode,
//             invoice_address,
//             pan,
//             gst,
//             gst_rate,
//             mobile_1,
//             mobile_2,
//             email_1,
//             email_2,
//             is_head_office
//         } = req.body;
        
//         // Get creator username from auth middleware
//         const creatorUsername = req.username;
//         const currentTime = new Date();
        
//         console.log('=== CREATE BRANCH ===');
//         console.log('Creator Username:', creatorUsername);
//         console.log('Branch Name:', branch_name);
//         console.log('Branch Code:', branch_code);
        
//         // Validate required fields
//         if (!branch_name || !branch_code || !address_line_1 || !city || !state) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Missing required fields: branch_name, branch_code, address_line_1, city, state"
//             });
//         }
        
//         conn = await pool.getConnection();
//         await conn.beginTransaction();
        
//         // Double check user exists in users table
//         const [userCheck] = await conn.query(
//             "SELECT username, login_id, status FROM users WHERE username = ? AND status = '1'",
//             [creatorUsername]
//         );
        
//         if (userCheck.length === 0) {
//             await conn.rollback();
//             return res.status(404).json({
//                 success: false,
//                 message: `User '${creatorUsername}' not found in users table`
//             });
//         }
//         console.log('User verification successful for:', creatorUsername);
//         console.log('User verified:', userCheck[0]);
        
//         const branch_id = branch_code;
        
//         // Check if branch_id already exists
//         const [existingBranch] = await conn.query(
//             "SELECT branch_id FROM branch_list WHERE branch_id = ? AND is_deleted = '0'",
//             [branch_id]
//         );
        
//         if (existingBranch.length > 0) {
//             await conn.rollback();
//             return res.status(409).json({
//                 success: false,
//                 message: "Branch ID already exists. Please use a different branch code."
//             });
//         }
        
//         // Generate unique map_id for branch_mapping
//         const map_id = `MAP_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        
//         // 1. INSERT INTO branch_list
//         await conn.query(
//             `INSERT INTO branch_list (
//                 branch_id, name, username, logo, sign, 
//                 create_by, modify_by, status,
//                 address_line_1, address_line_2, city, state, country, pincode, 
//                 invoice_address, pan, is_pan_verified, gst, gst_rate, is_gst_verified,
//                 mobile_1, mobile_2, email_1, email_2, 
//                 create_date, modify_date, is_deleted, deleted_by
//             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//             [
//                 branch_id,                           // branch_id
//                 branch_name,                         // name
//                 creatorUsername,                     // username (creator's username)
//                 null,                                // logo
//                 null,                                // sign
//                 creatorUsername,                     // create_by (creator)
//                 creatorUsername,                     // modify_by (creator)
//                 '1',                                 // status (active)
//                 address_line_1,                      // address_line_1
//                 address_line_2 || null,              // address_line_2
//                 city,                                // city
//                 state,                               // state
//                 country || 'India',                  // country
//                 pincode || null,                     // pincode
//                 invoice_address || null,             // invoice_address
//                 pan || null,                         // pan
//                 '0',                                 // is_pan_verified
//                 gst || null,                         // gst
//                 gst_rate || 0,                       // gst_rate
//                 '0',                                 // is_gst_verified
//                 mobile_1,                            // mobile_1
//                 mobile_2 || null,                    // mobile_2
//                 email_1 || null,                     // email_1
//                 email_2 || null,                     // email_2
//                 currentTime,                         // create_date
//                 currentTime,                         // modify_date
//                 '0',                                 // is_deleted
//                 null                                 // deleted_by
//             ]
//         );
        
//         console.log('Branch inserted into branch_list');
        
//         // 2. INSERT INTO branch_mapping
//         await conn.query(
//             `INSERT INTO branch_mapping (
//                 map_id, branch_id, username, designation, 
//                 create_by, modify_by, type, is_accepted, 
//                 invitation_token, status, is_deleted, deleted_by, 
//                 create_date, modify_date
//             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//             [
//                 map_id,                              // map_id
//                 branch_id,                           // branch_id
//                 creatorUsername,                     // username
//                 null,                                // designation
//                 creatorUsername,                     // create_by
//                 creatorUsername,                     // modify_by
//                 'admin',                             // type
//                 '1',                                 // is_accepted
//                 null,                                // invitation_token
//                 '1',                                 // status
//                 '0',                                 // is_deleted
//                 null,                                // deleted_by
//                 currentTime,                         // create_date
//                 currentTime                          // modify_date
//             ]
//         );
        
//         console.log('Branch mapping inserted for user:', creatorUsername);
        
//         await conn.commit();
        
//         // Fetch created branch with all info
//         const [newBranch] = await conn.query(
//             `SELECT 
//                 bl.branch_id, 
//                 bl.name as branch_name,
//                 bl.username as owner_username,
//                 bl.create_by,
//                 bl.create_date,
//                 bl.modify_by,
//                 bl.modify_date,
//                 bl.city, 
//                 bl.state, 
//                 bl.country,
//                 bl.mobile_1, 
//                 bl.email_1,
//                 bm.type as user_role,
//                 bm.is_accepted,
//                 bm.create_by as mapping_created_by,
//                 bm.create_date as mapping_created_date
//              FROM branch_list bl
//              LEFT JOIN branch_mapping bm ON bl.branch_id = bm.branch_id 
//                 AND bm.username = ? 
//                 AND bm.is_deleted = '0'
//              WHERE bl.branch_id = ? AND bl.is_deleted = '0'`,
//             [creatorUsername, branch_id]
//         );
        
//         console.log('Branch creation completed successfully');
        
//         return res.status(201).json({
//             success: true,
//             message: "Branch created successfully",
//             data: {
//                 branch_id: newBranch[0].branch_id,
//                 branch_name: newBranch[0].branch_name,
//                 owner_username: newBranch[0].owner_username,
//                 created_by: newBranch[0].create_by,
//                 created_date: newBranch[0].create_date,
//                 modified_by: newBranch[0].modify_by,
//                 modified_date: newBranch[0].modify_date,
//                 city: newBranch[0].city,
//                 state: newBranch[0].state,
//                 country: newBranch[0].country,
//                 mobile: newBranch[0].mobile_1,
//                 email: newBranch[0].email_1,
//                 user_role: newBranch[0].user_role,
//                 is_accepted: newBranch[0].is_accepted
//             }
//         });
        
//     } catch (err) {
//         if (conn) {
//             await conn.rollback();
//             conn.release();
//         }
//         console.error("CREATE BRANCH ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to create branch",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

export default router;