import express from "express";
import axios from "axios";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { GET_FIRMS_BY_USERNAME, RANDOM_STRING } from "../helpers/function.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { validateAgentSession } from "../middleware/validateAgentSession.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_IMAGE_DIR = path.join(__dirname, "..", "media", "profile", "image");
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
const ALLOWED_IMAGE_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
];

if (!fs.existsSync(PROFILE_IMAGE_DIR)) {
    fs.mkdirSync(PROFILE_IMAGE_DIR, { recursive: true });
}

function validateImageFile(buffer, ext) {
    if (buffer.length < 4) return false;

    const signatures = {
        jpg: [0xff, 0xd8, 0xff],
        jpeg: [0xff, 0xd8, 0xff],
        png: [0x89, 0x50, 0x4e, 0x47],
        gif: [0x47, 0x49, 0x46, 0x38],
        webp: [0x52, 0x49, 0x46, 0x46],
        bmp: [0x42, 0x4d],
    };

    const signature = signatures[ext];
    if (!signature) return false;

    for (let i = 0; i < signature.length; i++) {
        if (buffer[i] !== signature[i]) {
            return false;
        }
    }

    if (ext === "webp") {
        const webpString = buffer.toString("ascii", 8, 12);
        if (webpString !== "WEBP") {
            return false;
        }
    }

    return true;
}

