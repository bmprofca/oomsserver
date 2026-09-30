import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { FORMAT_DATE } from "../helpers/function.js";
import { ensureWalletPaymentTables } from "../helpers/walletPaymentConfig.js";
import { ensureAccountDeletionTable } from "../helpers/accountDeletionRequests.js";

const router = express.Router();

async function scalar(sql, params = []) {
    const [[row]] = await pool.query(sql, params);
    return row || {};
}

function displayMobile(profileMobile, tokenMobile) {
    const digits = String(profileMobile || tokenMobile || "").replace(/\D/g, "");
    if (!digits) return "";
    return digits.length > 10 ? digits.slice(-10) : digits;
}

router.get("/", authAdmin, async (_req, res) => {
    try {
        await ensureWalletPaymentTables();
        try {
            await ensureAccountDeletionTable();
        } catch (error) {
            console.error("DASHBOARD deletion table:", error.message);
        }

        const clients = await scalar(`
            SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN u.status = '1' THEN 1 ELSE 0 END), 0) AS active
            FROM users u
            INNER JOIN profile p ON p.username = u.username
                AND p.status = '1'
                AND p.user_type = 'user'
        `);

        const branches = await scalar(`
            SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS active
            FROM branch_list
            WHERE is_deleted = '0'
        `);

        const services = await scalar(`SELECT COUNT(*) AS total FROM services`);

        const payments = await scalar(`
            SELECT
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pending_amount
            FROM wallet_payment_requests
        `);

        let deletionPending = 0;
        try {
            const deletions = await scalar(`
                SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
                FROM account_deletion_requests
            `);
            deletionPending = Number(deletions.pending) || 0;
        } catch (_) {
            deletionPending = 0;
        }

        const logins = await scalar(`
            SELECT
                COALESCE(SUM(CASE WHEN DATE(create_date) = CURDATE() THEN 1 ELSE 0 END), 0) AS today,
                COALESCE(SUM(CASE WHEN create_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) THEN 1 ELSE 0 END), 0) AS last_7_days,
                COALESCE(SUM(CASE WHEN status = '1' AND (expire_date IS NULL OR expire_date >= NOW()) THEN 1 ELSE 0 END), 0) AS active_sessions
            FROM tokens
        `);

        let activeMail = null;
        let mailConfigs = 0;
        try {
            const mail = await scalar(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN LOWER(status) = 'active' THEN 1 ELSE 0 END) AS active_count
                FROM email_company_smtp_config
            `);
            mailConfigs = Number(mail.total) || 0;
            if (Number(mail.active_count) > 0) {
                const row = await scalar(`
                    SELECT config_name, host
                    FROM email_company_smtp_config
                    WHERE LOWER(status) = 'active'
                    ORDER BY id DESC
                    LIMIT 1
                `);
                activeMail = {
                    config_name: row.config_name || "",
                    host: row.host || "",
                };
            }
        } catch (_) {
            activeMail = null;
        }

        return res.status(200).json({
            success: true,
            message: "Dashboard retrieved",
            data: {
                stats: {
                    clients: {
                        total: Number(clients.total) || 0,
                        active: Number(clients.active) || 0,
                    },
                    branches: {
                        total: Number(branches.total) || 0,
                        active: Number(branches.active) || 0,
                    },
                    services: { total: Number(services.total) || 0 },
                    payments: {
                        pending_count: Number(payments.pending_count) || 0,
                        pending_amount: Number(payments.pending_amount) || 0,
                    },
                    deletions: { pending: deletionPending },
                    logins: {
                        today: Number(logins.today) || 0,
                        last_7_days: Number(logins.last_7_days) || 0,
                        active_sessions: Number(logins.active_sessions) || 0,
                    },
                    mail: {
                        configs: mailConfigs,
                        active: activeMail,
                    },
                },
            },
        });
    } catch (error) {
        console.error("ADMIN DASHBOARD ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load dashboard",
        });
    }
});

router.get("/login-activity", authAdmin, async (req, res) => {
    try {
        const pageNo = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
        const offset = (pageNo - 1) * limit;
        const status = ["active", "ended"].includes(String(req.query.status || "").toLowerCase())
            ? String(req.query.status).toLowerCase()
            : "all";
        const search = String(req.query.search || "").trim().slice(0, 100);

        const filters = [];
        const params = [];

        if (status === "active") {
            filters.push("t.status = '1' AND (t.expire_date IS NULL OR t.expire_date >= NOW())");
        } else if (status === "ended") {
            filters.push("(t.status <> '1' OR (t.expire_date IS NOT NULL AND t.expire_date < NOW()))");
        }

        if (search) {
            const like = `%${search}%`;
            filters.push(`(
                p.name LIKE ?
                OR p.mobile LIKE ?
                OR p.email LIKE ?
                OR p.user_type LIKE ?
                OR t.mobile LIKE ?
                OR t.create_ip LIKE ?
                OR t.last_ip LIKE ?
                OR t.login_method LIKE ?
            )`);
            params.push(like, like, like, like, like, like, like, like);
        }

        const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const fromSql = `
            FROM tokens t
            LEFT JOIN profile p ON p.username = t.username AND p.status = '1'
            ${whereSql}
        `;

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${fromSql}`,
            params
        );

        const [rows] = await pool.query(
            `SELECT
                t.token_id,
                t.create_ip,
                t.last_ip,
                t.login_method,
                t.status,
                t.create_date,
                t.last_used_date,
                t.expire_date,
                t.mobile AS token_mobile,
                p.name,
                p.email,
                p.mobile,
                p.user_type
            ${fromSql}
            ORDER BY t.id DESC
            LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const now = new Date();
        const data = rows.map((row) => {
            const expireDate = row.expire_date ? new Date(row.expire_date) : null;
            const expired = expireDate ? expireDate < now : false;
            const active = row.status === "1" && !expired;
            return {
                token_id: row.token_id,
                name: row.name || "—",
                mobile: displayMobile(row.mobile, row.token_mobile),
                email: row.email || "",
                user_type: row.user_type || "",
                login_method: row.login_method || "",
                create_ip: row.create_ip || "",
                last_ip: row.last_ip || "",
                create_date: FORMAT_DATE(row.create_date),
                last_used_date: FORMAT_DATE(row.last_used_date),
                expire_date: FORMAT_DATE(row.expire_date),
                active,
            };
        });

        const totalCount = Number(total) || 0;

        return res.status(200).json({
            success: true,
            message: "Login activity retrieved",
            data,
            pagination: {
                page_no: pageNo,
                limit,
                total: totalCount,
                total_pages: Math.ceil(totalCount / limit) || 0,
                has_more: offset + rows.length < totalCount,
            },
        });
    } catch (error) {
        console.error("ADMIN LOGIN ACTIVITY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load login activity",
        });
    }
});

export default router;
