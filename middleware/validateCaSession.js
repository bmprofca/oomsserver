import pool from "../db.js";
import { resolveCaTokenSession } from "./authCa.js";
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

function readCaCredential(req, name) {
    const fromHeader = readHeader(req, name);
    if (fromHeader) {
        return fromHeader;
    }

    const queryAliases =
        name === "countrycode"
            ? ["countrycode", "country_code"]
            : name === "branch" || name === "branch_id"
              ? ["branch", "branch_id", "branchid"]
              : [name];

    for (const alias of queryAliases) {
        if (req.query?.[alias] != null && String(req.query[alias]).trim() !== "") {
            return String(req.query[alias]).trim();
        }
    }

    return "";
}

function sessionExpired(res, message = "Session expired") {
    return res.status(401).json({
        success: false,
        message,
    });
}

/**
 * Validates CA portal session for every protected API:
 * - token must be a valid active CA session for the provided mobile
 * - username + branch_id must be an active CA assignment for that mobile
 */
async function validateCaSession(req, res, next) {
    try {
        const token = readCaCredential(req, "token");
        const country_code = readCaCredential(req, "countrycode");
        const mobile = readCaCredential(req, "mobile");
        const username = readCaCredential(req, "username");
        const branch_id = readCaCredential(req, "branch") || readCaCredential(req, "branch_id");

        if (!token || !country_code || !mobile || !username || !branch_id) {
            return sessionExpired(
                res,
                "Missing required session (token, country_code, mobile, username, branch_id)."
            );
        }

        const session = await resolveCaTokenSession(token);
        if (!session) {
            return sessionExpired(res, "Invalid or expired session");
        }

        const headerCountryCode = normalizeCountryCode(country_code);
        const headerMobile = normalizeMobileDigits(mobile);
        const headerBranchId = String(branch_id).trim();
        const headerUsername = String(username).trim();

        if (
            session.country_code !== headerCountryCode ||
            session.mobile !== headerMobile
        ) {
            return sessionExpired(
                res,
                "Token does not belong to the provided country_code and mobile"
            );
        }

        const [caRows] = await pool.query(
            `SELECT
                c.username,
                c.branch_id,
                c.status AS ca_status,
                p.name,
                p.email,
                p.mobile,
                p.country_code,
                bl.name AS branch_name
             FROM clients c
             INNER JOIN profile p ON p.username = c.username
                AND p.status = '1'
             LEFT JOIN branch_list bl ON bl.branch_id = c.branch_id
                AND (bl.is_deleted = '0' OR bl.is_deleted = 0)
             WHERE c.username = ?
               AND c.branch_id = ?
               AND c.user_type = 'ca'
               AND c.status = '1'
               AND (c.is_deleted = '0' OR c.is_deleted = 0)
               AND ${PROFILE_MOBILE_SQL} = ?
               AND ${PROFILE_COUNTRY_CODE_SQL} = ?
             LIMIT 1`,
            [headerUsername, headerBranchId, headerMobile, headerCountryCode]
        );

        if (!caRows.length) {
            return sessionExpired(
                res,
                "CA is not assigned to the selected branch"
            );
        }

        const ca = caRows[0];

        req.branch_id = String(ca.branch_id).trim();
        req.ca_username = ca.username;
        req.ca_country_code = headerCountryCode;
        req.ca_mobile = headerMobile;
        req.ca_branch_name = ca.branch_name || null;
        req.ca_profile = {
            username: ca.username,
            name: ca.name,
            email: ca.email,
            mobile: ca.mobile,
            country_code: normalizeCountryCode(ca.country_code),
            branch: {
                branch_id: String(ca.branch_id).trim(),
                name: ca.branch_name || null,
            },
        };

        next();
    } catch (error) {
        console.error("VALIDATE CA SESSION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to validate CA session",
        });
    }
}

export { validateCaSession, readCaCredential };