async function downloadAndSaveProfileImage(imageUrl) {
    try {
        if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
            throw new Error("Invalid image URL");
        }

        const response = await axios({
            method: "GET",
            url: imageUrl,
            responseType: "arraybuffer",
            maxContentLength: MAX_IMAGE_SIZE,
            timeout: 30000,
            validateStatus: (status) => status === 200,
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers["content-type"] || "";

        if (buffer.length > MAX_IMAGE_SIZE) {
            throw new Error("Image size exceeds maximum allowed size of 5MB");
        }

        if (!ALLOWED_IMAGE_MIME_TYPES.includes(contentType.toLowerCase())) {
            throw new Error(`Invalid image MIME type: ${contentType}. Allowed types: ${ALLOWED_IMAGE_MIME_TYPES.join(", ")}`);
        }

        let ext = "jpg";
        if (contentType.includes("jpeg")) ext = "jpg";
        else if (contentType.includes("png")) ext = "png";
        else if (contentType.includes("gif")) ext = "gif";
        else if (contentType.includes("webp")) ext = "webp";
        else if (contentType.includes("bmp")) ext = "bmp";
        else {
            const urlExt = imageUrl.split(".").pop()?.toLowerCase().split("?")[0];
            if (urlExt && ALLOWED_IMAGE_EXTENSIONS.includes(urlExt)) {
                ext = urlExt;
            }
        }

        if (!validateImageFile(buffer, ext)) {
            throw new Error("Invalid image file. File content does not match the image type.");
        }

        const filename = `${RANDOM_STRING(30)}.${ext}`;
        fs.writeFileSync(path.join(PROFILE_IMAGE_DIR, filename), buffer);
        return filename;
    } catch (error) {
        if (error.response) {
            throw new Error(`Failed to download image: HTTP ${error.response.status}`);
        }
        if (error.code === "ECONNABORTED") {
            throw new Error("Image download timeout");
        }
        if (error.message.includes("maxContentLength")) {
            throw new Error("Image size exceeds maximum allowed size of 5MB");
        }
        throw new Error(`Failed to download image: ${error.message}`);
    }
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

const CLIENT_STATUS_MAP = {
    "0": "inactive",
    "1": "active",
    "2": "under review",
};

const CLIENT_STATUS_FILTER_MAP = {
    inactive: "0",
    active: "1",
    "under review": "2",
};

function formatClientStatus(status) {
    return CLIENT_STATUS_MAP[String(status)] || "inactive";
}

function parseClientStatusFilter(value) {
    const raw = value != null ? String(value).trim().toLowerCase() : "";
    if (raw === "") {
        return { dbStatus: null };
    }

    if (!Object.prototype.hasOwnProperty.call(CLIENT_STATUS_FILTER_MAP, raw)) {
        return {
            error: 'Invalid status. Allowed values: "active", "inactive", "under review"',
        };
    }

    return { dbStatus: CLIENT_STATUS_FILTER_MAP[raw] };
}

function formatFirmStatus(status) {
    return String(status) === "1" ? "active" : "inactive";
}

async function getAgentManagedClient(username, branch_id, agent_username) {
    const [rows] = await pool.query(
        `SELECT c.username, c.branch_id, c.status, c.agent, c.create_date
         FROM clients c
         WHERE c.username = ?
           AND c.branch_id = ?
           AND c.user_type = 'client'
           AND c.agent = ?
           AND (c.is_deleted = '0' OR c.is_deleted = 0)
         LIMIT 1`,
        [username, branch_id, agent_username]
    );

    return rows[0] || null;
}

async function getAgentClientProfile(username, branch_id) {
    const [rows] = await pool.query(
        `SELECT
            c.username,
            c.branch_id,
            c.status,
            c.agent,
            c.create_date,
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
         WHERE c.username = ?
           AND c.branch_id = ?
         LIMIT 1`,
        [username, branch_id]
    );

    return rows[0] || null;
}

function buildClientDetailsResponse(row) {
    const image = row.image && String(row.image).trim() !== ""
        ? `${BASE_DOMAIN}/media/profile/image/${row.image}`
        : null;

    return {
        username: row.username,
        profile_id: row.profile_id,
        branch_id: row.branch_id,
        agent: row.agent,
        status: formatClientStatus(row.status),
        create_date: row.create_date,
        profile: {
            pan: row.pan_number,
            full_name: row.name,
            care_of: row.care_of,
            guardian_name: row.guardian_name,
            mobile: row.mobile,
            country_code: row.country_code,
            email: row.email,
            date_of_birth: row.date_of_birth,
            gender: row.gender,
            image,
        },
        address: {
            state: row.state,
            district: row.district,
            town_or_village: row.village_town,
            pincode: row.pincode,
            address_line_1: row.address_line_1,
            address_line_2: row.address_line_2,
        },
    };
}

function formatFirmRow(row) {
    return {
        firm_id: row.firm_id,
        type: row.firm_type,
        pan: row.pan_no,
        firm: row.firm_name,
        gst: row.gst_no,
        tan: row.tan_no,
        vat: row.vat_no,
        cin: row.cin_no,
        status: formatFirmStatus(row.status),
        create_date: row.create_date,
        address: {
            state: row.state,
            district: row.district,
            town: row.city,
            pincode: row.pincode,
            address_line_1: row.address_line_1,
            address_line_2: row.address_line_2,
        },
    };
}

function validateBusinessPayload(biz) {
    const { type: business_type, pan: business_pan } = biz || {};

    if (!business_type || !business_pan) {
        return "Missing required business details (type, pan)";
    }

    const isIndividual = business_type.toLowerCase() === "individual";
    if (!isIndividual) {
        const { firm, address: bizAddress } = biz;
        if (!firm || !bizAddress || !bizAddress.state || !bizAddress.district || !bizAddress.town || !bizAddress.pincode) {
            return "Missing required business details for non-individual type (firm, address with state, district, town, pincode)";
        }
    }

    return null;
}

router.get("/list", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
        const { page_no = 1, limit = 20, search, status } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const statusFilter = parseClientStatusFilter(status);
        if (statusFilter.error) {
            return res.status(400).json({
                success: false,
                message: statusFilter.error,
            });
        }

        let query = `
            SELECT
                c.id,
                c.username,
                c.branch_id,
                c.create_date,
                c.status,
                c.agent,
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
            WHERE c.user_type = 'client'
              AND (c.is_deleted = '0' OR c.is_deleted = 0)
              AND c.branch_id = ?
              AND c.agent = ?
        `;

        const queryParams = [branch_id, agent_username];

        if (statusFilter.dbStatus !== null) {
            query += ` AND c.status = ?`;
            queryParams.push(statusFilter.dbStatus);
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            query += ` AND (p.name LIKE ? OR p.mobile LIKE ? OR p.email LIKE ? OR p.pan_number LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        const countQuery = query.replace(
            /SELECT[\s\S]*?FROM/,
            "SELECT COUNT(*) AS total FROM"
        );
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = Number(countResult[0]?.total || 0);

        query += ` ORDER BY c.id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        const transformedRows = await Promise.all(rows.map(async (row) => {
            const transformedRow = { ...row };
            transformedRow.status = formatClientStatus(transformedRow.status);

            if (transformedRow.image && String(transformedRow.image).trim() !== "") {
                transformedRow.image = `${BASE_DOMAIN}/media/profile/image/${transformedRow.image}`;
            } else {
                transformedRow.image = null;
            }

            const firms = await GET_FIRMS_BY_USERNAME({
                username: transformedRow.username,
                branch_id,
            });
            transformedRow.firms = firms || [];

            return transformedRow;
        }));

        return res.status(200).json({
            success: true,
            message: "Client list retrieved successfully",
            data: transformedRows,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("AGENT CLIENT LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch client list",
            error: error.message,
        });
    }
});

router.post("/create", validateAgentSession, async (req, res) => {
    const conn = await pool.getConnection();
    let savedImageFilename = null;

    try {
        const {
            profile = {},
            address = {},
            business = [],
        } = req.body || {};

        const branch_id = req.branch_id;
        const createdBy = req.agent_username;

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

        if (!pan_number || !full_name || !care_of || !guardian_name || !mobile || !email || !date_of_birth || !gender) {
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

        if (!business || !Array.isArray(business) || business.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Missing required business details (business array must have at least one item)",
            });
        }

        for (const biz of business) {
            const { type: business_type, pan: business_pan } = biz;

            if (!business_type || !business_pan) {
                return res.status(400).json({
                    success: false,
                    message: "Missing required business details (type, pan) in business array",
                });
            }

            const isIndividual = business_type.toLowerCase() === "individual";
            if (!isIndividual) {
                const { firm, address: bizAddress } = biz;
                if (!firm || !bizAddress || !bizAddress.state || !bizAddress.district || !bizAddress.town || !bizAddress.pincode) {
                    return res.status(400).json({
                        success: false,
                        message: "Missing required business details for non-individual type (firm, address with state, district, town, pincode)",
                    });
                }
            }
        }

        const [existingMobile] = await pool.query(
            "SELECT p.username FROM profile p JOIN clients c ON p.username = c.username WHERE p.mobile = ? AND c.user_type = 'client' AND c.is_deleted = '0'",
            [mobile]
        );

        if (existingMobile.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this mobile number already exists",
            });
        }

        const [existingEmail] = await pool.query(
            "SELECT p.username FROM profile p JOIN clients c ON p.username = c.username WHERE p.email = ? AND c.user_type = 'client' AND c.is_deleted = '0'",
            [email]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this email already exists",
            });
        }

        const [existingPan] = await pool.query(
            "SELECT p.username FROM profile p JOIN clients c ON p.username = c.username WHERE p.pan_number = ? AND c.user_type = 'client' AND c.is_deleted = '0' AND c.branch_id = ?",
            [pan_number, branch_id]
        );

        if (existingPan.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this PAN number already exists",
            });
        }

        if (image && image !== null && String(image).trim() !== "") {
            try {
                savedImageFilename = await downloadAndSaveProfileImage(image);
            } catch (imageError) {
                return res.status(400).json({
                    success: false,
                    message: `Profile image error: ${imageError.message}`,
                });
            }
        }

        await conn.beginTransaction();

        const username = RANDOM_STRING(20);
        const profile_id = RANDOM_STRING(30);

        await insertRow("clients", {
            username,
            user_type: "client",
            agent: createdBy,
            branch_id,
            create_by: createdBy,
            status: "2",
            is_deleted: "0",
        });

        await insertRow("profile", {
            profile_id,
            username,
            create_by: createdBy,
            user_type: "client",
            name: full_name,
            care_of: care_of || null,
            guardian_name: guardian_name || null,
            date_of_birth: date_of_birth || null,
            gender: gender || null,
            mobile,
            country_code,
            email,
            pan_number,
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

        const createdFirms = [];
        for (const biz of business) {
            const {
                type: business_type,
                pan: business_pan,
                firm: firm_name,
                gst: gst_number,
                tan: tan_number,
                vat: vat_number,
                cin: cin_number,
                address: bizAddress = {},
            } = biz;

            const isIndividual = business_type.toLowerCase() === "individual";
            const firm_id = RANDOM_STRING(30);

            await insertRow("firms", {
                firm_id,
                branch_id,
                username,
                firm_name: isIndividual ? full_name : (firm_name || null),
                firm_type: business_type,
                pan_no: business_pan,
                gst_no: isIndividual ? null : (gst_number || null),
                tan_no: isIndividual ? null : (tan_number || null),
                vat_no: isIndividual ? null : (vat_number || null),
                cin_no: isIndividual ? null : (cin_number || null),
                file_no: null,
                state: isIndividual ? null : (bizAddress.state || null),
                district: isIndividual ? null : (bizAddress.district || null),
                city: isIndividual ? null : (bizAddress.town || null),
                pincode: isIndividual ? null : (bizAddress.pincode || null),
                address_line_1: isIndividual ? null : (bizAddress.address_line_1 || null),
                address_line_2: isIndividual ? null : (bizAddress.address_line_2 || null),
                create_by: createdBy,
                status: "1",
                is_deleted: "0",
            });

            createdFirms.push({
                firm_id,
                firm_name: isIndividual ? full_name : firm_name,
                business_type,
            });
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Client created successfully and pending office verification",
            data: {
                username,
                profile_id,
                firms: createdFirms,
                name: full_name,
                mobile,
                email,
                pan_number,
                branch_id,
                status: formatClientStatus("2"),
                agent: createdBy,
            },
        });
    } catch (error) {
        await conn.rollback();

        if (savedImageFilename) {
            try {
                const imagePath = path.join(PROFILE_IMAGE_DIR, savedImageFilename);
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
            } catch (cleanupError) {
                console.error("Error cleaning up image file:", cleanupError);
            }
        }

        console.error("AGENT CLIENT CREATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create client",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.get("/details/:username", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
        const username = String(req.params.username || "").trim();

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required",
            });
        }

        const client = await getAgentManagedClient(username, branch_id, agent_username);
        if (!client) {
            return res.status(404).json({
                success: false,
                message: "Client not found",
            });
        }

        const profileRow = await getAgentClientProfile(username, branch_id);
        if (!profileRow) {
            return res.status(404).json({
                success: false,
                message: "Client profile not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Client details retrieved successfully",
            data: buildClientDetailsResponse(profileRow),
        });
    } catch (error) {
        console.error("AGENT CLIENT DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch client details",
            error: error.message,
        });
    }
});

