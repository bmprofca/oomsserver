import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE, RANDOM_STRING, UNIQUE_RANDOM_STRING, SHORT_ID_LENGTH, USER_DATA } from "../helpers/function.js";
import { BASE_INVITATION_LINK, APP_NAME, BASE_DOMAIN } from "../helpers/Config.js";
import { SendMail } from "../helpers/Mail.js";

const router = express.Router();
const BRANCH_MAPPING_TYPE = "admin";

function maskMobile(mobile) {
    const digits = mobile != null ? String(mobile).replace(/\D/g, "") : "";
    if (digits.length < 4) {
        return null;
    }
    const hiddenCount = digits.length - 4;
    return `${digits.slice(0, 2)}${"X".repeat(hiddenCount)}${digits.slice(-2)}`;
}

async function getTableColumns(tableName) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map((r) => r.Field));
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

function generateAdminInvitationEmailHTML(invitationLink, adminName, branchName = "") {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Branch Invitation - ${APP_NAME}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; padding: 24px;">
        <h2>You're invited to join as Admin</h2>
        <p>Hello ${adminName || "there"},</p>
        <p>
            You have been invited to join${branchName ? ` <strong>${branchName}</strong>` : ""} as a
            <strong>Branch Administrator</strong> on ${APP_NAME}.
        </p>
        <p style="margin: 24px 0;">
            <a href="${invitationLink}" style="display: inline-block; padding: 12px 24px; background: #667eea; color: #fff; text-decoration: none; border-radius: 6px;">
                Accept Invitation
            </a>
        </p>
        <p>If the button does not work, copy and paste this link into your browser:</p>
        <p><a href="${invitationLink}">${invitationLink}</a></p>
        <p style="color: #888; font-size: 14px;">This is an automated email from ${APP_NAME}. Please do not reply.</p>
    </div>
</body>
</html>
    `;
}

async function requireBranchAdmin(req, res, next) {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        if (!username || String(username).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "username header is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT id FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND type = ?
               AND is_accepted = '1' AND status = '1' AND is_deleted = '0'
             LIMIT 1`,
            [String(username).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );

        if (!rows.length) {
            return res.status(403).json({
                success: false,
                message: "Only branch admins can access this resource",
            });
        }

        next();
    } catch (error) {
        console.error("Branch admin authorization error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to verify admin access",
            error: error.message,
        });
    }
}

async function requireBranchOwner(req, res, next) {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        if (!username || String(username).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "username header is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT create_by FROM branch_list
             WHERE branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [branch_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        if (rows[0].create_by !== String(username).trim()) {
            return res.status(403).json({
                success: false,
                message: "Only the branch owner can perform this action",
            });
        }

        next();
    } catch (error) {
        console.error("Branch owner authorization error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to verify branch owner access",
            error: error.message,
        });
    }
}

function getSessionUsername(req) {
    return String(req.headers["username"] || req.headers["Username"] || "").trim();
}

function isSelfUser(req, targetUsername) {
    const sessionUsername = getSessionUsername(req);
    return sessionUsername !== "" && sessionUsername === String(targetUsername || "").trim();
}

