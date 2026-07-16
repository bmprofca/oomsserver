import express from 'express';
const router = express.Router();

import { checkSubscription, requirePlan } from "../middleware/auth.js";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE, RANDOM_STRING, UNIQUE_RANDOM_STRING, SHORT_ID_LENGTH, USER_DATA } from "../helpers/function.js";
import { BASE_INVITATION_LINK, APP_NAME, BASE_DOMAIN } from '../helpers/Config.js';
import { buildBranchLogoUrl, buildProfileImageUrl } from '../helpers/mediaUrl.js';
import { SendMail } from '../helpers/Mail.js';
import { resolveSoftwareUserByContact } from "../helpers/authProfile.js";

const ALL_PAID_PLANS = ['Business', 'BusinessPlus', 'BusinessPro'];

router.use(checkSubscription, requirePlan(ALL_PAID_PLANS));

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

async function getTableColumns(tableName) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map(r => r.Field));
}

async function insertRow(tableName, data) {
    const columns = await getTableColumns(tableName);
    const entries = Object.entries(data).filter(([k]) => columns.has(k));

    if (entries.length === 0) {
        throw new Error(`No valid columns to insert into ${tableName}`);
    }

    const keys = entries.map(([k]) => `\`${k}\``).join(", ");
    const placeholders = entries.map(() => "?").join(", ");
    const values = entries.map(([, v]) => v);

    const [result] = await pool.query(
        `INSERT INTO \`${tableName}\` (${keys}) VALUES (${placeholders})`,
        values
    );

    return result;
}

