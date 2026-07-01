import express from "express";
import pool from "../db.js";
import {
    getFinancialYearForDate,
    getPeriodStartDate,
    getPeriodEndDate,
    autoTransferActiveAssignmentsForClient,
    filterSchedulesByRecurringRules
} from "../helpers/recurringTaskHelper.js";
import { auth, CheckUserProjectMaping, validateBranch } from "../middleware/auth.js";
import { RANDOM_STRING, USER_DATA, SET_OPENING_BALANCE, GET_BALANCE, TODAY_DATE, GET_FIRMS_BY_USERNAME, USER_SNIPPED_DATA } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { BASE_DOMAIN, DOCUMENT_RESERVED_CATEGORIES } from "../helpers/Config.js";
import {
    deleteProfileDocument,
    downloadAndUploadProfileDocument,
    getProfileDocumentAccessUrl,
} from "../helpers/b2Storage.js";
import { downloadAndSaveNoteFile, downloadAndSaveVoiceFile, NOTE_FILE_DIR, NOTE_VOICE_DIR } from "../helpers/NoteFile.js";
import axios from "axios";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import xlsx from "xlsx";
import moment from "moment";

const router = express.Router();

// Get current directory (where client.js is located)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Profile image configuration
const PROFILE_IMAGE_DIR = path.join(__dirname, "..", "media", "profile", "image");
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const ALLOWED_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp'
];

// Note file configuration (NOTE_FILE_DIR, NOTE_VOICE_DIR imported from helpers/NoteFile.js)
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_VOICE_SIZE = 50 * 1024 * 1024; // 50 MB for voice files

// Allowed file extensions (for type='file')
const ALLOWED_FILE_EXTENSIONS = [
    // Images
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
    // Documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv',
    // Videos
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', 'm4v',
    // Archives
    'zip', 'rar', '7z', 'tar', 'gz'
];

// Allowed audio extensions and MIME types (for type='voice')
const ALLOWED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'wma', 'opus'];
const ALLOWED_AUDIO_MIME_TYPES = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/ogg',
    'audio/vorbis',
    'audio/aac',
    'audio/flac',
    'audio/x-flac',
    'audio/mp4',
    'audio/x-m4a',
    'audio/x-ms-wma',
    'audio/opus',
    'audio/webm'
];

// Ensure directories exist
if (!fs.existsSync(PROFILE_IMAGE_DIR)) {
    fs.mkdirSync(PROFILE_IMAGE_DIR, { recursive: true });
}
// Note file/voice dirs are ensured in helpers/NoteFile.js on download

// Helper function to validate image file by checking file headers
function validateImageFile(buffer, ext) {
    if (buffer.length < 4) return false;

    const signatures = {
        'jpg': [0xFF, 0xD8, 0xFF],
        'jpeg': [0xFF, 0xD8, 0xFF],
        'png': [0x89, 0x50, 0x4E, 0x47],
        'gif': [0x47, 0x49, 0x46, 0x38],
        'webp': [0x52, 0x49, 0x46, 0x46], // RIFF header
        'bmp': [0x42, 0x4D] // BM
    };

    const signature = signatures[ext];
    if (!signature) return false;

    // Check if buffer starts with the signature
    for (let i = 0; i < signature.length; i++) {
        if (buffer[i] !== signature[i]) {
            return false;
        }
    }

    // Additional check for WebP (RIFF...WEBP)
    if (ext === 'webp') {
        const webpString = buffer.toString('ascii', 8, 12);
        if (webpString !== 'WEBP') {
            return false;
        }
    }

    return true;
}

// Helper function to download and save profile image
async function downloadAndSaveProfileImage(imageUrl) {
    try {
        // Validate URL
        if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
            throw new Error('Invalid image URL');
        }

        // Download image with size limit
        const response = await axios({
            method: 'GET',
            url: imageUrl,
            responseType: 'arraybuffer',
            maxContentLength: MAX_IMAGE_SIZE,
            timeout: 30000, // 30 seconds timeout
            validateStatus: (status) => status === 200
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';

        // Validate file size
        if (buffer.length > MAX_IMAGE_SIZE) {
            throw new Error(`Image size exceeds maximum allowed size of 5MB`);
        }

        // Validate MIME type
        if (!ALLOWED_IMAGE_MIME_TYPES.includes(contentType.toLowerCase())) {
            throw new Error(`Invalid image MIME type: ${contentType}. Allowed types: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`);
        }

        // Determine file extension from MIME type or URL
        let ext = 'jpg'; // default
        if (contentType.includes('jpeg')) ext = 'jpg';
        else if (contentType.includes('png')) ext = 'png';
        else if (contentType.includes('gif')) ext = 'gif';
        else if (contentType.includes('webp')) ext = 'webp';
        else if (contentType.includes('bmp')) ext = 'bmp';
        else {
            // Try to get extension from URL
            const urlExt = imageUrl.split('.').pop()?.toLowerCase().split('?')[0];
            if (urlExt && ALLOWED_IMAGE_EXTENSIONS.includes(urlExt)) {
                ext = urlExt;
            }
        }

        // Validate image file content
        if (!validateImageFile(buffer, ext)) {
            throw new Error(`Invalid image file. File content does not match the image type.`);
        }

        // Generate random filename
        const randomName = RANDOM_STRING(30);
        const filename = `${randomName}.${ext}`;
        const filePath = path.join(PROFILE_IMAGE_DIR, filename);

        // Save file
        fs.writeFileSync(filePath, buffer);

        return filename;
    } catch (error) {
        if (error.response) {
            throw new Error(`Failed to download image: HTTP ${error.response.status}`);
        } else if (error.code === 'ECONNABORTED') {
            throw new Error('Image download timeout');
        } else if (error.message.includes('maxContentLength')) {
            throw new Error(`Image size exceeds maximum allowed size of 5MB`);
        } else {
            throw new Error(`Failed to download image: ${error.message}`);
        }
    }
}

async function rollbackUploadedDocuments(savedFiles = []) {
    for (const item of savedFiles) {
        try {
            await deleteProfileDocument(item.categoryFolder, item.filename);
        } catch (_) { }
    }
}

// Helper function to get table columns
async function getTableColumns(tableName) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map(r => r.Field));
}

