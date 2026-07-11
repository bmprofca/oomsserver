import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, RANDOM_STRING, SET_OPENING_BALANCE, GET_BALANCE, ID_LENGTH } from "../helpers/function.js";
import {
    deleteProfileImage,
    downloadAndUploadProfileImage,
} from "../helpers/b2Storage.js";
import { resolveProfileImageUrl } from "../helpers/mediaUrl.js";

const router = express.Router();

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

router.post("/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    let savedImageFilename = null;

    try {
        const { profile = {}, address = {}, opening_balance = {} } = req.body || {};
        const createdBy = req.headers["username"] || "";
        const { branch_id } = req;

        const {
            pan: pan_number,
            full_name,
            care_of,
            guardian_name,
            mobile,
            country_code = "91",
            email,
            date_of_birth,
            gender,
            image,
        } = profile;

        const {
            state,
            district,
            town_or_village,
            pincode,
            address_line_1,
            address_line_2,
        } = address;

        if (!full_name || !care_of || !guardian_name || !mobile || !email || !date_of_birth || !gender) {
            return res.status(400).json({
                success: false,
                message: "Missing required profile details",
            });
        }

        if (!state || !district || !town_or_village || !pincode) {
            return res.status(400).json({
                success: false,
                message: "Missing required address details",
            });
        }

        const [existingMobile] = await pool.query(
            `SELECT p.username FROM profile p
                 JOIN clients c ON p.username = c.username
                 WHERE p.mobile = ? AND c.user_type = ? AND c.is_deleted = '0' AND c.branch_id = ?`,
            [mobile, "agent", branch_id]
        );

        if (existingMobile.length > 0) {
            return res.status(409).json({
                success: false,
                message: `An Agent with this mobile number already exists`,
            });
        }

        const [existingEmail] = await pool.query(
            `SELECT p.username FROM profile p
                 JOIN clients c ON p.username = c.username
                 WHERE p.email = ? AND c.user_type = ? AND c.is_deleted = '0' AND c.branch_id = ?`,
            [email, "agent", branch_id]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                success: false,
                message: `An Agent with this email already exists`,
            });
        }

        if (pan_number) {
            const [existingPan] = await pool.query(
                `SELECT p.username FROM profile p
                     JOIN clients c ON p.username = c.username
                     WHERE p.pan_number = ? AND c.user_type = ? AND c.is_deleted = '0' AND c.branch_id = ?`,
                [pan_number, "agent", branch_id]
            );

            if (existingPan.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: `An Agent with this PAN number already exists`,
                });
            }
        }

        if (image && image !== null && String(image).trim() !== "") {
            try {
                const uploadResult = await downloadAndUploadProfileImage(image);
                savedImageFilename = uploadResult.filename;
            } catch (imageError) {
                return res.status(400).json({
                    success: false,
                    message: `Profile image error: ${imageError.message}`,
                });
            }
        }

        await conn.beginTransaction();

        const username = await UNIQUE_RANDOM_STRING("clients", "username", { conn });
        const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", { conn });

        await insertRow("clients", {
            username,
            user_type: "agent",
            branch_id,
            create_by: createdBy,
            status: "1",
            is_deleted: "0",
        });

        await insertRow("profile", {
            profile_id,
            username,
            create_by: createdBy,
            user_type: "agent",
            name: full_name,
            care_of: care_of || null,
            guardian_name: guardian_name || null,
            date_of_birth: date_of_birth || null,
            gender: gender || null,
            mobile,
            country_code,
            email,
            pan_number: pan_number || null,
            state: state || null,
            district: district || null,
            city: district || null,
            village_town: town_or_village || null,
            pincode: pincode || null,
            address_line_1: address_line_1 || null,
            address_line_2: address_line_2 || null,
            image: savedImageFilename || null,
            status: "1",
        });

        await conn.commit();

        if (opening_balance && opening_balance.amount !== undefined && opening_balance.amount !== null) {
            const originalBranchId = req.headers["branch_id"];
            req.headers["branch_id"] = branch_id;

            try {
                await SET_OPENING_BALANCE({
                    req,
                    type: opening_balance.type || "credit",
                    party_type: "agent",
                    party_id: username,
                    amount: opening_balance.amount,
                    remark: "",
                    transaction_date: opening_balance.date || new Date().toISOString().split("T")[0],
                });
            } catch (balanceError) {
                console.error("Opening balance error:", balanceError);
            } finally {
                if (originalBranchId !== undefined) {
                    req.headers["branch_id"] = originalBranchId;
                } else {
                    delete req.headers["branch_id"];
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: `Agent created successfully`,
            data: {
                username,
                profile_id,
                name: full_name,
                mobile,
                email,
                pan_number: pan_number || null,
                branch_id,
            },
        });
    } catch (error) {
        await conn.rollback();

        if (savedImageFilename) {
            try {
                await deleteProfileImage(savedImageFilename);
            } catch (cleanupError) {
                console.error("Error cleaning up profile image from B2:", cleanupError);
            }
        }

        console.error(`Error creating Agent:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to create Agent`,
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const { branch_id } = req;
        const { search, page = 1, limit = 20 } = req.query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;

        let query = `
                SELECT
                    c.id,
                    c.username,
                    c.branch_id,
                    c.create_date,
                    c.status,
                    p.profile_id,
                    p.name,
                    p.care_of,
                    p.guardian_name,
                    p.date_of_birth,
                    p.gender,
                    p.mobile,
                    p.country_code,
                    p.email,
                    p.pan_number,
                    p.state,
                    p.district,
                    p.city,
                    p.village_town,
                    p.address_line_1,
                    p.address_line_2,
                    p.pincode,
                    p.image
                FROM clients c
                LEFT JOIN profile p ON c.username = p.username
                    AND p.id = (
                        SELECT MAX(p2.id)
                        FROM profile p2
                        WHERE p2.username = c.username
                    )
                WHERE c.user_type = ?
                AND c.is_deleted = '0'
                AND c.branch_id = ?
            `;

        const queryParams = ["agent", branch_id];

        if (search) {
            const searchPattern = `%${search}%`;
            query += ` AND (p.name LIKE ? OR p.mobile LIKE ? OR p.email LIKE ? OR p.pan_number LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        const countQuery = query.replace(/SELECT[\s\S]*?FROM/, "SELECT COUNT(*) as total FROM");
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = countResult[0]?.total || 0;

        query += ` ORDER BY c.id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        const data = await Promise.all(
            rows.map(async (row) => {
                const balance = await GET_BALANCE({
                    party_type: "agent",
                    party_id: row.username,
                    branch_id,
                });

                return {
                    ...row,
                    status: row.status == "1",
                    image: resolveProfileImageUrl(row.image),
                    balance: balance?.balance ?? 0,
                };
            })
        );

        return res.status(200).json({
            success: true,
            message: `Agent list retrieved successfully`,
            data,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error(`Error fetching Agent list:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to fetch Agent list`,
            error: error.message,
        });
    }
});

router.get("/details/profile", auth, validateBranch, async (req, res) => {
    try {
        const { username } = req.query;
        const branch_id = req.branch_id;

        if (!username || String(username).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "username is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT profile.*, clients.status AS is_active
                 FROM clients
                 JOIN profile ON clients.username = profile.username
                 WHERE clients.username = ?
                 AND clients.branch_id = ?
                 AND clients.user_type = ?
                 AND clients.is_deleted = '0'
                 AND profile.status = '1'
                 ORDER BY profile.id DESC
                 LIMIT 1`,
            [String(username).trim(), branch_id, "agent"]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: `Agent not found or does not belong to this branch`,
            });
        }

        const row = rows[0];
        const { balance, debit, credit } = await GET_BALANCE({
            party_type: "agent",
            party_id: username,
            branch_id,
        });

        return res.status(200).json({
            success: true,
            message: `Agent profile retrieved successfully`,
            data: {
                basic: {
                    name: row.name,
                    care_of: row.care_of,
                    guardian_name: row.guardian_name,
                    date_of_birth: row.date_of_birth,
                    gender: row.gender,
                    mobile: row.mobile,
                    country_code: row.country_code,
                    email: row.email,
                    pan_number: row.pan_number,
                    image: resolveProfileImageUrl(row.image),
                    is_active: row.is_active == "1",
                    address: {
                        state: row.state,
                        district: row.district,
                        city: row.city,
                        village_town: row.village_town,
                        pincode: row.pincode,
                        address_line_1: row.address_line_1,
                        address_line_2: row.address_line_2,
                    },
                },
                transactional: {
                    balance,
                    debit,
                    credit,
                },
            },
        });
    } catch (error) {
        console.error(`Error fetching agent profile:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to fetch Agent profile`,
            error: error.message,
        });
    }
});

router.post("/details/edit-profile", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    let savedImageFilename = null;

    try {
        const { username } = req.body;
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || "";

        if (!username || String(username).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "username is required",
            });
        }

        const [partyCheck] = await pool.query(
            `SELECT id, status FROM clients
                 WHERE username = ? AND branch_id = ? AND user_type = ? AND is_deleted = '0'`,
            [String(username).trim(), branch_id, "agent"]
        );

        if (!partyCheck.length) {
            return res.status(404).json({
                success: false,
                message: `Agent not found or does not belong to this branch`,
            });
        }

        const {
            name,
            care_of,
            guardian_name,
            date_of_birth,
            gender,
            mobile,
            country_code = "91",
            email,
            pan_number: pan_number_raw,
            image: imageInput,
            is_active,
            address = {},
        } = req.body || {};

        const {
            state,
            district,
            city,
            village_town,
            pincode,
            address_line_1,
            address_line_2,
        } = address;

        const pan_number = pan_number_raw ? String(pan_number_raw).trim().toUpperCase() : null;

        if (!name || !mobile || !email) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: name, mobile, and email are required",
            });
        }

        if (pan_number && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan_number)) {
            return res.status(400).json({
                success: false,
                message: "Invalid PAN number format",
            });
        }

        if (imageInput && imageInput !== null && String(imageInput).trim() !== "") {
            try {
                const uploadResult = await downloadAndUploadProfileImage(imageInput);
                savedImageFilename = uploadResult.filename;
            } catch (imageError) {
                return res.status(400).json({
                    success: false,
                    message: `Profile image error: ${imageError.message}`,
                });
            }
        }

        if (pan_number) {
            const [existingPan] = await pool.query(
                `SELECT p.username FROM profile p
                     JOIN clients c ON p.username = c.username
                     WHERE p.pan_number = ? AND c.user_type = ? AND c.is_deleted = '0'
                     AND c.branch_id = ? AND p.username != ?`,
                [pan_number, "agent", branch_id, String(username).trim()]
            );

            if (existingPan.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: `An Agent with this PAN number already exists`,
                });
            }
        }

        const [existingProfileRow] = await pool.query(
            `SELECT profile_id, image FROM profile
                 WHERE username = ? AND status = '1'
                 ORDER BY id DESC LIMIT 1`,
            [String(username).trim()]
        );
        const profile_id = existingProfileRow.length > 0
            ? existingProfileRow[0].profile_id
            : await UNIQUE_RANDOM_STRING("profile", "profile_id", { length: ID_LENGTH });
        const existingImage =
            existingProfileRow.length > 0 ? existingProfileRow[0].image : null;

        await conn.beginTransaction();

        await conn.query("UPDATE profile SET status = '0' WHERE username = ?", [String(username).trim()]);

        const [columns] = await conn.query("SHOW COLUMNS FROM `profile`");
        const validColumns = new Set(columns.map((c) => c.Field));

        const profileData = {
            profile_id,
            username: String(username).trim(),
            create_by: modifyBy,
            modify_by: modifyBy,
            user_type: "agent",
            name: String(name).trim(),
            care_of: care_of || null,
            guardian_name: guardian_name || null,
            date_of_birth: date_of_birth || null,
            gender: gender ? String(gender).toLowerCase() : null,
            mobile: String(mobile).trim(),
            country_code: country_code || "91",
            email: String(email).trim().toLowerCase(),
            pan_number,
            state: state || null,
            district: district || null,
            city: city || district || null,
            village_town: village_town || null,
            pincode: pincode || null,
            address_line_1: address_line_1 || null,
            address_line_2: address_line_2 || null,
            image: savedImageFilename || existingImage || null,
            status: "1",
        };

        const entries = Object.entries(profileData).filter(([k]) => validColumns.has(k));
        const keys = entries.map(([k]) => `\`${k}\``).join(", ");
        const placeholders = entries.map(() => "?").join(", ");
        const values = entries.map(([, v]) => v);

        await conn.query(`INSERT INTO \`profile\` (${keys}) VALUES (${placeholders})`, values);

        if (is_active !== undefined && is_active !== null) {
            const newStatus = is_active === true || is_active === "1" || is_active === 1 ? "1" : "0";
            const currentStatus = partyCheck[0].status;

            if (newStatus !== currentStatus) {
                await conn.query(
                    `UPDATE clients SET status = ?, modify_by = ?, modify_date = NOW()
                         WHERE username = ? AND branch_id = ? AND user_type = ?`,
                    [newStatus, modifyBy, String(username).trim(), branch_id, "agent"]
                );
            }
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: `Agent profile updated successfully`,
            data: {
                username: String(username).trim(),
                profile_id,
                name: String(name).trim(),
                mobile: String(mobile).trim(),
                email: String(email).trim().toLowerCase(),
                pan_number,
            },
        });
    } catch (error) {
        await conn.rollback();

        if (savedImageFilename) {
            try {
                await deleteProfileImage(savedImageFilename);
            } catch (cleanupError) {
                console.error("Error cleaning up profile image from B2:", cleanupError);
            }
        }

        console.error(`Error updating agent profile:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to update Agent profile`,
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.put("/change-status", auth, validateBranch, async (req, res) => {
    try {
        const { username, status } = req.body || {};
        const branch_id = req.branch_id;
        const session_username = req.headers["username"] || "";

        if (!username || String(username).trim() === "") {
            return res.status(400).json({ success: false, message: "username is required" });
        }

        if (!status || !["active", "deactive"].includes(String(status).trim().toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: "status must be 'active' or 'deactive'",
            });
        }

        const normalizedStatus = String(status).trim().toLowerCase();

        const [partyRows] = await pool.query(
            `SELECT status FROM clients
                 WHERE username = ? AND branch_id = ? AND user_type = ? AND is_deleted = '0'
                 LIMIT 1`,
            [String(username).trim(), branch_id, "agent"]
        );

        if (!partyRows.length) {
            return res.status(404).json({
                success: false,
                message: `Agent not found in this branch`,
            });
        }

        const currentStatus = partyRows[0].status === "1" ? "active" : "deactive";
        if (currentStatus === normalizedStatus) {
            return res.status(400).json({
                success: false,
                message: `Agent is already ${normalizedStatus}`,
            });
        }

        const newStatusValue = normalizedStatus === "active" ? "1" : "0";

        await pool.query(
            `UPDATE clients
                 SET status = ?, modify_by = ?, modify_date = NOW()
                 WHERE username = ? AND branch_id = ? AND user_type = ? AND is_deleted = '0'`,
            [newStatusValue, session_username, String(username).trim(), branch_id, "agent"]
        );

        return res.status(200).json({
            success: true,
            message: `Agent status updated to ${normalizedStatus} successfully`,
            data: {
                username: String(username).trim(),
                status: normalizedStatus,
            },
        });
    } catch (error) {
        console.error(`Error updating agent status:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to update Agent status`,
            error: error.message,
        });
    }
});

export default router;
