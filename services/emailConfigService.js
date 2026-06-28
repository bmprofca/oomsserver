import nodemailer from "nodemailer";
import crypto from "crypto";
import pool from "../db.js";
import { decrypt, encrypt } from "../utils/smtpEncryption.js";

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function sanitizeConfig(row) {
    if (!row) return row;
    const { password_encrypted, ...safe } = row;
    return safe;
}

async function createConfig({ branch_id, username, payload }) {
    const {
        config_name,
        host,
        port,
        secure = 0,
        username: smtp_username,
        password,
        from_email,
        from_name = null,
        reply_to = null,
        is_default = 0,
        status = "active"
    } = payload;

    if (!config_name || !host || !port || !smtp_username || !password || !from_email) {
        throw new Error("Missing required fields for SMTP config");
    }
    if (!isValidEmail(from_email) || (reply_to && !isValidEmail(reply_to))) {
        throw new Error("Invalid email format for from_email/reply_to");
    }
    if (!["active", "inactive"].includes(status)) {
        throw new Error("Invalid status value");
    }

    const config_id = newId("cfg");
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        if (Number(is_default) === 1) {
            await conn.query(
                "UPDATE email_configs SET is_default = 0, modify_by = ?, modify_date = NOW() WHERE branch_id = ?",
                [username || null, branch_id]
            );
        }

        await conn.query(
            `INSERT INTO email_configs
            (config_id, branch_id, config_name, host, port, secure, username, password_encrypted, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                config_id,
                branch_id,
                config_name,
                host,
                Number(port),
                Number(secure) ? 1 : 0,
                smtp_username,
                encrypt(password),
                from_email,
                from_name,
                reply_to,
                Number(is_default) ? 1 : 0,
                status,
                username || null,
                username || null
            ]
        );

        await conn.commit();
        const [rows] = await pool.query(
            "SELECT config_id, branch_id, config_name, host, port, secure, username, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date FROM email_configs WHERE branch_id = ? AND config_id = ?",
            [branch_id, config_id]
        );
        return sanitizeConfig(rows[0]);
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function updateConfig({ branch_id, username, payload }) {
    const {
        config_id,
        config_name,
        host,
        port,
        secure,
        smtp_username,
        password,
        from_email,
        from_name,
        reply_to
    } = payload;

    if (!config_id) throw new Error("config_id is required");
    if (from_email && !isValidEmail(from_email)) throw new Error("Invalid from_email");
    if (reply_to && !isValidEmail(reply_to)) throw new Error("Invalid reply_to");

    const [existingRows] = await pool.query(
        "SELECT * FROM email_configs WHERE branch_id = ? AND config_id = ? LIMIT 1",
        [branch_id, config_id]
    );
    if (!existingRows.length) {
        throw new Error("SMTP config not found");
    }

    const existing = existingRows[0];
    const finalUsername = smtp_username ?? existing.username;
    const finalPassword = password ? encrypt(password) : existing.password_encrypted;

    await pool.query(
        `UPDATE email_configs
         SET config_name = ?, host = ?, port = ?, secure = ?, username = ?, password_encrypted = ?,
             from_email = ?, from_name = ?, reply_to = ?, modify_by = ?, modify_date = NOW()
         WHERE branch_id = ? AND config_id = ?`,
        [
            config_name ?? existing.config_name,
            host ?? existing.host,
            Number(port ?? existing.port),
            Number(secure ?? existing.secure) ? 1 : 0,
            finalUsername,
            finalPassword,
            from_email ?? existing.from_email,
            from_name ?? existing.from_name,
            reply_to ?? existing.reply_to,
            username || null,
            branch_id,
            config_id
        ]
    );

    const [rows] = await pool.query(
        "SELECT config_id, branch_id, config_name, host, port, secure, username, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date FROM email_configs WHERE branch_id = ? AND config_id = ?",
        [branch_id, config_id]
    );
    return rows[0];
}

async function listConfigs({ branch_id, page_no = 1, limit = 10 }) {
    const page = Math.max(Number(page_no) || 1, 1);
    const size = Math.max(Number(limit) || 10, 1);
    const offset = (page - 1) * size;

    const [rows] = await pool.query(
        `SELECT config_id, branch_id, config_name, host, port, secure, username, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date
         FROM email_configs
         WHERE branch_id = ?
         ORDER BY is_default DESC, id DESC
         LIMIT ? OFFSET ?`,
        [branch_id, size, offset]
    );
    const [countRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM email_configs WHERE branch_id = ?",
        [branch_id]
    );
    const total = Number(countRows[0]?.total || 0);
    return {
        data: rows.map(sanitizeConfig),
        pagination: {
            page_no: page,
            limit: size,
            total,
            total_pages: Math.ceil(total / size) || 1,
            has_more: page * size < total
        }
    };
}

async function getConfigDetails({ branch_id, config_id }) {
    const [rows] = await pool.query(
        `SELECT config_id, branch_id, config_name, host, port, secure, username, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date
         FROM email_configs WHERE branch_id = ? AND config_id = ? LIMIT 1`,
        [branch_id, config_id]
    );
    if (!rows.length) throw new Error("SMTP config not found");
    return sanitizeConfig(rows[0]);
}

async function changeStatus({ branch_id, config_id, status, username }) {
    if (!["active", "inactive"].includes(status)) throw new Error("Invalid status value");
    const [result] = await pool.query(
        "UPDATE email_configs SET status = ?, modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND config_id = ?",
        [status, username || null, branch_id, config_id]
    );
    if (result.affectedRows === 0) throw new Error("SMTP config not found");
    return getConfigDetails({ branch_id, config_id });
}

async function setDefaultConfig({ branch_id, config_id, username }) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [exists] = await conn.query(
            "SELECT config_id FROM email_configs WHERE branch_id = ? AND config_id = ? LIMIT 1",
            [branch_id, config_id]
        );
        if (!exists.length) throw new Error("SMTP config not found");

        await conn.query(
            "UPDATE email_configs SET is_default = 0, modify_by = ?, modify_date = NOW() WHERE branch_id = ?",
            [username || null, branch_id]
        );
        await conn.query(
            "UPDATE email_configs SET is_default = 1, modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND config_id = ?",
            [username || null, branch_id, config_id]
        );
        await conn.commit();
        return getConfigDetails({ branch_id, config_id });
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function testConfig({ payload }) {
    const {
        host,
        port,
        secure = 0,
        username,
        password
    } = payload;
    if (!host || !port || !username || !password) {
        throw new Error("host, port, username, password are required");
    }

    const transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: Number(secure) === 1 || Number(port) === 465,
        auth: { user: username, pass: password }
    });
    await transporter.verify();
    return { verified: true };
}

async function getConfigWithDecryptedPassword({ branch_id, config_id }) {
    const [rows] = await pool.query(
        "SELECT * FROM email_configs WHERE branch_id = ? AND config_id = ? AND status = 'active' LIMIT 1",
        [branch_id, config_id]
    );
    if (!rows.length) throw new Error("Active SMTP config not found");
    const row = rows[0];
    return {
        ...sanitizeConfig(row),
        password: decrypt(row.password_encrypted)
    };
}

export {
    createConfig,
    updateConfig,
    listConfigs,
    getConfigDetails,
    changeStatus,
    setDefaultConfig,
    testConfig,
    getConfigWithDecryptedPassword
};
