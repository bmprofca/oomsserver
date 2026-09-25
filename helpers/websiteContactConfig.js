import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";

function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}

function parseJson(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeTypedList(list, valueKey) {
    if (!Array.isArray(list)) return [];
    return list
        .map((item) => {
            if (!item || typeof item !== "object") return null;
            const type = trimStr(item.type);
            const value = trimStr(item[valueKey]);
            if (!type && !value) return null;
            return { type: type || "general", [valueKey]: value };
        })
        .filter(Boolean);
}

const DEFAULT_CONTACT = {
    company_name: "OneSaaS Office Management System",
    short_name: "OOMS",
    website_url: "https://ooms.in",
    whatsapp_message:
        "Hi OOMS team, I am interested in scheduling a live demo of the Office Management System. Please assist.",
    google_maps_embed_url: "",
    email: [
        { type: "sale", email: "sales@ooms.in" },
        { type: "technical", email: "support@ooms.in" },
        { type: "general", email: "info@ooms.in" },
    ],
    phone: [
        { type: "sale", phone: "+91 98765 43210" },
        { type: "technical", phone: "+91 98765 43210" },
        { type: "general", phone: "+91 98765 43210" },
    ],
    whatsapp: [
        { type: "sale", whatsapp: "+91 98765 43210" },
        { type: "technical", whatsapp: "+91 98765 43210" },
        { type: "general", whatsapp: "+91 98765 43210" },
    ],
    address: [
        {
            type: "head office",
            address:
                "OneSaaS Technologies Pvt. Ltd., 4th Floor, Innovation Wing, Koramangala Inner Ring Road, Bengaluru, Karnataka - 560034",
        },
    ],
    business_hours: {
        weekdays: "Monday - Friday: 9:00 AM - 6:30 PM IST",
        saturday: "Saturday: 9:00 AM - 2:00 PM IST",
        sunday: "Sunday: Closed",
    },
    social_links: {
        linkedin: "",
        twitter: "",
        facebook: "",
        youtube: "",
    },
};

export async function ensureWebsiteContactConfigTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS website_contact_config (
          id INT NOT NULL AUTO_INCREMENT,
          config_id VARCHAR(50) NOT NULL,
          company_name VARCHAR(200) NULL DEFAULT NULL,
          short_name VARCHAR(50) NULL DEFAULT NULL,
          website_url VARCHAR(300) NULL DEFAULT NULL,
          whatsapp_message TEXT NULL DEFAULT NULL,
          google_maps_embed_url TEXT NULL DEFAULT NULL,
          email_json LONGTEXT NULL,
          phone_json LONGTEXT NULL,
          whatsapp_json LONGTEXT NULL,
          address_json LONGTEXT NULL,
          business_hours_json LONGTEXT NULL,
          social_links_json LONGTEXT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          create_by VARCHAR(50) NULL DEFAULT NULL,
          create_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
          modify_by VARCHAR(50) NULL DEFAULT NULL,
          modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_website_contact_config_id (config_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function getWebsiteContactConfigRow() {
    try {
        await ensureWebsiteContactConfigTable();
        const [rows] = await pool.query(
            `SELECT *
             FROM website_contact_config
             ORDER BY id DESC
             LIMIT 1`
        );
        return rows[0] || null;
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        throw error;
    }
}

function serializeFromRow(row) {
    if (!row) {
        return {
            configured: false,
            status: "inactive",
            company_name: DEFAULT_CONTACT.company_name,
            short_name: DEFAULT_CONTACT.short_name,
            website_url: DEFAULT_CONTACT.website_url,
            whatsapp_message: DEFAULT_CONTACT.whatsapp_message,
            google_maps_embed_url: DEFAULT_CONTACT.google_maps_embed_url,
            email: DEFAULT_CONTACT.email,
            phone: DEFAULT_CONTACT.phone,
            whatsapp: DEFAULT_CONTACT.whatsapp,
            address: DEFAULT_CONTACT.address,
            business_hours: DEFAULT_CONTACT.business_hours,
            social_links: DEFAULT_CONTACT.social_links,
        };
    }

    const email = normalizeTypedList(
        parseJson(row.email_json, DEFAULT_CONTACT.email),
        "email"
    );
    const phone = normalizeTypedList(
        parseJson(row.phone_json, DEFAULT_CONTACT.phone),
        "phone"
    );
    const whatsapp = normalizeTypedList(
        parseJson(row.whatsapp_json, DEFAULT_CONTACT.whatsapp),
        "whatsapp"
    );
    const address = normalizeTypedList(
        parseJson(row.address_json, DEFAULT_CONTACT.address),
        "address"
    );
    const business_hours = {
        ...DEFAULT_CONTACT.business_hours,
        ...parseJson(row.business_hours_json, {}),
    };
    const social_links = {
        ...DEFAULT_CONTACT.social_links,
        ...parseJson(row.social_links_json, {}),
    };

    return {
        config_id: row.config_id,
        configured: true,
        status: row.status || "active",
        company_name: trimStr(row.company_name) || DEFAULT_CONTACT.company_name,
        short_name: trimStr(row.short_name) || DEFAULT_CONTACT.short_name,
        website_url: trimStr(row.website_url) || DEFAULT_CONTACT.website_url,
        whatsapp_message:
            trimStr(row.whatsapp_message) || DEFAULT_CONTACT.whatsapp_message,
        google_maps_embed_url: trimStr(row.google_maps_embed_url),
        email: email.length ? email : DEFAULT_CONTACT.email,
        phone: phone.length ? phone : DEFAULT_CONTACT.phone,
        whatsapp: whatsapp.length ? whatsapp : DEFAULT_CONTACT.whatsapp,
        address: address.length ? address : DEFAULT_CONTACT.address,
        business_hours,
        social_links,
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

/** Admin panel shape (snake_case + configured flag). */
export function serializeWebsiteContactConfig(row) {
    return serializeFromRow(row);
}

/**
 * Public website API shape — camelCase keys matching WEBSITE siteConfig/
 * contactUtils expectations.
 */
export function serializeWebsiteContactPublic(row) {
    const data = serializeFromRow(row);
    const active = data.configured && data.status === "active";

    return {
        companyName: data.company_name,
        shortName: data.short_name,
        websiteUrl: data.website_url,
        whatsappMessage: data.whatsapp_message,
        googleMapsEmbedUrl: data.google_maps_embed_url,
        email: data.email,
        phone: data.phone,
        whatsapp: data.whatsapp,
        address: data.address,
        businessHours: data.business_hours,
        socialLinks: data.social_links,
        configured: active,
    };
}

export async function upsertWebsiteContactConfig(body = {}, actor = null) {
    await ensureWebsiteContactConfigTable();
    const existing = await getWebsiteContactConfigRow();

    const company_name = trimStr(body.company_name) || null;
    const short_name = trimStr(body.short_name) || null;
    const website_url = trimStr(body.website_url) || null;
    const whatsapp_message = trimStr(body.whatsapp_message) || null;
    const google_maps_embed_url = trimStr(body.google_maps_embed_url) || null;
    const status =
        String(body.status || "active").toLowerCase() === "inactive"
            ? "inactive"
            : "active";

    const email = normalizeTypedList(body.email, "email");
    const phone = normalizeTypedList(body.phone, "phone");
    const whatsapp = normalizeTypedList(body.whatsapp, "whatsapp");
    const address = normalizeTypedList(body.address, "address");

    const business_hours =
        body.business_hours && typeof body.business_hours === "object"
            ? {
                  weekdays: trimStr(body.business_hours.weekdays),
                  saturday: trimStr(body.business_hours.saturday),
                  sunday: trimStr(body.business_hours.sunday),
              }
            : DEFAULT_CONTACT.business_hours;

    const social_links =
        body.social_links && typeof body.social_links === "object"
            ? {
                  linkedin: trimStr(body.social_links.linkedin),
                  twitter: trimStr(body.social_links.twitter),
                  facebook: trimStr(body.social_links.facebook),
                  youtube: trimStr(body.social_links.youtube),
              }
            : DEFAULT_CONTACT.social_links;

    const email_json = JSON.stringify(email);
    const phone_json = JSON.stringify(phone);
    const whatsapp_json = JSON.stringify(whatsapp);
    const address_json = JSON.stringify(address);
    const business_hours_json = JSON.stringify(business_hours);
    const social_links_json = JSON.stringify(social_links);

    if (existing?.config_id) {
        await pool.query(
            `UPDATE website_contact_config
             SET company_name = ?, short_name = ?, website_url = ?, whatsapp_message = ?,
                 google_maps_embed_url = ?, email_json = ?, phone_json = ?, whatsapp_json = ?,
                 address_json = ?, business_hours_json = ?, social_links_json = ?,
                 status = ?, modify_by = ?, modify_date = NOW()
             WHERE config_id = ?`,
            [
                company_name,
                short_name,
                website_url,
                whatsapp_message,
                google_maps_embed_url,
                email_json,
                phone_json,
                whatsapp_json,
                address_json,
                business_hours_json,
                social_links_json,
                status,
                actor,
                existing.config_id,
            ]
        );
        const updated = await getWebsiteContactConfigRow();
        return serializeWebsiteContactConfig(updated);
    }

    const config_id = await UNIQUE_RANDOM_STRING(
        "website_contact_config",
        "config_id",
        { length: 12 }
    );

    await pool.query(
        `INSERT INTO website_contact_config
            (config_id, company_name, short_name, website_url, whatsapp_message,
             google_maps_embed_url, email_json, phone_json, whatsapp_json, address_json,
             business_hours_json, social_links_json, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            config_id,
            company_name,
            short_name,
            website_url,
            whatsapp_message,
            google_maps_embed_url,
            email_json,
            phone_json,
            whatsapp_json,
            address_json,
            business_hours_json,
            social_links_json,
            status,
            actor,
            actor,
        ]
    );

    const created = await getWebsiteContactConfigRow();
    return serializeWebsiteContactConfig(created);
}

export { DEFAULT_CONTACT };
