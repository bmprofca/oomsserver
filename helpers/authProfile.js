import {
    normalizeCountryCode,
    normalizeMobileDigits,
    PROFILE_COUNTRY_CODE_SQL,
    PROFILE_MOBILE_SQL,
} from "./clientPhone.js";

export const USER_OTP_TYPE = "login";
export const ADMIN_OTP_TYPE = "admin_login";
export const REGISTER_OTP_TYPE = "register";

export function getQueryExecutor(connOrPool) {
    return connOrPool?.query ? connOrPool : { query: connOrPool.execute?.bind(connOrPool) };
}

export async function findActiveProfileByUsername(executor, username) {
    const [rows] = await executor.query(
        `SELECT profile_id, username, user_type, name, mobile, country_code, email, status
         FROM profile
         WHERE username = ?
           AND status = '1'
         LIMIT 1`,
        [username]
    );
    return rows[0] || null;
}

export async function findSoftwareUserByMobile(executor, country_code, mobile) {
    const cc = normalizeCountryCode(country_code);
    const mob = normalizeMobileDigits(mobile);

    if (!mob || mob.length < 10) {
        return null;
    }

    const [rows] = await executor.query(
        `SELECT
            u.username,
            u.status AS user_status,
            p.name,
            p.email,
            p.mobile,
            p.country_code
         FROM users u
         INNER JOIN profile p ON p.username = u.username
            AND p.status = '1'
         WHERE u.status = '1'
           AND ${PROFILE_MOBILE_SQL} = ?
           AND ${PROFILE_COUNTRY_CODE_SQL} = ?
         LIMIT 1`,
        [mob, cc]
    );

    return rows[0] || null;
}

export async function findAdminUserByMobile(executor, country_code, mobile) {
    const cc = normalizeCountryCode(country_code);
    const mob = normalizeMobileDigits(mobile);

    if (!mob || mob.length < 10) {
        return null;
    }

    const [rows] = await executor.query(
        `SELECT
            u.username,
            u.status AS user_status,
            p.name,
            p.email,
            p.mobile,
            p.country_code
         FROM users u
         INNER JOIN profile p ON p.username = u.username
            AND p.status = '1'
            AND p.user_type = 'platform_admin'
         WHERE u.status = '1'
           AND ${PROFILE_MOBILE_SQL} = ?
           AND ${PROFILE_COUNTRY_CODE_SQL} = ?
         LIMIT 1`,
        [mob, cc]
    );

    return rows[0] || null;
}

export async function findPartyUserByMobile(executor, country_code, mobile, clientUserType) {
    const cc = normalizeCountryCode(country_code);
    const mob = normalizeMobileDigits(mobile);

    if (!mob || mob.length < 10) {
        return null;
    }

    const [rows] = await executor.query(
        `SELECT
            p.username,
            p.name,
            p.email,
            p.mobile,
            p.country_code,
            c.branch_id,
            c.status AS party_status
         FROM profile p
         INNER JOIN clients c ON c.username = p.username
            AND c.user_type = ?
            AND (c.is_deleted = '0' OR c.is_deleted = 0)
         WHERE p.status = '1'
           AND ${PROFILE_MOBILE_SQL} = ?
           AND ${PROFILE_COUNTRY_CODE_SQL} = ?
         LIMIT 1`,
        [clientUserType, mob, cc]
    );

    return rows[0] || null;
}

export async function resolveSoftwareUserByContact(executor, identifier) {
    const input = String(identifier || "").trim();
    if (!input) {
        return null;
    }

    const cleanDigits = input.replace(/\D/g, "");
    const isEmail = input.includes("@");
    const isMobile = !isEmail && cleanDigits.length >= 10;
    const mob = isMobile ? cleanDigits.slice(-10) : null;

    const [rows] = await executor.query(
        `SELECT
            u.username,
            p.email,
            p.mobile,
            p.country_code,
            p.name
         FROM users u
         LEFT JOIN profile p ON p.username = u.username
            AND p.status = '1'
         WHERE u.status = '1'
           AND (
                u.username = ?
             OR (? IS NOT NULL AND p.email = ?)
             OR (? IS NOT NULL AND ${PROFILE_MOBILE_SQL} = ?)
           )
         LIMIT 1`,
        [input, isEmail ? input.toLowerCase() : null, isEmail ? input.toLowerCase() : null, mob, mob]
    );

    return rows[0] || null;
}

export async function findSoftwareUserByEmail(executor, email) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) {
        return null;
    }

    const [rows] = await executor.query(
        `SELECT
            u.username,
            p.email,
            p.mobile,
            p.country_code,
            p.name
         FROM users u
         INNER JOIN profile p ON p.username = u.username
            AND p.status = '1'
         WHERE u.status = '1'
           AND LOWER(p.email) = ?
         LIMIT 1`,
        [normalizedEmail]
    );

    return rows[0] || null;
}
