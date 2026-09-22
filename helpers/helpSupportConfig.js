import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";

function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}

export async function ensureHelpSupportConfigTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS help_support_platform_config (
          id INT NOT NULL AUTO_INCREMENT,
          config_id VARCHAR(50) NOT NULL,
          page_title VARCHAR(150) NOT NULL DEFAULT 'Help & Support',
          intro_text TEXT NULL DEFAULT NULL,
          support_email VARCHAR(150) NULL DEFAULT NULL,
          support_phone VARCHAR(40) NULL DEFAULT NULL,
          support_whatsapp VARCHAR(40) NULL DEFAULT NULL,
          support_hours VARCHAR(200) NULL DEFAULT NULL,
          support_address VARCHAR(500) NULL DEFAULT NULL,
          website_url VARCHAR(300) NULL DEFAULT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          create_by VARCHAR(50) NULL DEFAULT NULL,
          create_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
          modify_by VARCHAR(50) NULL DEFAULT NULL,
          modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_help_support_config_id (config_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    try {
        await pool.query(`
            ALTER TABLE help_support_platform_config
            MODIFY COLUMN intro_text TEXT NULL DEFAULT NULL
        `);
    } catch (_) {
        /* already TEXT or table just created */
    }
}

export async function getHelpSupportConfigRow() {
    try {
        await ensureHelpSupportConfigTable();
        const [rows] = await pool.query(
            `SELECT *
             FROM help_support_platform_config
             ORDER BY id DESC
             LIMIT 1`
        );
        return rows[0] || null;
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        throw error;
    }
}

export function serializeHelpSupportConfig(row) {
    if (!row) {
        return {
            configured: false,
            page_title: "Help & Support",
            intro_text: "",
            support_email: "",
            support_phone: "",
            support_whatsapp: "",
            support_hours: "",
            support_address: "",
            website_url: "",
            status: "inactive",
        };
    }

    return {
        config_id: row.config_id,
        page_title: trimStr(row.page_title) || "Help & Support",
        intro_text: trimStr(row.intro_text),
        support_email: trimStr(row.support_email),
        support_phone: trimStr(row.support_phone),
        support_whatsapp: trimStr(row.support_whatsapp),
        support_hours: trimStr(row.support_hours),
        support_address: trimStr(row.support_address),
        website_url: trimStr(row.website_url),
        status: row.status || "active",
        configured: Boolean(
            trimStr(row.support_email) ||
                trimStr(row.support_phone) ||
                trimStr(row.support_whatsapp) ||
                trimStr(row.support_address) ||
                trimStr(row.website_url)
        ),
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

export async function upsertHelpSupportConfig(body = {}, actor = null) {
    await ensureHelpSupportConfigTable();
    const existing = await getHelpSupportConfigRow();

    const page_title = trimStr(body.page_title) || "Help & Support";
    const intro_text = trimStr(body.intro_text) || null;
    const support_email = trimStr(body.support_email) || null;
    const support_phone = trimStr(body.support_phone) || null;
    const support_whatsapp = trimStr(body.support_whatsapp) || null;
    const support_hours = trimStr(body.support_hours) || null;
    const support_address = trimStr(body.support_address) || null;
    const website_url = trimStr(body.website_url) || null;
    const status =
        String(body.status || "active").toLowerCase() === "inactive"
            ? "inactive"
            : "active";

    if (existing?.config_id) {
        await pool.query(
            `UPDATE help_support_platform_config
             SET page_title = ?, intro_text = ?, support_email = ?, support_phone = ?,
                 support_whatsapp = ?, support_hours = ?, support_address = ?,
                 website_url = ?, status = ?, modify_by = ?, modify_date = NOW()
             WHERE config_id = ?`,
            [
                page_title,
                intro_text,
                support_email,
                support_phone,
                support_whatsapp,
                support_hours,
                support_address,
                website_url,
                status,
                actor,
                existing.config_id,
            ]
        );
        const updated = await getHelpSupportConfigRow();
        return serializeHelpSupportConfig(updated);
    }

    const config_id = await UNIQUE_RANDOM_STRING(
        "help_support_platform_config",
        "config_id",
        { length: 12 }
    );
    await pool.query(
        `INSERT INTO help_support_platform_config
            (config_id, page_title, intro_text, support_email, support_phone,
             support_whatsapp, support_hours, support_address, website_url, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            config_id,
            page_title,
            intro_text,
            support_email,
            support_phone,
            support_whatsapp,
            support_hours,
            support_address,
            website_url,
            status,
            actor,
            actor,
        ]
    );
    const created = await getHelpSupportConfigRow();
    return serializeHelpSupportConfig(created);
}
