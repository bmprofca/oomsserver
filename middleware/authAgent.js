import pool from "../db.js";
import {
    normalizeCountryCode,
    normalizeMobileDigits,
    PROFILE_COUNTRY_CODE_SQL,
    PROFILE_MOBILE_SQL,
} from "../helpers/clientPhone.js";

async function checkAgentToken(token) {
    const session = await resolveAgentTokenSession(token);
    return session?.username || null;
}

async function resolveAgentTokenSession(token) {
    const [rows] = await pool.query(
        `SELECT username, country_code, mobile
         FROM tokens
         WHERE token = ?
           AND status = '1'
         LIMIT 1`,
        [token]
    );

    if (!rows.length) {
        return null;
    }

    const session = { ...rows[0] };

    if (!session.country_code || !session.mobile) {
        const [profileRows] = await pool.query(
            `SELECT country_code, mobile
             FROM profile
             WHERE username = ?
               AND user_type = 'agent'
               AND status = '1'
             LIMIT 1`,
            [session.username]
        );

        if (profileRows.length) {
            session.country_code = session.country_code || profileRows[0].country_code;
            session.mobile = session.mobile || profileRows[0].mobile;
        }
    }

    session.country_code = normalizeCountryCode(session.country_code);
    session.mobile = normalizeMobileDigits(session.mobile);

    if (!session.mobile) {
        return null;
    }

    return session;
}

async function agentProfileExists(country_code, mobile) {
    const cc = normalizeCountryCode(country_code);
    const mob = normalizeMobileDigits(mobile);

    if (!mob) {
        return false;
    }

    const [rows] = await pool.query(
        `SELECT p.username
         FROM profile p
         WHERE p.user_type = 'agent'
           AND p.status = '1'
           AND ${PROFILE_MOBILE_SQL} = ?
           AND ${PROFILE_COUNTRY_CODE_SQL} = ?
         LIMIT 1`,
        [mob, cc]
    );

    return rows.length > 0;
}

async function listAgentProfilesByPhone(country_code, mobile) {
    const cc = normalizeCountryCode(country_code);
    const mob = normalizeMobileDigits(mobile);

    const [rows] = await pool.query(
        `SELECT
            p.username,
            p.name,
            p.email,
            p.mobile,
            p.country_code,
            c.branch_id,
            c.status AS agent_status,
            bl.name AS branch_name,
            bl.logo AS branch_logo,
            bl.sign AS branch_sign
         FROM profile p
         INNER JOIN clients c ON c.username = p.username
            AND c.user_type = 'agent'
            AND (c.is_deleted = '0' OR c.is_deleted = 0)
         LEFT JOIN branch_list bl ON bl.branch_id = c.branch_id
            AND (bl.is_deleted = '0' OR bl.is_deleted = 0)
         WHERE p.user_type = 'agent'
           AND p.status = '1'
           AND ${PROFILE_MOBILE_SQL} = ?
           AND ${PROFILE_COUNTRY_CODE_SQL} = ?
         ORDER BY bl.name ASC, p.name ASC, c.branch_id ASC`,
        [mob, cc]
    );

    return rows.map((row) => ({
        username: row.username,
        name: row.name,
        email: row.email,
        mobile: row.mobile,
        country_code: normalizeCountryCode(row.country_code),
        branch: {
            branch_id: row.branch_id,
            name: row.branch_name,
        },
    }));
}

async function authAgent(req, res, next) {
    const token = req.headers["token"] || req.headers["Token"] || "";

    if (!token) {
        return res.status(401).json({
            success: false,
            message: "Session expired",
        });
    }

    const session = await resolveAgentTokenSession(token);
    if (!session?.username) {
        return res.status(401).json({
            success: false,
            message: "Session expired",
        });
    }

    req.agent_username = session.username;
    req.agent_session = session;
    next();
}

export {
    authAgent,
    checkAgentToken,
    resolveAgentTokenSession,
    agentProfileExists,
    listAgentProfilesByPhone,
};
