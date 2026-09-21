import express from "express";
import axios from "axios";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";
import { encrypt, decrypt } from "../utils/smtpEncryption.js";
import {
    CALL_CHANNELS,
    normalizeCallChannel,
    callChannelLabel,
} from "../helpers/callChannel.js";
import { resolveCallSystemConfigForDial } from "../helpers/callSystemConfig.js";

const router = express.Router();

function usernameFromReq(req) {
    return String(req.headers["username"] || req.headers["Username"] || "").trim();
}

function maskApiKey(token) {
    const value = String(token || "");
    if (!value) return "";
    if (value.length <= 8) return "****";
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function normalizePhoneForPbx(phoneNumber, countryCode) {
    let digits = String(phoneNumber || "").replace(/\D/g, "");
    const cc = String(countryCode || "").replace(/\D/g, "");
    if (!digits) return "";
    if (cc && digits.startsWith(cc) && digits.length > cc.length + 6) {
        digits = digits.slice(cc.length);
    }
    if (digits.startsWith("91") && digits.length === 12) {
        digits = digits.slice(2);
    }
    if (digits.startsWith("0") && digits.length === 11) {
        digits = digits.slice(1);
    }
    return digits;
}

async function getBranchCallConfigRow(branch_id) {
    try {
        const [rows] = await pool.query(
            `SELECT config_id, branch_id, api_key_encrypted, status, modify_date
             FROM call_branch_configs
             WHERE branch_id = ?
             LIMIT 1`,
            [branch_id]
        );
        return rows[0] || null;
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        throw error;
    }
}

function serializeBranchCallConfig(row, { includeKey = false } = {}) {
    if (!row) {
        return {
            configured: false,
            status: "inactive",
            api_key_masked: "",
        };
    }
    const apiKey = row.api_key_encrypted ? decrypt(row.api_key_encrypted) : "";
    return {
        config_id: row.config_id,
        branch_id: row.branch_id,
        status: row.status || "active",
        configured: Boolean(apiKey),
        api_key_masked: maskApiKey(apiKey),
        api_key: includeKey ? apiKey : undefined,
        modify_date: row.modify_date || null,
    };
}

async function getStaffCallAccess(branch_id, username) {
    try {
        const [rows] = await pool.query(
            `SELECT call_extension, call_enabled
             FROM branch_mapping
             WHERE branch_id = ?
               AND username = ?
               AND is_deleted = '0'
               AND status = '1'
               AND is_accepted = '1'
             LIMIT 1`,
            [branch_id, username]
        );
        const row = rows[0];
        const enabled = row?.call_enabled === "1" || row?.call_enabled === 1;
        const extension = String(row?.call_extension || "").trim();
        return { enabled, extension: enabled ? extension : "" };
    } catch (error) {
        if (error?.code === "ER_BAD_FIELD_ERROR") {
            const [rows] = await pool.query(
                `SELECT call_extension
                 FROM branch_mapping
                 WHERE branch_id = ?
                   AND username = ?
                   AND is_deleted = '0'
                   AND status = '1'
                 LIMIT 1`,
                [branch_id, username]
            );
            const extension = String(rows[0]?.call_extension || "").trim();
            return { enabled: Boolean(extension), extension };
        }
        throw error;
    }
}

async function getStaffExtension(branch_id, username) {
    const access = await getStaffCallAccess(branch_id, username);
    return access.extension;
}

router.get("/channel", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const [rows] = await pool.query(
            `SELECT branch_id, call_channel
             FROM branch_list
             WHERE branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [branch_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        const channel = normalizeCallChannel(rows[0].call_channel);
        return res.status(200).json({
            success: true,
            message: "Call channel retrieved successfully",
            data: {
                channel,
                channel_label: callChannelLabel(channel),
            },
        });
    } catch (error) {
        console.error("GET CALL CHANNEL ERROR:", error);
        if (error?.code === "ER_BAD_FIELD_ERROR") {
            return res.status(200).json({
                success: true,
                message: "Call channel retrieved successfully",
                data: { channel: "disabled", channel_label: "Disabled" },
            });
        }
        return res.status(500).json({
            success: false,
            message: "Failed to fetch call channel",
        });
    }
});

router.put("/channel", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = usernameFromReq(req);
        const channel = normalizeCallChannel(req.body?.channel);

        if (!CALL_CHANNELS.includes(channel)) {
            return res.status(400).json({
                success: false,
                message: "Invalid call channel",
            });
        }

        const [result] = await pool.query(
            `UPDATE branch_list
             SET call_channel = ?, modify_by = ?, modify_date = NOW()
             WHERE branch_id = ?
               AND is_deleted = '0'`,
            [channel, username || null, branch_id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Call channel updated successfully",
            data: {
                channel,
                channel_label: callChannelLabel(channel),
            },
        });
    } catch (error) {
        console.error("PUT CALL CHANNEL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to update call channel",
        });
    }
});

router.get("/ooms-system/config", auth, validateBranch, async (req, res) => {
    try {
        const row = await getBranchCallConfigRow(req.branch_id);
        return res.status(200).json({
            success: true,
            message: "Call branch config retrieved",
            data: serializeBranchCallConfig(row),
        });
    } catch (error) {
        console.error("GET CALL BRANCH CONFIG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load call config",
        });
    }
});

router.put("/ooms-system/config", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = usernameFromReq(req);
        const existing = await getBranchCallConfigRow(branch_id);
        const incomingKey = String(req.body?.api_key || "").trim();
        const status =
            String(req.body?.status || "active").toLowerCase() === "inactive"
                ? "inactive"
                : "active";

        if (!existing && !incomingKey) {
            return res.status(400).json({
                success: false,
                message: "API key (token) is required",
            });
        }

        if (existing) {
            if (incomingKey) {
                await pool.query(
                    `UPDATE call_branch_configs
                     SET api_key_encrypted = ?, status = ?, modify_by = ?, modify_date = NOW()
                     WHERE branch_id = ?`,
                    [encrypt(incomingKey), status, username || null, branch_id]
                );
            } else {
                await pool.query(
                    `UPDATE call_branch_configs
                     SET status = ?, modify_by = ?, modify_date = NOW()
                     WHERE branch_id = ?`,
                    [status, username || null, branch_id]
                );
            }
        } else {
            const config_id = await UNIQUE_RANDOM_STRING("call_branch_configs", "config_id", {
                length: ID_LENGTH,
            });
            await pool.query(
                `INSERT INTO call_branch_configs
                    (config_id, branch_id, api_key_encrypted, status, create_by, modify_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    config_id,
                    branch_id,
                    encrypt(incomingKey),
                    status,
                    username || null,
                    username || null,
                ]
            );
        }

        const row = await getBranchCallConfigRow(branch_id);
        return res.status(200).json({
            success: true,
            message: "Call branch config saved",
            data: serializeBranchCallConfig(row),
        });
    } catch (error) {
        console.error("PUT CALL BRANCH CONFIG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to save call config",
        });
    }
});