router.post("/check-user", auth, validateBranch, requireBranchAdmin, requireBranchOwner, async (req, res) => {
    try {
        const { email } = req.body || {};
        const branch_id = req.branch_id;

        if (!email || String(email).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Email is required",
            });
        }

        const [rows] = await pool.query(
            "SELECT username FROM users WHERE login_id = ? AND status = '1' ORDER BY id DESC LIMIT 1",
            [String(email).trim()]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const admin_username = rows[0].username;

        if (isSelfUser(req, admin_username)) {
            return res.status(400).json({
                success: false,
                message: "You cannot invite yourself as admin",
            });
        }

        const admin_data = await USER_DATA(admin_username);

        const [exist_data] = await pool.query(
            `SELECT is_accepted, type
             FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [admin_username, branch_id]
        );

        if (exist_data.length > 0) {
            if (exist_data[0].type === BRANCH_MAPPING_TYPE) {
                if (exist_data[0].is_accepted == "1") {
                    return res.status(200).json({
                        success: true,
                        message: "Admin already exists",
                    });
                }
                return res.status(200).json({
                    success: true,
                    message: "Admin already exists but not accepted yet",
                });
            }

            return res.status(409).json({
                success: false,
                message: "User is already mapped to this branch with a different role",
            });
        }

        return res.status(200).json({
            success: true,
            message: "User details fetched successfully",
            data: {
                username: admin_username,
                email: admin_data?.email ?? null,
                name: admin_data?.name ?? null,
                mobile: maskMobile(admin_data?.mobile),
            },
        });
    } catch (error) {
        console.error("Error checking admin user:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to check user",
            error: error.message,
        });
    }
});

router.post("/create", auth, validateBranch, requireBranchAdmin, requireBranchOwner, async (req, res) => {
    try {
        const { username } = req.body || {};
        const branch_id = req.branch_id;
        const createdBy = req.headers["username"] || "";

        if (!username || String(username).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Missing required parameter: username",
            });
        }

        if (isSelfUser(req, username)) {
            return res.status(400).json({
                success: false,
                message: "You cannot invite yourself as admin",
            });
        }

        const [userRows] = await pool.query(
            "SELECT username FROM users WHERE username = ? LIMIT 1",
            [String(username).trim()]
        );

        if (!userRows.length) {
            return res.status(404).json({
                success: false,
                message: "User not found. Create the user first, then assign to branch.",
            });
        }

        const resolvedUsername = userRows[0].username;
        const userData = await USER_DATA(resolvedUsername);
        const userEmail = userData?.email || null;
        const userName = userData?.name || resolvedUsername;

        const [branchRows] = await pool.query(
            "SELECT name FROM branch_list WHERE branch_id = ? LIMIT 1",
            [branch_id]
        ).catch(() => [[]]);
        const branchName = branchRows?.[0]?.name || null;

        const [existingMap] = await pool.query(
            `SELECT id, map_id, type
             FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [resolvedUsername, branch_id]
        ).catch(async () => {
            const [rows] = await pool.query(
                "SELECT id, map_id, type FROM branch_mapping WHERE username = ? AND branch_id = ? LIMIT 1",
                [resolvedUsername, branch_id]
            );
            return [rows];
        });

        let map_id = existingMap?.[0]?.map_id;
        let invitation_token = null;

        if (existingMap?.length) {
            if (existingMap[0].type !== BRANCH_MAPPING_TYPE) {
                return res.status(409).json({
                    success: false,
                    message: "User is already mapped to this branch with a different role",
                });
            }
        }

        if (!existingMap?.length) {
            map_id = await UNIQUE_RANDOM_STRING("branch_mapping", "map_id", {
                length: SHORT_ID_LENGTH,
                prefix: `MAP_${Date.now()}_`,
            });
            invitation_token = RANDOM_STRING(100);

            await insertRow("branch_mapping", {
                map_id,
                branch_id,
                username: resolvedUsername,
                designation: null,
                create_by: createdBy || resolvedUsername,
                modify_by: createdBy || resolvedUsername,
                is_accepted: "0",
                invitation_token,
                status: "1",
                is_deleted: "0",
                type: BRANCH_MAPPING_TYPE,
            });

            if (userEmail) {
                try {
                    const invitationLink = `${BASE_INVITATION_LINK}/${invitation_token}`;
                    await SendMail({
                        to: userEmail,
                        subject: `You're Invited to Join ${APP_NAME}${branchName ? ` - ${branchName}` : ""} as Admin`,
                        html: generateAdminInvitationEmailHTML(invitationLink, userName, branchName),
                    });
                } catch (emailError) {
                    console.error("Error sending admin invitation email:", emailError);
                }
            }
        } else {
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

        if (invitation_token) {
            responseData.invitation_link = `${BASE_INVITATION_LINK}/${invitation_token}`;
        }

        if (existingMap?.length) {
            return res.status(409).json({
                success: true,
                message: "Admin already assigned to this branch",
                data: responseData,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Invitation sent to admin successfully",
            data: responseData,
        });
    } catch (error) {
        console.error("Error creating admin:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create admin",
            error: error.message,
        });
    }
});

