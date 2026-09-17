import express from 'express';
const router = express.Router();

import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { RANDOM_STRING, UNIQUE_RANDOM_STRING, ID_LENGTH, TODAY_DATE } from "../helpers/function.js";
import { buildExpenseAttachmentUrl, buildProfileImageUrl } from '../helpers/mediaUrl.js';
import {
    deleteExpenseAttachment,
    downloadAndUploadExpenseAttachment,
} from '../helpers/b2Storage.js';
import { fetchPermissionRoleById } from "../helpers/permissionRole.js";
import multer from 'multer';
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

function parseUserPermissions(permissionsAssigned) {
    if (!permissionsAssigned) return [];
    try {
        const parsed =
            typeof permissionsAssigned === "string"
                ? JSON.parse(permissionsAssigned)
                : permissionsAssigned;
        if (parsed?.permissions && Array.isArray(parsed.permissions)) {
            return parsed.permissions;
        }
        if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
    return [];
}

async function checkUserPermission(username, branchId, permissionKey) {
    if (!username || !branchId || !permissionKey) return false;
    try {
        const [mappings] = await pool.query(
            `SELECT type, permission_role_id, custom_permissions
             FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [username, branchId]
        );
        if (!mappings.length) return false;
        const userMap = mappings[0];
        if (userMap.type === "admin" || userMap.permission_role_id === "admin") return true;

        const [optCheck] = await pool.query(
            "SELECT id FROM permission_option WHERE p_option_id = ? AND status = '1' LIMIT 1",
            [permissionKey]
        );
        if (!optCheck.length) return false;

        if (userMap.custom_permissions) {
            const customPerms = parseUserPermissions(userMap.custom_permissions);
            if (customPerms.includes(permissionKey)) return true;
        }
        if (userMap.permission_role_id) {
            const role = await fetchPermissionRoleById(pool, userMap.permission_role_id, branchId);
            if (role) {
                const rolePerms = parseUserPermissions(role.permissions_assigned);
                if (rolePerms.includes(permissionKey)) return true;
            }
        }
        return false;
    } catch (error) {
        console.error("Error checking user permission:", error);
        return false;
    }
}

async function resolveIndirectExpenseItem(conn, branch_id, item_id) {
    const [rows] = await conn.query(
        `SELECT item_id, name, type
         FROM expense_items
         WHERE item_id = ?
           AND is_deleted = '0'
           AND type = 'indirect'
           AND (branch_id IS NULL OR branch_id = ?)
         LIMIT 1`,
        [item_id, branch_id]
    );
    return rows[0] || null;
}

/**
 * Approve a pending staff expense inside an open transaction:
 * creates invoice + expense transaction (staff credit) + expense_entries.
 * Mutates staff_expenses to approved.
 * @returns {{ transaction_id, linked_expense_id, invoice_no }}
 */
async function approvePendingStaffExpense(conn, {
    expense,
    branch_id,
    actorUsername,
    remarks = null,
}) {
    if (!expense?.item_id) {
        const err = new Error("Cannot approve: expense has no item. Staff must resubmit with an indirect expense item.");
        err.statusCode = 400;
        throw err;
    }

    const item = await resolveIndirectExpenseItem(conn, branch_id, expense.item_id);
    if (!item) {
        const err = new Error("Cannot approve: linked expense item is missing or not an indirect item.");
        err.statusCode = 400;
        throw err;
    }

    const amountNum = Number(Number(expense.amount).toFixed(2));
    const expenseDate = toYmd(expense.expense_date);
    if (!expenseDate) {
        const err = new Error("Cannot approve: expense date is invalid.");
        err.statusCode = 400;
        throw err;
    }

    const remarkVal = remarks != null && String(remarks).trim() !== ''
        ? String(remarks).trim()
        : (expense.description || `Staff expense: ${expense.title || item.name}`);

    const [invoicePrefixRows] = await conn.query(
        "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
        [branch_id, "expense", "0", TODAY_DATE(), TODAY_DATE()]
    );
    if (!invoicePrefixRows?.length) {
        const err = new Error("Invoice prefix not set for expense.");
        err.statusCode = 400;
        throw err;
    }

    const invoiceData = invoicePrefixRows[0];
    const invoicePrimaryId = invoiceData?.id;
    const serial = Number(invoiceData?.current || 0) + 1;
    const invoice_no = `${invoiceData?.prefix}${serial}`;

    const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", {
        length: ID_LENGTH,
        conn,
    });
    const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", {
        length: ID_LENGTH,
        conn,
    });
    const linked_expense_id = await UNIQUE_RANDOM_STRING("expense_entries", "expense_id", {
        length: ID_LENGTH,
        conn,
    });

    await conn.query(
        `INSERT INTO invoice (
            invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id,
            subtotal, discount_type, discount_perc_rate, discount_value,
            additional_charge, total, round_off, grand_total
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            invoice_id,
            branch_id,
            invoice_no,
            actorUsername,
            actorUsername,
            "expense",
            transaction_id,
            amountNum,
            "not applicable",
            0,
            0,
            0,
            amountNum,
            0,
            amountNum,
        ]
    );

    await conn.query(
        `INSERT INTO transactions (
            branch_id, transaction_id, create_by, modify_by, transaction_date,
            amount, transaction_type, invoice_id, invoice_no,
            party1_type, party1_id, party2_type, party2_id, remark
         )
         VALUES (?, ?, ?, ?, ?, ?, 'expense', ?, ?, 'staff', ?, 'expense', ?, ?)`,
        [
            branch_id,
            transaction_id,
            actorUsername,
            actorUsername,
            expenseDate,
            amountNum,
            invoice_id,
            invoice_no,
            expense.staff_username,
            invoice_id,
            remarkVal,
        ]
    );

    await conn.query(
        `INSERT INTO expense_entries (
            branch_id, expense_id, create_by, modify_by, expense_date,
            party_type, party_id, amount, invoice_id, invoice_no, transaction_id, remark
         )
         VALUES (?, ?, ?, ?, ?, 'staff', ?, ?, ?, ?, ?, ?)`,
        [
            branch_id,
            linked_expense_id,
            actorUsername,
            actorUsername,
            expenseDate,
            expense.staff_username,
            amountNum,
            invoice_id,
            invoice_no,
            transaction_id,
            remarkVal,
        ]
    );

    await conn.query(
        `INSERT INTO expense_entries_items (
            branch_id, item_id, expense_id, invoice_id, amount, remark
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            branch_id,
            expense.item_id,
            linked_expense_id,
            invoice_id,
            amountNum,
            remarkVal,
        ]
    );

    await conn.query(
        "UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?",
        [serial, invoicePrimaryId]
    );

    await conn.query(
        `UPDATE staff_expenses 
         SET status = '1', approved_by = ?, approved_date = NOW(), modify_by = ?,
             modify_date = NOW(), transaction_id = ?, linked_expense_id = ?, remarks = ?
         WHERE expense_id = ? AND branch_id = ?`,
        [
            actorUsername,
            actorUsername,
            transaction_id,
            linked_expense_id,
            remarks || null,
            expense.expense_id,
            branch_id,
        ]
    );

    return { transaction_id, linked_expense_id, invoice_no };
}

function toYmd(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
        const y = parsed.getFullYear();
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return null;
}

function resolveAttachmentUrl(attachment) {
    if (!attachment) return null;
    const val = String(attachment).trim();
    if (!val) return null;
    // Legacy: already a public URL (e.g. OneSaaS) stored before B2 transfer
    if (/^https?:\/\//i.test(val)) return val;
    // B2 filename under media/expense/attachment/
    return buildExpenseAttachmentUrl(val);
}

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Staff expense configuration
const STAFF_EXPENSE_ATTACHMENT_DIR = path.join(__dirname, "..", "media", "expense", "attachment");

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure directory exists
        if (!fs.existsSync(STAFF_EXPENSE_ATTACHMENT_DIR)) {
            fs.mkdirSync(STAFF_EXPENSE_ATTACHMENT_DIR, { recursive: true });
        }
        cb(null, STAFF_EXPENSE_ATTACHMENT_DIR);
    },
    filename: function (req, file, cb) {
        const randomName = RANDOM_STRING(30);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${randomName}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.zip', '.rar'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});

// Helper function to get file as base64
function getFileAsBase64(filepath) {
    try {
        if (fs.existsSync(filepath)) {
            const fileBuffer = fs.readFileSync(filepath);
            const mimeType = getMimeType(path.extname(filepath));
            return `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
        }
        return null;
    } catch (error) {
        console.error('Error reading file:', error);
        return null;
    }
}

// Helper function to get MIME type from extension
function getMimeType(ext) {
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed'
    };
    return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

// ==================== STAFF EXPENSE ROUTES ====================

// Create expense (supports staff_username in body for admin).
// Client uploads to upload.onesaas.in first, then passes public URL in attachment_url.
// Server downloads that URL and stores the file on B2 under media/expense/attachment/.
router.post('/create', auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    let uploadedB2Filename = null;

    try {
        let { item_id, description, amount, date, staff_username, attachment_url } = req.body || {};
        let staffUsername = req.headers["username"] || "";
        const actorUsername = staffUsername;
        const { branch_id } = req;

        // If staff_username is provided in body for another user, allow admin or finance_entry.
        let autoApprove = false;
        if (staff_username && staff_username.trim() !== '' && staff_username.trim() !== actorUsername) {
            const [adminCheck] = await conn.query(
                "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'admin' AND status = '1' AND is_deleted = '0'",
                [actorUsername, branch_id]
            );
            const isAdmin = adminCheck.length > 0;
            const canFinance = await checkUserPermission(actorUsername, branch_id, "finance_entry");

            if (!isAdmin && !canFinance) {
                return res.status(403).json({
                    success: false,
                    message: "Need admin or Finance Entry permission to create expense for other staff members"
                });
            }

            staffUsername = staff_username.trim();
            autoApprove = true;
        }

        if (!item_id || String(item_id).trim() === '') {
            return res.status(400).json({ success: false, message: "Expense item is required" });
        }
        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }
        const dateVal = toYmd(date);
        if (!dateVal) {
            return res.status(400).json({ success: false, message: "Date is required" });
        }

        const itemIdVal = String(item_id).trim();
        const item = await resolveIndirectExpenseItem(conn, branch_id, itemIdVal);
        if (!item) {
            return res.status(400).json({
                success: false,
                message: "Invalid expense item. Only indirect expense items are allowed."
            });
        }

        const [staffCheck] = await conn.query(
            "SELECT username FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'staff' AND status = '1' AND is_deleted = '0'",
            [staffUsername, branch_id]
        );

        if (staffCheck.length === 0) {
            return res.status(404).json({ success: false, message: "Staff member not found or inactive" });
        }

        let attachmentValue = null;
        const urlFromBody = attachment_url != null ? String(attachment_url).trim() : '';
        if (urlFromBody) {
            if (!/^https?:\/\//i.test(urlFromBody)) {
                return res.status(400).json({
                    success: false,
                    message: "attachment_url must be a public http(s) URL from the upload service",
                });
            }
            try {
                const uploaded = await downloadAndUploadExpenseAttachment(urlFromBody);
                attachmentValue = uploaded.filename;
                uploadedB2Filename = uploaded.filename;
            } catch (uploadErr) {
                return res.status(400).json({
                    success: false,
                    message: `Failed to store attachment: ${uploadErr.message}`,
                });
            }
        }

        await conn.beginTransaction();

        const expense_id = await UNIQUE_RANDOM_STRING("staff_expenses", "expense_id", { conn, length: ID_LENGTH });
        const amountNum = Number(Number(amount).toFixed(2));
        const descriptionVal = description != null && String(description).trim() !== ''
            ? String(description).trim()
            : '';
        const titleVal = item.name;

        await conn.query(
            `INSERT INTO staff_expenses (
                expense_id, branch_id, staff_username, title, description, item_id,
                amount, expense_date, attachment, status, create_by, modify_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`,
            [
                expense_id, branch_id, staffUsername, titleVal,
                descriptionVal, itemIdVal, amountNum, dateVal, attachmentValue,
                actorUsername, actorUsername
            ]
        );

        let statusOut = "pending";
        let transaction_id = null;
        let linked_expense_id = null;
        let invoice_no = null;

        if (autoApprove) {
            const approved = await approvePendingStaffExpense(conn, {
                expense: {
                    expense_id,
                    staff_username: staffUsername,
                    item_id: itemIdVal,
                    amount: amountNum,
                    expense_date: dateVal,
                    title: titleVal,
                    description: descriptionVal,
                },
                branch_id,
                actorUsername,
                remarks: descriptionVal || null,
            });
            statusOut = "approved";
            transaction_id = approved.transaction_id;
            linked_expense_id = approved.linked_expense_id;
            invoice_no = approved.invoice_no;
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: autoApprove
                ? "Expense created and approved. Staff ledger credited."
                : "Expense submitted successfully. Awaiting finance approval.",
            data: {
                expense_id,
                staff_username: staffUsername,
                title: titleVal,
                item_id: itemIdVal,
                item_name: item.name,
                description: descriptionVal,
                amount: amountNum,
                date: dateVal,
                status: statusOut,
                attachment_url: resolveAttachmentUrl(attachmentValue),
                transaction_id: transaction_id || undefined,
                linked_expense_id: linked_expense_id || undefined,
                invoice_no: invoice_no || undefined,
            }
        });

    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        if (uploadedB2Filename) {
            try { await deleteExpenseAttachment(uploadedB2Filename); } catch (_) {}
        }

        console.error('Error creating staff expense:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to create expense",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

// Get expenses for a specific staff member (with base64 preview)
router.get('/list/:username', auth, validateBranch, async (req, res) => {
    try {
        const { username } = req.params;
        const { branch_id } = req;
        const { search, status, from_date, to_date, page = 1, limit = 20 } = req.query;

        if (!username || username.trim() === '') {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;
        const fromDateVal = from_date ? toYmd(from_date) : null;
        const toDateVal = to_date ? toYmd(to_date) : null;

        let query = `
            SELECT 
                se.expense_id,
                se.title,
                se.description,
                se.item_id,
                ei.name AS item_name,
                ei.type AS item_type,
                se.amount,
                se.expense_date,
                se.attachment,
                se.status,
                se.create_date,
                se.approved_by,
                se.approved_date,
                se.transaction_id,
                se.linked_expense_id,
                se.remarks,
                CASE 
                    WHEN se.status = '0' THEN 'pending'
                    WHEN se.status = '1' THEN 'approved'
                    WHEN se.status = '2' THEN 'rejected'
                END as status_text
            FROM staff_expenses se
            LEFT JOIN expense_items ei
              ON ei.item_id = se.item_id
             AND ei.is_deleted = '0'
             AND (ei.branch_id IS NULL OR ei.branch_id = se.branch_id)
            WHERE se.branch_id = ? AND se.staff_username = ? AND se.is_deleted = '0'
        `;

        const queryParams = [branch_id, username];

        if (search && search.trim() !== '') {
            const searchPattern = `%${search.trim()}%`;
            query += ` AND (se.title LIKE ? OR se.description LIKE ? OR ei.name LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        if (status !== undefined && status !== '') {
            query += ` AND se.status = ?`;
            queryParams.push(status);
        }

        if (fromDateVal) {
            query += ` AND se.expense_date >= ?`;
            queryParams.push(fromDateVal);
        }

        if (toDateVal) {
            query += ` AND se.expense_date <= ?`;
            queryParams.push(toDateVal);
        }

        const countQuery = query.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM');
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = countResult[0]?.total || 0;

        query += ` ORDER BY se.id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        // Transform rows with optional local base64 preview
        const transformedRows = [];
        for (const row of rows) {
            let attachmentBase64 = null;
            if (row.attachment && !/^https?:\/\//i.test(String(row.attachment))) {
                const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, row.attachment);
                attachmentBase64 = getFileAsBase64(filePath);
            }
            
            transformedRows.push({
                ...row,
                title: row.item_name || row.title,
                attachment_base64: attachmentBase64,
                attachment_url: resolveAttachmentUrl(row.attachment),
            });
        }

        // Summary for same staff + date range (status filter does not apply to cards)
        let summarySql = `
            SELECT 
                COUNT(*) as total_expenses,
                SUM(CASE WHEN status = '0' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END) as approved_count,
                SUM(CASE WHEN status = '2' THEN 1 ELSE 0 END) as rejected_count,
                SUM(amount) as total_amount,
                SUM(CASE WHEN status = '1' THEN amount ELSE 0 END) as total_approved_amount,
                SUM(CASE WHEN status = '0' THEN amount ELSE 0 END) as total_pending_amount,
                SUM(CASE WHEN status = '2' THEN amount ELSE 0 END) as total_rejected_amount
             FROM staff_expenses 
             WHERE branch_id = ? AND staff_username = ? AND is_deleted = '0'`;
        const summaryParams = [branch_id, username];
        if (fromDateVal) {
            summarySql += ` AND expense_date >= ?`;
            summaryParams.push(fromDateVal);
        }
        if (toDateVal) {
            summarySql += ` AND expense_date <= ?`;
            summaryParams.push(toDateVal);
        }
        const [summaryRows] = await pool.query(summarySql, summaryParams);

        return res.status(200).json({
            success: true,
            message: "Staff expenses retrieved successfully",
            data: transformedRows,
            summary: summaryRows[0] || {},
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error('Error fetching staff expenses:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch expenses",
            error: error.message
        });
    }
});

// Get all expenses for admin (with base64 preview)
router.get('/admin-list', auth, validateBranch, async (req, res) => {
    try {
        const { branch_id } = req;
        const { search, status, staff_username, from_date, to_date, page = 1, limit = 20 } = req.query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;

        let query = `
            SELECT 
                se.expense_id,
                se.staff_username,
                se.title,
                se.description,
                se.item_id,
                ei.name AS item_name,
                ei.type AS item_type,
                se.amount,
                se.expense_date,
                se.attachment,
                se.status,
                se.create_date,
                se.approved_by,
                se.approved_date,
                se.transaction_id,
                se.linked_expense_id,
                se.remarks,
                p.name as staff_name,
                p.email as staff_email,
                p.mobile as staff_mobile,
                p.country_code as staff_country_code,
                ap.name as approved_by_name,
                ap.mobile as approved_by_mobile,
                ap.country_code as approved_by_country_code,
                CASE 
                    WHEN se.status = '0' THEN 'pending'
                    WHEN se.status = '1' THEN 'approved'
                    WHEN se.status = '2' THEN 'rejected'
                END as status_text
            FROM staff_expenses se
            LEFT JOIN expense_items ei
              ON ei.item_id = se.item_id
             AND ei.is_deleted = '0'
             AND (ei.branch_id IS NULL OR ei.branch_id = se.branch_id)
            LEFT JOIN profile p ON se.staff_username = p.username
            LEFT JOIN profile ap ON se.approved_by = ap.username
            WHERE se.branch_id = ? AND se.is_deleted = '0'
        `;

        const queryParams = [branch_id];

        if (search && search.trim() !== '') {
            const searchPattern = `%${search.trim()}%`;
            query += ` AND (se.title LIKE ? OR se.description LIKE ? OR ei.name LIKE ? OR p.name LIKE ? OR p.email LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
        }

        if (status !== undefined && status !== '') {
            query += ` AND se.status = ?`;
            queryParams.push(status);
        }

        if (staff_username && staff_username.trim() !== '') {
            query += ` AND se.staff_username = ?`;
            queryParams.push(staff_username);
        }

        if (from_date && from_date.trim() !== '') {
            query += ` AND se.expense_date >= ?`;
            queryParams.push(from_date);
        }

        if (to_date && to_date.trim() !== '') {
            query += ` AND se.expense_date <= ?`;
            queryParams.push(to_date);
        }

        const countQuery = query.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM');
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = countResult[0]?.total || 0;

        query += ` ORDER BY se.id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        // Transform rows with optional local base64 preview
        const transformedRows = [];
        for (const row of rows) {
            let attachmentBase64 = null;
            if (row.attachment && !/^https?:\/\//i.test(String(row.attachment))) {
                const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, row.attachment);
                attachmentBase64 = getFileAsBase64(filePath);
            }
            
            transformedRows.push({
                ...row,
                attachment_base64: attachmentBase64,
                attachment_url: resolveAttachmentUrl(row.attachment),
            });
        }

        // Get summary
        const [summaryRows] = await pool.query(
            `SELECT 
                COUNT(*) as total_expenses,
                SUM(CASE WHEN status = '0' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END) as approved_count,
                SUM(CASE WHEN status = '2' THEN 1 ELSE 0 END) as rejected_count,
                SUM(CASE WHEN status = '1' THEN amount ELSE 0 END) as total_approved_amount,
                SUM(CASE WHEN status = '0' THEN amount ELSE 0 END) as total_pending_amount
             FROM staff_expenses 
             WHERE branch_id = ? AND is_deleted = '0'`,
            [branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "All expenses retrieved successfully",
            data: transformedRows,
            summary: summaryRows[0] || {},
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error('Error fetching all expenses:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch expenses",
            error: error.message
        });
    }
});

// Get single expense details with base64 preview
router.get('/details/:expense_id', auth, validateBranch, async (req, res) => {
    try {
        const { expense_id } = req.params;
        const { branch_id } = req;

        if (!expense_id || expense_id.trim() === '') {
            return res.status(400).json({ success: false, message: "Expense ID is required" });
        }

        const [rows] = await pool.query(
            `SELECT 
                se.*,
                ei.name AS item_name,
                p.name as staff_name,
                p.email as staff_email,
                p.mobile as staff_mobile,
                p.image as staff_image,
                ap.name as approved_by_name,
                ap.email as approved_by_email
             FROM staff_expenses se
             LEFT JOIN expense_items ei
               ON ei.item_id = se.item_id
              AND ei.is_deleted = '0'
              AND (ei.branch_id IS NULL OR ei.branch_id = se.branch_id)
             LEFT JOIN profile p ON se.staff_username = p.username
             LEFT JOIN profile ap ON se.approved_by = ap.username
             WHERE se.expense_id = ? AND se.branch_id = ? AND se.is_deleted = '0'`,
            [expense_id.trim(), branch_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Expense not found" });
        }

        const expense = rows[0];
        
        // Attachment: public URL (OneSaaS) or legacy local filename
        const attachmentUrl = resolveAttachmentUrl(expense.attachment);
        let attachmentBase64 = null;
        if (expense.attachment && !/^https?:\/\//i.test(String(expense.attachment))) {
            const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, expense.attachment);
            attachmentBase64 = getFileAsBase64(filePath);
        }

        expense.attachment_base64 = attachmentBase64;
        expense.attachment_url = attachmentUrl;
        
        expense.staff_image_url = expense.staff_image
            ? buildProfileImageUrl(expense.staff_image)
            : null;
        
        expense.status_text = expense.status === '0' ? 'pending' : 
                             expense.status === '1' ? 'approved' : 'rejected';

        return res.status(200).json({
            success: true,
            message: "Expense details retrieved successfully",
            data: expense
        });

    } catch (error) {
        console.error('Error fetching expense details:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch expense details",
            error: error.message
        });
    }
});

// Download attachment file
router.get('/download/:filename', auth, validateBranch, async (req, res) => {
    try {
        const { filename } = req.params;
        const { branch_id } = req;
        
        // Verify the file belongs to an expense in this branch
        const [expenseRow] = await pool.query(
            "SELECT attachment FROM staff_expenses WHERE attachment = ? AND branch_id = ? AND is_deleted = '0'",
            [filename, branch_id]
        );
        
        if (expenseRow.length === 0) {
            return res.status(404).json({ success: false, message: "File not found" });
        }
        
        const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: "File not found on server" });
        }
        
        const mimeType = getMimeType(path.extname(filename));
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        console.error('Error downloading file:', error);
        return res.status(500).json({ success: false, message: "Failed to download file" });
    }
});

// Verify/Approve/Reject expense (finance_entry permission)
router.post('/verify', auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const { expense_id, action, remarks } = req.body;
        const adminUsername = req.headers["username"] || "";
        const { branch_id } = req;

        if (!expense_id || String(expense_id).trim() === '') {
            return res.status(400).json({ success: false, message: "Expense ID is required" });
        }

        if (!action || !['approve', 'reject'].includes(String(action).toLowerCase())) {
            return res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'" });
        }

        const canFinance = await checkUserPermission(adminUsername, branch_id, "finance_entry");
        if (!canFinance) {
            return res.status(403).json({
                success: false,
                message: "Need Finance Entry permission to approve or reject staff expenses"
            });
        }

        const isApproved = String(action).toLowerCase() === 'approve';
        const newStatus = isApproved ? '1' : '2';

        await conn.beginTransaction();

        const [expenseRows] = await conn.query(
            `SELECT * FROM staff_expenses 
             WHERE expense_id = ? AND branch_id = ? AND is_deleted = '0'
             FOR UPDATE`,
            [String(expense_id).trim(), branch_id]
        );

        if (expenseRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: "Expense not found" });
        }

        const expense = expenseRows[0];

        if (expense.status !== '0') {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: `Expense has already been ${expense.status === '1' ? 'approved' : 'rejected'}`
            });
        }

        let transaction_id = null;
        let linked_expense_id = null;
        let invoice_no = null;

        if (isApproved) {
            try {
                const approved = await approvePendingStaffExpense(conn, {
                    expense,
                    branch_id,
                    actorUsername: adminUsername,
                    remarks: remarks || null,
                });
                transaction_id = approved.transaction_id;
                linked_expense_id = approved.linked_expense_id;
                invoice_no = approved.invoice_no;
            } catch (approveErr) {
                await conn.rollback();
                const status = approveErr.statusCode || 500;
                return res.status(status).json({
                    success: false,
                    message: approveErr.message || "Failed to approve expense",
                });
            }
        } else {
            await conn.query(
                `UPDATE staff_expenses 
                 SET status = ?, approved_by = ?, approved_date = NOW(), modify_by = ?,
                     modify_date = NOW(), remarks = ?
                 WHERE expense_id = ? AND branch_id = ?`,
                [
                    newStatus,
                    adminUsername,
                    adminUsername,
                    remarks || null,
                    String(expense_id).trim(),
                    branch_id,
                ]
            );
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: isApproved
                ? "Expense approved: expense entry created and staff ledger credited"
                : "Expense rejected",
            data: {
                expense_id: String(expense_id).trim(),
                status: isApproved ? "approved" : "rejected",
                transaction_id: transaction_id || undefined,
                linked_expense_id: linked_expense_id || undefined,
                invoice_no: invoice_no || undefined,
            }
        });

    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        console.error('Error verifying expense:', error);
        return res.status(500).json({ success: false, message: "Failed to verify expense", error: error.message });
    } finally {
        conn.release();
    }
});

