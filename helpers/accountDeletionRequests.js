import pool from "../db.js";
import { FORMAT_DATE, UNIQUE_RANDOM_STRING } from "./function.js";

const STATUSES = ["pending", "in_review", "completed", "rejected"];

let tableReady = null;

export function isDeletionStatus(value) {
    return STATUSES.includes(String(value || "").trim().toLowerCase());
}

export async function ensureAccountDeletionTable() {
    if (!tableReady) {
        tableReady = pool.query(`
            CREATE TABLE IF NOT EXISTS account_deletion_requests (
                id INT AUTO_INCREMENT PRIMARY KEY,
                request_id VARCHAR(20) NOT NULL,
                name VARCHAR(150) NOT NULL,
                email VARCHAR(190) NOT NULL,
                mobile VARCHAR(20) NOT NULL,
                username VARCHAR(100) NULL,
                reason TEXT NULL,
                status ENUM('pending','in_review','completed','rejected') NOT NULL DEFAULT 'pending',
                admin_remark TEXT NULL,
                create_ip VARCHAR(64) NULL,
                create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                reviewed_by VARCHAR(100) NULL,
                reviewed_date DATETIME NULL,
                UNIQUE KEY uk_account_deletion_request_id (request_id),
                KEY idx_account_deletion_status (status),
                KEY idx_account_deletion_email (email)
            )
        `).catch((error) => {
            tableReady = null;
            throw error;
        });
    }
    await tableReady;
}

function serialize(row) {
    return {
        request_id: row.request_id,
        name: row.name,
        email: row.email,
        mobile: row.mobile,
        username: row.username || "",
        reason: row.reason || "",
        status: row.status,
        admin_remark: row.admin_remark || "",
        create_ip: row.create_ip || "",
        create_date: FORMAT_DATE(row.create_date),
        reviewed_by: row.reviewed_by || "",
        reviewed_date: row.reviewed_date ? FORMAT_DATE(row.reviewed_date) : null,
    };
}

export async function createAccountDeletionRequest({
    name,
    email,
    mobile,
    username,
    reason,
    create_ip,
}) {
    await ensureAccountDeletionTable();
    const request_id = await UNIQUE_RANDOM_STRING(
        "account_deletion_requests",
        "request_id",
        { length: 10 }
    );

    await pool.query(
        `INSERT INTO account_deletion_requests
            (request_id, name, email, mobile, username, reason, status, create_ip, create_date)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)`,
        [
            request_id,
            name,
            email,
            mobile,
            username || null,
            reason || null,
            create_ip || null,
        ]
    );

    const [rows] = await pool.query(
        `SELECT * FROM account_deletion_requests WHERE request_id = ? LIMIT 1`,
        [request_id]
    );
    return serialize(rows[0]);
}

export async function listAccountDeletionRequests({
    status = "",
    search = "",
    page_no = 1,
    limit = 20,
} = {}) {
    await ensureAccountDeletionTable();
    const page = Math.max(1, Number(page_no) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];

    if (status && status !== "all" && isDeletionStatus(status)) {
        where.push("status = ?");
        params.push(status);
    }

    const term = String(search || "").trim();
    if (term) {
        const like = `%${term}%`;
        where.push("(name LIKE ? OR email LIKE ? OR mobile LIKE ? OR username LIKE ? OR request_id LIKE ?)");
        params.push(like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM account_deletion_requests ${whereSql}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT * FROM account_deletion_requests
         ${whereSql}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );

    const totalCount = Number(total) || 0;
    return {
        data: rows.map(serialize),
        pagination: {
            page_no: page,
            limit: pageSize,
            total: totalCount,
            total_pages: Math.ceil(totalCount / pageSize) || 0,
        },
    };
}

export async function updateAccountDeletionRequest(requestId, { status, admin_remark, reviewed_by }) {
    await ensureAccountDeletionTable();
    const [existing] = await pool.query(
        `SELECT request_id FROM account_deletion_requests WHERE request_id = ? LIMIT 1`,
        [requestId]
    );
    if (!existing.length) return null;

    await pool.query(
        `UPDATE account_deletion_requests
         SET status = ?,
             admin_remark = ?,
             reviewed_by = ?,
             reviewed_date = CURRENT_TIMESTAMP
         WHERE request_id = ?`,
        [status, admin_remark || null, reviewed_by || null, requestId]
    );

    const [rows] = await pool.query(
        `SELECT * FROM account_deletion_requests WHERE request_id = ? LIMIT 1`,
        [requestId]
    );
    return serialize(rows[0]);
}