router.get("/ooms-system/staff", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";

        const filterParams = [branch_id];
        let searchSql = "";
        if (search) {
            const sp = `%${search}%`;
            searchSql = ` AND (
                bm.designation LIKE ?
                OR bm.call_extension LIKE ?
                OR p.name LIKE ?
                OR p.email LIKE ?
                OR p.mobile LIKE ?
            )`;
            filterParams.push(sp, sp, sp, sp, sp);
        }

        // Active staff only: accepted + branch-active + user-active. Never list invites/disabled.
        const baseFrom = `
            FROM branch_mapping bm
            INNER JOIN users u ON u.username = bm.username
                AND u.status = '1'
            LEFT JOIN profile p ON p.username = bm.username
                AND p.status = '1'
                AND p.id = (
                    SELECT MAX(p2.id)
                    FROM profile p2
                    WHERE p2.username = bm.username
                      AND p2.status = '1'
                )
            WHERE bm.branch_id = ?
              AND bm.is_deleted = '0'
              AND bm.status = '1'
              AND bm.is_accepted = '1'
              AND bm.type IN ('admin', 'staff')
            ${searchSql}
        `;

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            filterParams
        );

        let rows;
        try {
            const [result] = await pool.query(
                `SELECT
                    bm.map_id,
                    bm.username,
                    bm.designation,
                    bm.type,
                    bm.call_extension,
                    bm.call_enabled,
                    p.name,
                    p.email,
                    p.mobile,
                    p.country_code
                 ${baseFrom}
                 ORDER BY FIELD(bm.type, 'admin', 'staff'), p.name ASC, bm.id DESC
                 LIMIT ? OFFSET ?`,
                [...filterParams, limit, offset]
            );
            rows = result;
        } catch (error) {
            if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
            const [result] = await pool.query(
                `SELECT
                    bm.map_id,
                    bm.username,
                    bm.designation,
                    bm.type,
                    bm.call_extension,
                    p.name,
                    p.email,
                    p.mobile,
                    p.country_code
                 ${baseFrom}
                 ORDER BY FIELD(bm.type, 'admin', 'staff'), p.name ASC, bm.id DESC
                 LIMIT ? OFFSET ?`,
                [...filterParams, limit, offset]
            );
            rows = result.map((row) => ({
                ...row,
                call_enabled:
                    row.call_extension && String(row.call_extension).trim()
                        ? "1"
                        : "0",
            }));
        }

        const data = rows.map((row) => {
            const call_enabled =
                row.call_enabled === "1" || row.call_enabled === 1;
            return {
                map_id: row.map_id,
                designation: row.designation,
                type: row.type,
                call_enabled,
                call_extension: call_enabled ? row.call_extension || "" : "",
                profile: {
                    name: row.name || null,
                    email: row.email || null,
                    mobile: row.mobile || null,
                    country_code: row.country_code || null,
                },
            };
        });

        return res.status(200).json({
            success: true,
            message: "Staff call extensions retrieved",
            data,
            pagination: {
                page_no,
                limit,
                total: Number(total) || 0,
                total_pages: Math.max(1, Math.ceil((Number(total) || 0) / limit)),
                is_last_page: offset + rows.length >= (Number(total) || 0),
            },
        });
    } catch (error) {
        console.error("GET CALL STAFF ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load staff",
        });
    }
});