// Helper function to insert row with only valid columns
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
    let savedImageFilename = null; // Declare outside try block for cleanup

    try {
        const {
            profile = {},
            address = {},
            business = [],
            opening_balance = {}
        } = req.body || {};

        const createdBy = req.headers["username"] || "";
        const { branch_id } = req;

        // Extract profile fields
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
            image
        } = profile;

        // Extract address fields
        const {
            state,
            district,
            town_or_village,
            pincode,
            address_line_1,
            address_line_2
        } = address;

        // Validate required fields
        if (!pan_number || !full_name || !care_of || !guardian_name || !mobile || !email || !date_of_birth || !gender) {
            return res.status(400).json({
                success: false,
                message: "Missing required profile details"
            });
        }

        if (!state || !district || !town_or_village || !pincode) {
            return res.status(400).json({
                success: false,
                message: "Missing required address details"
            });
        }

        if (!business || !Array.isArray(business) || business.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Missing required business details (business array must have at least one item)"
            });
        }

        // Validate each business in the array
        for (const biz of business) {
            const { type: business_type, pan: business_pan } = biz;

            if (!business_type || !business_pan) {
                return res.status(400).json({
                    success: false,
                    message: "Missing required business details (type, pan) in business array"
                });
            }

            // For non-individual business types, validate additional required fields
            const isIndividual = business_type.toLowerCase() === 'individual';
            if (!isIndividual) {
                const { firm, address: bizAddress } = biz;
                if (!firm || !bizAddress || !bizAddress.state || !bizAddress.district || !bizAddress.town || !bizAddress.pincode) {
                    return res.status(400).json({
                        success: false,
                        message: "Missing required business details for non-individual type (firm, address with state, district, town, pincode)"
                    });
                }
            }
        }

        // Check if client with same mobile already exists
        const [existingMobile] = await pool.query(
            "SELECT p.username FROM profile p JOIN clients c ON p.username = c.username WHERE p.mobile = ? AND c.user_type = 'client' AND c.is_deleted = '0'",
            [mobile]
        );

        if (existingMobile.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this mobile number already exists"
            });
        }

        // Check if client with same email already exists
        const [existingEmail] = await pool.query(
            "SELECT p.username FROM profile p JOIN clients c ON p.username = c.username WHERE p.email = ? AND c.user_type = 'client' AND c.is_deleted = '0'",
            [email]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this email already exists"
            });
        }

        // Check if PAN already exists
        const [existingPan] = await pool.query(
            "SELECT p.username FROM profile p JOIN clients c ON p.username = c.username WHERE p.pan_number = ? AND c.user_type = 'client' AND c.is_deleted = '0' AND c.branch_id = ?",
            [pan_number, branch_id]
        );

        if (existingPan.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this PAN number already exists"
            });
        }

        // Process profile image if provided
        if (image && image !== null && image.trim() !== '') {
            try {
                savedImageFilename = await downloadAndSaveProfileImage(image);
            } catch (imageError) {
                return res.status(400).json({
                    success: false,
                    message: `Profile image error: ${imageError.message}`
                });
            }
        }

        await conn.beginTransaction();

        // Generate unique IDs
        const username = RANDOM_STRING(20);
        const profile_id = RANDOM_STRING(30);

        // Insert into clients table
        await insertRow("clients", {
            username,
            user_type: "client",
            branch_id,
            create_by: createdBy,
            status: "1",
            is_deleted: "0"
        });

        // Insert into profile table
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
            status: "1"
        });

        // Process each business in the array
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
                file: file_number,
                address: bizAddress = {},
                groups: bizGroups = []
            } = biz;

            const isIndividual = business_type.toLowerCase() === 'individual';
            const firm_id = RANDOM_STRING(30);

            // Insert into firms table
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
                file_no: isIndividual ? null : (file_number || null),
                state: isIndividual ? null : (bizAddress.state || null),
                district: isIndividual ? null : (bizAddress.district || null),
                city: isIndividual ? null : (bizAddress.town || null),
                pincode: isIndividual ? null : (bizAddress.pincode || null),
                address_line_1: isIndividual ? null : (bizAddress.address_line_1 || null),
                address_line_2: isIndividual ? null : (bizAddress.address_line_2 || null),
                create_by: createdBy,
                status: "1",
                is_deleted: "0"
            });

            // Insert group mappings for this firm
            if (bizGroups && Array.isArray(bizGroups) && bizGroups.length > 0) {
                for (const groupId of bizGroups) {
                    const unique_id = RANDOM_STRING(30);
                    await conn.query(
                        "INSERT INTO group_firms (unique_id, firm_id, group_id, create_by, modify_by) VALUES (?, ?, ?, ?, ?)",
                        [unique_id, firm_id, groupId, createdBy, createdBy]
                    );
                }
            }

            createdFirms.push({
                firm_id,
                firm_name: isIndividual ? full_name : firm_name,
                business_type
            });
        }

        await conn.commit();

        // Handle opening balance if provided (after commit since SET_OPENING_BALANCE uses its own transaction)
        if (opening_balance && opening_balance.amount !== undefined && opening_balance.amount !== null) {
            // SET_OPENING_BALANCE expects branch_id in headers, so we need to add it temporarily
            const originalBranchId = req.headers["branch_id"];
            req.headers["branch_id"] = branch_id;

            try {
                await SET_OPENING_BALANCE({
                    req,
                    type: opening_balance.type || "credit",
                    party_type: "client",
                    party_id: username,
                    amount: opening_balance.amount,
                    remark: "",
                    transaction_date: opening_balance.date || new Date().toISOString().split('T')[0]
                });
            } catch (balanceError) {
                // If opening balance fails, log but don't fail the entire creation
                console.error('Opening balance error:', balanceError);
            } finally {
                // Restore original branch_id if it existed
                if (originalBranchId !== undefined) {
                    req.headers["branch_id"] = originalBranchId;
                } else {
                    delete req.headers["branch_id"];
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "Client created successfully",
            data: {
                username,
                profile_id,
                firms: createdFirms,
                name: full_name,
                mobile,
                email,
                pan_number,
                branch_id
            }
        });

    } catch (error) {
        await conn.rollback();

        // Clean up downloaded image if transaction failed
        if (savedImageFilename) {
            try {
                const imagePath = path.join(PROFILE_IMAGE_DIR, savedImageFilename);
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
            } catch (cleanupError) {
                console.error('Error cleaning up image file:', cleanupError);
            }
        }

        console.error('Error creating Client:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to create Client",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const { branch_id } = req;
        const { search, page = 1, limit = 20 } = req.query; // Get from middleware (added to query)

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
            WHERE c.user_type = 'client' 
            AND c.is_deleted = '0'
            AND c.branch_id = ?
        `;

        const queryParams = [branch_id];

        // Add search filter if provided
        if (search) {
            const searchPattern = `%${search}%`;
            query += ` AND (p.name LIKE ? OR p.mobile LIKE ? OR p.email LIKE ? OR p.pan_number LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        // Get total count for pagination
        const countQuery = query.replace(
            /SELECT[\s\S]*?FROM/,
            'SELECT COUNT(*) as total FROM'
        );
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = countResult[0]?.total || 0;

        // Add ordering and pagination
        query += ` ORDER BY c.id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        // Transform rows: add image URL and fetch firms for each client
        const transformedRows = await Promise.all(rows.map(async (row) => {
            const transformedRow = { ...row };

            // Transform image field to include BASE_DOMAIN if not null/empty
            if (transformedRow.image && transformedRow.image.trim() !== '') {
                transformedRow.image = `${BASE_DOMAIN}/media/profile/image/${transformedRow.image}`;
            } else {
                transformedRow.image = null;
            }

            // Fetch firms for this client using GET_FIRMS_BY_USERNAME
            const firms = await GET_FIRMS_BY_USERNAME({
                username: transformedRow.username,
                branch_id: branch_id
            });
            transformedRow.firms = firms || [];

            const balanceResult = await GET_BALANCE({
                party_type: "client",
                party_id: transformedRow.username,
                branch_id
            });
            transformedRow.balance = balanceResult?.balance ?? 0;

            return transformedRow;
        }));

        return res.status(200).json({
            success: true,
            message: "Client list retrieved successfully",
            data: transformedRows,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error('Error fetching Client list:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch Client list",
            error: error.message
        });
    }
});

// Helper functions imported from helpers/recurringTaskHelper.js

router.get("/details/profile", auth, validateBranch, async (req, res) => {
    try {
        const { username } = req.query;
        const branch_id = req.branch_id;
        const [rows] = await pool.query("SELECT profile.*, clients.status AS is_active FROM `clients` JOIN profile ON clients.username = profile.username WHERE clients.username = ? AND clients.branch_id = ? AND profile.status = '1' ORDER BY profile.id DESC LIMIT 1", [username, branch_id]);

        const name = rows[0]?.name;
        const care_of = rows[0]?.care_of;
        const guardian_name = rows[0]?.guardian_name;
        const date_of_birth = rows[0]?.date_of_birth;
        const gender = rows[0]?.gender;
        const mobile = rows[0]?.mobile;
        const country_code = rows[0]?.country_code;
        const email = rows[0]?.email;
        const pan_number = rows[0]?.pan_number;
        const state = rows[0]?.state;
        const district = rows[0]?.district;
        const city = rows[0]?.city;
        const village_town = rows[0]?.village_town;
        const pincode = rows[0]?.pincode;
        const address_line_1 = rows[0]?.address_line_1;
        const address_line_2 = rows[0]?.address_line_2;
        const image = rows[0]?.image;
        const is_active = rows[0]?.is_active == "1" ? true : false;
        const address = {
            state,
            district,
            city,
            village_town,
            pincode,
            address_line_1,
            address_line_2
        };
        const image_url = image ? `${BASE_DOMAIN}/media/profile/image/${image}` : null;


        const { balance, debit, credit } = await GET_BALANCE({
            party_type: "client",
            party_id: username,
            branch_id,
        });

        // Fetch active compliance assignments for client's firms (synced)
        const [activeAssignments] = await pool.query(
            `SELECT 
                ca.assignment_id, 
                ca.firm_id, 
                ca.service_id, 
                ca.custom_amount, 
                ca.status,
                ca.create_date,
                ca.employee_username,
                ca.ca_id,
                ca.ack_no,
                ca.custom_fields,
                f.firm_name, 
                s.name AS service_name, 
                s.frequency,
                s.fields
             FROM compliance_assignments ca
             INNER JOIN firms f ON ca.firm_id = f.firm_id
             INNER JOIN services s ON ca.service_id = s.service_id
             WHERE f.username = ? AND f.branch_id = ? AND ca.status = 'active' AND f.is_deleted = '0'
             ORDER BY ca.id DESC`,
            [username, branch_id]
        );

        // Resolve profiles for active assignments
        for (const item of activeAssignments) {
            // Parse custom_fields
            if (item.custom_fields) {
                try {
                    item.custom_fields = JSON.parse(item.custom_fields);
                } catch (e) {
                    item.custom_fields = {};
                }
            } else {
                item.custom_fields = {};
            }

            // Parse fields
            if (item.fields) {
                try {
                    item.fields = JSON.parse(item.fields);
                } catch (e) {
                    item.fields = [];
                }
            } else {
                // Predefined fallback
                if (item.service_id === 'ptax') {
                    item.fields = [
                        { key: "ptax_reg_no", label: "Ptax Reg No", type: "text" },
                        { key: "ptax_user_id", label: "User ID", type: "text" },
                        { key: "ptax_password", label: "Password", type: "password" }
                    ];
                } else if (item.service_id === 'GSTR-1' || item.service_id === 'GSTR-3B') {
                    item.fields = [
                        { key: "gst_login_id", label: "GST Login ID", type: "text" },
                        { key: "gst_password", label: "Password", type: "password" }
                    ];
                } else {
                    item.fields = [];
                }
            }

            item.employee = item.employee_username ? await USER_SNIPPED_DATA(item.employee_username) : null;
            item.ca = item.ca_id ? await USER_SNIPPED_DATA(item.ca_id) : null;
        }

        // Auto-transfer active assignments for the current financial year
        const currentFyClient = getFinancialYearForDate(new Date());
        await autoTransferActiveAssignmentsForClient(pool, username, branch_id, currentFyClient);

        // Fetch pending schedules
        const [pendingSchedules] = await pool.query(
            `SELECT 
                cs.schedule_id, 
                cs.assignment_id, 
                cs.financial_year, 
                cs.period_name, 
                cs.status, 
                cs.amount, 
                cs.due_date,
                ca.firm_id, 
                ca.service_id, 
                ca.employee_username,
                ca.ca_id,
                ca.ack_no,
                ca.custom_fields,
                f.firm_name, 
                s.name AS service_name, 
                s.frequency,
                s.fields,
                ca.create_date,
                ca.modify_date,
                ca.pay_from_month
             FROM compliance_schedules cs
             INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
             INNER JOIN firms f ON ca.firm_id = f.firm_id
             INNER JOIN services s ON ca.service_id = s.service_id
             WHERE f.username = ? AND f.branch_id = ? AND cs.status IN ('Pending From The Department', 'Pending From Client', 'N/A') AND f.is_deleted = '0'
             ORDER BY cs.id ASC`,
            [username, branch_id]
        );

        // Map status of future pending periods to 'N/A' dynamically
        const now = new Date();
        const currentFy = getFinancialYearForDate(now);
        let mappedPending = pendingSchedules.map(row => {
            const periodStart = getPeriodStartDate(row.period_name, row.financial_year);
            if (periodStart > now) {
                if (row.status === 'Pending From The Department' || row.status === 'Pending From Client') {
                    row.status = 'N/A';
                }
            } else {
                if (row.status === 'N/A') {
                    row.status = 'Pending From The Department';
                }
            }
            return row;
        });

        // Filter: only show based on recurring task frequency-specific display limits
        mappedPending = filterSchedulesByRecurringRules(mappedPending, now);

        // Resolve profiles for pending schedules
        for (const item of mappedPending) {
            item.due_date = item.due_date ?
                (item.due_date instanceof Date ?
                    item.due_date.toISOString().split('T')[0] :
                    String(item.due_date).split('T')[0]
                ) : null;

            // Parse custom_fields
            if (item.custom_fields) {
                try {
                    item.custom_fields = JSON.parse(item.custom_fields);
                } catch (e) {
                    item.custom_fields = {};
                }
            } else {
                item.custom_fields = {};
            }

            // Parse fields
            if (item.fields) {
                try {
                    item.fields = JSON.parse(item.fields);
                } catch (e) {
                    item.fields = [];
                }
            } else {
                // Predefined fallback
                if (item.service_id === 'ptax') {
                    item.fields = [
                        { key: "ptax_reg_no", label: "Ptax Reg No", type: "text" },
                        { key: "ptax_user_id", label: "User ID", type: "text" },
                        { key: "ptax_password", label: "Password", type: "password" }
                    ];
                } else if (item.service_id === 'GSTR-1' || item.service_id === 'GSTR-3B') {
                    item.fields = [
                        { key: "gst_login_id", label: "GST Login ID", type: "text" },
                        { key: "gst_password", label: "Password", type: "password" }
                    ];
                } else {
                    item.fields = [];
                }
            }

            item.employee = item.employee_username ? await USER_SNIPPED_DATA(item.employee_username) : null;
            item.ca = item.ca_id ? await USER_SNIPPED_DATA(item.ca_id) : null;
        }

        // Fetch history schedules (status !== 'Pending')
        const [historySchedules] = await pool.query(
            `SELECT 
                cs.schedule_id, 
                cs.assignment_id, 
                cs.financial_year, 
                cs.period_name, 
                cs.status, 
                cs.amount, 
                cs.invoice_id, 
                cs.invoice_no,
                cs.completed_by,
                cs.completed_at,
                cs.due_date,
                ca.firm_id, 
                ca.service_id, 
                ca.employee_username,
                ca.ca_id,
                ca.ack_no,
                ca.custom_fields,
                f.firm_name, 
                s.name AS service_name, 
                s.frequency,
                s.fields
             FROM compliance_schedules cs
             INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
             INNER JOIN firms f ON ca.firm_id = f.firm_id
             INNER JOIN services s ON ca.service_id = s.service_id
             WHERE f.username = ? AND f.branch_id = ? AND cs.status NOT IN ('Pending From The Department', 'Pending From Client', 'N/A') AND f.is_deleted = '0'
             ORDER BY cs.completed_at DESC, cs.id DESC`,
            [username, branch_id]
        );

        // Resolve profiles for history schedules
        for (const item of historySchedules) {
            item.due_date = item.due_date ?
                (item.due_date instanceof Date ?
                    item.due_date.toISOString().split('T')[0] :
                    String(item.due_date).split('T')[0]
                ) : null;

            // Parse custom_fields
            if (item.custom_fields) {
                try {
                    item.custom_fields = JSON.parse(item.custom_fields);
                } catch (e) {
                    item.custom_fields = {};
                }
            } else {
                item.custom_fields = {};
            }

            // Parse fields
            if (item.fields) {
                try {
                    item.fields = JSON.parse(item.fields);
                } catch (e) {
                    item.fields = [];
                }
            } else {
                // Predefined fallback
                if (item.service_id === 'ptax') {
                    item.fields = [
                        { key: "ptax_reg_no", label: "Ptax Reg No", type: "text" },
                        { key: "ptax_user_id", label: "User ID", type: "text" },
                        { key: "ptax_password", label: "Password", type: "password" }
                    ];
                } else if (item.service_id === 'GSTR-1' || item.service_id === 'GSTR-3B') {
                    item.fields = [
                        { key: "gst_login_id", label: "GST Login ID", type: "text" },
                        { key: "gst_password", label: "Password", type: "password" }
                    ];
                } else {
                    item.fields = [];
                }
            }

            item.employee = item.employee_username ? await USER_SNIPPED_DATA(item.employee_username) : null;
            item.ca = item.ca_id ? await USER_SNIPPED_DATA(item.ca_id) : null;
            item.completed_by_user = item.completed_by ? await USER_SNIPPED_DATA(item.completed_by) : null;
        }

        return res.status(200).json({
            success: true,
            message: 'Client profile retrieved successfully',
            data: {
                basic: {
                    name,
                    care_of,
                    guardian_name,
                    date_of_birth,
                    gender,
                    mobile,
                    country_code,
                    email,
                    pan_number,
                    image: image_url,
                    is_active,
                    address,
                },
                transactional: {
                    balance,
                    debit,
                    credit
                },
                compliance: {
                    active: activeAssignments,
                    pending: mappedPending,
                    history: historySchedules
                }
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve client profile',
            error: error.message
        });
    }
});

router.post("/details/edit-profile", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    let savedImageFilename = null; // For cleanup if transaction fails

    try {
        const { username } = req.body;
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || "";

        // Validate username is provided
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        // Validate that client exists and belongs to the branch
        const [clientCheck] = await pool.query(
            "SELECT id, status FROM clients WHERE username = ? AND branch_id = ? AND user_type = 'client' AND is_deleted = '0'",
            [username, branch_id]
        );

        if (clientCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Client not found or does not belong to this branch'
            });
        }

        // Extract basic fields
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
            address = {}
        } = req.body || {};

        // Extract address fields
        const {
            state,
            district,
            city,
            village_town,
            pincode,
            address_line_1,
            address_line_2
        } = address;

        // Normalize PAN number: trim whitespace and convert to uppercase
        const pan_number = pan_number_raw ? pan_number_raw.trim().toUpperCase() : null;

        // Validate required fields
        if (!name || !mobile || !email || !pan_number) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name, mobile, email, and pan_number are required'
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (email && !emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format'
            });
        }

        // Validate mobile format (should be numeric and reasonable length)
        if (mobile && (!/^\d+$/.test(mobile) || mobile.length < 10 || mobile.length > 15)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid mobile number format'
            });
        }

        // Validate PAN format (should be 10 characters alphanumeric)
        if (pan_number && (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan_number))) {
            return res.status(400).json({
                success: false,
                message: 'Invalid PAN number format'
            });
        }

        // Validate date_of_birth format if provided
        if (date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid date_of_birth format. Expected format: YYYY-MM-DD'
            });
        }

        // Validate gender if provided
        if (gender && !['male', 'female', 'other'].includes(gender.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid gender. Must be one of: male, female, other'
            });
        }

        // Process profile image if provided
        if (imageInput && imageInput !== null && imageInput.trim() !== '') {
            try {
                savedImageFilename = await downloadAndSaveProfileImage(imageInput);
            } catch (imageError) {
                return res.status(400).json({
                    success: false,
                    message: `Profile image error: ${imageError.message}`
                });
            }
        }

        // Check if PAN already exists
        const [existingPan] = await pool.query(
            "SELECT p.username FROM profile p JOIN clients c ON p.username = c.username WHERE p.pan_number = ? AND c.user_type = 'client' AND c.is_deleted = '0' AND c.branch_id = ? AND p.username != ?",
            [pan_number, branch_id, username]
        );

        if (existingPan.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A Client with this PAN number already exists"
            });
        }

        // Get existing profile data before transaction
        const [existingProfileRow] = await pool.query(
            "SELECT profile_id, image FROM profile WHERE username = ? AND status = '1' ORDER BY id DESC LIMIT 1",
            [username]
        );
        const profile_id = existingProfileRow.length > 0 ? existingProfileRow[0].profile_id : RANDOM_STRING(30);
        const existingImage = existingProfileRow.length > 0 ? existingProfileRow[0].image : null;

        await conn.beginTransaction();

        // Step 1: Set status = '0' for all existing profile records for this username
        await conn.query(
            "UPDATE profile SET status = '0' WHERE username = ?",
            [username]
        );

        // Get valid columns for profile table
        const [columns] = await conn.query(`SHOW COLUMNS FROM \`profile\``);
        const validColumns = new Set(columns.map(c => c.Field));

        // Build INSERT query with only valid columns
        const profileData = {
            profile_id,
            username,
            create_by: modifyBy,
            modify_by: modifyBy,
            user_type: "client",
            name: name.trim(),
            care_of: care_of || null,
            guardian_name: guardian_name || null,
            date_of_birth: date_of_birth || null,
            gender: gender ? gender.toLowerCase() : null,
            mobile: mobile.trim(),
            country_code: country_code || "91",
            email: email.trim().toLowerCase(),
            pan_number: pan_number,
            state: state || null,
            district: district || null,
            city: city || district || null,
            village_town: village_town || null,
            pincode: pincode || null,
            address_line_1: address_line_1 || null,
            address_line_2: address_line_2 || null,
            image: savedImageFilename || existingImage || null,
            status: "1"
        };

        const entries = Object.entries(profileData).filter(([k]) => validColumns.has(k));
        const keys = entries.map(([k]) => `\`${k}\``).join(", ");
        const placeholders = entries.map(() => "?").join(", ");
        const values = entries.map(([, v]) => v);

        // Step 2: Insert new profile record with status = '1' and user_type = 'client'
        await conn.query(
            `INSERT INTO \`profile\` (${keys}) VALUES (${placeholders})`,
            values
        );

        // Update clients table if is_active status changed
        if (is_active !== undefined && is_active !== null) {
            const newStatus = is_active === true || is_active === "1" || is_active === 1 ? "1" : "0";
            const currentStatus = clientCheck[0].status;

            if (newStatus !== currentStatus) {
                await conn.query(
                    "UPDATE clients SET status = ?, modify_by = ?, modify_date = NOW() WHERE username = ? AND branch_id = ?",
                    [newStatus, modifyBy, username, branch_id]
                );
            }
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: 'Client profile updated successfully',
            data: {
                username,
                profile_id,
                name: name.trim(),
                mobile: mobile.trim(),
                email: email.trim().toLowerCase(),
                pan_number: pan_number
            }
        });

    } catch (error) {
        await conn.rollback();

        // Clean up downloaded image if transaction failed
        if (savedImageFilename) {
            try {
                const imagePath = path.join(PROFILE_IMAGE_DIR, savedImageFilename);
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
            } catch (cleanupError) {
                console.error('Error cleaning up image file:', cleanupError);
            }
        }

        console.error('Error updating client profile:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update client profile',
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.get("/details/firms/list", auth, validateBranch, async (req, res) => {
    try {
        const { username } = req.query;
        const branch_id = req.branch_id;

        const firm_list = await GET_FIRMS_BY_USERNAME({
            username,
            branch_id
        });


        const [total_row] = await pool.query("SELECT COUNT(*) as total FROM firms WHERE username = ? AND branch_id = ? AND is_deleted = '0'", [username, branch_id]);
        const total = total_row[0]?.total || 0;

        const [active_row] = await pool.query("SELECT COUNT(*) as active FROM firms WHERE username = ? AND branch_id = ? AND is_deleted = '0' AND status = '1'", [username, branch_id]);
        const active = active_row[0]?.active || 0;

        const [inactive_row] = await pool.query("SELECT COUNT(*) as inactive FROM firms WHERE username = ? AND branch_id = ? AND is_deleted = '0' AND status = '0'", [username, branch_id]);
        const inactive = inactive_row[0]?.inactive || 0;

        return res.status(200).json({
            success: true,
            message: 'Client firms retrieved successfully',
            data: {
                firms: firm_list,
                meta: {
                    total,
                    active,
                    inactive
                }
            },
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve client firms',
            error: error.message
        });
    }
});

router.get("/details/notes/list", auth, validateBranch, async (req, res) => {
    try {
        const { username, search = "", priority = "", status = "" } = req.query;
        const branch_id = req.branch_id;

        // Validate username is provided
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        const pageNum = Number(req.query.page_no) || 1;
        const limitNum = Number(req.query.limit) || 20;
        const offset = (pageNum - 1) * limitNum;

        // Build base query conditions
        let whereConditions = ['username = ?', 'branch_id = ?', 'note_type = ?'];
        const queryParams = [username, branch_id, 'client'];

        // Add is_deleted condition if column exists (with fallback)
        whereConditions.push("(is_deleted = '0' OR is_deleted IS NULL)");

        // Add search filter if provided
        if (search && search.trim() !== '') {
            const searchPattern = `%${search.trim()}%`;
            whereConditions.push('(subject LIKE ? OR note LIKE ?)');
            queryParams.push(searchPattern, searchPattern);
        }

        // Add priority filter if provided
        if (priority && priority.trim() !== '') {
            const priorityValue = priority.trim().toLowerCase();
            if (['high', 'medium', 'low'].includes(priorityValue)) {
                whereConditions.push('priority = ?');
                queryParams.push(priorityValue);
            }
        }

        // Add status filter if provided
        if (status && status.trim() !== '') {
            const statusPattern = `%${status.trim()}%`;
            whereConditions.push('status LIKE ?');
            queryParams.push(statusPattern);
        }

        const whereClause = whereConditions.join(' AND ');

        // Get total count and priority counts
        const [total_row] = await pool.query(
            `SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN priority = 'high' THEN 1 END) as high,
                COUNT(CASE WHEN priority = 'medium' THEN 1 END) as medium,
                COUNT(CASE WHEN priority = 'low' THEN 1 END) as low
            FROM notes 
            WHERE ${whereClause}`,
            queryParams
        );

        const counts = total_row[0] || {
            total: 0,
            high: 0,
            medium: 0,
            low: 0
        };

        const total = Number(counts.total) || 0;

        // Fetch notes with pagination
        let notesQuery = `
            SELECT 
                note_id,
                username,
                task_id,
                note_type,
                subject,
                note,
                priority,
                status,
                create_date,
                create_by,
                modify_date,
                modify_by,
                type,
                file
            FROM notes 
            WHERE ${whereClause}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `;

        const notesParams = [...queryParams, limitNum, offset];
        const [notesRows] = await pool.query(notesQuery, notesParams);

        const note_list = [];

        for (let index = 0; index < notesRows.length; index++) {
            const element = notesRows[index];

            const note_id = element.note_id;
            const username = element.username;
            const subject = element.subject;
            const note = element.note;
            const priority = element.priority;
            const status = element.status;
            const create_date = element.create_date;
            const create_by_user = element.create_by;
            const modify_date = element.modify_date;
            const modify_by_user = element.modify_by;
            const type = element.type;
            const file = element.file;
            const create_by_user_data = await USER_DATA(create_by_user);
            const modify_by_user_data = await USER_DATA(modify_by_user);

            const create_by = {
                username: create_by_user_data.username,
                name: create_by_user_data.name,
                email: create_by_user_data.email,
                mobile: create_by_user_data.mobile,
                user_type: create_by_user_data.user_type
            }

            const modify_by = {
                username: modify_by_user_data.username,
                name: modify_by_user_data.name,
                email: modify_by_user_data.email,
                mobile: modify_by_user_data.mobile,
                user_type: modify_by_user_data.user_type
            }

            const object = {
                note_id,
                username,
                subject,
                note,
                priority,
                type,
                status,
                create_date,
                create_by,
                modify_date,
                modify_by
            };

            if (type === 'file') {
                object.file = `${BASE_DOMAIN}/media/note/file/${file}`;
            } else if (type === 'voice') {
                object.voice = `${BASE_DOMAIN}/media/note/voice/${file}`;
            }

            note_list.push(object);
        }

        return res.status(200).json({
            success: true,
            message: 'Client notes retrieved successfully',
            data: note_list,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + note_list.length >= total
            },
            meta: {
                total: Number(counts.total) || 0,
                priority: {
                    high: Number(counts.high) || 0,
                    medium: Number(counts.medium) || 0,
                    low: Number(counts.low) || 0
                }
            }
        });
    } catch (error) {
        console.error('Error fetching client notes:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve client notes',
            error: error.message
        });
    }
});

