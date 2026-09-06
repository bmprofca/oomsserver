import nodemailer from "nodemailer";
import pool from "../db.js";
import { APP_NAME } from "./Config.js";
import { decrypt } from "../utils/smtpEncryption.js";

let cachedActive = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

function envCompanySmtp() {
    const host = String(process.env.COMPANY_SMTP_HOST || "").trim();
    const port = Number(process.env.COMPANY_SMTP_PORT || 587);
    const username = String(process.env.COMPANY_SMTP_USER || "").trim();
    const password = String(process.env.COMPANY_SMTP_PASS || "").trim();
    const from_email = String(
        process.env.COMPANY_SMTP_FROM_EMAIL || username || ""
    ).trim();
    const from_name = String(
        process.env.COMPANY_SMTP_FROM_NAME || APP_NAME || ""
    ).trim();
    const reply_to = String(process.env.COMPANY_SMTP_REPLY_TO || "").trim();
    const secure =
        String(process.env.COMPANY_SMTP_SECURE || "").trim() === "1" ||
        port === 465;

    if (!host || !username || !password || !from_email) return null;
    return {
        source: "env",
        host,
        port,
        secure,
        username,
        password,
        from_email,
        from_name: from_name || APP_NAME,
        reply_to: reply_to || null,
    };
}

async function dbActiveCompanySmtp() {
    try {
        const [rows] = await pool.query(
            `SELECT config_id, host, port, secure, username, password_encrypted,
                    from_email, from_name, reply_to
             FROM email_company_smtp_config
             WHERE status = 'active'
             ORDER BY id DESC
             LIMIT 1`
        );
        const row = rows[0];
        if (!row?.password_encrypted) return null;
        const password = decrypt(row.password_encrypted);
        if (!password) return null;
        return {
            source: "database",
            config_id: row.config_id,
            host: row.host,
            port: Number(row.port) || 587,
            secure: Number(row.secure) === 1 || Number(row.port) === 465,
            username: row.username,
            password,
            from_email: row.from_email,
            from_name: row.from_name || APP_NAME,
            reply_to: row.reply_to || null,
        };
    } catch (error) {
        // Table may not exist yet before migration.
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        console.error("Company SMTP DB resolve error:", error?.message || error);
        return null;
    }
}

/**
 * Resolve company SMTP: active DB config → env → legacy hardcoded fallback.
 */
export async function resolveCompanySmtp({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && cachedActive && now - cachedAt < CACHE_TTL_MS) {
        return cachedActive;
    }

    const fromDb = await dbActiveCompanySmtp();
    if (fromDb) {
        cachedActive = fromDb;
        cachedAt = now;
        return fromDb;
    }

    const fromEnv = envCompanySmtp();
    if (fromEnv) {
        cachedActive = fromEnv;
        cachedAt = now;
        return fromEnv;
    }

    // Legacy fallback (pre-migration installs). Prefer configuring via ADMIN panel.
    const legacy = {
        source: "legacy",
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        username: "souravadhikary1916@gmail.com",
        password: "srsl kqdl pdpz upqo",
        from_email: "souravadhikary1916@gmail.com",
        from_name: APP_NAME,
        reply_to: null,
    };
    cachedActive = legacy;
    cachedAt = now;
    return legacy;
}

export function clearCompanySmtpCache() {
    cachedActive = null;
    cachedAt = 0;
}

export const SendMail = async ({ to, subject, html, text }) => {
    const smtp = await resolveCompanySmtp();
    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port),
        secure: Boolean(smtp.secure),
        auth: {
            user: smtp.username,
            pass: smtp.password,
        },
    });

    const from = smtp.from_name
        ? `"${smtp.from_name}" <${smtp.from_email}>`
        : smtp.from_email;

    return transporter.sendMail({
        from,
        to,
        replyTo: smtp.reply_to || undefined,
        subject,
        html,
        text: text || undefined,
    });
};