router.put("/ooms-system/staff", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = usernameFromReq(req);
        const map_id = String(req.body?.map_id || "").trim();
        const enabledRaw = req.body?.enabled ?? req.body?.call_enabled;
        const hasEnabledFlag =
            enabledRaw === true ||
            enabledRaw === false ||
            enabledRaw === "1" ||
            enabledRaw === "0" ||
            enabledRaw === 1 ||
            enabledRaw === 0;
        const enabled = hasEnabledFlag
            ? enabledRaw === true || enabledRaw === "1" || enabledRaw === 1
            : null;

        const extensionRaw = req.body?.call_extension ?? req.body?.extension;
        const call_extension =
            extensionRaw == null || String(extensionRaw).trim() === ""
                ? null
                : String(extensionRaw).trim();

        if (!map_id) {
            return res.status(400).json({
                success: false,
                message: "map_id is required",
            });
        }

        if (enabled === true && !call_extension) {
            return res.status(400).json({
                success: false,
                message: "Extension code is required when call is enabled",
            });
        }

        if (call_extension && !/^[0-9A-Za-z_-]{1,50}$/.test(call_extension)) {
            return res.status(400).json({
                success: false,
                message: "Invalid extension format",
            });
        }

        let existingRow = null;
        try {
            const [existing] = await pool.query(
                `SELECT map_id, call_extension, call_enabled
                 FROM branch_mapping
                 WHERE map_id = ?
                   AND branch_id = ?
                   AND is_deleted = '0'
                   AND status = '1'
                   AND is_accepted = '1'
                   AND type IN ('admin', 'staff')
                 LIMIT 1`,
                [map_id, branch_id]
            );
            existingRow = existing[0] || null;
        } catch (error) {
            if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
            const [existing] = await pool.query(
                `SELECT map_id, call_extension
                 FROM branch_mapping
                 WHERE map_id = ?
                   AND branch_id = ?
                   AND is_deleted = '0'
                   AND status = '1'
                   AND type IN ('admin', 'staff')
                 LIMIT 1`,
                [map_id, branch_id]
            );
            if (existing[0]) {
                existingRow = {
                    ...existing[0],
                    call_enabled:
                        existing[0].call_extension &&
                        String(existing[0].call_extension).trim()
                            ? "1"
                            : "0",
                };
            }
        }

        if (!existingRow) {
            return res.status(404).json({
                success: false,
                message: "Active staff mapping not found",
            });
        }

        const nextEnabled =
            enabled === null
                ? existingRow.call_enabled === "1" || Boolean(call_extension)
                : enabled;
        const nextExtension = nextEnabled ? call_extension : null;

        if (nextEnabled && !nextExtension) {
            return res.status(400).json({
                success: false,
                message: "Extension code is required when call is enabled",
            });
        }

        try {
            const [result] = await pool.query(
                `UPDATE branch_mapping
                 SET call_enabled = ?,
                     call_extension = ?,
                     modify_by = ?,
                     modify_date = NOW()
                 WHERE map_id = ?
                   AND branch_id = ?
                   AND is_deleted = '0'
                   AND status = '1'
                   AND type IN ('admin', 'staff')`,
                [
                    nextEnabled ? "1" : "0",
                    nextExtension,
                    username || null,
                    map_id,
                    branch_id,
                ]
            );

            if (!result.affectedRows) {
                return res.status(404).json({
                    success: false,
                    message: "Staff mapping not found",
                });
            }
        } catch (error) {
            if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
            // Legacy DB without call_enabled — store extension only
            if (nextEnabled && !nextExtension) {
                return res.status(400).json({
                    success: false,
                    message: "Extension code is required when call is enabled",
                });
            }
            const [result] = await pool.query(
                `UPDATE branch_mapping
                 SET call_extension = ?, modify_by = ?, modify_date = NOW()
                 WHERE map_id = ?
                   AND branch_id = ?
                   AND is_deleted = '0'
                   AND status = '1'
                   AND type IN ('admin', 'staff')`,
                [nextExtension, username || null, map_id, branch_id]
            );
            if (!result.affectedRows) {
                return res.status(404).json({
                    success: false,
                    message: "Staff mapping not found",
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: nextEnabled
                ? "Call access enabled"
                : "Call access disabled",
            data: {
                map_id,
                call_enabled: nextEnabled,
                call_extension: nextExtension || "",
            },
        });
    } catch (error) {
        console.error("PUT CALL STAFF ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to update extension",
        });
    }
});

