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
            [mobile, "ca", branch_id]
        );

        if (existingMobile.length > 0) {
            return res.status(409).json({
                success: false,
                message: `A CA with this mobile number already exists`,
            });
        }

        const [existingEmail] = await pool.query(
            `SELECT p.username FROM profile p
                 JOIN clients c ON p.username = c.username
                 WHERE p.email = ? AND c.user_type = ? AND c.is_deleted = '0' AND c.branch_id = ?`,
            [email, "ca", branch_id]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                success: false,
                message: `A CA with this email already exists`,
            });
        }

        if (pan_number) {
            const [existingPan] = await pool.query(
                `SELECT p.username FROM profile p
                     JOIN clients c ON p.username = c.username
                     WHERE p.pan_number = ? AND c.user_type = ? AND c.is_deleted = '0' AND c.branch_id = ?`,
                [pan_number, "ca", branch_id]
            );

            if (existingPan.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: `A CA with this PAN number already exists`,
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
            user_type: "ca",
            branch_id,
            create_by: createdBy,
            status: "1",
            is_deleted: "0",
        });

        await insertRow("profile", {
            profile_id,
            username,
            create_by: createdBy,
            user_type: "ca",
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
                    party_type: "ca",
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
            message: `CA created successfully`,
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

        console.error(`Error creating CA:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to create CA`,
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

        const queryParams = ["ca", branch_id];

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
                    party_type: "ca",
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
            message: `CA list retrieved successfully`,
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
        console.error(`Error fetching CA list:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to fetch CA list`,
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
            [String(username).trim(), branch_id, "ca"]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: `CA not found or does not belong to this branch`,
            });
        }

        const row = rows[0];
        const { balance, debit, credit } = await GET_BALANCE({
            party_type: "ca",
            party_id: username,
            branch_id,
        });

        return res.status(200).json({
            success: true,
            message: `CA profile retrieved successfully`,
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
        console.error(`Error fetching ca profile:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to fetch CA profile`,
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
            [String(username).trim(), branch_id, "ca"]
        );

        if (!partyCheck.length) {
            return res.status(404).json({
                success: false,
                message: `CA not found or does not belong to this branch`,
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
                [pan_number, "ca", branch_id, String(username).trim()]
            );

            if (existingPan.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: `A CA with this PAN number already exists`,
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
            user_type: "ca",
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
                    [newStatus, modifyBy, String(username).trim(), branch_id, "ca"]
                );
            }
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: `CA profile updated successfully`,
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

        console.error(`Error updating ca profile:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to update CA profile`,
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
            [String(username).trim(), branch_id, "ca"]
        );

        if (!partyRows.length) {
            return res.status(404).json({
                success: false,
                message: `CA not found in this branch`,
            });
        }

        const currentStatus = partyRows[0].status === "1" ? "active" : "deactive";
        if (currentStatus === normalizedStatus) {
            return res.status(400).json({
                success: false,
                message: `CA is already ${normalizedStatus}`,
            });
        }

        const newStatusValue = normalizedStatus === "active" ? "1" : "0";

        await pool.query(
            `UPDATE clients
                 SET status = ?, modify_by = ?, modify_date = NOW()
                 WHERE username = ? AND branch_id = ? AND user_type = ? AND is_deleted = '0'`,
            [newStatusValue, session_username, String(username).trim(), branch_id, "ca"]
        );

        return res.status(200).json({
            success: true,
            message: `CA status updated to ${normalizedStatus} successfully`,
            data: {
                username: String(username).trim(),
                status: normalizedStatus,
            },
        });
    } catch (error) {
        console.error(`Error updating ca status:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to update CA status`,
            error: error.message,
        });
    }
});

