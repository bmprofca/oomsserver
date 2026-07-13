import crypto from "crypto";
import pool from "../db.js";
import { decrypt, encrypt } from "../utils/smsEncryption.js";
import axios from "axios";
import {
    FAST2SMS_API_URL,
    FAST2SMS_AUTH_TOKEN,
    FAST2SMS_AUTH_TOKEN_MASKED,
    FAST2SMS_DEFAULT_ROUTE,
    FAST2SMS_SENDER_ID,
} from "../helpers/Config.js";

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function sanitizeConfig(row) {
    if (!row) return row;
    const { auth_token_encrypted, ...safe } = row;
    return safe;
}

async function createConfig({ branch_id, username, payload }) {
    const {
        config_name,
        provider = "fast2sms",
        auth_token,
        sender_id = "",
        route = "dlt",
        is_default = 0,
        status = "active",
        daily_limit = 1000
    } = payload;

    if (!config_name || !auth_token) {
        throw new Error("Missing required fields (config_name, auth_token)");
    }
    if (!["active", "inactive"].includes(status)) {
        throw new Error("Invalid status value");
    }

    const config_id = newId("scfg");
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        if (Number(is_default) === 1) {
            await conn.query(
                "UPDATE sms_configs SET is_default = 0, modify_by = ?, modify_date = NOW() WHERE branch_id = ?",
                [username || null, branch_id]
            );
        }

        await conn.query(
            `INSERT INTO sms_configs
            (config_id, branch_id, config_name, provider, auth_token_encrypted, sender_id, route, is_default, status, daily_limit, create_by, modify_by, create_date, modify_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                config_id,
                branch_id,
                config_name,
                provider,
                encrypt(auth_token),
                sender_id,
                route,
                Number(is_default) ? 1 : 0,
                status,
                daily_limit,
                username || null,
                username || null
            ]
        );

        await conn.commit();
        const [rows] = await pool.query(
            "SELECT * FROM sms_configs WHERE branch_id = ? AND config_id = ?",
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
        provider,
        auth_token,
        sender_id,
        route,
        daily_limit
    } = payload;

    if (!config_id) throw new Error("config_id is required");

    const [existingRows] = await pool.query(
        "SELECT * FROM sms_configs WHERE branch_id = ? AND config_id = ? LIMIT 1",
        [branch_id, config_id]
    );
    if (!existingRows.length) {
        throw new Error("SMS config not found");
    }

    const existing = existingRows[0];
    const finalAuthToken = auth_token ? encrypt(auth_token) : existing.auth_token_encrypted;

    await pool.query(
        `UPDATE sms_configs
         SET config_name = ?, provider = ?, auth_token_encrypted = ?, sender_id = ?, route = ?, daily_limit = ?, modify_by = ?, modify_date = NOW()
         WHERE branch_id = ? AND config_id = ?`,
        [
            config_name ?? existing.config_name,
            provider ?? existing.provider,
            finalAuthToken,
            sender_id ?? existing.sender_id,
            route ?? existing.route,
            daily_limit ?? existing.daily_limit,
            username || null,
            branch_id,
            config_id
        ]
    );

    const [rows] = await pool.query(
        "SELECT * FROM sms_configs WHERE branch_id = ? AND config_id = ?",
        [branch_id, config_id]
    );
    return sanitizeConfig(rows[0]);
}

async function listConfigs({ branch_id, page_no = 1, limit = 10 }) {
    const page = Math.max(Number(page_no) || 1, 1);
    const size = Math.max(Number(limit) || 10, 1);
    const offset = (page - 1) * size;

    const [rows] = await pool.query(
        `SELECT * FROM sms_configs
         WHERE branch_id = ?
         ORDER BY is_default DESC, id DESC
         LIMIT ? OFFSET ?`,
        [branch_id, size, offset]
    );

    const hasCustomDefault = rows.some(r => Number(r.is_default) === 1 && r.status === "active");

    const systemDefault = {
        config_id: "default_fast2sms",
        branch_id: branch_id,
        config_name: "System Default Fast2SMS",
        provider: "fast2sms",
        sender_id: FAST2SMS_SENDER_ID,
        route: FAST2SMS_DEFAULT_ROUTE,
        is_default: hasCustomDefault ? 0 : 1,
        status: "active",
        daily_limit: 1000,
        sent_today: 0,
        auth_token: FAST2SMS_AUTH_TOKEN_MASKED
    };

    const sanitizedRows = rows.map(sanitizeConfig);
    const allConfigs = page === 1 ? [systemDefault, ...sanitizedRows] : sanitizedRows;

    const [countRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM sms_configs WHERE branch_id = ?",
        [branch_id]
    );
    const total = Number(countRows[0]?.total || 0) + 1; // +1 for the virtual config

    return {
        data: allConfigs,
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
    if (config_id === "default_fast2sms") {
        return {
            config_id: "default_fast2sms",
            branch_id: branch_id,
            config_name: "System Default Fast2SMS",
            provider: "fast2sms",
            sender_id: FAST2SMS_SENDER_ID,
            route: FAST2SMS_DEFAULT_ROUTE,
            is_default: 1, // Resolves as default
            status: "active",
            daily_limit: 1000,
            sent_today: 0,
            auth_token: FAST2SMS_AUTH_TOKEN_MASKED
        };
    }

    const [rows] = await pool.query(
        `SELECT * FROM sms_configs WHERE branch_id = ? AND config_id = ? LIMIT 1`,
        [branch_id, config_id]
    );
    if (!rows.length) throw new Error("SMS config not found");
    return sanitizeConfig(rows[0]);
}

async function changeStatus({ branch_id, config_id, status, username }) {
    if (config_id === "default_fast2sms") throw new Error("Cannot change status of system default configuration");
    if (!["active", "inactive"].includes(status)) throw new Error("Invalid status value");
    const [result] = await pool.query(
        "UPDATE sms_configs SET status = ?, modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND config_id = ?",
        [status, username || null, branch_id, config_id]
    );
    if (result.affectedRows === 0) throw new Error("SMS config not found");
    return getConfigDetails({ branch_id, config_id });
}

async function setDefaultConfig({ branch_id, config_id, username }) {
    if (config_id === "default_fast2sms") {
        // Unset all custom defaults to fall back to system default
        await pool.query(
            "UPDATE sms_configs SET is_default = 0, modify_by = ?, modify_date = NOW() WHERE branch_id = ?",
            [username || null, branch_id]
        );
        return getConfigDetails({ branch_id, config_id });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [exists] = await conn.query(
            "SELECT config_id FROM sms_configs WHERE branch_id = ? AND config_id = ? LIMIT 1",
            [branch_id, config_id]
        );
        if (!exists.length) throw new Error("SMS config not found");

        await conn.query(
            "UPDATE sms_configs SET is_default = 0, modify_by = ?, modify_date = NOW() WHERE branch_id = ?",
            [username || null, branch_id]
        );
        await conn.query(
            "UPDATE sms_configs SET is_default = 1, modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND config_id = ?",
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
        provider = "fast2sms",
        auth_token,
        sender_id = FAST2SMS_SENDER_ID,
        route = FAST2SMS_DEFAULT_ROUTE,
        test_number,
        template_id,
        variables_values
    } = payload;

    const actualToken = auth_token === FAST2SMS_AUTH_TOKEN_MASKED ? FAST2SMS_AUTH_TOKEN : auth_token;

    if (!actualToken || !test_number) {
        throw new Error("auth_token and test_number are required");
    }

    if (provider === "fast2sms") {
        try {
            const resolvedRoute = route || "dlt";
            const cleanNumbers = String(test_number).replace(/\s+/g, ',').replace(/,+/g, ',');
            const body = {
                route: resolvedRoute,
                sender_id: sender_id || FAST2SMS_SENDER_ID,
                flash: 0,
                numbers: cleanNumbers
            };

            if (resolvedRoute === "dlt") {
                body.message = template_id || "197771";
                body.variables_values = variables_values !== undefined ? variables_values : "test|";
            } else {
                body.message = payload.message || "Test SMS config connection successful.";
            }

            const response = await axios.post(FAST2SMS_API_URL, body, {
                headers: {
                    "authorization": actualToken,
                    "Content-Type": "application/json"
                }
            });

            if (response.data && response.data.return) {
                return { verified: true, request_id: response.data.request_id || "success" };
            } else {
                throw new Error(response.data?.message || "Fast2SMS test failed");
            }
        } catch (error) {
            throw new Error(error.response?.data?.message || error.message);
        }
    } else {
        throw new Error(`Unsupported provider: ${provider}`);
    }
}

async function getConfigWithDecryptedToken({ branch_id, config_id }) {
    if (config_id === "default_fast2sms") {
        return {
            config_id: "default_fast2sms",
            branch_id: branch_id,
            config_name: "System Default Fast2SMS",
            provider: "fast2sms",
            sender_id: FAST2SMS_SENDER_ID,
            route: FAST2SMS_DEFAULT_ROUTE,
            is_default: 1,
            status: "active",
            daily_limit: 1000,
            auth_token: FAST2SMS_AUTH_TOKEN
        };
    }

    const [rows] = await pool.query(
        "SELECT * FROM sms_configs WHERE branch_id = ? AND config_id = ? AND status = 'active' LIMIT 1",
        [branch_id, config_id]
    );
    if (!rows.length) throw new Error("Active SMS config not found");
    const row = rows[0];
    return {
        ...sanitizeConfig(row),
        auth_token: decrypt(row.auth_token_encrypted)
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
    getConfigWithDecryptedToken
};
