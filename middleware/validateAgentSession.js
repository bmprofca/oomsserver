import pool from "../db.js";
import { resolveAgentTokenSession } from "./authAgent.js";
import {
    normalizeCountryCode,
    normalizeMobileDigits,
    PROFILE_COUNTRY_CODE_SQL,
    PROFILE_MOBILE_SQL,
} from "../helpers/clientPhone.js";

function readHeader(req, name) {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(req.headers || {})) {
        if (key.toLowerCase() === lower) {
            return value == null ? "" : String(value).trim();
        }
    }
    return "";
}

function readAgentCredential(req, name) {
    const fromHeader = readHeader(req, name);
    if (fromHeader) {
        return fromHeader;
    }

    const queryAliases =
        name === "countrycode" ? ["countrycode", "country_code"] : [name];

    for (const alias of queryAliases) {
        if (req.query?.[alias] != null && String(req.query[alias]).trim() !== "") {
            return String(req.query[alias]).trim();
        }
    }

    return "";
}

async function validateAgentSession(req, res, next) {
    try {
        const token = readAgentCredential(req, "token");
        const country_code = readAgentCredential(req, "countrycode");
        const mobile = readAgentCredential(req, "mobile");
        const username = readAgentCredential(req, "username");

        if (!token || !country_code || !mobile || !username) {
            return res.status(400).json({
                success: false,
                message: "Missing required headers (token, country_code, mobile, username).",
            });
        }

        const session = await resolveAgentTokenSession(token);
        if (!session) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired session",
            });
        }

        const headerCountryCode = normalizeCountryCode(country_code);
        const headerMobile = normalizeMobileDigits(mobile);

        if (
            session.country_code !== headerCountryCode ||
            session.mobile !== headerMobile
        ) {
            return res.status(401).json({
                success: false,
                message: "Token does not belong to the provided country_code and mobile",
            });
        }

        const [profileRows] = await pool.query(
            `SELECT p.username, p.name, p.email, p.mobile, p.country_code
             FROM profile p
             WHERE p.username = ?
               AND p.user_type = 'agent'
               AND p.status = '1'
               AND ${PROFILE_MOBILE_SQL} = ?
               AND ${PROFILE_COUNTRY_CODE_SQL} = ?
             LIMIT 1`,
            [username, headerMobile, headerCountryCode]
        );

        if (!profileRows.length) {
            return res.status(403).json({
                success: false,
                message: "Username does not match the provided country_code and mobile",
            });
        }

        const [caRows] = await pool.query(
            `SELECT c.branch_id
             FROM clients c
             WHERE c.username = ?
               AND c.user_type = 'agent'
               AND (c.is_deleted = '0' OR c.is_deleted = 0)
               AND c.status = '1'
             LIMIT 1`,
            [username]
        );

        if (!caRows.length || !caRows[0].branch_id) {
            return res.status(404).json({
                success: false,
                message: "Agent branch mapping not found",
            });
        }

        req.branch_id = String(caRows[0].branch_id).trim();
        req.agent_username = username;
        req.agent_country_code = headerCountryCode;
        req.agent_mobile = headerMobile;

        next();
    } catch (error) {
        console.error("VALIDATE AGENT SESSION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to validate agent session",
        });
    }
}

export { validateAgentSession, readAgentCredential };
