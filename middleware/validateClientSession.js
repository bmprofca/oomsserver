import pool from "../db.js";
import { resolveClientTokenSession } from "./authClient.js";
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

function readClientCredential(req, name) {
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

async function validateClientSession(req, res, next) {
    try {
        const token = readClientCredential(req, "token");
        const country_code = readClientCredential(req, "countrycode");
        const mobile = readClientCredential(req, "mobile");
        const username = readClientCredential(req, "username");

        if (!token || !country_code || !mobile || !username) {
            return res.status(400).json({
                success: false,
                message: "Missing required headers (token, country_code, mobile, username).",
            });
        }

        const session = await resolveClientTokenSession(token);
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
               AND p.user_type = 'client'
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

        const [clientRows] = await pool.query(
            `SELECT c.branch_id
             FROM clients c
             WHERE c.username = ?
               AND c.user_type = 'client'
               AND (c.is_deleted = '0' OR c.is_deleted = 0)
             LIMIT 1`,
            [username]
        );

        if (!clientRows.length || !clientRows[0].branch_id) {
            return res.status(404).json({
                success: false,
                message: "Client branch mapping not found",
            });
        }

        req.branch_id = String(clientRows[0].branch_id).trim();
        req.client_username = username;
        req.client_country_code = headerCountryCode;
        req.client_mobile = headerMobile;

        next();
    } catch (error) {
        console.error("VALIDATE CLIENT SESSION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to validate client session",
        });
    }
}

export { validateClientSession, readClientCredential };