router.post("/resend-invitation", auth, validateBranch, requireBranchAdmin, requireBranchOwner, async (req, res) => {
    try {
        const { map_id } = req.body || {};
        const branch_id = req.branch_id;
        const modifiedBy = req.headers["username"] || "";

        if (!map_id || String(map_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "map_id is required",
            });
        }

        const [mappingRows] = await pool.query(
            `SELECT map_id, username, is_accepted, status
             FROM branch_mapping
             WHERE map_id = ? AND branch_id = ? AND type = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [String(map_id).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );

        if (!mappingRows.length) {
            return res.status(404).json({
                success: false,
                message: "Admin mapping not found or does not belong to this branch",
            });
        }

        const mapping = mappingRows[0];

        if (isSelfUser(req, mapping.username)) {
            return res.status(400).json({
                success: false,
                message: "You cannot resend an invitation to yourself",
            });
        }

        if (mapping.is_accepted == "1") {
            return res.status(400).json({
                success: false,
                message: "Admin has already accepted the invitation",
            });
        }

        if (mapping.status != "1") {
            return res.status(400).json({
                success: false,
                message: "Cannot resend invitation for an inactive admin mapping",
            });
        }

        const userData = await USER_DATA(mapping.username);
        const userEmail = userData?.email || null;
        const userName = userData?.name || mapping.username;

        if (!userEmail) {
            return res.status(400).json({
                success: false,
                message: "Admin has no email on file. Update the profile before resending the invitation.",
            });
        }

        const [branchRows] = await pool.query(
            "SELECT name FROM branch_list WHERE branch_id = ? LIMIT 1",
            [branch_id]
        ).catch(() => [[]]);
        const branchName = branchRows?.[0]?.name || null;

        const invitation_token = RANDOM_STRING(100);

        await pool.query(
            `UPDATE branch_mapping
             SET invitation_token = ?, modify_by = ?, modify_date = NOW()
             WHERE map_id = ? AND branch_id = ? AND type = ?`,
            [invitation_token, modifiedBy, String(map_id).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );

        const invitationLink = `${BASE_INVITATION_LINK}/${invitation_token}`;

        try {
            await SendMail({
                to: userEmail,
                subject: `You're Invited to Join ${APP_NAME}${branchName ? ` - ${branchName}` : ""} as Admin`,
                html: generateAdminInvitationEmailHTML(invitationLink, userName, branchName),
            });
        } catch (emailError) {
            console.error("Error resending admin invitation email:", emailError);
            return res.status(500).json({
                success: false,
                message: "Failed to send invitation email",
                error: emailError.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Invitation resent successfully",
            data: {
                map_id: mapping.map_id,
                username: mapping.username,
                invitation_link: invitationLink,
            },
        });
    } catch (error) {
        console.error("Error resending admin invitation:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to resend invitation",
            error: error.message,
        });
    }
});

router.get("/list", auth, validateBranch, requireBranchAdmin, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const session_username = getSessionUsername(req);
        const { search = "", page = 1, limit = 20 } = req.query || {};

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;
        const searchPattern = `%${String(search).trim()}%`;

        const baseWhere = `
            bm.branch_id = ?
            AND bm.is_deleted = '0'
            AND bm.type = ?
            AND bm.username != ?
            AND (p.name LIKE ? OR p.mobile LIKE ? OR p.email LIKE ?)
            AND u.status = '1'
        `;
        const baseParams = [branch_id, BRANCH_MAPPING_TYPE, session_username, searchPattern, searchPattern, searchPattern];

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
                bm.modify_date AS bm_modify_date,
                bm.modify_by AS bm_modify_by,
                bm.status AS bm_status,
                bm.is_accepted,
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
        for (const element of rows) {
            const bm_modify_user = await USER_DATA(element.bm_modify_by);
            const is_accepted = element.is_accepted == "1";
            const balance = await GET_BALANCE({
                party_type: BRANCH_MAPPING_TYPE,
                party_id: element.username,
                branch_id,
            });

            const object = {
                map_id: element.map_id,
                username: element.username,
                is_accepted,
                status: element.bm_status == "1",
                modify_date: element.bm_modify_date,
                modify_by: {
                    username: bm_modify_user?.username ?? null,
                    name: bm_modify_user?.name ?? null,
                    email: bm_modify_user?.email ?? null,
                    mobile: bm_modify_user?.mobile ?? null,
                    country_code: bm_modify_user?.country_code ?? null,
                },
                profile: {
                    name: element.name,
                    email: element.email,
                },
                balance: balance?.balance ?? 0,
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
                    image:
                        element.image != "" && element.image != null
                            ? `${BASE_DOMAIN}/media/profile/image/${element.image}`
                            : null,
                    address: {
                        address_line_1: element.address_line_1,
                        address_line_2: element.address_line_2,
                        city: element.city,
                        district: element.district,
                        state: element.state,
                        country: element.country,
                        pincode: element.pincode,
                    },
                };
            }

            data.push(object);
        }

        return res.status(200).json({
            success: true,
            message: "Admin list retrieved successfully",
            data,
            meta: {
                total: Number(total) || 0,
                page: pageNum,
                limit: limitNum,
                total_pages: Math.ceil((Number(total) || 0) / limitNum) || 1,
                is_last_page: offset + rows.length >= (Number(total) || 0),
            },
        });
    } catch (error) {
        console.error("Error fetching admin list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch admin list",
            error: error.message,
        });
    }
});