function parseCsvQuery(value) {
    if (value === undefined || value === null) return [];
    const raw = String(value).trim();
    if (!raw) return [];
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * CA report — individual tasks where CA is assigned.
 * GET /ca/details/report-by-service
 * Query: username, service_ids, type, firm_id, status (csv),
 *        from_date, to_date (complete_date — all service types),
 *        compliance_year, compliance_period (compliance tasks), search,
 *        page_no, limit
 */
router.get("/details/report-by-service", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            username,
            service_ids,
            type,
            firm_id,
            status,
            from_date,
            to_date,
            compliance_year,
            compliance_period,
            search,
            page_no = 1,
            limit = 20,
        } = req.query || {};

        const caUsername = String(username || "").trim();
        if (!caUsername) {
            return res.status(400).json({
                success: false,
                message: "username is required",
            });
        }

        const serviceType = type != null ? String(type).trim().toLowerCase() : "";
        if (serviceType && !["general", "compliance"].includes(serviceType)) {
            return res.status(400).json({
                success: false,
                message: "type must be empty, 'general', or 'compliance'",
            });
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        let limitNum = Number(limit) || 20;
        if (limitNum > 100) limitNum = 100;
        if (limitNum < 1) limitNum = 20;
        const offset = (pageNum - 1) * limitNum;

        const [caRows] = await pool.query(
            `SELECT username FROM clients
             WHERE username = ? AND branch_id = ? AND user_type = 'ca' AND is_deleted = '0'
             LIMIT 1`,
            [caUsername, branch_id]
        );
        if (!caRows.length) {
            return res.status(404).json({
                success: false,
                message: "CA not found in this branch",
            });
        }

        const serviceIdList = parseCsvQuery(service_ids);
        const statusList = parseCsvQuery(status).map((s) => String(s).trim().toLowerCase());
        const allowedStatuses = new Set([
            "in process",
            "pending from client",
            "pending from department",
            "complete",
            "cancel",
        ]);
        const normalizedStatuses = statusList.filter((s) => allowedStatuses.has(s));

        const hasComplianceYear =
            compliance_year != null && String(compliance_year).trim() !== "";
        const hasCompliancePeriod =
            compliance_period != null && String(compliance_period).trim() !== "";

        if (hasCompliancePeriod && !hasComplianceYear) {
            return res.status(400).json({
                success: false,
                message: "compliance_year is required when compliance_period is provided",
            });
        }

        const fromJoins = `
            FROM tasks t
            INNER JOIN services s ON s.service_id = t.service_id
            LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN profile pf ON pf.username = f.username
            LEFT JOIN profile p ON p.username = t.username
        `;

        const buildWhere = () => {
            let whereSql = `
                WHERE t.branch_id = ?
                  AND t.has_ca = '1'
                  AND t.ca_id = ?
            `;
            const whereParams = [branch_id, caUsername];

            if (serviceIdList.length > 0) {
                whereSql += ` AND t.service_id IN (${serviceIdList.map(() => "?").join(",")})`;
                whereParams.push(...serviceIdList);
            }
            if (serviceType) {
                whereSql += " AND LOWER(s.type) = ?";
                whereParams.push(serviceType);
            }
            if (firm_id && String(firm_id).trim() !== "") {
                whereSql += " AND t.firm_id = ?";
                whereParams.push(String(firm_id).trim());
            }
            if (normalizedStatuses.length > 0) {
                whereSql += ` AND LOWER(TRIM(t.status)) IN (${normalizedStatuses.map(() => "?").join(",")})`;
                whereParams.push(...normalizedStatuses);
            }

            if (from_date && String(from_date).trim() !== "") {
                whereSql += " AND DATE(t.complete_date) >= ?";
                whereParams.push(String(from_date).trim());
            }
            if (to_date && String(to_date).trim() !== "") {
                whereSql += " AND DATE(t.complete_date) <= ?";
                whereParams.push(String(to_date).trim());
            }

            if (hasComplianceYear || hasCompliancePeriod) {
                whereSql += " AND LOWER(s.type) = 'compliance'";
                if (hasComplianceYear) {
                    whereSql += " AND t.compliance_year = ?";
                    whereParams.push(String(compliance_year).trim());
                }
                if (hasCompliancePeriod) {
                    whereSql += " AND t.compliance_period = ?";
                    whereParams.push(String(compliance_period).trim());
                }
            }

            if (search && String(search).trim() !== "") {
                const pattern = `%${String(search).trim()}%`;
                whereSql += ` AND (
                    s.name LIKE ?
                    OR f.firm_name LIKE ?
                    OR COALESCE(NULLIF(TRIM(f.pan_no), ''), NULLIF(TRIM(pf.pan_number), ''), '') LIKE ?
                    OR p.name LIKE ?
                    OR p.mobile LIKE ?
                    OR t.username LIKE ?
                )`;
                whereParams.push(pattern, pattern, pattern, pattern, pattern, pattern);
            }

            return { whereSql, whereParams };
        };

        const { whereSql, whereParams } = buildWhere();

        const selectFields = `
            SELECT
                t.task_id,
                t.status,
                t.create_date,
                t.complete_date,
                t.service_id,
                s.name AS service_name,
                s.type AS service_type,
                t.firm_id,
                f.firm_name,
                f.firm_type,
                f.gst_no,
                f.tan_no,
                f.cin_no,
                f.vat_no,
                f.file_no,
                f.address_line_1,
                f.address_line_2,
                f.city,
                f.state,
                f.country,
                f.pincode,
                f.create_date AS firm_create_date,
                f.status AS firm_status,
                COALESCE(NULLIF(TRIM(f.pan_no), ''), NULLIF(TRIM(pf.pan_number), ''), '') AS firm_pan,
                t.username AS client_username,
                p.name AS client_name,
                p.mobile AS client_mobile,
                p.country_code AS client_country_code,
                t.compliance_year,
                t.compliance_period
        `;

        const [countRows] = await pool.query(
            `SELECT
                COUNT(*) AS total_tasks,
                COUNT(DISTINCT t.service_id) AS total_services,
                COUNT(DISTINCT t.firm_id) AS total_firms
             ${fromJoins}
             ${whereSql}`,
            whereParams
        );

        const total = Number(countRows[0]?.total_tasks) || 0;
        const totalServices = Number(countRows[0]?.total_services) || 0;
        const totalFirms = Number(countRows[0]?.total_firms) || 0;

        const [rows] = await pool.query(
            `${selectFields}
             ${fromJoins}
             ${whereSql}
             ORDER BY t.complete_date DESC, s.name ASC, f.firm_name ASC, p.name ASC
             LIMIT ? OFFSET ?`,
            [...whereParams, limitNum, offset]
        );

        const data = rows.map((row) => ({
            task_id: row.task_id,
            status: row.status || "",
            create_date: row.create_date,
            complete_date: row.complete_date,
            service_id: row.service_id,
            service_name: row.service_name,
            service_type: row.service_type,
            firm_id: row.firm_id,
            firm_name: row.firm_name || "—",
            firm_pan: row.firm_pan || "",
            firm_type: row.firm_type || "",
            firm_gst: row.gst_no || "",
            firm_tan: row.tan_no || "",
            firm_cin: row.cin_no || "",
            firm_vat: row.vat_no || "",
            firm_file_no: row.file_no || "",
            firm_address_line_1: row.address_line_1 || "",
            firm_address_line_2: row.address_line_2 || "",
            firm_city: row.city || "",
            firm_state: row.state || "",
            firm_country: row.country || "",
            firm_pincode: row.pincode || "",
            firm_create_date: row.firm_create_date || null,
            firm_status: row.firm_status,
            client_username: row.client_username || "",
            client_name: row.client_name || row.client_username || "—",
            client_mobile: row.client_mobile || "",
            client_country_code: row.client_country_code || "",
            compliance_year: row.compliance_year || null,
            compliance_period: row.compliance_period || null,
        }));

        return res.status(200).json({
            success: true,
            message: "CA firm report retrieved successfully",
            data,
            summary: {
                total_services: totalServices,
                total_firms: totalFirms,
                total_tasks: total,
            },
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
            filters_applied: {
                username: caUsername,
                service_ids: serviceIdList.length > 0 ? serviceIdList : "all",
                type: serviceType || "all",
                firm_id: firm_id ? String(firm_id).trim() : "all",
                status: normalizedStatuses.length > 0 ? normalizedStatuses : "all",
                from_date: from_date || null,
                to_date: to_date || null,
                compliance_year: compliance_year || null,
                compliance_period: compliance_period || null,
                search: search || null,
            },
        });
    } catch (error) {
        console.error("CA report-by-service error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch CA service report",
            error: error.message,
        });
    }
});

export default router;