router.post("/details/notes/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    const downloadedFiles = [];

    try {
        const body = req.body || {};
        const username = (body.username || "").trim();
        const branch_id = req.branch_id;
        const createdBy = req.headers["username"] || req.headers["Username"] || "";

        const priority = ["low", "medium", "high"].includes(body.priority) ? body.priority : "low";
        const status = ["pending", "complete", "cancel"].includes(body.status) ? body.status : "pending";

        const noteObj =
            body.notes != null && typeof body.notes === "object"
                ? body.notes
                : body;

        const textArrRaw = noteObj.text;
        const attachmentsArrRaw = noteObj.attachments;
        const voiceArrRaw = noteObj.voice;

        const textArr = Array.isArray(textArrRaw) ? textArrRaw : (textArrRaw != null ? [textArrRaw] : []);
        const attachmentsArr = Array.isArray(attachmentsArrRaw) ? attachmentsArrRaw : [];
        const voiceArr = Array.isArray(voiceArrRaw) ? voiceArrRaw : (voiceArrRaw != null ? [voiceArrRaw] : []);

        if (!username) {
            conn.release();
            return res.status(400).json({ success: false, message: "username is required" });
        }

        const hasAny =
            textArr.some(v => v != null && String(v).trim() !== "") ||
            attachmentsArr.some(a => (a?.url ?? "").trim() !== "") ||
            voiceArr.some(v => v != null && String(v).trim() !== "");

        if (!hasAny) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Provide at least one note item (text / attachments / voice)"
            });
        }

        await conn.beginTransaction();

        const [clientRows] = await conn.query(
            `SELECT username
             FROM clients
             WHERE username = ? AND branch_id = ? AND user_type = 'client' AND is_deleted = '0'
             LIMIT 1`,
            [username, branch_id]
        );

        if (!clientRows?.length) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "username not found or does not belong to this branch"
            });
        }

        const urlToSavedFile = new Map();
        try {
            for (const att of attachmentsArr) {
                const url = (att?.url ?? "").trim();
                if (url && !urlToSavedFile.has(url)) {
                    const saved = await downloadAndSaveNoteFile(url);
                    urlToSavedFile.set(url, saved);
                    downloadedFiles.push({ type: "file", name: saved });
                }
            }
            for (const v of voiceArr) {
                const url = (v ?? "").trim();
                if (url && !urlToSavedFile.has(url)) {
                    const saved = await downloadAndSaveVoiceFile(url);
                    urlToSavedFile.set(url, saved);
                    downloadedFiles.push({ type: "voice", name: saved });
                }
            }
        } catch (downloadErr) {
            try { await conn.rollback(); } catch { }
            conn.release();
            return res.status(400).json({
                success: false,
                message: downloadErr.message || "Failed to download note file or voice file"
            });
        }

        const created = [];

        // TEXT notes
        for (const t of textArr) {
            const content = t != null ? String(t).trim() : "";
            if (!content) continue;

            await conn.query(
                `INSERT INTO notes
                (note_id, username, branch_id, note_type, subject, note, type, priority, status, create_by, modify_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    RANDOM_STRING(30),
                    username,
                    branch_id,
                    "client",
                    content.slice(0, 255) || null,
                    content,
                    "text",
                    priority,
                    status,
                    createdBy,
                    createdBy
                ]
            );
            created.push("text");
        }

        // FILE notes
        for (const att of attachmentsArr) {
            const url = (att?.url ?? "").trim();
            if (!url) continue;

            const savedFile = urlToSavedFile.get(url);
            if (!savedFile) continue;

            const name = att?.name ?? att?.remark ?? "";
            const remark = att?.remark ?? att?.name ?? "";

            await conn.query(
                `INSERT INTO notes
                (note_id, username, branch_id, note_type, subject, note, type, file, priority, status, create_by, modify_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    RANDOM_STRING(30),
                    username,
                    branch_id,
                    "client",
                    String(name).slice(0, 255),
                    String(remark),
                    "file",
                    savedFile,
                    priority,
                    status,
                    createdBy,
                    createdBy
                ]
            );
            created.push("file");
        }

        // VOICE notes
        for (const v of voiceArr) {
            const url = (v ?? "").trim();
            if (!url) continue;

            const savedVoice = urlToSavedFile.get(url);
            if (!savedVoice) continue;

            await conn.query(
                `INSERT INTO notes
                (note_id, username, branch_id, note_type, type, file, priority, status, create_by, modify_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    RANDOM_STRING(30),
                    username,
                    branch_id,
                    "client",
                    "voice",
                    savedVoice,
                    priority,
                    status,
                    createdBy,
                    createdBy
                ]
            );
            created.push("voice");
        }

        if (created.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No valid note items to create (empty text / missing urls)"
            });
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Notes created successfully"
        });
    } catch (error) {
        try { await conn.rollback(); } catch { }

        for (const fileInfo of downloadedFiles) {
            try {
                const dir = fileInfo.type === "voice" ? NOTE_VOICE_DIR : NOTE_FILE_DIR;
                const filePath = path.join(dir, fileInfo.name);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (cleanupError) {
                console.error("Error cleaning up note file:", cleanupError);
            }
        }

        console.error("Error creating note:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create notes",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.post("/details/notes/edit", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { note_id, subject, note, priority, status, username } = req.body;
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || "";

        // Validate username is provided
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        // Validate note_id is provided
        if (!note_id || note_id.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Note ID is required'
            });
        }

        // Validate required fields
        if (!subject || subject.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Subject is required'
            });
        }

        if (!note || note.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Note is required'
            });
        }

        // Validate priority
        const validPriorities = ['low', 'medium', 'high'];
        if (!priority || !validPriorities.includes(priority.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: `Priority must be one of: ${validPriorities.join(', ')}`
            });
        }

        // Validate status
        const validStatuses = ['pending', 'complete', 'cancel'];
        if (!status || !validStatuses.includes(status.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: `Status must be one of: ${validStatuses.join(', ')}`
            });
        }

        await conn.beginTransaction();

        // Check if note exists and belongs to the user and branch
        const [existingNote] = await conn.query(
            "SELECT id FROM notes WHERE note_id = ? AND username = ? AND branch_id = ? AND note_type = 'client' AND (is_deleted = '0' OR is_deleted IS NULL) LIMIT 1",
            [note_id.trim(), username.trim(), branch_id]
        );

        if (!existingNote || existingNote.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: 'Note not found or you do not have permission to edit it'
            });
        }

        // Update note
        await conn.query(
            `UPDATE notes 
            SET subject = ?, 
                note = ?, 
                priority = ?, 
                status = ?, 
                modify_by = ?,
                modify_date = CURRENT_TIMESTAMP
            WHERE note_id = ? AND username = ? AND branch_id = ? AND note_type = 'client'`,
            [
                subject.trim(),
                note.trim(),
                priority.toLowerCase(),
                status.toLowerCase(),
                modifyBy,
                note_id.trim(),
                username.trim(),
                branch_id
            ]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: 'Note updated successfully',
            data: {
                note_id: note_id.trim()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error('Error updating note:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update note',
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.post("/details/firms/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { username, type, pan, firm, gst, tan, vat, cin, file, address = {}, groups = [] } = req.body;
        const branch_id = req.branch_id;
        const createdBy = req.headers["username"] || "";

        // Validate username is provided
        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        // Validate required fields
        if (!type || type.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Business type is required'
            });
        }

        if (!pan || pan.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'PAN is required'
            });
        }

        // For non-individual types, validate firm name and address
        const isIndividual = type.toLowerCase() === 'individual';
        if (!isIndividual) {
            if (!firm || firm.trim() === '') {
                return res.status(400).json({
                    success: false,
                    message: 'Firm name is required for non-individual business types'
                });
            }

            if (!address || !address.state || !address.district || !address.town || !address.pincode) {
                return res.status(400).json({
                    success: false,
                    message: 'Address with state, district, town, and pincode is required for non-individual business types'
                });
            }
        }

        // Verify username exists and is a client
        const [clientCheck] = await pool.query(
            "SELECT username FROM clients WHERE username = ? AND user_type = 'client' AND branch_id = ? AND is_deleted = '0' LIMIT 1",
            [username.trim(), branch_id]
        );

        if (!clientCheck || clientCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Client not found or does not belong to this branch'
            });
        }

        await conn.beginTransaction();

        // Generate firm_id
        const firm_id = RANDOM_STRING(30);

        // Insert into firms table
        await conn.query(
            `INSERT INTO firms 
            (firm_id, branch_id, username, firm_name, firm_type, pan_no, gst_no, tan_no, vat_no, cin_no, file_no, 
             state, district, city, pincode, address_line_1, address_line_2, create_by, modify_by, status, is_deleted) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                firm_id,
                branch_id,
                username.trim(),
                isIndividual ? null : (firm || null),
                type.trim(),
                pan.trim(),
                isIndividual ? null : (gst || null),
                isIndividual ? null : (tan || null),
                isIndividual ? null : (vat || null),
                isIndividual ? null : (cin || null),
                isIndividual ? null : (file || null),
                isIndividual ? null : (address.state || null),
                isIndividual ? null : (address.district || null),
                isIndividual ? null : (address.town || null),
                isIndividual ? null : (address.pincode || null),
                isIndividual ? null : (address.address_line_1 || null),
                isIndividual ? null : (address.address_line_2 || null),
                createdBy,
                createdBy,
                "1",
                "0"
            ]
        );

        // Insert group mappings for this firm (validate each group_id belongs to branch, status = '1', is_deleted = '0')
        if (groups && Array.isArray(groups) && groups.length > 0) {
            for (const groupId of groups) {
                if (groupId && groupId.trim() !== '') {
                    const [groupCheck] = await conn.query(
                        "SELECT 1 FROM groups WHERE group_id = ? AND branch_id = ? AND status = '1' AND is_deleted = '0' LIMIT 1",
                        [groupId.trim(), branch_id]
                    );
                    if (!groupCheck || groupCheck.length === 0) {
                        await conn.rollback();
                        conn.release();
                        return res.status(400).json({
                            success: false,
                            message: `Group "${groupId.trim()}" not found or does not belong to this branch or is inactive/deleted`
                        });
                    }
                    const unique_id = RANDOM_STRING(30);
                    await conn.query(
                        "INSERT INTO group_firms (unique_id, firm_id, group_id, create_by, modify_by) VALUES (?, ?, ?, ?, ?)",
                        [unique_id, firm_id, groupId.trim(), createdBy, createdBy]
                    );
                }
            }
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: 'Firm created successfully',
            data: {
                firm_id,
                firm_name: isIndividual ? null : firm,
                business_type: type
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error('Error creating firm:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create firm',
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.post("/details/firms/edit", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { firm_id, username, type, pan, firm, gst, tan, vat, cin, file, address = {}, groups = [] } = req.body;
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || "";

        // Validate required fields
        if (!firm_id || firm_id.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Firm ID is required'
            });
        }

        if (!username || username.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        if (!type || type.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Business type is required'
            });
        }

        if (!pan || pan.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'PAN is required'
            });
        }

        // For non-individual types, validate firm name and address
        const isIndividual = type.toLowerCase() === 'individual';
        if (!isIndividual) {
            if (!firm || firm.trim() === '') {
                return res.status(400).json({
                    success: false,
                    message: 'Firm name is required for non-individual business types'
                });
            }

            if (!address || !address.state || !address.district || !address.town || !address.pincode) {
                return res.status(400).json({
                    success: false,
                    message: 'Address with state, district, town, and pincode is required for non-individual business types'
                });
            }
        }

        await conn.beginTransaction();

        // Check if firm exists and belongs to the user and branch
        const [existingFirm] = await conn.query(
            "SELECT id FROM firms WHERE firm_id = ? AND username = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1",
            [firm_id.trim(), username.trim(), branch_id]
        );

        if (!existingFirm || existingFirm.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: 'Firm not found or you do not have permission to edit it'
            });
        }

        // Update firm
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
                modify_date = CURRENT_TIMESTAMP
            WHERE firm_id = ? AND username = ? AND branch_id = ? AND is_deleted = '0'`,
            [
                isIndividual ? null : (firm || null),
                type.trim(),
                pan.trim(),
                isIndividual ? null : (gst || null),
                isIndividual ? null : (tan || null),
                isIndividual ? null : (vat || null),
                isIndividual ? null : (cin || null),
                isIndividual ? null : (file || null),
                isIndividual ? null : (address.state || null),
                isIndividual ? null : (address.district || null),
                isIndividual ? null : (address.town || null),
                isIndividual ? null : (address.pincode || null),
                isIndividual ? null : (address.address_line_1 || null),
                isIndividual ? null : (address.address_line_2 || null),
                modifyBy,
                firm_id.trim(),
                username.trim(),
                branch_id
            ]
        );

        // Delete existing group mappings for this firm (soft delete)
        await conn.query(
            "UPDATE group_firms SET is_deleted = '1', deleted_by = ? WHERE firm_id = ? AND is_deleted = '0'",
            [modifyBy, firm_id.trim()]
        );

        // Insert new group mappings (validate each group_id belongs to branch, status = '1', is_deleted = '0')
        if (groups && Array.isArray(groups) && groups.length > 0) {
            for (const groupId of groups) {
                if (groupId && groupId.trim() !== '') {
                    const [groupCheck] = await conn.query(
                        "SELECT 1 FROM groups WHERE group_id = ? AND branch_id = ? AND status = '1' AND is_deleted = '0' LIMIT 1",
                        [groupId.trim(), branch_id]
                    );
                    if (!groupCheck || groupCheck.length === 0) {
                        await conn.rollback();
                        conn.release();
                        return res.status(400).json({
                            success: false,
                            message: `Group "${groupId.trim()}" not found or does not belong to this branch or is inactive/deleted`
                        });
                    }
                    const unique_id = RANDOM_STRING(30);
                    await conn.query(
                        "INSERT INTO group_firms (unique_id, firm_id, group_id, create_by, modify_by) VALUES (?, ?, ?, ?, ?)",
                        [unique_id, firm_id.trim(), groupId.trim(), modifyBy, modifyBy]
                    );
                }
            }
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: 'Firm updated successfully',
            data: {
                firm_id: firm_id.trim(),
                firm_name: isIndividual ? null : firm,
                business_type: type
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error('Error updating firm:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update firm',
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.post("/details/documents/create/gst", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    const branch_id = req.branch_id;
    const createdBy = req.headers["username"] || "";
    const { firm_id = "", username = "", documents = [] } = req.body;

    if (!firm_id || typeof firm_id !== "string" || firm_id.trim() === "") {
        conn.release();
        return res.status(400).json({ success: false, message: "Firm ID is required" });
    }
    if (!username || typeof username !== "string" || username.trim() === "") {
        conn.release();
        return res.status(400).json({ success: false, message: "Username is required" });
    }

    if (!Array.isArray(documents) || documents.length === 0) {
        conn.release();
        return res.status(400).json({ success: false, message: "Documents array is required and must not be empty" });
    }

    const [firmCheck] = await pool.query(
        "SELECT firm_id FROM firms WHERE firm_id = ? AND branch_id = ? AND is_deleted = '0'",
        [firm_id.trim(), branch_id]
    );
    if (firmCheck.length === 0) {
        conn.release();
        return res.status(404).json({ success: false, message: "Firm not found or does not belong to this branch" });
    }

    const savedFiles = [];
    try {
        await conn.beginTransaction();

        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            const url = doc?.url;
            const name = doc?.name ?? null;
            const year = doc?.year ?? null;
            const month = doc?.month ?? null;
            const type = doc?.type ?? null;
            const remark = doc?.remark ?? null;

            if (!url || typeof url !== "string" || url.trim() === "") {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Document at index ${i} is missing a valid url`
                });
            }

            let filename, mimeType, size;
            try {
                const result = await downloadAndUploadProfileDocument(url.trim(), "gst");
                filename = result.filename;
                mimeType = result.mimeType;
                size = result.size;
            } catch (downloadErr) {
                await conn.rollback();
                await rollbackUploadedDocuments(savedFiles);
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Failed to download document at index ${i}: ${downloadErr.message}`
                });
            }
            savedFiles.push({ filename, categoryFolder: "gst" });

            const document_id = RANDOM_STRING(30);
            await conn.query(
                `INSERT INTO documents (
                    document_id, branch_id, firm_id, username, category_id, name, f_year, type, remark, month,
                    is_reserved, file, size, mime_type, created_by, create_date, modify_by, modify_date, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "1", ?, ?, ?, ?, NOW(), ?, NOW(), '0')`,
                [
                    document_id,
                    branch_id,
                    firm_id.trim(),
                    username.trim(),
                    "GST",
                    name,
                    year,
                    type,
                    remark,
                    month,
                    filename,
                    size,
                    mimeType,
                    createdBy,
                    createdBy
                ]
            );
        }

        await conn.commit();
        conn.release();
        return res.status(200).json({
            success: true,
            message: "GST documents created successfully",
            data: { firm_id: firm_id.trim(), username: username.trim(), count: documents.length }
        });
    } catch (error) {
        await conn.rollback();
        await rollbackUploadedDocuments(savedFiles);
        conn.release();
        console.error("Error creating GST documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create GST documents",
            error: error.message
        });
    }
});

router.post("/details/documents/create/it", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    const branch_id = req.branch_id;
    const createdBy = req.headers["username"] || "";
    const { firm_id = "", username = "", documents = [] } = req.body;

    if (!firm_id || typeof firm_id !== "string" || firm_id.trim() === "") {
        conn.release();
        return res.status(400).json({ success: false, message: "Firm ID is required" });
    }
    if (!username || typeof username !== "string" || username.trim() === "") {
        conn.release();
        return res.status(400).json({ success: false, message: "Username is required" });
    }

    if (!Array.isArray(documents) || documents.length === 0) {
        conn.release();
        return res.status(400).json({ success: false, message: "Documents array is required and must not be empty" });
    }

    const [firmCheck] = await pool.query(
        "SELECT firm_id FROM firms WHERE firm_id = ? AND branch_id = ? AND is_deleted = '0'",
        [firm_id.trim(), branch_id]
    );
    if (firmCheck.length === 0) {
        conn.release();
        return res.status(404).json({ success: false, message: "Firm not found or does not belong to this branch" });
    }

    const savedFiles = [];
    try {
        await conn.beginTransaction();

        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            const url = doc?.url;
            const name = doc?.name ?? null;
            const year = doc?.year ?? null;
            const type = doc?.type ?? null;
            const remark = doc?.remark ?? null;

            if (!url || typeof url !== "string" || url.trim() === "") {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Document at index ${i} is missing a valid url`
                });
            }

            let filename, mimeType, size;
            try {
                const result = await downloadAndUploadProfileDocument(url.trim(), "it");
                filename = result.filename;
                mimeType = result.mimeType;
                size = result.size;
            } catch (downloadErr) {
                await conn.rollback();
                await rollbackUploadedDocuments(savedFiles);
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Failed to download document at index ${i}: ${downloadErr.message}`
                });
            }
            savedFiles.push({ filename, categoryFolder: "it" });

            const document_id = RANDOM_STRING(30);
            await conn.query(
                `INSERT INTO documents (
                    document_id, branch_id, firm_id, username, category_id, name, f_year, type, remark,
                    is_reserved, file, size, mime_type, created_by, create_date, modify_by, modify_date, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NOW(), ?, NOW(), '0')`,
                [
                    document_id,
                    branch_id,
                    firm_id.trim(),
                    username.trim(),
                    "IT",
                    name,
                    year,
                    type,
                    remark,
                    filename,
                    size,
                    mimeType,
                    createdBy,
                    createdBy
                ]
            );
        }

        await conn.commit();
        conn.release();
        return res.status(200).json({
            success: true,
            message: "IT documents created successfully",
            data: { firm_id: firm_id.trim(), username: username.trim(), count: documents.length }
        });
    } catch (error) {
        await conn.rollback();
        await rollbackUploadedDocuments(savedFiles);
        conn.release();
        console.error("Error creating IT documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create IT documents",
            error: error.message
        });
    }
});

router.post("/details/documents/create/mca", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    const branch_id = req.branch_id;
    const createdBy = req.headers["username"] || "";
    const { firm_id = "", username = "", documents = [] } = req.body;

    if (!firm_id || typeof firm_id !== "string" || firm_id.trim() === "") {
        conn.release();
        return res.status(400).json({ success: false, message: "Firm ID is required" });
    }
    if (!username || typeof username !== "string" || username.trim() === "") {
        conn.release();
        return res.status(400).json({ success: false, message: "Username is required" });
    }

    if (!Array.isArray(documents) || documents.length === 0) {
        conn.release();
        return res.status(400).json({ success: false, message: "Documents array is required and must not be empty" });
    }

    const [firmCheck] = await pool.query(
        "SELECT firm_id FROM firms WHERE firm_id = ? AND branch_id = ? AND is_deleted = '0'",
        [firm_id.trim(), branch_id]
    );
    if (firmCheck.length === 0) {
        conn.release();
        return res.status(404).json({ success: false, message: "Firm not found or does not belong to this branch" });
    }

    const savedFiles = [];
    try {
        await conn.beginTransaction();

        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            const url = doc?.url;
            const name = doc?.name ?? null;
            const year = doc?.year ?? null;
            const type = doc?.type ?? null;
            const remark = doc?.remark ?? null;

            if (!url || typeof url !== "string" || url.trim() === "") {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Document at index ${i} is missing a valid url`
                });
            }

            let filename, mimeType, size;
            try {
                const result = await downloadAndUploadProfileDocument(url.trim(), "mca");
                filename = result.filename;
                mimeType = result.mimeType;
                size = result.size;
            } catch (downloadErr) {
                await conn.rollback();
                await rollbackUploadedDocuments(savedFiles);
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Failed to download document at index ${i}: ${downloadErr.message}`
                });
            }
            savedFiles.push({ filename, categoryFolder: "mca" });

            const document_id = RANDOM_STRING(30);
            await conn.query(
                `INSERT INTO documents (
                    document_id, branch_id, firm_id, username, category_id, name, f_year, type, remark,
                    is_reserved, file, size, mime_type, created_by, create_date, modify_by, modify_date, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NOW(), ?, NOW(), '0')`,
                [
                    document_id,
                    branch_id,
                    firm_id.trim(),
                    username.trim(),
                    "MCA",
                    name,
                    year,
                    type,
                    remark,
                    filename,
                    size,
                    mimeType,
                    createdBy,
                    createdBy
                ]
            );
        }

        await conn.commit();
        conn.release();
        return res.status(200).json({
            success: true,
            message: "MCA documents created successfully",
            data: { firm_id: firm_id.trim(), username: username.trim(), count: documents.length }
        });
    } catch (error) {
        await conn.rollback();
        await rollbackUploadedDocuments(savedFiles);
        conn.release();
        console.error("Error creating MCA documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create MCA documents",
            error: error.message
        });
    }
});

router.get("/details/documents/types", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: {
            it: [
                {
                    name: "Full Set",
                    value: "full_set"
                },
                {
                    name: "TIS",
                    value: "tis"
                },
                {
                    name: 'AIS',
                    value: 'ais'
                }
            ],
            gst: [
                {
                    name: "GSTR 3B (Monthly)",
                    value: "gstr_3b_monthly"
                },
                {
                    name: "GSTR 1 (Quarterly)",
                    value: "gstr_1_quarterly"
                },
                {
                    name: "GSTR 2 (Quarterly)",
                    value: "gstr_2_quarterly"
                },
                {
                    name: "GSTR 4 (Yearly)",
                    value: "gstr_4_yearly"
                }
            ],
            mca: [
                {
                    name: "DIN",
                    value: "din"
                },
                {
                    name: "Chalan",
                    value: "chalan"
                }
            ]
        }
    })


});

async function getDocumentListByCategory(branch_id, category_id, categoryFolder, query) {
    const page = Number(query.page) || 1;
    const limitNum = Number(query.limit) || 20;
    const offset = (page - 1) * limitNum;

    const username = query.username != null ? String(query.username).trim() : "";
    const firm_id = query.firm_id != null ? String(query.firm_id).trim() : "";
    const month = query.month != null ? String(query.month).trim() : "";
    const type = query.type != null ? String(query.type).trim() : "";
    const year = query.year != null ? String(query.year).trim() : "";

    const conditions = ["branch_id = ?", "category_id = ?", "is_deleted = '0'"];
    const params = [branch_id, category_id];

    if (username !== "") {
        conditions.push("username = ?");
        params.push(username);
    }
    if (firm_id !== "") {
        conditions.push("firm_id LIKE ?");
        params.push(`%${firm_id}%`);
    }
    if (month !== "") {
        conditions.push("month LIKE ?");
        params.push(`%${month}%`);
    }
    if (type !== "") {
        conditions.push("type LIKE ?");
        params.push(`%${type}%`);
    }
    if (year !== "") {
        conditions.push("f_year LIKE ?");
        params.push(`%${year}%`);
    }

    const whereClause = conditions.join(" AND ");

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM documents WHERE ${whereClause}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT document_id, branch_id, firm_id, username, category_id, name, f_year, type, remark, month, file, size, mime_type, created_by, create_date, modify_by, modify_date
         FROM documents
         WHERE ${whereClause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
    );

    const data = await Promise.all(rows.map(async (el) => ({
        document_id: el.document_id,
        branch_id: el.branch_id,
        firm_id: el.firm_id,
        username: el.username,
        category_id: el.category_id,
        name: el.name,
        f_year: el.f_year,
        type: el.type,
        remark: el.remark,
        month: el.month,
        file: el.file ? await getProfileDocumentAccessUrl(categoryFolder, el.file) : null,
        size: el.size,
        mime_type: el.mime_type,
        create_date: el.create_date,
        modify_date: el.modify_date
    })));

    return { data, total, page, limitNum, offset, rowCount: rows.length };
}

router.get("/details/documents/list/gst", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.query.username != null ? String(req.query.username).trim() : "";
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        const [clientCheck] = await pool.query(
            "SELECT 1 FROM clients WHERE username = ? AND branch_id = ? AND user_type = 'client' AND is_deleted = '0' LIMIT 1",
            [username, branch_id]
        );
        if (clientCheck.length === 0) {
            return res.status(403).json({ success: false, message: "User not found or does not belong to this branch" });
        }
        const result = await getDocumentListByCategory(branch_id, "GST", "gst", req.query);
        return res.status(200).json({
            success: true,
            message: "GST documents fetched successfully",
            data: result.data,
            pagination: {
                page: result.page,
                limit: result.limitNum,
                total: result.total,
                total_pages: Math.ceil(result.total / result.limitNum),
                is_last_page: result.offset + result.rowCount >= result.total
            }
        });
    } catch (error) {
        console.error("Error fetching GST documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch GST documents",
            error: error.message
        });
    }
});

router.get("/details/documents/list/it", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.query.username != null ? String(req.query.username).trim() : "";
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        const [clientCheck] = await pool.query(
            "SELECT 1 FROM clients WHERE username = ? AND branch_id = ? AND user_type = 'client' AND is_deleted = '0' LIMIT 1",
            [username, branch_id]
        );
        if (clientCheck.length === 0) {
            return res.status(403).json({ success: false, message: "User not found or does not belong to this branch" });
        }
        const result = await getDocumentListByCategory(branch_id, "IT", "it", req.query);
        return res.status(200).json({
            success: true,
            message: "IT documents fetched successfully",
            data: result.data,
            pagination: {
                page: result.page,
                limit: result.limitNum,
                total: result.total,
                total_pages: Math.ceil(result.total / result.limitNum),
                is_last_page: result.offset + result.rowCount >= result.total
            }
        });
    } catch (error) {
        console.error("Error fetching IT documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch IT documents",
            error: error.message
        });
    }
});

router.get("/details/documents/list/mca", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.query.username != null ? String(req.query.username).trim() : "";
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        const [clientCheck] = await pool.query(
            "SELECT 1 FROM clients WHERE username = ? AND branch_id = ? AND user_type = 'client' AND is_deleted = '0' LIMIT 1",
            [username, branch_id]
        );
        if (clientCheck.length === 0) {
            return res.status(403).json({ success: false, message: "User not found or does not belong to this branch" });
        }
        const result = await getDocumentListByCategory(branch_id, "MCA", "mca", req.query);
        return res.status(200).json({
            success: true,
            message: "MCA documents fetched successfully",
            data: result.data,
            pagination: {
                page: result.page,
                limit: result.limitNum,
                total: result.total,
                total_pages: Math.ceil(result.total / result.limitNum),
                is_last_page: result.offset + result.rowCount >= result.total
            }
        });
    } catch (error) {
        console.error("Error fetching MCA documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch MCA documents",
            error: error.message
        });
    }
});

router.post("/details/documents/create-category", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { name, remark } = req.body || {};
        const createdBy = req.headers["username"] || "";

        if (!name || typeof name !== "string" || name.trim() === "") {
            return res.status(400).json({ success: false, message: "Name is required" });
        }

        const category_id = RANDOM_STRING(30);

        await pool.query(
            `INSERT INTO document_categories (category_id, branch_id, name, remark, create_by, modify_by, create_date, modify_date, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), '0')`,
            [category_id, branch_id, name.trim(), remark != null && remark !== "" ? remark : null, createdBy, createdBy]
        );

        return res.status(200).json({
            success: true,
            message: "Document category created successfully",
            data: { category_id, branch_id, name: name.trim(), remark: remark != null && remark !== "" ? remark : null }
        });
    } catch (error) {
        console.error("Error creating document category:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create document category",
            error: error.message
        });
    }
});

router.get("/details/documents/category-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { search = "" } = req.query;
        const searchPattern = search != null && String(search).trim() !== "" ? `%${String(search).trim()}%` : "%%";

        const [rows] = await pool.query(
            `SELECT category_id, branch_id, name, remark, create_by, modify_by, create_date, modify_date
             FROM document_categories
             WHERE branch_id = ? AND is_deleted = '0'
             AND (name LIKE ? OR remark LIKE ?)
             ORDER BY id DESC`,
            [branch_id, searchPattern, searchPattern]
        );

        const data = [];
        for (let i = 0; i < rows.length; i++) {
            const el = rows[i];
            const create_by_user_data = await USER_DATA(el.create_by);
            const modify_by_user_data = await USER_DATA(el.modify_by);

            data.push({
                category_id: el.category_id,
                branch_id: el.branch_id,
                name: el.name,
                remark: el.remark,
                create_date: el.create_date,
                modify_date: el.modify_date,
                create_by: {
                    username: create_by_user_data?.username,
                    name: create_by_user_data?.name,
                    email: create_by_user_data?.email,
                    mobile: create_by_user_data?.mobile,
                    user_type: create_by_user_data?.user_type
                },
                modify_by: {
                    username: modify_by_user_data?.username,
                    name: modify_by_user_data?.name,
                    email: modify_by_user_data?.email,
                    mobile: modify_by_user_data?.mobile,
                    user_type: modify_by_user_data?.user_type
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: "Document categories fetched successfully",
            data
        });
    } catch (error) {
        console.error("Error fetching document categories:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch document categories",
            error: error.message
        });
    }
});

router.put("/details/documents/category-edit", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || "";
        const { category_id, name, remark } = req.body || {};

        if (!category_id || typeof category_id !== "string" || category_id.trim() === "") {
            return res.status(400).json({ success: false, message: "category_id is required" });
        }

        const [existing] = await pool.query(
            "SELECT category_id, name, remark FROM document_categories WHERE category_id = ? AND branch_id = ? AND is_deleted = '0'",
            [category_id.trim(), branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: "Document category not found" });
        }

        const newName = name != null && typeof name === "string" ? name.trim() : existing[0].name;
        if (!newName) {
            return res.status(400).json({ success: false, message: "Name is required and cannot be empty" });
        }
        const newRemark = remark !== undefined && remark !== null ? (typeof remark === "string" ? (remark.trim() || null) : null) : existing[0].remark;

        await pool.query(
            `UPDATE document_categories SET name = ?, remark = ?, modify_by = ?, modify_date = NOW() WHERE category_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [newName, newRemark, modifyBy, category_id.trim(), branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Document category updated successfully",
            data: { category_id: category_id.trim(), name: newName, remark: newRemark }
        });
    } catch (error) {
        console.error("Error updating document category:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update document category",
            error: error.message
        });
    }
});