// Helper function to generate invitation email HTML template
function generateInvitationEmailHTML(invitationLink, staffName, designation, branchName = '') {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Branch Invitation - ${APP_NAME}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            background-color: #f4f4f4;
        }
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
        }
        .email-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px 30px;
            text-align: center;
        }
        .email-header h1 {
            color: #ffffff;
            font-size: 28px;
            font-weight: 600;
            margin-bottom: 10px;
        }
        .email-header p {
            color: rgba(255, 255, 255, 0.9);
            font-size: 16px;
        }
        .email-body {
            padding: 40px 30px;
        }
        .greeting {
            font-size: 18px;
            color: #333333;
            margin-bottom: 20px;
        }
        .message {
            font-size: 16px;
            color: #555555;
            margin-bottom: 30px;
            line-height: 1.8;
        }
        .invitation-details {
            background-color: #f8f9fa;
            border-left: 4px solid #667eea;
            padding: 20px;
            margin: 30px 0;
            border-radius: 4px;
        }
        .invitation-details p {
            margin: 8px 0;
            color: #555555;
        }
        .invitation-details strong {
            color: #333333;
        }
        .cta-button {
            display: inline-block;
            padding: 16px 40px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #ffffff !important;
            text-decoration: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            text-align: center;
            margin: 30px 0;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
        }
        .button-container {
            text-align: center;
            margin: 30px 0;
        }
        .alternative-link {
            margin-top: 30px;
            padding: 20px;
            background-color: #f8f9fa;
            border-radius: 8px;
            font-size: 14px;
            color: #666666;
            word-break: break-all;
        }
        .alternative-link p {
            margin: 5px 0;
        }
        .alternative-link a {
            color: #667eea;
            text-decoration: none;
        }
        .email-footer {
            background-color: #f8f9fa;
            padding: 30px;
            text-align: center;
            border-top: 1px solid #e0e0e0;
        }
        .email-footer p {
            color: #888888;
            font-size: 14px;
            margin: 5px 0;
        }
        .email-footer a {
            color: #667eea;
            text-decoration: none;
        }
        .divider {
            height: 1px;
            background-color: #e0e0e0;
            margin: 30px 0;
        }
        @media only screen and (max-width: 600px) {
            .email-body {
                padding: 30px 20px;
            }
            .email-header {
                padding: 30px 20px;
            }
            .email-header h1 {
                font-size: 24px;
            }
            .cta-button {
                padding: 14px 30px;
                font-size: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="email-header">
            <h1>🎉 You're Invited!</h1>
            <p>Join our team on ${APP_NAME}</p>
        </div>
        
        <div class="email-body">
            <div class="greeting">
                Hello ${staffName || 'there'}!
            </div>
            
            <div class="message">
                You have been invited to join as a staff member${designation ? ` with the designation of <strong>${designation}</strong>` : ''}${branchName ? ` at <strong>${branchName}</strong>` : ''}.
            </div>
            
            <div class="invitation-details">
                <p><strong>What's next?</strong></p>
                <p>Click the button below to accept this invitation and get started. This link will allow you to access your account and begin working with the team.</p>
            </div>
            
            <div class="button-container">
                <a href="${invitationLink}" class="cta-button">Accept Invitation</a>
            </div>
            
            <div class="alternative-link">
                <p><strong>Or copy and paste this link into your browser:</strong></p>
                <p><a href="${invitationLink}">${invitationLink}</a></p>
            </div>
            
            <div class="divider"></div>
            
            <div class="message" style="font-size: 14px; color: #888888;">
                <strong>Note:</strong> This invitation link will expire after a certain period. If you have any questions or need assistance, please contact your administrator.
            </div>
        </div>
        
        <div class="email-footer">
            <p>This is an automated email from <strong>${APP_NAME}</strong></p>
            <p>Please do not reply to this email.</p>
            <p style="margin-top: 15px;">
                <a href="${BASE_INVITATION_LINK}">Visit ${APP_NAME}</a>
            </p>
        </div>
    </div>
</body>
</html>
    `;
}


router.get('/settings-list', (req, res) => {
    try {
        const settingsList = [
            {
                id: 'staff-list',
                title: 'Staff List',
                description: 'Add, edit & delete staff members',
                icon: 'users',
                route: '/settings/staff'
            },
            {
                id: 'staff-permissions',
                title: 'Staff Permissions',
                description: 'Add, edit & delete staff permissions and roles',
                icon: 'shield-check',
                route: '/settings/permissions'
            },
            {
                id: 'invoice-setting',
                title: 'Invoice Setting',
                description: 'Voucher configuration and invoice templates',
                icon: 'file-text',
                route: '/settings/invoice'
            },
            {
                id: 'app-settings',
                title: 'App Settings',
                description: 'Configure your app preferences and general settings',
                icon: 'settings',
                route: '/settings/app'
            },
            {
                id: 'email-configuration',
                title: 'Email Configuration',
                description: 'Set your own SMTP server and email settings',
                icon: 'mail',
                route: '/settings/email'
            },
            {
                id: 'whatsapp-ooms',
                title: 'WhatsApp OOMS',
                description: 'Scan to connect WhatsApp with OOMS system',
                icon: 'message-circle',
                route: '/settings/whatsapp-ooms'
            },
            {
                id: 'whatsapp-w1chat',
                title: 'WhatsApp W1Chat',
                description: 'Connect W1Chat with OOMS for enhanced messaging',
                icon: 'message-square',
                route: '/settings/whatsapp-w1chat'
            },
            {
                id: 'default-daterange',
                title: 'Default Daterange',
                description: 'Edit default date range for reports and filters',
                icon: 'calendar',
                route: '/settings/daterange'
            },
            {
                id: 'google-2fa',
                title: 'Google 2FA',
                description: 'Google authenticator two-factor authentication setup',
                icon: 'shield',
                route: '/settings/2fa'
            },
            {
                id: 'gateway',
                title: 'Gateway',
                description: 'Configure payment gateway settings and options',
                icon: 'credit-card',
                route: '/settings/gateway'
            },
            {
                id: 'branch-list',
                title: 'Branch List',
                description: 'Add, edit & view branch locations and details',
                icon: 'map-pin',
                route: '/settings/branches'
            },
            {
                id: 'manage-admin',
                title: 'Manage Admin',
                description: 'Add, edit & view admin users and their privileges',
                icon: 'user-check',
                route: '/settings/admins'
            }
        ];

        res.status(200).json({
            success: true,
            message: 'Settings list retrieved successfully',
            data: settingsList,
            total: settingsList.length,
        });
    } catch (error) {
        console.error('Error fetching settings list:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve settings list',
            error: error.message
        });
    }
});

router.post('/create', auth, validateBranch, async (req, res) => {

    try {
        const { username, designation } = req.body || {};
        const branch_id = req.branch_id;
        const createdBy = req.headers["username"] || "";

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameter: username"
            });
        }

        // Verify user exists in users table
        const [userRows] = await pool.query(
            "SELECT username FROM users WHERE username = ? LIMIT 1",
            [username]
        );

        if (!userRows || userRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found. Create the user first, then assign to branch."
            });
        }

        const resolvedUsername = userRows[0].username;

        // Get user data for email
        const userData = await USER_DATA(resolvedUsername);
        const userEmail = userData?.email || null;
        const userName = userData?.name || resolvedUsername;

        // Get branch name for email
        const [branchRows] = await pool.query(
            "SELECT branch_name FROM branch_list WHERE branch_id = ? LIMIT 1",
            [branch_id]
        ).catch(() => []);
        const branchName = branchRows?.[0]?.branch_name || null;

        // If already mapped (not deleted), return success
        const [existingMap] = await pool.query(
            "SELECT id, map_id FROM branch_mapping WHERE username = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0) LIMIT 1",
            [resolvedUsername, branch_id]
        ).catch(async () => {
            // Fallback if is_deleted column doesn't exist
            const [rows] = await pool.query(
                "SELECT id, map_id FROM branch_mapping WHERE username = ? AND branch_id = ? LIMIT 1",
                [resolvedUsername, branch_id]
            );
            return [rows];
        });

        let map_id = existingMap?.[0]?.map_id;
        let invitation_token = null;

        if (!existingMap?.length) {
            // Insert into branch_mapping (schema-safe)
            map_id = await UNIQUE_RANDOM_STRING("branch_mapping", "map_id", {
                length: SHORT_ID_LENGTH,
                prefix: `MAP_${Date.now()}_`,
            });
            invitation_token = RANDOM_STRING(100);
            // Let DB defaults handle create_date/modify_date (TIMESTAMP DEFAULT CURRENT_TIMESTAMP)
            await insertRow("branch_mapping", {
                map_id,
                branch_id,
                username: resolvedUsername,
                designation: designation ?? null,
                create_by: createdBy || resolvedUsername,
                modify_by: createdBy || resolvedUsername,
                is_accepted: "0",
                invitation_token,
                status: "1",
                is_deleted: "0",
                type: 'staff'
            });

            // Send invitation email if email is available
            if (userEmail) {
                try {
                    const invitationLink = `${BASE_INVITATION_LINK}/${invitation_token}`;
                    const emailHTML = generateInvitationEmailHTML(
                        invitationLink,
                        userName,
                        designation || null,
                        branchName
                    );

                    await SendMail({
                        to: userEmail,
                        subject: `You're Invited to Join ${APP_NAME}${branchName ? ` - ${branchName}` : ''}`,
                        html: emailHTML
                    });
                } catch (emailError) {
                    // Log error but don't fail the entire operation
                    console.error('Error sending invitation email:', emailError);
                }
            }
        } else {
            // Get existing invitation token if mapping already exists
            const [existingToken] = await pool.query(
                "SELECT invitation_token FROM branch_mapping WHERE map_id = ? LIMIT 1",
                [map_id]
            );
            invitation_token = existingToken?.[0]?.invitation_token || null;
        }

        const responseData = {
            username: resolvedUsername,
            branch_id,
            map_id,
        };

        // Include invitation link if token is available
        if (invitation_token) {
            responseData.invitation_link = `${BASE_INVITATION_LINK}/${invitation_token}`;
        }

        if (existingMap?.length) {
            return res.status(409).json({
                success: true,
                message: "Staff already assigned to this branch",
                data: responseData
            });
        } else {
            return res.status(200).json({
                success: true,
                message: "Invitation sent to staff successfully",
                data: responseData
            });
        }


    } catch (error) {
        console.error('Error creating staff:', error);
        return res.status(500).json({ success: false, message: 'Failed to create staff', error: error.message });
    }
});

