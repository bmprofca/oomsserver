import express from "express";
import crypto from "crypto";
import nodemailer from "nodemailer";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { encrypt, decrypt } from "../utils/smtpEncryption.js";
import { clearCompanySmtpCache } from "../helpers/Mail.js";

const router = express.Router();

function newConfigId() {
    return `cfg_${crypto.randomBytes(8).toString("hex")}`;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function sanitizeRow(row) {
    if (!row) return null;
    return {
        config_id: row.config_id,
        config_name: row.config_name,
        host: row.host,
        port: Number(row.port),
        secure: Number(row.secure) === 1,
        username: row.username,
        from_email: row.from_email,
        from_name: row.from_name || null,
        reply_to: row.reply_to || null,
        status: row.status,
        create_by: row.create_by,
        create_date: row.create_date,
        modify_by: row.modify_by,
        modify_date: row.modify_date,
        has_password: Boolean(row.password_encrypted),
    };
}

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

async function setOnlyActive(conn, config_id, username) {
    await conn.query(
        `UPDATE email_company_smtp_config
         SET status = 'inactive', modify_by = ?, modify_date = NOW()
         WHERE status = 'active' AND config_id <> ?`,
        [username, config_id]
    );
    await conn.query(
        `UPDATE email_company_smtp_config
         SET status = 'active', modify_by = ?, modify_date = NOW()
         WHERE config_id = ?`,
        [username, config_id]
    );
}

/** GET /admin/mail/config/list */
router.get("/config/list", authAdmin, async (req, res) => {
    try {
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";

        const params = [];
        let where = "";
        if (search) {
            where = `WHERE (
                config_name LIKE ? OR host LIKE ? OR username LIKE ?
                OR from_email LIKE ? OR from_name LIKE ? OR config_id LIKE ?
            )`;
            const sp = `%${search}%`;
            params.push(sp, sp, sp, sp, sp, sp);
        }

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM email_company_smtp_config ${where}`,
            params
        );

        const [rows] = await pool.query(
            `SELECT *
             FROM email_company_smtp_config
             ${where}
             ORDER BY FIELD(status, 'active') DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return res.status(200).json({
            success: true,
            message: "Company mail configs retrieved",
            data: rows.map(sanitizeRow),
            pagination: {
                page_no,
                limit,
                total: Number(total) || 0,
                total_pages: Math.ceil((Number(total) || 0) / limit) || 1,
                is_last_page: offset + rows.length >= (Number(total) || 0),
            },
        });
    } catch (error) {
        console.error("ADMIN MAIL CONFIG LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to list company mail configs",
            error: error.message,
        });
    }
});

/** GET /admin/mail/config/:config_id */
router.get("/config/:config_id", authAdmin, async (req, res) => {
    try {
        const config_id = String(req.params.config_id || "").trim();
        const [rows] = await pool.query(
            `SELECT * FROM email_company_smtp_config WHERE config_id = ? LIMIT 1`,
            [config_id]
        );
        if (!rows.length) {
            return res.status(404).json({ success: false, message: "Mail config not found" });
        }
        return res.status(200).json({
            success: true,
            data: sanitizeRow(rows[0]),
        });
    } catch (error) {
        console.error("ADMIN MAIL CONFIG DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch mail config",
            error: error.message,
        });
    }
});