router.delete("/details/documents/category-delete", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || "";
        const { category_id } = req.body || {};

        if (!category_id || typeof category_id !== "string" || category_id.trim() === "") {
            return res.status(400).json({ success: false, message: "category_id is required" });
        }

        const [existing] = await pool.query(
            "SELECT category_id FROM document_categories WHERE category_id = ? AND branch_id = ? AND is_deleted = '0'",
            [category_id.trim(), branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: "Document category not found" });
        }

        const [documentsUsing] = await pool.query(
            "SELECT 1 FROM documents WHERE category_id = ? AND is_deleted = '0' LIMIT 1",
            [category_id.trim()]
        );

        if (documentsUsing.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot delete category: one or more documents are assigned to this category"
            });
        }

        await pool.query(
            `UPDATE document_categories SET is_deleted = '1', modify_by = ?, modify_date = NOW() WHERE category_id = ? AND branch_id = ?`,
            [modifyBy, category_id.trim(), branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Document category deleted successfully"
        });
    } catch (error) {
        console.error("Error deleting document category:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete document category",
            error: error.message
        });
    }
});

router.get("/details/password/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { search, page = 1, limit, username = "" } = req.query;

        const parsedPage = Number(page);
        const pageNum = Number.isFinite(parsedPage) && parsedPage > 0 ? Math.floor(parsedPage) : 1;
        const parsedLimit = Number(limit);
        const limitNum = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(Math.floor(parsedLimit), 100)
            : 20;
        const offset = (pageNum - 1) * limitNum;

        const searchText = typeof search === "string" ? search.trim() : "";
        const hasSearch = searchText.length > 0;
        const searchPattern = hasSearch ? `%${searchText}%` : "%%";

        const firms = await GET_FIRMS_BY_USERNAME({
            username,
            branch_id
        });

        const firmIds = firms.map((f) => f.firm_id).filter(Boolean);
        if (firmIds.length === 0) {
            return res.status(200).json({
                success: true,
                message: "Password credentials fetched successfully",
                data: [],
                meta: {
                    page: pageNum,
                    limit: limitNum,
                    total: 0,
                    total_pages: 0,
                    is_last_page: true
                }
            });
        }

        const firmPlaceholders = firmIds.map(() => "?").join(", ");

        let countQuery = `
            SELECT COUNT(*) AS total
            FROM password_group_firms pg
            INNER JOIN password_groups p
                ON pg.group_id = p.group_id
                AND p.branch_id = ?
                AND p.is_deleted = '0'
            LEFT JOIN firms f
                ON pg.firm_id = f.firm_id
                AND f.branch_id = ?
                AND f.is_deleted = '0'
            WHERE pg.is_deleted = '0'
              AND pg.firm_id IN (${firmPlaceholders})
        `;
        let countParams = [branch_id, branch_id, ...firmIds];

        if (hasSearch) {
            countQuery += ` AND (pg.username LIKE ? OR pg.description LIKE ? OR IFNULL(f.firm_name, '') LIKE ? OR IFNULL(p.group_name, '') LIKE ?)`;
            countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        const [[{ total }]] = await pool.query(countQuery, countParams);

        let query = `
            SELECT
                pg.credential_id,
                pg.group_id,
                pg.firm_id,
                pg.username AS credential_username,
                pg.password,
                pg.description,
                pg.status AS credential_status,
                pg.create_by,
                pg.create_date,
                pg.modify_by,
                pg.modify_date,
                p.group_name,
                p.status AS group_status,
                f.firm_name,
                f.firm_type,
                f.gst_no,
                f.pan_no,
                f.tan_no,
                f.vat_no,
                f.cin_no,
                f.file_no,
                f.address_line_1,
                f.address_line_2,
                f.city,
                f.district,
                f.state,
                f.country,
                f.pincode,
                f.status AS firm_status,
                f.remark AS firm_remark,
                c.username AS owner_username,
                c.status AS owner_status
            FROM password_group_firms pg
            INNER JOIN password_groups p
                ON pg.group_id = p.group_id
                AND p.branch_id = ?
                AND p.is_deleted = '0'
            LEFT JOIN firms f
                ON pg.firm_id = f.firm_id
                AND f.branch_id = ?
                AND f.is_deleted = '0'
            LEFT JOIN clients c
                ON f.username = c.username
                AND c.user_type = 'client'
                AND c.is_deleted = '0'
            WHERE pg.is_deleted = '0'
              AND pg.firm_id IN (${firmPlaceholders})
        `;
        let queryParams = [branch_id, branch_id, ...firmIds];

        if (hasSearch) {
            query += ` AND (pg.username LIKE ? OR pg.description LIKE ? OR f.firm_name LIKE ? OR p.group_name LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY pg.id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        const credentials = [];
        for (const el of rows) {
            const create_by_user = await USER_DATA(el?.create_by);
            const modify_by_user = await USER_DATA(el?.modify_by);
            const owner_details = el.owner_username ? await USER_DATA(el.owner_username) : null;

            credentials.push({
                group: {
                    group_id: el.group_id,
                    group_name: el.group_name,
                    status: el.group_status == "1"
                },
                credential: {
                    credential_id: el.credential_id,
                    username: el.credential_username,
                    password: el.password,
                    description: el.description,
                    status: el.credential_status == "1",
                    created_by: {
                        name: create_by_user?.name,
                        mobile: create_by_user?.mobile,
                        email: create_by_user?.email
                    },
                    modified_by: {
                        name: modify_by_user?.name,
                        mobile: modify_by_user?.mobile,
                        email: modify_by_user?.email
                    },
                    create_date: el.create_date,
                    modify_date: el.modify_date
                },
                firm: {
                    firm_id: el.firm_id,
                    firm_name: el.firm_name,
                    firm_type: el.firm_type,
                    gst_no: el.gst_no,
                    pan_no: el.pan_no,
                    tan_no: el.tan_no,
                    vat_no: el.vat_no,
                    cin_no: el.cin_no,
                    file_no: el.file_no,
                    address: {
                        line1: el.address_line_1,
                        line2: el.address_line_2,
                        city: el.city,
                        district: el.district,
                        state: el.state,
                        country: el.country,
                        pincode: el.pincode
                    },
                    status: el.firm_status == "1",
                    remark: el.firm_remark
                },
                client: el.owner_username
                    ? {
                        username: el.owner_username,
                        name: owner_details?.name || null,
                        mobile: owner_details?.mobile || null,
                        email: owner_details?.email || null,
                        status: el.owner_status == "1"
                    }
                    : null
            });
        }

        return res.status(200).json({
            success: true,
            message: "Password credentials fetched successfully",
            data: credentials,
            meta: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });
    } catch (error) {
        console.error("Error fetching password credentials list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch password credentials",
            error: error.message
        });
    }
});

router.get("/details/password/group-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [rows] = await pool.query("SELECT group_id, group_name FROM password_groups WHERE branch_id = ? AND is_deleted = '0' AND status = '1'", [branch_id]);

        return res.status(200).json({
            success: true,
            message: "Password groups fetched successfully",
            data: rows,
        });
    } catch (error) {
        console.error("Error fetching password groups list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch password groups",
            error: error.message
        });
    }
});

router.get("/details/tasks/statistics", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const raw = req.query?.username;
        const clientUsername =
            raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;

        if (!clientUsername) {
            return res.status(400).json({
                success: false,
                message: "username query parameter is required"
            });
        }

        const [[stats]] = await pool.query(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) AS complete_cnt,
                COALESCE(SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END), 0) AS cancel_cnt,
                COALESCE(SUM(CASE WHEN status = 'pending from department' THEN 1 ELSE 0 END), 0) AS pending_from_department_cnt,
                COALESCE(SUM(CASE WHEN status = 'pending from client' THEN 1 ELSE 0 END), 0) AS pending_from_client_cnt,
                COALESCE(SUM(CASE WHEN status = 'in process' THEN 1 ELSE 0 END), 0) AS in_process_cnt
            FROM tasks
            WHERE CAST(branch_id AS CHAR) = CAST(? AS CHAR)
              AND username = ?`,
            [branch_id, clientUsername]
        );

        const row = stats || {};
        const num = (v) => Number(v) || 0;

        return res.status(200).json({
            success: true,
            message: "Tasks statistics fetched successfully",
            data: {
                total: num(row.total),
                complete: num(row.complete_cnt),
                cancel: num(row.cancel_cnt),
                pending_from_department: num(row.pending_from_department_cnt),
                pending_from_client: num(row.pending_from_client_cnt),
                in_process: num(row.in_process_cnt)
            }
        });
    } catch (error) {
        console.error("Error fetching tasks statistics:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch tasks statistics",
            error: error.message
        });
    }
});