router.get('/list', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            search = "",
            page = 1,
            limit = 20,
            status = "",
            permission_role_id = "",
        } = req.query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;

        const searchPattern = `%${search}%`;

        let filterSql = "";
        const filterParams = [];

        const normalizedStatus = String(status || "").trim().toLowerCase();
        if (normalizedStatus === "active") {
            filterSql += " AND bm.status = '1'";
        } else if (normalizedStatus === "inactive") {
            filterSql += " AND bm.status != '1'";
        }

        const roleFilter = String(permission_role_id || "").trim();
        if (roleFilter) {
            filterSql += " AND bm.permission_role_id = ?";
            filterParams.push(roleFilter);
        }

        const baseWhere = `
            bm.branch_id = ?
            AND bm.is_deleted = '0'
            AND (p.name LIKE ? OR p.mobile LIKE ? OR p.email LIKE ? OR bm.designation LIKE ?)
            AND u.status = '1'
            AND bm.type = 'staff'
            ${filterSql}
        `;
        const baseParams = [branch_id, searchPattern, searchPattern, searchPattern, searchPattern, ...filterParams];

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM branch_mapping bm
             INNER JOIN profile p ON bm.username = p.username
             INNER JOIN users u ON bm.username = u.username
             WHERE ${baseWhere}`,
            baseParams
        );

        const [rows] = await pool.query(
            `SELECT
                bm.map_id,
                bm.username,
                bm.designation,
                bm.modify_date AS bm_modify_date,
                bm.modify_by AS bm_modify_by,
                bm.status AS bm_status,
                bm.is_accepted,
                bm.permission_role_id,
                bm.custom_permissions,
                p.name,
                p.care_of,
                p.guardian_name,
                p.date_of_birth,
                p.gender,
                p.mobile,
                p.country_code,
                p.email,
                p.image,
                p.country,
                p.state,
                p.city,
                p.district,
                p.village_town,
                p.address_line_1,
                p.address_line_2,
                p.pincode
            FROM branch_mapping bm
            INNER JOIN profile p ON bm.username = p.username
            INNER JOIN users u ON bm.username = u.username
            WHERE ${baseWhere}
            ORDER BY bm.id DESC
            LIMIT ? OFFSET ?`,
            [...baseParams, limitNum, offset]
        );

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            const bm_modify_user = await USER_DATA(element.bm_modify_by);
            const is_accepted = element.is_accepted == "1" ? true : false;
            let balance = await GET_BALANCE({
                party_type: "staff",
                party_id: element.username,
                branch_id
            });

            const object = {
                map_id: element.map_id,
                username: element.username,
                designation: element.designation,
                is_accepted,
                status: element.bm_status == "1" ? true : false,
                modify_date: element.bm_modify_date,
                modify_by: {
                    username: bm_modify_user?.username,
                    name: bm_modify_user?.name,
                    email: bm_modify_user?.email,
                    mobile: bm_modify_user?.mobile,
                    country_code: bm_modify_user?.country_code,
                },
                profile: {
                    name: element.name,
                    email: element.email,
                },
                balance: balance?.balance ?? 0,
                permission_role_id: element.permission_role_id || null,
                custom_permissions: element.custom_permissions ? parsePermissions(element.custom_permissions) : []
            };

            if (is_accepted) {
                object.profile = {
                    name: element.name,
                    email: element.email,
                    mobile: element.mobile,
                    country_code: element.country_code,
                    date_of_birth: element.date_of_birth,
                    gender: element.gender,
                    care_of: element.care_of,
                    guardian_name: element.guardian_name,
                    image: buildProfileImageUrl(element.image),
                    address: {
                        address_line_1: element.address_line_1,
                        address_line_2: element.address_line_2,
                        city: element.city,
                        district: element.district,
                        state: element.state,
                        country: element.country,
                        pincode: element.pincode,
                    }
                };
            }

            data.push(object);
        }

        return res.status(200).json({
            success: true,
            message: 'Staff list retrieved successfully',
            data: data,
            meta: {
                total: Number(total) || 0,
                page: pageNum,
                limit: limitNum,
                total_pages: Math.ceil((Number(total) || 0) / limitNum),
                is_last_page: offset + rows.length >= (Number(total) || 0)
            }
        });
    } catch (error) {
        console.error('Error fetching staff list:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch staff list',
            error: error.message
        });
    }
});

router.post('/delete', auth, validateBranch, async (req, res) => {
    try {
        const { map_id } = req.body;
        const branch_id = req.branch_id;
        const deletedBy = req.headers["username"] || "";

        // Validate map_id is provided
        if (!map_id || map_id.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Map ID is required'
            });
        }

        // Verify the mapping belongs to the branch before deleting
        const [existingMap] = await pool.query(
            "SELECT map_id FROM branch_mapping WHERE map_id = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0) LIMIT 1",
            [map_id.trim(), branch_id]
        );

        if (!existingMap || existingMap.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Staff mapping not found or does not belong to this branch'
            });
        }

        const [rows] = await pool.query(
            "UPDATE branch_mapping SET is_deleted = '1', deleted_by = ? WHERE map_id = ? AND branch_id = ?",
            [deletedBy, map_id.trim(), branch_id]
        );
        return res.status(200).json({ success: true, message: 'Staff deleted successfully', data: rows });
    } catch (error) {
        console.error('Error deleting staff:', error);
        return res.status(500).json({ success: false, message: 'Failed to delete staff', error: error.message });
    }
});

router.get('/profile', auth, validateBranch, async (req, res) => {
    try {
        const { username } = req.query;
        const branch_id = req.branch_id;

        // Validate username is provided
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        // Verify the user is mapped to this branch
        const [mappingCheck] = await pool.query(
            "SELECT map_id FROM branch_mapping WHERE username = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0) LIMIT 1",
            [username.trim(), branch_id]
        );

        if (!mappingCheck || mappingCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Staff not found or is not mapped to this branch'
            });
        }

        const [rows] = await pool.query(
            "SELECT * FROM profile WHERE username = ? AND status = '1' ORDER BY id DESC LIMIT 1",
            [username.trim()]
        );
        return res.status(200).json({ success: true, message: 'Staff profile retrieved successfully', data: rows });
    } catch (error) {
        console.error('Error fetching staff profile:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch staff profile', error: error.message });
    }
});

router.post('/check-user', auth, validateBranch, async (req, res) => {
    try {
        const { email } = req.body;
        const branch_id = req.branch_id;

        // Validate username is provided
        if (!email || email.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }


        const resolvedUser = await resolveSoftwareUserByContact(pool, email.trim());

        if (!resolvedUser) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const staff_username = resolvedUser.username;
        const staff_data = await USER_DATA(staff_username);

        const [exist_data] = await pool.query(
            "SELECT * FROM branch_mapping WHERE username = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1",
            [staff_username, branch_id]
        );

        if (exist_data.length > 0) {
            if (exist_data[0]?.is_accepted == '1') {
                return res.status(200).json({ success: true, message: 'Staff already exists' });
            } else {
                return res.status(200).json({ success: true, message: 'Staff already exists but not accepted yet' });
            }
        }

        return res.status(200).json({
            success: true,
            message: 'User details fetched successfully',
            data: {
                username: staff_username,
                email: staff_data?.email,
                name: staff_data?.name,
            }
        })
    } catch (error) {
        console.error('Error checking user:', error);
        return res.status(500).json({ success: false, message: 'Failed to check user', error: error.message });
    }
});

// Search staff by name with all parameters - Fixed with correct column names
router.get('/search-by-name', auth, async (req, res) => {
    try {
        const {
            name,
            branch_id,
            limit = 50,
            status = 'all',
            include_inactive = 'false'
        } = req.query;

        // Validate name is provided
        if (!name || name.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Name is required for search'
            });
        }

        // Validate and parse limit
        const limitNum = Math.min(parseInt(limit) || 50, 100);

        const searchPattern = `%${name.trim()}%`;

        // Query with correct column names from branch_list
        let query = `
            SELECT 
                bm.map_id,
                bm.username,
                bm.designation,
                bm.status AS bm_status,
                bm.is_accepted,
                bm.branch_id,
                bm.create_by,
                bm.modify_by,
                bm.create_date,
                bm.modify_date,
                bm.permission_role_id,
                bm.custom_permissions,
                
                p.name AS profile_name,
                p.email,
                p.mobile,
                p.country_code,
                p.image,
                p.care_of,
                p.guardian_name,
                p.date_of_birth,
                p.gender,
                
                u.status AS user_status,
                
                bl.id AS branch_db_id,
                bl.branch_id AS branch_identifier,
                bl.name AS branch_name,
                bl.logo AS branch_logo,
                bl.address_line_1 AS branch_address_line1,
                bl.address_line_2 AS branch_address_line2,
                bl.city AS branch_city,
                bl.state AS branch_state,
                bl.country AS branch_country,
                bl.pincode AS branch_pincode,
                bl.pan AS branch_pan,
                bl.gst AS branch_gst
                
            FROM branch_mapping bm
            INNER JOIN profile p ON bm.username = p.username
            INNER JOIN users u ON bm.username = u.username
            LEFT JOIN branch_list bl ON bm.branch_id = bl.branch_id
            WHERE bm.is_deleted = '0'
                AND bm.type = 'staff'
                AND p.name LIKE ?
        `;

        const queryParams = [searchPattern];

        // Filter by user status
        if (include_inactive !== 'true') {
            query += ` AND u.status = '1'`;
        }

        // Filter by acceptance status
        if (status !== 'all') {
            if (status === 'accepted') {
                query += ` AND bm.is_accepted = '1'`;
            } else if (status === 'pending') {
                query += ` AND bm.is_accepted = '0'`;
            }
        }

        // Filter by branch
        if (branch_id && branch_id.trim() !== '') {
            query += ` AND bm.branch_id = ?`;
            queryParams.push(branch_id.trim());
        }

        query += ` ORDER BY p.name ASC LIMIT ?`;
        queryParams.push(limitNum);

        const [rows] = await pool.query(query, queryParams);

        // Format the response data
        const formattedData = await Promise.all(rows.map(async (row) => {
            const profileImage = buildProfileImageUrl(row.image);

            const branchLogo = buildBranchLogoUrl(row.branch_logo);

            // Get modifier user data if available
            const modifyUser = row.modify_by ? await USER_DATA(row.modify_by) : null;

            return {
                map_id: row.map_id,
                username: row.username,
                profile: {
                    name: row.profile_name,
                    email: row.email,
                    mobile: row.mobile,
                    country_code: row.country_code,
                    care_of: row.care_of,
                    guardian_name: row.guardian_name,
                    date_of_birth: row.date_of_birth,
                    gender: row.gender,
                    profile_image: profileImage
                },
                designation: row.designation,
                is_accepted: row.is_accepted === "1",
                status: row.bm_status === "1",
                user_status: row.user_status === "1",
                branch: row.branch_id ? {
                    id: row.branch_id,
                    db_id: row.branch_db_id,
                    name: row.branch_name,
                    logo: branchLogo,
                    address: {
                        line1: row.branch_address_line1,
                        line2: row.branch_address_line2,
                        city: row.branch_city,
                        state: row.branch_state,
                        country: row.branch_country,
                        pincode: row.branch_pincode
                    },
                    tax_info: {
                        pan: row.branch_pan,
                        gst: row.branch_gst
                    }
                } : null,
                permission_role_id: row.permission_role_id || null,
                custom_permissions: row.custom_permissions ? parsePermissions(row.custom_permissions) : [],
                metadata: {
                    created_by: row.create_by,
                    modified_by: modifyUser ? {
                        username: modifyUser.username,
                        name: modifyUser.name
                    } : null,
                    created_at: row.create_date,
                    modified_at: row.modify_date
                }
            };
        }));

        // Calculate statistics
        const stats = {
            total: formattedData.length,
            accepted: formattedData.filter(s => s.is_accepted).length,
            pending: formattedData.filter(s => !s.is_accepted).length,
            active: formattedData.filter(s => s.status).length,
            with_branch: formattedData.filter(s => s.branch).length
        };

        return res.status(200).json({
            success: true,
            message: formattedData.length > 0
                ? 'Staff members found successfully'
                : 'No staff members found matching the search criteria',
            data: formattedData,
            meta: {
                search_term: name.trim(),
                filters: {
                    branch_id: branch_id || 'all',
                    status: status,
                    include_inactive: include_inactive === 'true'
                },
                pagination: {
                    limit: limitNum,
                    returned: formattedData.length
                },
                statistics: stats
            }
        });

    } catch (error) {
        console.error('Error searching staff by name:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to search staff members',
            error: error.message
        });
    }
});

router.get('/profile/:username', auth, validateBranch, async (req, res) => {
    try {
        const { username } = req.params;
        const branch_id = req.branch_id;

        // Validate username is provided
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        // Get profile data with branch mapping and branch details
        const [rows] = await pool.query(
            `SELECT 
                -- Profile fields
                p.id,
                p.profile_id,
                p.username,
                p.create_by,
                p.user_type,
                p.name,
                p.care_of,
                p.guardian_name,
                p.date_of_birth,
                p.gender,
                p.mobile,
                p.country_code,
                p.email,
                p.pan_number,
                p.country,
                p.state,
                p.city,
                p.district,
                p.village_town,
                p.address_line_1,
                p.address_line_2,
                p.pincode,
                p.image,
                p.status AS profile_status,
                p.create_date,
                
                -- Branch mapping fields
                bm.designation,
                bm.is_accepted,
                bm.status AS bm_status,
                
                -- User status
                u.status AS user_status,
                
                -- Branch details
                bl.id AS branch_db_id,
                bl.branch_id,
                bl.name AS branch_name,
                bl.logo AS branch_logo,
                bl.address_line_1 AS branch_address_line1,
                bl.address_line_2 AS branch_address_line2,
                bl.city AS branch_city,
                bl.state AS branch_state,
                bl.country AS branch_country,
                bl.pincode AS branch_pincode,
                bl.pan AS branch_pan,
                bl.gst AS branch_gst
                
            FROM profile p
            INNER JOIN branch_mapping bm ON p.username = bm.username
            INNER JOIN users u ON p.username = u.username
            LEFT JOIN branch_list bl ON bm.branch_id = bl.branch_id
            WHERE p.username = ? 
                AND bm.branch_id = ?
                AND bm.is_deleted = '0'
                AND bm.type = 'staff'
                AND p.status = '1'
            ORDER BY p.id DESC 
            LIMIT 1`,
            [username.trim(), branch_id]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found or not mapped to this branch'
            });
        }

        const profile = rows[0];

        // Format branch logo URL if exists
        const branchLogo = buildBranchLogoUrl(profile.branch_logo);

        // Format profile image URL if exists
        const profileImage = buildProfileImageUrl(profile.image);

        // Prepare the response data with all required fields
        const responseData = [{
            // Profile fields
            id: profile.id,
            profile_id: profile.profile_id,
            username: profile.username,
            create_by: profile.create_by,
            user_type: profile.user_type,
            name: profile.name,
            care_of: profile.care_of,
            guardian_name: profile.guardian_name,
            date_of_birth: profile.date_of_birth,
            gender: profile.gender,
            mobile: profile.mobile,
            country_code: profile.country_code,
            email: profile.email,
            pan_number: profile.pan_number,
            country: profile.country,
            state: profile.state,
            city: profile.city,
            district: profile.district,
            village_town: profile.village_town,
            address_line_1: profile.address_line_1,
            address_line_2: profile.address_line_2,
            pincode: profile.pincode,
            image: profileImage,
            status: profile.profile_status,
            create_date: profile.create_date,

            // Additional fields you requested
            designation: profile.designation,
            is_accepted: profile.is_accepted === "1" ? true : false,
            status: profile.bm_status === "1" ? true : false,
            user_status: profile.user_status === "1" ? true : false,

            // Branch details
            branch: {
                id: profile.branch_id,
                db_id: profile.branch_db_id,
                name: profile.branch_name,
                logo: branchLogo,
                address: {
                    line1: profile.branch_address_line1,
                    line2: profile.branch_address_line2,
                    city: profile.branch_city,
                    state: profile.branch_state,
                    country: profile.branch_country,
                    pincode: profile.branch_pincode
                },
                tax_info: {
                    pan: profile.branch_pan || "",
                    gst: profile.branch_gst || ""
                }
            }
        }];

        return res.status(200).json({
            success: true,
            message: 'Staff profile retrieved successfully',
            data: responseData
        });

    } catch (error) {
        console.error('Error fetching profile by username:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch profile',
            error: error.message
        });
    }
});

router.put("/change-status", auth, validateBranch, async (req, res) => {
    try {
        const { username, status } = req.body;
        const branch_id = req.branch_id;
        const session_username = req.headers["username"] || "";

        if (!username || String(username).trim() === "") {
            return res.status(400).json({ success: false, message: "username is required" });
        }

        if (!status || !["active", "deactive"].includes(String(status).trim().toLowerCase())) {
            return res.status(400).json({ success: false, message: "status must be 'active' or 'deactive'" });
        }

        const normalizedStatus = String(status).trim().toLowerCase();

        // Check session user is admin on this branch
        const [adminRows] = await pool.query(
            "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'admin' AND is_deleted = '0' LIMIT 1",
            [session_username, branch_id]
        );
        if (!adminRows.length) {
            return res.status(403).json({ success: false, message: "Only branch admins can change staff status" });
        }

        // Fetch current staff status
        const [staffRows] = await pool.query(
            "SELECT status FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'staff' AND is_deleted = '0' LIMIT 1",
            [username, branch_id]
        );
        if (!staffRows.length) {
            return res.status(404).json({ success: false, message: "Staff not found in this branch" });
        }

        const currentStatus = staffRows[0].status === "1" ? "active" : "deactive";
        if (currentStatus === normalizedStatus) {
            return res.status(400).json({
                success: false,
                message: `Staff is already ${normalizedStatus}`
            });
        }

        const newStatusValue = normalizedStatus === "active" ? "1" : "0";

        await pool.query(
            "UPDATE branch_mapping SET status = ?, modify_by = ?, modify_date = NOW() WHERE username = ? AND branch_id = ? AND type = 'staff' AND is_deleted = '0'",
            [newStatusValue, session_username, username, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: `Staff status updated to ${normalizedStatus} successfully`,
            data: {
                username,
                status: normalizedStatus
            }
        });

    } catch (error) {
        console.error('Error updating staff status:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update staff status',
            error: error.message
        });
    }
});

export default router;