router.post("/delete", auth, validateBranch, requireBranchAdmin, requireBranchOwner, async (req, res) => {
    try {
        const { map_id } = req.body || {};
        const branch_id = req.branch_id;
        const deletedBy = req.headers["username"] || "";

        if (!map_id || String(map_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "map_id is required",
            });
        }

        const [existingMap] = await pool.query(
            `SELECT map_id, username, is_accepted
             FROM branch_mapping
             WHERE map_id = ? AND branch_id = ? AND type = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [String(map_id).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );

        if (!existingMap.length) {
            return res.status(404).json({
                success: false,
                message: "Admin mapping not found or does not belong to this branch",
            });
        }

        if (isSelfUser(req, existingMap[0].username)) {
            return res.status(400).json({
                success: false,
                message: "You cannot delete your own admin record",
            });
        }

        if (existingMap[0].is_accepted == "1") {
            return res.status(400).json({
                success: false,
                message: "Accepted admin cannot be deleted. Deactivate the admin instead.",
            });
        }

        await pool.query(
            "UPDATE branch_mapping SET is_deleted = '1', deleted_by = ? WHERE map_id = ? AND branch_id = ? AND type = ?",
            [deletedBy, String(map_id).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );

        return res.status(200).json({
            success: true,
            message: "Admin deleted successfully",
        });
    } catch (error) {
        console.error("Error deleting admin:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete admin",
            error: error.message,
        });
    }
});

router.get("/profile", auth, validateBranch, requireBranchAdmin, requireBranchOwner, async (req, res) => {
    try {
        const { username } = req.query || {};
        const branch_id = req.branch_id;

        if (!username || String(username).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "username is required",
            });
        }

        if (isSelfUser(req, username)) {
            return res.status(400).json({
                success: false,
                message: "Your own profile is not available through this endpoint",
            });
        }

        const [mappingCheck] = await pool.query(
            `SELECT map_id
             FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND type = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [String(username).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );

        if (!mappingCheck.length) {
            return res.status(404).json({
                success: false,
                message: "Admin not found or is not mapped to this branch",
            });
        }

        const [rows] = await pool.query(
            "SELECT * FROM profile WHERE username = ? AND status = '1' ORDER BY id DESC LIMIT 1",
            [String(username).trim()]
        );

        return res.status(200).json({
            success: true,
            message: "Admin profile retrieved successfully",
            data: rows,
        });
    } catch (error) {
        console.error("Error fetching admin profile:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch admin profile",
            error: error.message,
        });
    }
});

router.put("/change-status", auth, validateBranch, requireBranchAdmin, requireBranchOwner, async (req, res) => {
    try {
        const { username, status } = req.body || {};
        const branch_id = req.branch_id;
        const session_username = req.headers["username"] || "";

        if (!username || String(username).trim() === "") {
            return res.status(400).json({ success: false, message: "username is required" });
        }

        if (isSelfUser(req, username)) {
            return res.status(400).json({
                success: false,
                message: "You cannot change your own admin status through this endpoint",
            });
        }

        if (!status || !["active", "deactive"].includes(String(status).trim().toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: "status must be 'active' or 'deactive'",
            });
        }

        const normalizedStatus = String(status).trim().toLowerCase();

        const [targetRows] = await pool.query(
            `SELECT status, is_accepted
             FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND type = ? AND is_deleted = '0'
             LIMIT 1`,
            [String(username).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );
        if (!targetRows.length) {
            return res.status(404).json({
                success: false,
                message: "Admin not found in this branch",
            });
        }

        if (targetRows[0].is_accepted != "1") {
            return res.status(400).json({
                success: false,
                message: "Admin must accept the invitation before status can be changed",
            });
        }

        const currentStatus = targetRows[0].status === "1" ? "active" : "deactive";
        if (currentStatus === normalizedStatus) {
            return res.status(400).json({
                success: false,
                message: `Admin is already ${normalizedStatus}`,
            });
        }

        const newStatusValue = normalizedStatus === "active" ? "1" : "0";

        await pool.query(
            `UPDATE branch_mapping
             SET status = ?, modify_by = ?, modify_date = NOW()
             WHERE username = ? AND branch_id = ? AND type = ? AND is_deleted = '0'`,
            [newStatusValue, session_username, String(username).trim(), branch_id, BRANCH_MAPPING_TYPE]
        );

        return res.status(200).json({
            success: true,
            message: `Admin status updated to ${normalizedStatus} successfully`,
            data: {
                username: String(username).trim(),
                status: normalizedStatus,
            },
        });
    } catch (error) {
        console.error("Error updating admin status:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update admin status",
            error: error.message,
        });
    }
});

export default router;
