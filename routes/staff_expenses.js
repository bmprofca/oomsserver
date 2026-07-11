import express from 'express';
const router = express.Router();

import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE, RANDOM_STRING, UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import { BASE_DOMAIN } from '../helpers/Config.js';
import multer from 'multer';
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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

// Create expense (supports staff_username in body for admin)
router.post('/create', auth, validateBranch, upload.single('attachment'), async (req, res) => {
    const conn = await pool.getConnection();
    let savedFilename = null;

    try {
        let { title, description, amount, date, staff_username } = req.body;
        let staffUsername = req.headers["username"] || "";
        const { branch_id } = req;
        
        // If staff_username is provided in body, use it (admin creating for staff)
        // Otherwise use the logged-in username from headers
        if (staff_username && staff_username.trim() !== '') {
            // Verify the logged-in user is admin
            const [adminCheck] = await conn.query(
                "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'admin' AND status = '1' AND is_deleted = '0'",
                [staffUsername, branch_id]
            );
            
            if (adminCheck.length === 0) {
                return res.status(403).json({ 
                    success: false, 
                    message: "Only admins can create expense for other staff members" 
                });
            }
            
            // Use the staff_username from body
            staffUsername = staff_username.trim();
        }

        // Validate required fields
        if (!title || title.trim() === '') {
            return res.status(400).json({ success: false, message: "Title is required" });
        }
        if (!description || description.trim() === '') {
            return res.status(400).json({ success: false, message: "Description is required" });
        }
        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }
        if (!date || date.trim() === '') {
            return res.status(400).json({ success: false, message: "Date is required" });
        }

        // Verify staff exists and belongs to this branch
        const [staffCheck] = await conn.query(
            "SELECT username FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'staff' AND status = '1' AND is_deleted = '0'",
            [staffUsername, branch_id]
        );

        if (staffCheck.length === 0) {
            return res.status(404).json({ success: false, message: "Staff member not found or inactive" });
        }

        // Get saved filename from multer
        if (req.file) {
            savedFilename = req.file.filename;
        }

        await conn.beginTransaction();

        const expense_id = await UNIQUE_RANDOM_STRING("staff_expenses", "expense_id", { conn });
        const amountNum = Number(amount);

        await conn.query(
            `INSERT INTO staff_expenses (
                expense_id, branch_id, staff_username, title, description, 
                amount, expense_date, attachment, status, create_by, modify_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`,
            [
                expense_id, branch_id, staffUsername, title.trim(), 
                description.trim(), amountNum, date.trim(), savedFilename, 
                staffUsername, staffUsername
            ]
        );

        await conn.commit();

        // Get base64 for preview if file was uploaded
        let attachmentBase64 = null;
        if (savedFilename) {
            const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, savedFilename);
            attachmentBase64 = getFileAsBase64(filePath);
        }

        return res.status(200).json({
            success: true,
            message: "Expense submitted successfully. Awaiting admin approval.",
            data: {
                expense_id,
                staff_username: staffUsername,
                title,
                amount: amountNum,
                date,
                status: "pending",
                attachment_filename: savedFilename,
                attachment_base64: attachmentBase64,
                attachment_url: savedFilename ? `${BASE_DOMAIN}/media/expense/attachment/${savedFilename}` : null
            }
        });

    } catch (error) {
        await conn.rollback();
        
        if (savedFilename) {
            try {
                const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, savedFilename);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (cleanupError) {
                console.error('Error cleaning up attachment:', cleanupError);
            }
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
        const { search, status, page = 1, limit = 20 } = req.query;

        if (!username || username.trim() === '') {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;

        let query = `
            SELECT 
                expense_id,
                title,
                description,
                amount,
                expense_date,
                attachment,
                status,
                create_date,
                approved_by,
                approved_date,
                transaction_id,
                remarks,
                CASE 
                    WHEN status = '0' THEN 'pending'
                    WHEN status = '1' THEN 'approved'
                    WHEN status = '2' THEN 'rejected'
                END as status_text
            FROM staff_expenses 
            WHERE branch_id = ? AND staff_username = ? AND is_deleted = '0'
        `;

        const queryParams = [branch_id, username];

        if (search && search.trim() !== '') {
            const searchPattern = `%${search.trim()}%`;
            query += ` AND (title LIKE ? OR description LIKE ?)`;
            queryParams.push(searchPattern, searchPattern);
        }

        if (status !== undefined && status !== '') {
            query += ` AND status = ?`;
            queryParams.push(status);
        }

        const countQuery = query.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM');
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = countResult[0]?.total || 0;

        query += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        // Transform rows with base64 preview
        const transformedRows = [];
        for (const row of rows) {
            let attachmentBase64 = null;
            if (row.attachment) {
                const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, row.attachment);
                attachmentBase64 = getFileAsBase64(filePath);
            }
            
            transformedRows.push({
                ...row,
                attachment_base64: attachmentBase64,
                attachment_url: row.attachment ? `${BASE_DOMAIN}/media/expense/attachment/${row.attachment}` : null
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
             WHERE branch_id = ? AND staff_username = ? AND is_deleted = '0'`,
            [branch_id, username]
        );

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
                se.amount,
                se.expense_date,
                se.attachment,
                se.status,
                se.create_date,
                se.approved_by,
                se.approved_date,
                se.transaction_id,
                se.remarks,
                p.name as staff_name,
                p.email as staff_email,
                p.mobile as staff_mobile,
                CASE 
                    WHEN se.status = '0' THEN 'pending'
                    WHEN se.status = '1' THEN 'approved'
                    WHEN se.status = '2' THEN 'rejected'
                END as status_text
            FROM staff_expenses se
            LEFT JOIN profile p ON se.staff_username = p.username
            WHERE se.branch_id = ? AND se.is_deleted = '0'
        `;

        const queryParams = [branch_id];

        if (search && search.trim() !== '') {
            const searchPattern = `%${search.trim()}%`;
            query += ` AND (se.title LIKE ? OR se.description LIKE ? OR p.name LIKE ? OR p.email LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
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

        // Transform rows with base64 preview
        const transformedRows = [];
        for (const row of rows) {
            let attachmentBase64 = null;
            if (row.attachment) {
                const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, row.attachment);
                attachmentBase64 = getFileAsBase64(filePath);
            }
            
            transformedRows.push({
                ...row,
                attachment_base64: attachmentBase64,
                attachment_url: row.attachment ? `${BASE_DOMAIN}/media/expense/attachment/${row.attachment}` : null
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
                p.name as staff_name,
                p.email as staff_email,
                p.mobile as staff_mobile,
                p.image as staff_image,
                ap.name as approved_by_name,
                ap.email as approved_by_email
             FROM staff_expenses se
             LEFT JOIN profile p ON se.staff_username = p.username
             LEFT JOIN profile ap ON se.approved_by = ap.username
             WHERE se.expense_id = ? AND se.branch_id = ? AND se.is_deleted = '0'`,
            [expense_id.trim(), branch_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Expense not found" });
        }

        const expense = rows[0];
        
        // Get attachment as base64
        let attachmentBase64 = null;
        if (expense.attachment) {
            const filePath = path.join(STAFF_EXPENSE_ATTACHMENT_DIR, expense.attachment);
            attachmentBase64 = getFileAsBase64(filePath);
        }
        
        expense.attachment_base64 = attachmentBase64;
        expense.attachment_url = expense.attachment ? 
            `${BASE_DOMAIN}/media/expense/attachment/${expense.attachment}` : null;
        
        expense.staff_image_url = expense.staff_image ? 
            `${BASE_DOMAIN}/media/profile/image/${expense.staff_image}` : null;
        
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

// Verify/Approve/Reject expense (Admin only)
router.post('/verify', auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const { expense_id, action, remarks } = req.body;
        const adminUsername = req.headers["username"] || "";
        const { branch_id } = req;

        if (!expense_id || expense_id.trim() === '') {
            return res.status(400).json({ success: false, message: "Expense ID is required" });
        }

        if (!action || !['approve', 'reject'].includes(action.toLowerCase())) {
            return res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'" });
        }

        const isApproved = action.toLowerCase() === 'approve';
        const newStatus = isApproved ? '1' : '2';

        await conn.beginTransaction();

        const [expenseRows] = await conn.query(
            `SELECT * FROM staff_expenses 
             WHERE expense_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [expense_id.trim(), branch_id]
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

        if (isApproved) {
            const amountNum = Number(expense.amount);
            const transactionId = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { conn });
            
            await conn.query(
                `INSERT INTO transactions (
                    branch_id, transaction_id, create_by, modify_by, transaction_date, 
                    amount, transaction_type, party1_type, party1_id, party2_type, party2_id, remark
                ) VALUES (?, ?, ?, ?, ?, ?, 'expense_approval', ?, ?, ?, ?, ?)`,
                [
                    branch_id, transactionId, adminUsername, adminUsername, expense.expense_date,
                    amountNum, 'branch', branch_id, 'employee', expense.staff_username,
                    `Expense approved: ${expense.title}`
                ]
            );
            transaction_id = transactionId;
        }

        await conn.query(
            `UPDATE staff_expenses 
             SET status = ?, approved_by = ?, approved_date = NOW(), modify_by = ?,
                 modify_date = NOW(), transaction_id = ?, remarks = ?
             WHERE expense_id = ? AND branch_id = ?`,
            [newStatus, adminUsername, adminUsername, transaction_id, remarks || null, expense_id.trim(), branch_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: isApproved ? "Expense approved and added to employee's ledger" : "Expense rejected",
            data: { expense_id: expense_id.trim(), status: isApproved ? "approved" : "rejected", transaction_id: transaction_id || undefined }
        });

    } catch (error) {
        await conn.rollback();
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