// Configure multer for memory storage and size limits
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB size limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.includes('csv') ||
            file.mimetype.includes('spreadsheet') ||
            file.originalname.match(/\.(csv|xls|xlsx)$/)) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV and Excel files allowed'));
        }
    }
}).single('file');

// Helper function to detect columns
function detectColumns(headers) {
    const mapped = {};
    const namePatterns = ['name', 'full name', 'fullname', 'client name', 'client_name'];
    const mobilePatterns = ['mobile', 'phone', 'mobile number', 'mobile_no', 'phone number', 'phone_no'];
    const emailPatterns = ['email', 'e-mail', 'mail', 'email address', 'email_id', 'emailid'];
    const panPatterns = ['pan', 'pan number', 'pan_no', 'pan_number', 'client_pan', 'client pan'];
    const genderPatterns = ['gender', 'sex'];
    const dobPatterns = ['dob', 'date of birth', 'date_of_birth', 'birth date', 'birth_date', 'dateofbirth'];
    const careOfPatterns = ['care of', 'care_of', 'c/o', 'co'];
    const guardianPatterns = ['guardian', 'guardian name', 'guardian_name'];
    const countryCodePatterns = ['country code', 'country_code', 'code'];
    const statePatterns = ['state'];
    const districtPatterns = ['district'];
    const cityPatterns = ['city', 'town', 'village', 'city/town/village', 'village_town', 'town_or_village'];
    const pincodePatterns = ['pincode', 'pin', 'zip', 'zipcode', 'postal code', 'postal_code'];
    const address1Patterns = ['address line 1', 'address_line_1', 'address1', 'address 1'];
    const address2Patterns = ['address line 2', 'address_line_2', 'address2', 'address 2'];

    // Firm columns
    const firmNamePatterns = ['firm', 'firm name', 'firm_name', 'business name', 'business_name', 'company', 'company name'];
    const businessTypePatterns = ['business type', 'business_type', 'firm type', 'firm_type', 'type'];
    const firmPanPatterns = ['firm pan', 'firm_pan', 'business pan', 'business_pan', 'firm pan number', 'firm_pan_no'];
    const gstPatterns = ['gst', 'gstin', 'gst number', 'gst_number', 'gst_no'];
    const tanPatterns = ['tan', 'tan number', 'tan_number', 'tan_no'];
    const vatPatterns = ['vat', 'vat number', 'vat_number', 'vat_no'];
    const cinPatterns = ['cin', 'cin number', 'cin_number', 'cin_no'];
    const fileNoPatterns = ['file', 'file number', 'file_number', 'file_no'];

    // Opening Balance
    const balancePatterns = ['opening balance', 'opening_balance', 'balance', 'opening balance amount', 'opening_balance_amount'];
    const balanceTypePatterns = ['opening balance type', 'opening_balance_type', 'balance type', 'type'];
    const balanceDatePatterns = ['opening balance date', 'opening_balance_date', 'balance date'];

    const matchPattern = (header, patterns) => {
        const cleaned = String(header || '').toLowerCase().trim();
        const cleanedCompressed = cleaned.replace(/[\s_-]/g, '');
        return patterns.some(p => cleaned === p || cleanedCompressed === p.replace(/[\s_-]/g, ''));
    };

    for (const header of headers) {
        if (matchPattern(header, namePatterns)) mapped.name = header;
        else if (matchPattern(header, mobilePatterns)) mapped.mobile = header;
        else if (matchPattern(header, emailPatterns)) mapped.email = header;
        else if (matchPattern(header, panPatterns)) mapped.pan_number = header;
        else if (matchPattern(header, genderPatterns)) mapped.gender = header;
        else if (matchPattern(header, dobPatterns)) mapped.date_of_birth = header;
        else if (matchPattern(header, careOfPatterns)) mapped.care_of = header;
        else if (matchPattern(header, guardianPatterns)) mapped.guardian_name = header;
        else if (matchPattern(header, countryCodePatterns)) mapped.country_code = header;
        else if (matchPattern(header, statePatterns)) mapped.state = header;
        else if (matchPattern(header, districtPatterns)) mapped.district = header;
        else if (matchPattern(header, cityPatterns)) mapped.city = header;
        else if (matchPattern(header, pincodePatterns)) mapped.pincode = header;
        else if (matchPattern(header, address1Patterns)) mapped.address_line_1 = header;
        else if (matchPattern(header, address2Patterns)) mapped.address_line_2 = header;
        else if (matchPattern(header, firmNamePatterns)) mapped.firm_name = header;
        else if (matchPattern(header, businessTypePatterns)) mapped.firm_type = header;
        else if (matchPattern(header, firmPanPatterns)) mapped.firm_pan = header;
        else if (matchPattern(header, gstPatterns)) mapped.gst_no = header;
        else if (matchPattern(header, tanPatterns)) mapped.tan_no = header;
        else if (matchPattern(header, vatPatterns)) mapped.vat_no = header;
        else if (matchPattern(header, cinPatterns)) mapped.cin_no = header;
        else if (matchPattern(header, fileNoPatterns)) mapped.file_no = header;
        else if (matchPattern(header, balancePatterns)) mapped.opening_balance = header;
        else if (matchPattern(header, balanceTypePatterns)) mapped.opening_balance_type = header;
        else if (matchPattern(header, balanceDatePatterns)) mapped.opening_balance_date = header;
    }
    return mapped;
}