/** Capability for click-to-call UI (current user). */
router.get("/capability", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = usernameFromReq(req);

        let channel = "disabled";
        try {
            const [branchRows] = await pool.query(
                `SELECT call_channel FROM branch_list
                 WHERE branch_id = ? AND is_deleted = '0' LIMIT 1`,
                [branch_id]
            );
            channel = normalizeCallChannel(branchRows[0]?.call_channel);
        } catch (error) {
            if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
        }

        const system = await resolveCallSystemConfigForDial();
        const branchCfg = await getBranchCallConfigRow(branch_id);
        const branchSerialized = serializeBranchCallConfig(branchCfg);
        const access = username
            ? await getStaffCallAccess(branch_id, username)
            : { enabled: false, extension: "" };

        const can_call =
            channel === "ooms system" &&
            Boolean(system) &&
            branchSerialized.configured &&
            String(branchSerialized.status).toLowerCase() === "active" &&
            access.enabled &&
            Boolean(access.extension);

        return res.status(200).json({
            success: true,
            message: "Call capability retrieved",
            data: {
                channel,
                can_call,
                extension: can_call ? access.extension : "",
                reasons: {
                    channel_enabled: channel === "ooms system",
                    system_url_configured: Boolean(system),
                    branch_token_configured: branchSerialized.configured,
                    call_enabled: access.enabled,
                    extension_configured: Boolean(access.extension),
                },
            },
        });
    } catch (error) {
        console.error("GET CALL CAPABILITY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load call capability",
        });
    }
});