// Delete expense
router.delete('/delete', auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const { expense_id } = req.body;
        const currentUsername = req.headers["username"] || "";
        const { branch_id } = req;

        if (!expense_id || expense_id.trim() === '') {
            return res.status(400).json({ success: false, message: "Expense ID is required" });
        }

        const [expenseRows] = await conn.query(
            "SELECT status, staff_username, attachment FROM staff_expenses WHERE expense_id = ? AND branch_id = ? AND is_deleted = '0'",
            [expense_id.trim(), branch_id]
        );

        if (expenseRows.length === 0) {
            return res.status(404).json({ success: false, message: "Expense not found" });
        }

        const expense = expenseRows[0];

        if (expense.status !== '0') {
            return res.status(400).json({ success: false, message: "Only pending expenses can be deleted" });
        }

        const isOwner = currentUsername === expense.staff_username;
        
        let isAdmin = false;
        if (!isOwner) {
            const [adminCheck] = await conn.query(
                "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'admin' AND status = '1' AND is_deleted = '0'",
                [currentUsername, branch_id]
            );
            isAdmin = adminCheck.length > 0;
        }

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, message: "You don't have permission to delete this expense" });
        }

        await conn.query(
            "UPDATE staff_expenses SET is_deleted = '1', modify_by = ?, modify_date = NOW() WHERE expense_id = ? AND branch_id = ?",
            [currentUsername, expense_id.trim(), branch_id]
        );

        return res.status(200).json({ success: true, message: "Expense deleted successfully" });

    } catch (error) {
        console.error('Error deleting expense:', error);
        return res.status(500).json({ success: false, message: "Failed to delete expense", error: error.message });
    } finally {
        conn.release();
    }
});