/** POST /admin/mail/config/create */
router.post("/config/create", authAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const {
            config_name,
            host,
            port = 587,
            secure = 0,
            username,
            password,
            from_email,
            from_name = null,
            reply_to = null,
            status = "inactive",
        } = req.body || {};

        if (!config_name || !host || !port || !username || !password || !from_email) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "config_name, host, port, username, password, and from_email are required",
            });
        }
        if (!isValidEmail(from_email) || (reply_to && !isValidEmail(reply_to))) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Invalid from_email or reply_to",
            });
        }

        const nextStatus = String(status).toLowerCase() === "active" ? "active" : "inactive";
        const config_id = newConfigId();
        const usernameActor = actor(req);

        await conn.beginTransaction();
        await conn.query(
            `INSERT INTO email_company_smtp_config
            (config_id, config_name, host, port, secure, username, password_encrypted,
             from_email, from_name, reply_to, status, create_by, modify_by, create_date, modify_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                config_id,
                String(config_name).trim(),
                String(host).trim(),
                Number(port),
                Number(secure) ? 1 : 0,
                String(username).trim(),
                encrypt(password),
                String(from_email).trim().toLowerCase(),
                from_name ? String(from_name).trim() : null,
                reply_to ? String(reply_to).trim().toLowerCase() : null,
                nextStatus,
                usernameActor,
                usernameActor,
            ]
        );

        if (nextStatus === "active") {
            await setOnlyActive(conn, config_id, usernameActor);
        }

        await conn.commit();
        clearCompanySmtpCache();

        const [rows] = await pool.query(
            `SELECT * FROM email_company_smtp_config WHERE config_id = ? LIMIT 1`,
            [config_id]
        );

        return res.status(201).json({
            success: true,
            message: "Company mail config created",
            data: sanitizeRow(rows[0]),
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) { /* ignore */ }
        console.error("ADMIN MAIL CONFIG CREATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create mail config",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

/** PUT /admin/mail/config/edit */
router.put("/config/edit", authAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const {
            config_id,
            config_name,
            host,
            port,
            secure,
            username,
            password,
            from_email,
            from_name,
            reply_to,
            status,
        } = req.body || {};

        const id = String(config_id || "").trim();
        if (!id) {
            conn.release();
            return res.status(400).json({ success: false, message: "config_id is required" });
        }

        const [existing] = await conn.query(
            `SELECT * FROM email_company_smtp_config WHERE config_id = ? LIMIT 1`,
            [id]
        );
        if (!existing.length) {
            conn.release();
            return res.status(404).json({ success: false, message: "Mail config not found" });
        }

        if (from_email != null && !isValidEmail(from_email)) {
            conn.release();
            return res.status(400).json({ success: false, message: "Invalid from_email" });
        }
        if (reply_to != null && String(reply_to).trim() !== "" && !isValidEmail(reply_to)) {
            conn.release();
            return res.status(400).json({ success: false, message: "Invalid reply_to" });
        }

        const row = existing[0];
        const usernameActor = actor(req);
        const nextStatus =
            status != null
                ? String(status).toLowerCase() === "active"
                    ? "active"
                    : "inactive"
                : row.status;

        const passwordEncrypted =
            password != null && String(password).trim() !== ""
                ? encrypt(password)
                : row.password_encrypted;

        await conn.beginTransaction();
        await conn.query(
            `UPDATE email_company_smtp_config
             SET config_name = ?, host = ?, port = ?, secure = ?, username = ?,
                 password_encrypted = ?, from_email = ?, from_name = ?, reply_to = ?,
                 status = ?, modify_by = ?, modify_date = NOW()
             WHERE config_id = ?`,
            [
                config_name != null ? String(config_name).trim() : row.config_name,
                host != null ? String(host).trim() : row.host,
                port != null ? Number(port) : row.port,
                secure != null ? (Number(secure) ? 1 : 0) : row.secure,
                username != null ? String(username).trim() : row.username,
                passwordEncrypted,
                from_email != null ? String(from_email).trim().toLowerCase() : row.from_email,
                from_name !== undefined
                    ? from_name
                        ? String(from_name).trim()
                        : null
                    : row.from_name,
                reply_to !== undefined
                    ? reply_to
                        ? String(reply_to).trim().toLowerCase()
                        : null
                    : row.reply_to,
                nextStatus,
                usernameActor,
                id,
            ]
        );

        if (nextStatus === "active") {
            await setOnlyActive(conn, id, usernameActor);
        }

        await conn.commit();
        clearCompanySmtpCache();

        const [fresh] = await pool.query(
            `SELECT * FROM email_company_smtp_config WHERE config_id = ? LIMIT 1`,
            [id]
        );

        return res.status(200).json({
            success: true,
            message: "Company mail config updated",
            data: sanitizeRow(fresh[0]),
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) { /* ignore */ }
        console.error("ADMIN MAIL CONFIG EDIT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update mail config",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

/** PUT /admin/mail/config/status — set active/inactive; activating deactivates others */
router.put("/config/status", authAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const config_id = String(req.body?.config_id || "").trim();
        const status = String(req.body?.status || "").trim().toLowerCase();
        if (!config_id || !["active", "inactive"].includes(status)) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "config_id and status (active|inactive) are required",
            });
        }

        const [existing] = await conn.query(
            `SELECT config_id FROM email_company_smtp_config WHERE config_id = ? LIMIT 1`,
            [config_id]
        );
        if (!existing.length) {
            conn.release();
            return res.status(404).json({ success: false, message: "Mail config not found" });
        }

        const usernameActor = actor(req);
        await conn.beginTransaction();
        if (status === "active") {
            await setOnlyActive(conn, config_id, usernameActor);
        } else {
            await conn.query(
                `UPDATE email_company_smtp_config
                 SET status = 'inactive', modify_by = ?, modify_date = NOW()
                 WHERE config_id = ?`,
                [usernameActor, config_id]
            );
        }
        await conn.commit();
        clearCompanySmtpCache();

        const [fresh] = await pool.query(
            `SELECT * FROM email_company_smtp_config WHERE config_id = ? LIMIT 1`,
            [config_id]
        );

        return res.status(200).json({
            success: true,
            message:
                status === "active"
                    ? "Mail config activated for company mailing"
                    : "Mail config deactivated",
            data: sanitizeRow(fresh[0]),
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) { /* ignore */ }
        console.error("ADMIN MAIL CONFIG STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update mail config status",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

/** POST /admin/mail/config/test — verify SMTP (uses payload or saved config) */
router.post("/config/test", authAdmin, async (req, res) => {
    try {
        const {
            config_id,
            host,
            port,
            secure,
            username,
            password,
            from_email,
            to,
        } = req.body || {};

        let smtp = {
            host,
            port,
            secure,
            username,
            password,
            from_email,
        };

        if (config_id) {
            const [rows] = await pool.query(
                `SELECT * FROM email_company_smtp_config WHERE config_id = ? LIMIT 1`,
                [String(config_id).trim()]
            );
            if (!rows.length) {
                return res.status(404).json({ success: false, message: "Mail config not found" });
            }
            const row = rows[0];
            smtp = {
                host: host || row.host,
                port: port != null ? port : row.port,
                secure: secure != null ? secure : row.secure,
                username: username || row.username,
                password:
                    password && String(password).trim() !== ""
                        ? password
                        : decrypt(row.password_encrypted),
                from_email: from_email || row.from_email,
            };
        }

        if (!smtp.host || !smtp.port || !smtp.username || !smtp.password) {
            return res.status(400).json({
                success: false,
                message: "host, port, username, and password are required to test",
            });
        }

        const transporter = nodemailer.createTransport({
            host: String(smtp.host).trim(),
            port: Number(smtp.port),
            secure: Number(smtp.secure) === 1 || Number(smtp.port) === 465,
            auth: {
                user: String(smtp.username).trim(),
                pass: String(smtp.password),
            },
        });

        await transporter.verify();

        const testTo = to && isValidEmail(to) ? String(to).trim() : null;
        if (testTo && smtp.from_email) {
            await transporter.sendMail({
                from: smtp.from_email,
                to: testTo,
                subject: "OOMS company mail test",
                html: "<p>This is a test email from the company mail configuration.</p>",
            });
        }

        return res.status(200).json({
            success: true,
            message: testTo
                ? `SMTP verified and test email sent to ${testTo}`
                : "SMTP connection verified successfully",
        });
    } catch (error) {
        console.error("ADMIN MAIL CONFIG TEST ERROR:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "SMTP test failed",
        });
    }
});

export default router;