// Parse CSV manually or parse Excel sheet
function parseCSVLine(line) {
    const result = [];
    let inQuote = false;
    let currentValue = '';

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
            result.push(currentValue.trim().replace(/^"|"$/g, ''));
            currentValue = '';
        } else {
            currentValue += char;
        }
    }
    result.push(currentValue.trim().replace(/^"|"$/g, ''));
    return result;
}

router.post("/import", auth, validateBranch, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: "Please upload a file" });
        }

        try {
            const branch_id = req.branch_id;
            const createdBy = req.headers["username"] || "";
            const isPreview = req.query.preview === 'true';
            const fileBuffer = req.file.buffer;
            const originalName = req.file.originalname;
            const isCSV = originalName.toLowerCase().endsWith('.csv');

            let headers = [];
            let rows = [];

            if (isCSV) {
                const content = fileBuffer.toString('utf-8');
                const lines = content.split(/\r?\n/);
                if (lines.length === 0 || !lines[0].trim()) {
                    return res.status(400).json({ success: false, message: "Uploaded CSV file is empty" });
                }
                headers = parseCSVLine(lines[0]);
                for (let i = 1; i < lines.length; i++) {
                    if (!lines[i].trim()) continue;
                    const values = parseCSVLine(lines[i]);
                    const row = {};
                    headers.forEach((h, idx) => {
                        if (h) row[h] = values[idx] !== undefined ? values[idx] : '';
                    });
                    rows.push(row);
                }
            } else {
                const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
                if (workbook.SheetNames.length === 0) {
                    return res.status(400).json({ success: false, message: "Uploaded Excel file has no sheets" });
                }
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(sheet, { defval: '' });
                rows = data;
                if (rows.length > 0) {
                    headers = Object.keys(rows[0]);
                }
            }

            if (rows.length === 0) {
                return res.status(400).json({ success: false, message: "No data rows found in the uploaded file" });
            }

            // Support dynamic column mapping
            let customMapping = {};
            const rawMapping = req.body.column_mapping || req.body.column_mappings;
            if (rawMapping) {
                let parsed = null;
                if (typeof rawMapping === 'string') {
                    try {
                        parsed = JSON.parse(rawMapping);
                    } catch (e) {
                        console.error("Failed to parse column_mapping:", e);
                    }
                } else if (typeof rawMapping === 'object' && rawMapping !== null) {
                    parsed = rawMapping;
                }

                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    // Sanitize keys and values to prevent prototype pollution and ensure only string mappings are used
                    for (const [key, value] of Object.entries(parsed)) {
                        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                            continue;
                        }
                        if (typeof value === 'string') {
                            customMapping[key] = value;
                        }
                    }
                }
            }

            // Normalize custom mapping value to match exact case of headers if they match case-insensitively
            const normalizedCustomMapping = {};
            const invalidMappings = [];
            for (const [key, colName] of Object.entries(customMapping)) {
                if (colName) {
                    const exactMatch = headers.find(h => h === colName);
                    if (exactMatch) {
                        normalizedCustomMapping[key] = exactMatch;
                    } else {
                        const caseInsensitiveMatch = headers.find(h => h.toLowerCase() === colName.toLowerCase());
                        if (caseInsensitiveMatch) {
                            normalizedCustomMapping[key] = caseInsensitiveMatch;
                        } else {
                            invalidMappings.push(`"${colName}" (mapped to "${key}")`);
                        }
                    }
                }
            }
            if (invalidMappings.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `The following mapped columns were not found in the uploaded file: ${invalidMappings.join(', ')}`
                });
            }

            const mappedCols = { ...detectColumns(headers), ...normalizedCustomMapping };

            // Check minimum required headers mapping
            const missingRequiredHeaders = [];
            if (!mappedCols.name) missingRequiredHeaders.push("Client Name");
            if (!mappedCols.mobile) missingRequiredHeaders.push("Mobile");
            if (!mappedCols.email) missingRequiredHeaders.push("Email");
            if (!mappedCols.pan_number) missingRequiredHeaders.push("PAN Number");
            if (!mappedCols.gender) missingRequiredHeaders.push("Gender");
            if (!mappedCols.date_of_birth) missingRequiredHeaders.push("Date of Birth");
            if (!mappedCols.state) missingRequiredHeaders.push("State");
            if (!mappedCols.district) missingRequiredHeaders.push("District");
            if (!mappedCols.city) missingRequiredHeaders.push("City/Town/Village");
            if (!mappedCols.pincode) missingRequiredHeaders.push("Pincode");

            if (missingRequiredHeaders.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `Could not detect one or more required columns. Missing columns: ${missingRequiredHeaders.join(', ')}. Please check your file headers.`
                });
            }

            const parsedClients = [];
            const validationErrors = [];

            // Helper function to format/parse Dates safely
            const parseDateString = (val) => {
                if (!val) return null;
                if (typeof val === 'number') {
                    const dateObj = new Date((val - 25569) * 86400 * 1000);
                    return moment(dateObj).format("YYYY-MM-DD");
                }
                const m = moment(String(val).trim(), ["YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY", "MM/DD/YYYY"], true);
                return m.isValid() ? m.format("YYYY-MM-DD") : null;
            };

            // Process and validate each row
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowNum = i + 2; // 1-based indexing for sheets, row 1 is header

                const name = String(row[mappedCols.name] || '').trim();
                const mobile = String(row[mappedCols.mobile] || '').trim();
                const email = String(row[mappedCols.email] || '').trim();
                const pan_number = String(row[mappedCols.pan_number] || '').trim().toUpperCase();
                const rawGender = String(row[mappedCols.gender] || '').trim().toLowerCase();
                const rawDob = row[mappedCols.date_of_birth];
                const care_of = String(mappedCols.care_of ? (row[mappedCols.care_of] || '') : '').trim();
                const guardian_name = String(mappedCols.guardian_name ? (row[mappedCols.guardian_name] || '') : '').trim();
                const country_code = String(mappedCols.country_code ? (row[mappedCols.country_code] || '91') : '91').trim();
                const state = String(row[mappedCols.state] || '').trim();
                const district = String(row[mappedCols.district] || '').trim();
                const city = String(row[mappedCols.city] || '').trim();
                const pincode = String(row[mappedCols.pincode] || '').trim();
                const address_line_1 = String(mappedCols.address_line_1 ? (row[mappedCols.address_line_1] || '') : '').trim();
                const address_line_2 = String(mappedCols.address_line_2 ? (row[mappedCols.address_line_2] || '') : '').trim();

                // Firm fields
                const firm_name = String(mappedCols.firm_name ? (row[mappedCols.firm_name] || '') : '').trim();
                const rawFirmType = String(mappedCols.firm_type ? (row[mappedCols.firm_type] || '') : '').trim();
                const firm_pan = String(mappedCols.firm_pan ? (row[mappedCols.firm_pan] || '') : '').trim().toUpperCase();
                const gst_no = String(mappedCols.gst_no ? (row[mappedCols.gst_no] || '') : '').trim().toUpperCase();
                const tan_no = String(mappedCols.tan_no ? (row[mappedCols.tan_no] || '') : '').trim().toUpperCase();
                const vat_no = String(mappedCols.vat_no ? (row[mappedCols.vat_no] || '') : '').trim().toUpperCase();
                const cin_no = String(mappedCols.cin_no ? (row[mappedCols.cin_no] || '') : '').trim().toUpperCase();
                const file_no = String(mappedCols.file_no ? (row[mappedCols.file_no] || '') : '').trim().toUpperCase();

                // Opening balance fields
                const rawBalance = mappedCols.opening_balance ? row[mappedCols.opening_balance] : null;
                const rawBalanceType = mappedCols.opening_balance_type ? String(row[mappedCols.opening_balance_type] || '').trim().toLowerCase() : 'credit';
                const rawBalanceDate = mappedCols.opening_balance_date ? row[mappedCols.opening_balance_date] : null;

                const rowErrors = [];

                // Validations
                if (!name) rowErrors.push("Client Name is required");
                if (!mobile) {
                    rowErrors.push("Mobile number is required");
                } else if (!/^\+?[0-9]{10,15}$/.test(mobile)) {
                    rowErrors.push("Invalid mobile number format (should be 10-15 digits)");
                }
                if (!email) {
                    rowErrors.push("Email is required");
                } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    rowErrors.push("Invalid email format");
                }

                const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
                if (!pan_number) {
                    rowErrors.push("PAN Number is required");
                } else if (!panRegex.test(pan_number)) {
                    rowErrors.push("Invalid PAN format (should be 10 characters e.g. ABCDE1234F)");
                }

                let gender = null;
                if (!rawGender) {
                    rowErrors.push("Gender is required");
                } else if (['male', 'female', 'other'].includes(rawGender)) {
                    gender = rawGender;
                } else {
                    rowErrors.push("Gender must be 'male', 'female', or 'other'");
                }

                const dob = parseDateString(rawDob);
                if (!rawDob) {
                    rowErrors.push("Date of Birth is required");
                } else if (!dob) {
                    rowErrors.push("Invalid Date of Birth format (should be YYYY-MM-DD or DD/MM/YYYY)");
                }

                if (!state) rowErrors.push("State is required");
                if (!district) rowErrors.push("District is required");
                if (!city) rowErrors.push("City/Town/Village is required");
                if (!pincode) rowErrors.push("Pincode is required");

                // Determine Firm (Business) Type & Details
                let firmType = 'Individual';
                if (rawFirmType) {
                    firmType = rawFirmType;
                }

                // If Business is non-individual, require Firm Name and address fields, otherwise fallback
                const isIndividual = firmType.toLowerCase() === 'individual';
                const finalFirmName = isIndividual ? name : (firm_name || `${name} Business`);
                const finalFirmPan = firm_pan || pan_number;

                // Validate opening balance if any
                let openingBalance = null;
                if (rawBalance !== null && rawBalance !== undefined && String(rawBalance).trim() !== '') {
                    const amt = parseFloat(rawBalance);
                    if (isNaN(amt) || amt < 0) {
                        rowErrors.push("Opening Balance must be a positive number");
                    } else if (amt > 0) {
                        const balType = ['credit', 'debit', '1', '0'].includes(rawBalanceType) ? (rawBalanceType === '1' || rawBalanceType === 'credit' ? 'credit' : 'debit') : 'credit';
                        const balDate = parseDateString(rawBalanceDate) || TODAY_DATE();
                        openingBalance = {
                            amount: amt,
                            type: balType === 'credit' ? '1' : '0', // "1" is credit, "0" is debit
                            date: balDate
                        };
                    }
                }

                // Check duplicates in database (if no local errors found yet, to save DB query overhead)
                if (rowErrors.length === 0) {
                    // Duplicate mobile check
                    const [dupMobile] = await pool.query(
                        "SELECT p.name FROM profile p JOIN clients c ON p.username = c.username WHERE p.mobile = ? AND c.user_type = 'client' AND c.is_deleted = '0' LIMIT 1",
                        [mobile]
                    );
                    if (dupMobile.length > 0) {
                        rowErrors.push(`Mobile number already exists (registered to ${dupMobile[0].name})`);
                    }

                    // Duplicate email check
                    const [dupEmail] = await pool.query(
                        "SELECT p.name FROM profile p JOIN clients c ON p.username = c.username WHERE p.email = ? AND c.user_type = 'client' AND c.is_deleted = '0' LIMIT 1",
                        [email]
                    );
                    if (dupEmail.length > 0) {
                        rowErrors.push(`Email already exists (registered to ${dupEmail[0].name})`);
                    }

                    // Duplicate PAN check (branch specific)
                    const [dupPan] = await pool.query(
                        "SELECT p.name FROM profile p JOIN clients c ON p.username = c.username WHERE p.pan_number = ? AND c.user_type = 'client' AND c.is_deleted = '0' AND c.branch_id = ? LIMIT 1",
                        [pan_number, branch_id]
                    );
                    if (dupPan.length > 0) {
                        rowErrors.push(`PAN number already exists in this branch (registered to ${dupPan[0].name})`);
                    }

                    // Also check duplicates within the uploaded file itself
                    const isDupInFile = parsedClients.some(c => c.mobile === mobile || c.email === email || c.pan_number === pan_number);
                    if (isDupInFile) {
                        rowErrors.push("Duplicate record within this spreadsheet (mobile, email, or PAN already present in a previous row)");
                    }
                }

                if (rowErrors.length > 0) {
                    validationErrors.push({
                        row: rowNum,
                        name: name || 'Unknown',
                        errors: rowErrors
                    });
                } else {
                    parsedClients.push({
                        name,
                        mobile,
                        email,
                        pan_number,
                        gender,
                        date_of_birth: dob,
                        care_of: care_of || 'N/A',
                        guardian_name: guardian_name || 'N/A',
                        country_code,
                        state,
                        district,
                        city,
                        pincode,
                        address_line_1: address_line_1 || null,
                        address_line_2: address_line_2 || null,
                        firm: {
                            firm_name: finalFirmName,
                            firm_type: firmType,
                            pan_no: finalFirmPan,
                            gst_no: gst_no || null,
                            tan_no: tan_no || null,
                            vat_no: vat_no || null,
                            cin_no: cin_no || null,
                            file_no: file_no || null,
                            state: state,
                            district: district,
                            city: city,
                            pincode: pincode,
                            address_line_1: address_line_1 || null,
                            address_line_2: address_line_2 || null
                        },
                        openingBalance
                    });
                }
            }

            // Preview output
            if (isPreview) {
                return res.status(200).json({
                    success: true,
                    message: "File preview and validation completed",
                    data: {
                        total_rows: rows.length,
                        valid_count: parsedClients.length,
                        invalid_count: validationErrors.length,
                        column_mappings: mappedCols,
                        preview: parsedClients.slice(0, 10),
                        errors: validationErrors
                    }
                });
            }

            // If not preview and there are errors, fail immediately (atomic rollback pattern)
            if (validationErrors.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: "Import failed due to validation errors. Please check the preview to fix your sheet.",
                    errors: validationErrors
                });
            }

            // Perform actual DB transaction insertion
            const conn = await pool.getConnection();
            const createdClients = [];
            try {
                await conn.beginTransaction();

                for (const client of parsedClients) {
                    const username = RANDOM_STRING(20);
                    const profile_id = RANDOM_STRING(30);

                    // Insert client
                    await conn.query(
                        `INSERT INTO clients (username, user_type, branch_id, create_by, status, is_deleted)
                         VALUES (?, 'client', ?, ?, '1', '0')`,
                        [username, branch_id, createdBy]
                    );

                    // Insert profile
                    await conn.query(
                        `INSERT INTO profile (profile_id, username, create_by, user_type, name, care_of, guardian_name, date_of_birth, gender, mobile, country_code, email, pan_number, state, district, city, village_town, pincode, address_line_1, address_line_2, status)
                         VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1')`,
                        [
                            profile_id, username, createdBy, client.name, client.care_of, client.guardian_name,
                            client.date_of_birth, client.gender, client.mobile, client.country_code, client.email,
                            client.pan_number, client.state, client.district, client.city, client.city, client.pincode,
                            client.address_line_1, client.address_line_2
                        ]
                    );

                    // Insert firm
                    const firm_id = RANDOM_STRING(30);
                    await conn.query(
                        `INSERT INTO firms (firm_id, branch_id, username, firm_name, firm_type, pan_no, gst_no, tan_no, vat_no, cin_no, file_no, state, district, city, pincode, address_line_1, address_line_2, create_by, status, is_deleted)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', '0')`,
                        [
                            firm_id, branch_id, username, client.firm.firm_name, client.firm.firm_type, client.firm.pan_no,
                            client.firm.gst_no, client.firm.tan_no, client.firm.vat_no, client.firm.cin_no, client.firm.file_no,
                            client.firm.state, client.firm.district, client.firm.city, client.firm.pincode,
                            client.firm.address_line_1, client.firm.address_line_2, createdBy
                        ]
                    );

                    createdClients.push({
                        username,
                        name: client.name,
                        mobile: client.mobile,
                        email: client.email,
                        openingBalance: client.openingBalance
                    });
                }

                await conn.commit();
            } catch (txErr) {
                await conn.rollback();
                throw txErr;
            } finally {
                conn.release();
            }

            // Post-commit: handle opening balances sequentially
            const originalBranchId = req.headers["branch_id"];
            req.headers["branch_id"] = branch_id;

            let openingBalanceCount = 0;
            for (const client of createdClients) {
                if (client.openingBalance) {
                    try {
                        await SET_OPENING_BALANCE({
                            req,
                            type: client.openingBalance.type,
                            party_type: "client",
                            party_id: client.username,
                            amount: client.openingBalance.amount,
                            remark: "Imported opening balance",
                            transaction_date: client.openingBalance.date
                        });
                        openingBalanceCount++;
                    } catch (balError) {
                        console.error(`Opening balance creation failed for user ${client.username}:`, balError);
                    }
                }
            }

            // Restore original branch_id if any
            if (originalBranchId !== undefined) {
                req.headers["branch_id"] = originalBranchId;
            } else {
                delete req.headers["branch_id"];
            }

            return res.status(200).json({
                success: true,
                message: `Successfully imported ${createdClients.length} clients!`,
                data: {
                    imported_count: createdClients.length,
                    opening_balance_applied: openingBalanceCount
                }
            });

        } catch (error) {
            console.error("Bulk client import error:", error);
            return res.status(500).json({
                success: false,
                message: "Internal server error occurred during bulk client import",
                error: error.message
            });
        }
    });
});

export default router;