// Get expense summary
router.get('/summary', auth, validateBranch, async (req, res) => {
    try {
        const { branch_id } = req;
        const { staff_username } = req.query;
        const currentUsername = req.headers["username"] || "";

        let query = `
            SELECT 
                COUNT(*) as total_expenses,
                SUM(CASE WHEN status = '0' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END) as approved,
                SUM(CASE WHEN status = '2' THEN 1 ELSE 0 END) as rejected,
                SUM(CASE WHEN status = '1' THEN amount ELSE 0 END) as total_approved_amount,
                SUM(CASE WHEN status = '0' THEN amount ELSE 0 END) as total_pending_amount
            FROM staff_expenses 
            WHERE branch_id = ? AND is_deleted = '0'
        `;
        
        const params = [branch_id];
        
        if (staff_username && staff_username.trim() !== '') {
            query += ` AND staff_username = ?`;
            params.push(staff_username);
        } else {
            const [adminCheck] = await pool.query(
                "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'admin' AND status = '1' AND is_deleted = '0'",
                [currentUsername, branch_id]
            );
            
            if (adminCheck.length === 0) {
                query += ` AND staff_username = ?`;
                params.push(currentUsername);
            }
        }

        const [rows] = await pool.query(query, params);
        const summary = rows[0] || {};

        const [monthlyRows] = await pool.query(
            `SELECT 
                DATE_FORMAT(expense_date, '%Y-%m') as month,
                COUNT(*) as count,
                SUM(amount) as total_amount,
                SUM(CASE WHEN status = '1' THEN amount ELSE 0 END) as approved_amount
             FROM staff_expenses 
             WHERE branch_id = ? AND is_deleted = '0'
             GROUP BY DATE_FORMAT(expense_date, '%Y-%m')
             ORDER BY month DESC
             LIMIT 12`,
            [branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Expense summary retrieved successfully",
            data: {
                total_expenses: Number(summary.total_expenses) || 0,
                pending: Number(summary.pending) || 0,
                approved: Number(summary.approved) || 0,
                rejected: Number(summary.rejected) || 0,
                total_approved_amount: Number(summary.total_approved_amount) || 0,
                total_pending_amount: Number(summary.total_pending_amount) || 0,
                monthly_breakdown: monthlyRows || []
            }
        });

    } catch (error) {
        console.error('Error fetching expense summary:', error);
        return res.status(500).json({ success: false, message: "Failed to fetch expense summary", error: error.message });
    }
});

export default router;