router.post("/initiate", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = usernameFromReq(req);
        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Username required",
            });
        }

        const [branchRows] = await pool.query(
            `SELECT call_channel FROM branch_list
             WHERE branch_id = ? AND is_deleted = '0' LIMIT 1`,
            [branch_id]
        );
        const channel = normalizeCallChannel(branchRows[0]?.call_channel);
        if (channel !== "ooms system") {
            return res.status(400).json({
                success: false,
                message: "Call channel is disabled for this branch",
            });
        }

        const system = await resolveCallSystemConfigForDial();
        if (!system) {
            return res.status(503).json({
                success: false,
                message: "Call system API URL is not configured by admin",
            });
        }

        const branchCfg = await getBranchCallConfigRow(branch_id);
        const apiKey = branchCfg?.api_key_encrypted
            ? decrypt(branchCfg.api_key_encrypted)
            : "";
        if (
            !apiKey ||
            String(branchCfg?.status || "").toLowerCase() !== "active"
        ) {
            return res.status(400).json({
                success: false,
                message: "Branch call API token is not configured",
            });
        }

        const extension = await getStaffExtension(branch_id, username);
        if (!extension) {
            return res.status(400).json({
                success: false,
                message: "Your PBX extension is not configured",
            });
        }

        const phoneNumber = normalizePhoneForPbx(
            req.body?.phoneNumber || req.body?.phone || req.body?.mobile,
            req.body?.country_code || req.body?.countryCode
        );
        if (!phoneNumber || phoneNumber.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Valid phoneNumber is required",
            });
        }

        const response = await axios.post(
            system.api_base_url,
            { phoneNumber, extension },
            {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                },
                timeout: 30000,
                validateStatus: () => true,
            }
        );

        const payload = response.data;
        const ok =
            response.status >= 200 &&
            response.status < 300 &&
            String(payload?.status || "").toLowerCase() === "success";

        try {
            const log_id = await UNIQUE_RANDOM_STRING("call_pbx_logs", "log_id", {
                length: ID_LENGTH,
            });
            await pool.query(
                `INSERT INTO call_pbx_logs
                    (log_id, branch_id, initiated_by, extension, phone_number,
                     pbx_call_id, request_id, call_status, raw_response)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    log_id,
                    branch_id,
                    username,
                    extension,
                    phoneNumber,
                    payload?.data?.call_id || null,
                    payload?.data?.request_id || null,
                    payload?.data?.call_status || (ok ? "acknowledged" : "failed"),
                    JSON.stringify(payload || {}),
                ]
            );
        } catch (logError) {
            console.error("CALL PBX LOG ERROR:", logError.message);
        }

        if (!ok) {
            return res.status(response.status >= 400 ? response.status : 502).json({
                success: false,
                message:
                    payload?.message ||
                    payload?.error ||
                    "PBX call initiate failed",
                data: payload?.data || null,
            });
        }

        return res.status(200).json({
            success: true,
            message: payload?.message || "Call initiated successfully",
            data: payload?.data || null,
        });
    } catch (error) {
        console.error("POST CALL INITIATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to initiate call",
        });
    }
});

export default router;