router.get("/details/:username/firms", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
        const username = String(req.params.username || "").trim();
        const { page_no = 1, limit = 20, search } = req.query || {};

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required",
            });
        }

        const client = await getAgentManagedClient(username, branch_id, agent_username);
        if (!client) {
            return res.status(404).json({
                success: false,
                message: "Client not found",
            });
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let baseQuery = `
            FROM firms f
            WHERE f.username = ?
              AND f.branch_id = ?
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
        `;
        const params = [username, branch_id];

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
              AND (
                  f.firm_name LIKE ?
                  OR f.firm_type LIKE ?
                  OR f.pan_no LIKE ?
                  OR f.gst_no LIKE ?
                  OR f.tan_no LIKE ?
                  OR f.cin_no LIKE ?
              )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
        const total = Number(countRows[0]?.total || 0);

        const [rows] = await pool.query(
            `SELECT
                f.firm_id,
                f.firm_name,
                f.firm_type,
                f.pan_no,
                f.gst_no,
                f.tan_no,
                f.vat_no,
                f.cin_no,
                f.state,
                f.district,
                f.city,
                f.pincode,
                f.address_line_1,
                f.address_line_2,
                f.status,
                f.create_date
             ${baseQuery}
             ORDER BY f.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        return res.status(200).json({
            success: true,
            message: "Client firms retrieved successfully",
            data: rows.map(formatFirmRow),
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("AGENT CLIENT FIRMS LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch client firms",
            error: error.message,
        });
    }
});

router.put("/details/:username", validateAgentSession, async (req, res) => {
    const conn = await pool.getConnection();
    let savedImageFilename = null;

    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
        const username = String(req.params.username || "").trim();
        const { profile = {}, address = {} } = req.body || {};

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required",
            });
        }

        const client = await getAgentManagedClient(username, branch_id, agent_username);
        if (!client) {
            return res.status(404).json({
                success: false,
                message: "Client not found",
            });
        }

        if (String(client.status) !== "2") {
            return res.status(403).json({
                success: false,
                message: "Client can only be edited while under review",
            });
        }

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

        if (!pan_number || !full_name || !care_of || !guardian_name || !mobile || !email || !date_of_birth || !gender) {
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
             WHERE p.mobile = ? AND c.user_type = 'client' AND c.is_deleted = '0' AND p.username != ?`,
            [mobile, username]
        );

        if (existingMobile.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this mobile number already exists",
            });
        }

        const [existingEmail] = await pool.query(
            `SELECT p.username FROM profile p
             JOIN clients c ON p.username = c.username
             WHERE p.email = ? AND c.user_type = 'client' AND c.is_deleted = '0' AND p.username != ?`,
            [email, username]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this email already exists",
            });
        }

        const [existingPan] = await pool.query(
            `SELECT p.username FROM profile p
             JOIN clients c ON p.username = c.username
             WHERE p.pan_number = ? AND c.user_type = 'client' AND c.is_deleted = '0'
               AND c.branch_id = ? AND p.username != ?`,
            [pan_number, branch_id, username]
        );

        if (existingPan.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this PAN number already exists",
            });
        }

        if (image && image !== null && String(image).trim() !== "") {
            try {
                savedImageFilename = await downloadAndSaveProfileImage(image);
            } catch (imageError) {
                return res.status(400).json({
                    success: false,
                    message: `Profile image error: ${imageError.message}`,
                });
            }
        }

        const [existingProfileRow] = await pool.query(
            "SELECT profile_id, image FROM profile WHERE username = ? AND status = '1' ORDER BY id DESC LIMIT 1",
            [username]
        );
        const profile_id = existingProfileRow.length > 0
            ? existingProfileRow[0].profile_id
            : RANDOM_STRING(30);
        const existingImage = existingProfileRow.length > 0 ? existingProfileRow[0].image : null;

        await conn.beginTransaction();

        await conn.query("UPDATE profile SET status = '0' WHERE username = ?", [username]);

        await insertRow("profile", {
            profile_id,
            username,
            create_by: agent_username,
            modify_by: agent_username,
            user_type: "client",
            name: full_name,
            care_of: care_of || null,
            guardian_name: guardian_name || null,
            date_of_birth: date_of_birth || null,
            gender: gender || null,
            mobile,
            country_code,
            email,
            pan_number,
            state: state || null,
            district: district || null,
            city: district || null,
            village_town: town_or_village || null,
            pincode: pincode || null,
            address_line_1: address_line_1 || null,
            address_line_2: address_line_2 || null,
            image: savedImageFilename || existingImage || null,
            status: "1",
        });

        await conn.query(
            `UPDATE firms
             SET firm_name = ?
             WHERE username = ?
               AND branch_id = ?
               AND firm_type = 'individual'
               AND (is_deleted = '0' OR is_deleted = 0)`,
            [full_name, username, branch_id]
        );

        await conn.query(
            "UPDATE clients SET modify_by = ?, modify_date = NOW() WHERE username = ? AND branch_id = ?",
            [agent_username, username, branch_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Client updated successfully",
            data: {
                username,
                profile_id,
                name: full_name,
                mobile,
                email,
                pan_number,
                branch_id,
                status: formatClientStatus(client.status),
                agent: agent_username,
            },
        });
    } catch (error) {
        await conn.rollback();

        if (savedImageFilename) {
            try {
                const imagePath = path.join(PROFILE_IMAGE_DIR, savedImageFilename);
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
            } catch (cleanupError) {
                console.error("Error cleaning up image file:", cleanupError);
            }
        }

        console.error("AGENT CLIENT UPDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update client",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.put("/details/firms/:firm_id", validateAgentSession, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
        const firm_id = String(req.params.firm_id || "").trim();
        const biz = req.body || {};

        if (!firm_id) {
            return res.status(400).json({
                success: false,
                message: "Firm ID is required",
            });
        }

        const validationError = validateBusinessPayload(biz);
        if (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError,
            });
        }

        const [firmRows] = await pool.query(
            `SELECT f.firm_id, f.username, c.status AS client_status
             FROM firms f
             INNER JOIN clients c ON c.username = f.username
                AND c.branch_id = f.branch_id
                AND c.user_type = 'client'
                AND c.agent = ?
                AND (c.is_deleted = '0' OR c.is_deleted = 0)
             WHERE f.firm_id = ?
               AND f.branch_id = ?
               AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LIMIT 1`,
            [agent_username, firm_id, branch_id]
        );

        if (!firmRows.length) {
            return res.status(404).json({
                success: false,
                message: "Firm not found",
            });
        }

        if (String(firmRows[0].client_status) !== "2") {
            return res.status(403).json({
                success: false,
                message: "Firm can only be edited while client is under review",
            });
        }

        const username = firmRows[0].username;
        const {
            type: business_type,
            pan: business_pan,
            firm: firm_name,
            gst: gst_number,
            tan: tan_number,
            vat: vat_number,
            cin: cin_number,
            address: bizAddress = {},
        } = biz;

        const isIndividual = business_type.toLowerCase() === "individual";
        let resolvedFirmName = isIndividual ? null : (firm_name || null);

        if (isIndividual) {
            const [profileRows] = await pool.query(
                `SELECT name FROM profile
                 WHERE username = ? AND status = '1'
                 ORDER BY id DESC LIMIT 1`,
                [username]
            );
            resolvedFirmName = profileRows[0]?.name || null;
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE firms
             SET firm_name = ?,
                 firm_type = ?,
                 pan_no = ?,
                 gst_no = ?,
                 tan_no = ?,
                 vat_no = ?,
                 cin_no = ?,
                 file_no = ?,
                 state = ?,
                 district = ?,
                 city = ?,
                 pincode = ?,
                 address_line_1 = ?,
                 address_line_2 = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE firm_id = ?
               AND username = ?
               AND branch_id = ?
               AND (is_deleted = '0' OR is_deleted = 0)`,
            [
                resolvedFirmName,
                business_type,
                business_pan,
                isIndividual ? null : (gst_number || null),
                isIndividual ? null : (tan_number || null),
                isIndividual ? null : (vat_number || null),
                isIndividual ? null : (cin_number || null),
                null,
                isIndividual ? null : (bizAddress.state || null),
                isIndividual ? null : (bizAddress.district || null),
                isIndividual ? null : (bizAddress.town || null),
                isIndividual ? null : (bizAddress.pincode || null),
                isIndividual ? null : (bizAddress.address_line_1 || null),
                isIndividual ? null : (bizAddress.address_line_2 || null),
                agent_username,
                firm_id,
                username,
                branch_id,
            ]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Firm updated successfully",
            data: {
                firm_id,
                firm_name: resolvedFirmName,
                business_type,
            },
        });
    } catch (error) {
        await conn.rollback();
        console.error("AGENT FIRM UPDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update firm",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.delete("/:username", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
        const username = String(req.params.username || "").trim();

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required",
            });
        }

        const client = await getAgentManagedClient(username, branch_id, agent_username);
        if (!client) {
            return res.status(404).json({
                success: false,
                message: "Client not found",
            });
        }

        if (String(client.status) !== "2") {
            return res.status(403).json({
                success: false,
                message: "Client can only be deleted while under review",
            });
        }

        await pool.query(
            `UPDATE clients
             SET is_deleted = '1', modify_by = ?, modify_date = NOW()
             WHERE username = ? AND branch_id = ? AND user_type = 'client'`,
            [agent_username, username, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Client deleted successfully",
            data: {
                username,
                status: formatClientStatus(client.status),
            },
        });
    } catch (error) {
        console.error("AGENT CLIENT DELETE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete client",
            error: error.message,
        });
    }
});

router.delete("/client/firms/:firm_id", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
        const firm_id = String(req.params.firm_id || "").trim();

        if (!firm_id) {
            return res.status(400).json({
                success: false,
                message: "Firm ID is required",
            });
        }

        const [firmRows] = await pool.query(
            `SELECT f.firm_id, f.username, c.status AS client_status
             FROM firms f
             INNER JOIN clients c ON c.username = f.username
                AND c.branch_id = f.branch_id
                AND c.user_type = 'client'
                AND c.agent = ?
                AND (c.is_deleted = '0' OR c.is_deleted = 0)
             WHERE f.firm_id = ?
               AND f.branch_id = ?
               AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LIMIT 1`,
            [agent_username, firm_id, branch_id]
        );

        if (!firmRows.length) {
            return res.status(404).json({
                success: false,
                message: "Firm not found",
            });
        }

        if (String(firmRows[0].client_status) !== "2") {
            return res.status(403).json({
                success: false,
                message: "Firm can only be deleted while client is under review",
            });
        }

        await pool.query(
            `UPDATE firms
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE firm_id = ? AND branch_id = ?`,
            [agent_username, agent_username, firm_id, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Firm deleted successfully",
            data: {
                firm_id,
            },
        });
    } catch (error) {
        console.error("AGENT FIRM DELETE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete firm",
            error: error.message,
        });
    }
});

export default router;
