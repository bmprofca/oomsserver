import crypto from "crypto";
import express from "express";
import {
    AccessToken,
    RoomServiceClient,
    TrackSource,
    WebhookReceiver,
} from "livekit-server-sdk";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { validateClientVoiceCallSession } from "../middleware/validateClientSession.js";
import { validateCaSession } from "../middleware/validateCaSession.js";
import { sendPushToUser } from "../helpers/fcmPush.js";
import {
    emitCAVoiceCallIncoming,
    emitStaffVoiceCallIncoming,
    emitVoiceCallAnswered,
    emitVoiceCallCancelled,
    emitVoiceCallIncoming,
    getConnectedVoiceCallSessions,
    hasConnectedCAVoiceCallSocket,
    hasConnectedClientVoiceCallSocket,
    hasConnectedStaffVoiceCallSocket,
} from "../helpers/Socket.js";
import {
    decryptVoiceCallConfig,
    encryptVoiceCallConfig,
} from "../utils/voiceCallConfigCrypto.js";

const router = express.Router();
const INVITE_TTL_SECONDS = 45;
const MAX_CALL_INVITES_PER_MINUTE = 10;
const ACTIVE_CALL_STATUSES = ["ringing", "accepted"];
const ACCEPTED_CALL_EMPTY_ROOM_GRACE_SECONDS = 45;
const ENDED_ROOM_CLEANUP_DELAY_MS = 5000;

async function liveKitConfig({ requireEnabled = true } = {}) {
    const [rows] = await pool.query(
        `SELECT enabled, server_url, api_key_encrypted, api_secret_encrypted
         FROM in_app_voice_call_settings
         WHERE id = 1
         LIMIT 1`
    );
    const settings = rows[0];
    if (!settings || (requireEnabled && Number(settings.enabled) !== 1)) {
        const error = new Error("In-app voice calling is not enabled");
        error.status = 503;
        throw error;
    }

    const serverUrl = String(settings.server_url || "").trim().replace(/\/+$/, "");
    let apiKey;
    let apiSecret;
    try {
        apiKey = decryptVoiceCallConfig(settings.api_key_encrypted);
        apiSecret = decryptVoiceCallConfig(settings.api_secret_encrypted);
    } catch (error) {
        if (error?.status) throw error;
        const configError = new Error("LiveKit credentials could not be decrypted");
        configError.status = 503;
        throw configError;
    }
    if (!serverUrl || !apiKey || !apiSecret) {
        const error = new Error("In-app voice calling is not configured");
        error.status = 503;
        throw error;
    }

    let parsed;
    try {
        parsed = new URL(serverUrl);
    } catch {
        const error = new Error("Stored LiveKit server URL must be valid");
        error.status = 503;
        throw error;
    }
    if (parsed.protocol !== "wss:") {
        const error = new Error("Stored LiveKit server URL must use wss://");
        error.status = 503;
        throw error;
    }

    return {
        serverUrl,
        apiUrl: serverUrl.replace(/^wss:/i, "https:"),
        apiKey,
        apiSecret,
    };
}

function roomService(config) {
    return new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret);
}

function sendError(res, error, fallback) {
    console.error("IN-APP VOICE CALL ERROR:", error);
    return res.status(error?.status || 500).json({
        success: false,
        message: error?.status ? error.message : fallback,
    });
}

function requestUsername(req) {
    return String(req.headers.username || req.headers.Username || "").trim();
}

function requestVoiceCallSessionHash(req) {
    const token = String(req.headers.token || req.headers.Token || "");
    return crypto.createHash("sha256").update(token).digest("hex");
}

function requestVoiceCallSessionId(req) {
    const fcmToken = String(req.headers["x-fcm-token"] || "").trim();
    if (fcmToken) {
        return `fcm:${crypto.createHash("sha256").update(fcmToken).digest("hex")}`;
    }
    const sessionId = String(req.headers["x-voice-call-session-id"] || "").trim();
    if (/^[A-Za-z0-9:_-]{8,160}$/.test(sessionId)) return sessionId;
    return `session:${requestVoiceCallSessionHash(req)}`;
}

async function recipientVoiceCallSessionIds(connection, username, panel) {
    const sessionIds = new Set(getConnectedVoiceCallSessions(username, panel));
    const [tokenRows] = await connection.query(
        `SELECT fcm_token FROM fcm_tokens WHERE username = ? AND panel = ?`,
        [username, panel]
    );
    for (const row of tokenRows) {
        const token = String(row.fcm_token || "").trim();
        if (token) {
            sessionIds.add(`fcm:${crypto.createHash("sha256").update(token).digest("hex")}`);
        }
    }
    return Array.from(sessionIds);
}

async function saveRecipientVoiceCallSessions(connection, callId, sessionIds) {
    for (const sessionId of sessionIds) {
        await connection.query(
            `INSERT IGNORE INTO in_app_voice_call_sessions (call_id, session_id)
             VALUES (?, ?)`,
            [callId, sessionId]
        );
    }
}

async function declineCallSession(call, req, endReason) {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
        await connection.beginTransaction();
        transactionStarted = true;
        const [lockedRows] = await connection.query(
            `SELECT status
             FROM in_app_voice_calls
             WHERE call_id = ?
             LIMIT 1 FOR UPDATE`,
            [call.call_id]
        );
        if (!lockedRows.length || lockedRows[0].status !== "ringing") {
            const error = new Error("This call is no longer available");
            error.status = 409;
            throw error;
        }

        await connection.query(
            `INSERT INTO in_app_voice_call_sessions (call_id, session_id, status)
             VALUES (?, ?, 'declined')
             ON DUPLICATE KEY UPDATE status = 'declined'`,
            [call.call_id, requestVoiceCallSessionId(req)]
        );
        const [counts] = await connection.query(
            `SELECT COUNT(*) AS total,
                    SUM(status = 'declined') AS declined
             FROM in_app_voice_call_sessions
             WHERE call_id = ?`,
            [call.call_id]
        );
        const allSessionsDeclined =
            Number(counts[0]?.total || 0) > 0 &&
            Number(counts[0]?.declined || 0) >= Number(counts[0]?.total || 0);
        if (allSessionsDeclined) {
            await connection.query(
                `UPDATE in_app_voice_calls
                 SET status = 'rejected', end_reason = ?, ended_at = NOW()
                 WHERE call_id = ? AND status = 'ringing'`,
                [endReason, call.call_id]
            );
        }
        await connection.commit();
        transactionStarted = false;
        return allSessionsDeclined ? "rejected" : "ringing";
    } catch (error) {
        if (transactionStarted) await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function hasDeclinedCallSession(callId, req) {
    const [rows] = await pool.query(
        `SELECT 1
         FROM in_app_voice_call_sessions
         WHERE call_id = ? AND session_id = ? AND status = 'declined'
         LIMIT 1`,
        [callId, requestVoiceCallSessionId(req)]
    );
    return rows.length > 0;
}

async function notifyCallAnswered(
    call,
    username,
    panel,
    answeredByName,
    acceptedSessionId,
    acceptingDeviceFcmToken
) {
    const answeredCall = {
        call_id: call.call_id,
        answered_by_name: String(answeredByName || "Another OOMS user"),
    };
    emitVoiceCallAnswered(
        username,
        panel,
        answeredCall,
        acceptedSessionId
    );
    try {
        const result = await sendPushToUser(
            username,
            panel,
            {
                title: "Call answered",
                body: `${answeredCall.answered_by_name} already answered this call.`,
                data: {
                    type: "IN_APP_VOICE_CALL_ANSWERED",
                    call_id: call.call_id,
                    answered_by_name: answeredCall.answered_by_name,
                },
            },
            { excludeTokens: acceptingDeviceFcmToken ? [acceptingDeviceFcmToken] : [] }
        );
        if (result.failureCount > 0) {
            console.warn("Some devices did not receive the voice-call answer update", {
                call_id: call.call_id,
                failure_count: result.failureCount,
            });
        }
    } catch (error) {
        console.error("Unable to notify other devices that the voice call was answered:", error);
    }
}

function voiceCallRecipient(call) {
    if (call.initiated_by === "client") {
        return { username: call.caller_username, panel: "enduser" };
    }
    return {
        username: call.client_username,
        panel: call.recipient_panel,
    };
}

async function notifyCallCancelled(call) {
    const recipient = voiceCallRecipient(call);
    const event = { call_id: call.call_id };
    emitVoiceCallCancelled(recipient.username, recipient.panel, event);
    try {
        const result = await sendPushToUser(recipient.username, recipient.panel, {
            title: "Call cancelled",
            body: `${call.caller_name} cancelled the call.`,
            data: {
                type: "IN_APP_VOICE_CALL_CANCELLED",
                call_id: call.call_id,
            },
        });
        if (result.failureCount > 0) {
            console.warn("Some devices did not receive the voice-call cancellation", {
                call_id: call.call_id,
                failure_count: result.failureCount,
            });
        }
    } catch (error) {
        console.error("Unable to notify devices that the voice call was cancelled:", error);
    }
}

async function requirePlatformAdmin(req, res, next) {
    try {
        const username = requestUsername(req);
        const [rows] = await pool.query(
            `SELECT 1
             FROM profile
             WHERE username = ? AND user_type = 'platform_admin' AND status = '1'
             LIMIT 1`,
            [username]
        );
        if (!rows.length) {
            return res.status(403).json({
                success: false,
                message: "Only platform admins can manage LiveKit settings",
            });
        }
        next();
    } catch (error) {
        console.error("LIVEKIT SETTINGS AUTHORIZATION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to verify platform admin access",
        });
    }
}

function normalizeEnabled(value, fallback) {
    if (value === undefined) return fallback;
    if (value === true || value === 1 || value === "1") return 1;
    if (value === false || value === 0 || value === "0") return 0;
    return null;
}

function validateLiveKitUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "wss:" &&
            Boolean(parsed.hostname) &&
            !parsed.username &&
            !parsed.password &&
            !parsed.search &&
            !parsed.hash &&
            parsed.pathname === "/";
    } catch {
        return false;
    }
}

router.get("/admin/settings", auth, requirePlatformAdmin, async (_req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT enabled, server_url, api_key_encrypted, api_secret_encrypted,
                    updated_by, updated_at
             FROM in_app_voice_call_settings
             WHERE id = 1
             LIMIT 1`
        );
        const settings = rows[0];
        return res.status(200).json({
            success: true,
            data: settings
                ? {
                    configured: true,
                    enabled: Number(settings.enabled) === 1,
                    server_url: settings.server_url,
                    has_api_key: Boolean(settings.api_key_encrypted),
                    has_api_secret: Boolean(settings.api_secret_encrypted),
                    updated_by: settings.updated_by,
                    updated_at: settings.updated_at,
                }
                : {
                    configured: false,
                    enabled: false,
                    server_url: "",
                    has_api_key: false,
                    has_api_secret: false,
                    updated_by: null,
                    updated_at: null,
                },
        });
    } catch (error) {
        return sendError(res, error, "Failed to load LiveKit settings");
    }
});

router.put("/admin/settings", auth, requirePlatformAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT enabled, server_url, api_key_encrypted, api_secret_encrypted
             FROM in_app_voice_call_settings
             WHERE id = 1
             LIMIT 1`
        );
        const existing = rows[0];
        const body = req.body || {};
        const serverUrl = body.server_url === undefined
            ? String(existing?.server_url || "").trim()
            : String(body.server_url || "").trim().replace(/\/+$/, "");
        const enabled = normalizeEnabled(body.enabled, Number(existing?.enabled || 0));
        const apiKey = body.api_key === undefined || body.api_key === ""
            ? ""
            : String(body.api_key).trim();
        const apiSecret = body.api_secret === undefined || body.api_secret === ""
            ? ""
            : String(body.api_secret).trim();

        if (!validateLiveKitUrl(serverUrl)) {
            return res.status(400).json({
                success: false,
                message: "server_url must be a valid wss:// LiveKit URL",
            });
        }
        if (enabled === null) {
            return res.status(400).json({
                success: false,
                message: "enabled must be a boolean",
            });
        }
        if (apiKey.length > 255 || apiSecret.length > 4096) {
            return res.status(400).json({
                success: false,
                message: "LiveKit credentials exceed the allowed length",
            });
        }

        const encryptedApiKey = apiKey
            ? encryptVoiceCallConfig(apiKey)
            : existing?.api_key_encrypted;
        const encryptedApiSecret = apiSecret
            ? encryptVoiceCallConfig(apiSecret)
            : existing?.api_secret_encrypted;
        if (!encryptedApiKey || !encryptedApiSecret) {
            return res.status(400).json({
                success: false,
                message: "Both LiveKit API key and secret are required",
            });
        }

        await pool.query(
            `INSERT INTO in_app_voice_call_settings
                (id, enabled, server_url, api_key_encrypted, api_secret_encrypted, updated_by)
             VALUES (1, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                server_url = VALUES(server_url),
                api_key_encrypted = VALUES(api_key_encrypted),
                api_secret_encrypted = VALUES(api_secret_encrypted),
                updated_by = VALUES(updated_by)`,
            [
                enabled,
                serverUrl,
                encryptedApiKey,
                encryptedApiSecret,
                requestUsername(req),
            ]
        );

        return res.status(200).json({
            success: true,
            message: "LiveKit settings saved",
            data: {
                configured: true,
                enabled: enabled === 1,
                server_url: serverUrl,
                has_api_key: true,
                has_api_secret: true,
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to save LiveKit settings");
    }
});

router.delete("/admin/settings", auth, requirePlatformAdmin, async (_req, res) => {
    try {
        await pool.query(
            "DELETE FROM in_app_voice_call_settings WHERE id = 1"
        );
        return res.status(200).json({
            success: true,
            message: "LiveKit settings deleted and app-to-app calling disabled",
        });
    } catch (error) {
        return sendError(res, error, "Failed to delete LiveKit settings");
    }
});

async function getStaffCaller(branchId, username) {
    const [rows] = await pool.query(
        `SELECT bm.type, p.name
         FROM branch_mapping bm
         JOIN users u ON u.username = bm.username AND u.status = '1'
         LEFT JOIN profile p ON p.username = bm.username AND p.status = '1'
         WHERE bm.branch_id = ?
           AND bm.username = ?
           AND bm.type IN ('admin', 'staff')
           AND bm.is_deleted = '0'
           AND bm.status = '1'
           AND bm.is_accepted = '1'
         ORDER BY p.id DESC
         LIMIT 1`,
        [branchId, username]
    );
    if (!rows.length) {
        const error = new Error("Only active branch admins and staff can place client calls");
        error.status = 403;
        throw error;
    }
    return {
        username,
        name: String(rows[0].name || "Branch staff"),
    };
}

async function getBranchRecipient(branchId, username, panel = "client") {
    if (panel === "enduser") {
        const [rows] = await pool.query(
            `SELECT bm.username, p.name
             FROM branch_mapping bm
             JOIN users u ON u.username = bm.username AND u.status = '1'
             LEFT JOIN profile p ON p.username = bm.username AND p.status = '1'
             WHERE bm.branch_id = ? AND bm.username = ?
               AND bm.type IN ('admin', 'staff')
               AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'
             ORDER BY p.id DESC
             LIMIT 1`,
            [branchId, username]
        );
        if (!rows.length) {
            const error = new Error("Staff member is not active in this branch");
            error.status = 404;
            throw error;
        }
        return { username, name: String(rows[0].name || "Branch staff") };
    }
    if (!["client", "ca"].includes(panel)) {
        const error = new Error("recipient_panel must be client, ca, or enduser");
        error.status = 400;
        throw error;
    }
    const [rows] = await pool.query(
        `SELECT c.username, c.status, p.name
         FROM clients c
         LEFT JOIN profile p ON p.username = c.username AND p.status = '1'
         WHERE c.username = ?
           AND c.branch_id = ?
           AND c.user_type = ?
           AND c.status = '1'
           AND c.is_deleted = '0'
         ORDER BY p.id DESC
         LIMIT 1`,
        [username, branchId, panel]
    );
    if (!rows.length) {
        const error = new Error(`${panel === "ca" ? "CA" : "Client"} is not active in this branch`);
        error.status = 404;
        throw error;
    }

    if (panel === "ca") {
        const [deviceRows] = await pool.query(
            "SELECT 1 FROM fcm_tokens WHERE username = ? AND panel = 'ca' LIMIT 1",
            [username]
        );
        if (!deviceRows.length) {
            const error = new Error("This CA has not registered the OOMS mobile app");
            error.status = 409;
            throw error;
        }
    }

    return {
        username,
        name: String(rows[0].name || (panel === "ca" ? "CA" : "Client")),
    };
}

async function hasRegisteredCallPushToken(username, panel) {
    const [rows] = await pool.query(
        `SELECT 1
         FROM fcm_tokens
         WHERE username = ? AND panel = ?
         LIMIT 1`,
        [username, panel]
    );
    return rows.length > 0;
}

async function getVoiceCallBranchName(branchId) {
    const [rows] = await pool.query(
        "SELECT name FROM branch_list WHERE branch_id = ? LIMIT 1",
        [branchId]
    );
    return String(rows[0]?.name || "").trim();
}

export async function resolveVoiceCallCapability({
    callerPanel,
    callerUsername,
    branchId,
    recipientUsername,
    recipientPanel = "client",
}) {
    const username = String(recipientUsername || "").trim();
    const panel = String(recipientPanel || "client").trim().toLowerCase();
    if (!["client", "ca", "enduser"].includes(panel)) {
        const error = new Error("recipient_panel must be client, ca, or enduser");
        error.status = 400;
        throw error;
    }
    if (!username || username.length > 50) {
        const error = new Error("A valid recipient_username is required");
        error.status = 400;
        throw error;
    }

    let caller;
    if (callerPanel === "enduser") {
        caller = await getStaffCaller(branchId, callerUsername);
    } else if (callerPanel !== "client") {
        const error = new Error("Authenticate with an active OOMS staff or client session");
        error.status = 401;
        throw error;
    }

    try {
        await liveKitConfig();
    } catch (error) {
        if (error?.status === 503) {
            return {
                can_call: false,
                reason: error.message === "In-app voice calling is not enabled"
                    ? "disabled"
                    : "provider_not_configured",
                is_online: false,
            };
        }
        throw error;
    }

    if (callerPanel === "client") {
        if (panel !== "enduser") {
            const error = new Error("Clients can only call assigned staff");
            error.status = 403;
            throw error;
        }
        await getAssignedStaff(branchId, callerUsername, username);
        const isOnline = hasConnectedStaffVoiceCallSocket(username);
        const mobileReachable = await hasRegisteredCallPushToken(username, "enduser");
        return {
            can_call: isOnline || mobileReachable,
            is_online: isOnline,
            ...(!isOnline && !mobileReachable ? { reason: "staff_offline" } : {}),
        };
    }

    try {
        await getBranchRecipient(branchId, username, panel);
    } catch (error) {
        if (error?.status === 409) {
            return { can_call: false, reason: error.message };
        }
        throw error;
    }
    const isOnline = panel === "client"
        ? hasConnectedClientVoiceCallSocket(username)
        : panel === "enduser"
            ? hasConnectedStaffVoiceCallSocket(username)
            : hasConnectedCAVoiceCallSocket(username);
    const mobileReachable = await hasRegisteredCallPushToken(username, panel);
    if (!isOnline && !mobileReachable) {
        return {
            can_call: false,
            is_online: isOnline,
            reason: panel === "enduser"
                ? "staff_offline"
                : panel === "ca"
                    ? "ca_offline"
                    : "client_offline",
            caller_role: caller.type,
        };
    }
    return {
        can_call: true,
        is_online: isOnline,
        caller_role: caller.type,
    };
}

async function getAssignedStaff(branchId, clientUsername, staffUsername) {
    const [rows] = await pool.query(
        `SELECT bm.username, p.name
         FROM branch_mapping bm
         JOIN users u ON u.username = bm.username AND u.status = '1'
         LEFT JOIN profile p ON p.username = bm.username AND p.status = '1'
         WHERE bm.branch_id = ?
           AND bm.username = ?
           AND bm.type IN ('admin', 'staff')
           AND bm.is_deleted = '0'
           AND bm.status = '1'
           AND bm.is_accepted = '1'
           AND EXISTS (
               SELECT 1
               FROM task_staffs ts
               JOIN tasks t ON t.task_id = ts.task_id AND t.branch_id = ts.branch_id
               WHERE ts.branch_id = ?
                 AND ts.username = bm.username
                 AND ts.is_deleted = '0'
                 AND t.username = ?
                 AND t.status IN ('in process', 'pending from client', 'pending from department')
           )
         ORDER BY p.id DESC
         LIMIT 1`,
        [branchId, staffUsername, branchId, clientUsername]
    );
    if (!rows.length) {
        const error = new Error("This staff member is not assigned to your active tasks");
        error.status = 403;
        throw error;
    }
    return {
        username: String(rows[0].username),
        name: String(rows[0].name || "Assigned staff"),
    };
}

async function getClientIdentity(branchId, username) {
    const [rows] = await pool.query(
        `SELECT p.name
         FROM clients c
         LEFT JOIN profile p ON p.username = c.username AND p.status = '1'
         WHERE c.username = ?
           AND c.branch_id = ?
           AND c.user_type = 'client'
           AND c.status = '1'
           AND c.is_deleted = '0'
         ORDER BY p.id DESC
         LIMIT 1`,
        [username, branchId]
    );
    if (!rows.length) {
        const error = new Error("Client is not active in this branch");
        error.status = 404;
        throw error;
    }
    return { username, name: String(rows[0].name || "Client") };
}

export async function updateExpiredInvites() {
    await pool.query(
        `UPDATE in_app_voice_calls
         SET status = 'missed', end_reason = 'timeout', ended_at = NOW()
         WHERE status = 'ringing' AND expires_at <= NOW()`
    );
}

async function findActiveCallsForParticipants(connection, config, firstUsername, secondUsername) {
    const [activeRows] = await connection.query(
        `SELECT call_id, provider_room, status, connected_at,
                accepted_at <= DATE_SUB(NOW(), INTERVAL ${ACCEPTED_CALL_EMPTY_ROOM_GRACE_SECONDS} SECOND)
                    AS accepted_join_grace_elapsed
         FROM in_app_voice_calls
         WHERE status IN ('ringing', 'accepted')
           AND (
               client_username IN (?, ?) OR caller_username IN (?, ?)
           )`,
        [firstUsername, secondUsername, firstUsername, secondUsername]
    );
    if (!activeRows.length) return activeRows;

    const rooms = await roomService(config).listRooms(
        activeRows.map((call) => call.provider_room)
    );
    const roomsByName = new Map(rooms.map((room) => [room.name, room]));
    for (const call of activeRows) {
        const room = roomsByName.get(call.provider_room);
        const roomMissing = !room;
        const roomHasNoParticipants =
            Boolean(room) && Number(room.numParticipants) === 0;
        const acceptedRoomEmpty =
            call.status === "accepted" &&
            roomHasNoParticipants &&
            (Boolean(call.connected_at) ||
                Number(call.accepted_join_grace_elapsed) === 1);
        if (roomMissing || acceptedRoomEmpty) {
            await connection.query(
                `UPDATE in_app_voice_calls
                 SET status = IF(status = 'ringing', 'missed', 'ended'),
                     end_reason = ?, ended_at = NOW()
                 WHERE call_id = ? AND status IN ('ringing', 'accepted')`,
                [
                    roomMissing ? "provider_room_missing" : "provider_room_empty",
                    call.call_id,
                ]
            );
            if (acceptedRoomEmpty) {
                scheduleCallRoomCleanup(call);
            }
        }
    }

    return activeRows.filter((call) => {
        const room = roomsByName.get(call.provider_room);
        return room &&
            !(
                call.status === "accepted" &&
                Number(room.numParticipants) === 0 &&
                (Boolean(call.connected_at) ||
                    Number(call.accepted_join_grace_elapsed) === 1)
            );
    });
}

export async function reconcileVoiceCallsAfterSocketDisconnect(identity) {
    const username = String(identity?.username || "").trim();
    if (!username) return;

    const [calls] = await pool.query(
        `SELECT call_id, provider_room
         FROM in_app_voice_calls
         WHERE status = 'accepted'
           AND (caller_username = ? OR client_username = ?)`,
        [username, username]
    );
    if (!calls.length) return;

    const config = await liveKitConfig({ requireEnabled: false });
    const service = roomService(config);
    const rooms = await service.listRooms(calls.map((call) => call.provider_room));
    const roomsByName = new Map(rooms.map((room) => [room.name, room]));

    for (const call of calls) {
        const room = roomsByName.get(call.provider_room);
        if (room && Number(room.numParticipants) > 0) continue;

        const [result] = await pool.query(
            `UPDATE in_app_voice_calls
             SET status = 'ended', end_reason = 'participant_disconnected',
                 ended_at = NOW()
             WHERE call_id = ? AND status = 'accepted'`,
            [call.call_id]
        );
        if (result.affectedRows) {
            scheduleCallRoomCleanup(call);
        }
    }
}

async function loadAuthorizedCall(callId, branchId, username, participant) {
    const [rows] = await pool.query(
            `SELECT c.call_id, c.branch_id, bl.name AS branch_name,
                c.caller_username, c.client_username,
                c.caller_name, c.client_name, c.initiated_by, c.recipient_panel,
                c.provider_room, c.status, c.accepted_by_session_hash,
                c.expires_at, c.accepted_at,
                c.ended_at, c.end_reason, c.create_date
             FROM in_app_voice_calls c
             LEFT JOIN branch_list bl ON bl.branch_id = c.branch_id
             WHERE c.call_id = ?
               AND c.branch_id = ?
               AND c.${participant === "client" ? "client_username" : "caller_username"} = ?
         LIMIT 1`,
        [callId, branchId, username]
    );
    if (!rows.length) {
        const error = new Error("Voice call not found");
        error.status = 404;
        throw error;
    }
    return rows[0];
}

function endedByName(call) {
    return ({
        caller_cancelled: call.caller_name,
        caller_ended: call.caller_name,
        client_ended: call.client_name,
        client_cancelled: call.client_name,
        staff_ended: call.client_name,
        staff_cancelled: call.client_name,
        ca_ended: call.client_name,
        ca_cancelled: call.client_name,
    }[call.end_reason] || null);
}

function callView(call, participant, sessionDeclined = false) {
    return {
        call_id: call.call_id,
        status: call.status,
        session_declined: sessionDeclined,
        other_participant_name:
            participant === "client" ? call.caller_name : call.client_name,
        other_participant_username:
            participant === "client" ? call.caller_username : call.client_username,
        branch_id: call.branch_id,
        branch_name: call.branch_name || "",
        expires_at: call.expires_at,
        accepted_at: call.accepted_at,
        accepted_by_name: call.status === "accepted"
            ? call.initiated_by === "client" ? call.caller_name : call.client_name
            : null,
        ended_at: call.ended_at,
        end_reason: call.end_reason,
        ended_by_name: endedByName(call),
        create_date: call.create_date,
    };
}

async function issueParticipantToken(call, participant) {
    const config = await liveKitConfig({ requireEnabled: false });
    if (call.status !== "accepted") {
        const error = new Error("The call must be accepted before joining");
        error.status = 409;
        throw error;
    }
    const token = new AccessToken(config.apiKey, config.apiSecret, {
        identity: `${call.call_id}:${participant}`,
        name: participant === "client" ? call.client_name : call.caller_name,
        ttl: "2h",
    });
    token.addGrant({
        roomJoin: true,
        room: call.provider_room,
        canPublishSources: [
            TrackSource.MICROPHONE,
            TrackSource.SCREEN_SHARE,
        ],
        canSubscribe: true,
        canPublishData: false,
    });
    return {
        server_url: config.serverUrl,
        room_name: call.provider_room,
        token: await token.toJwt(),
    };
}

async function deleteCallRoom(call) {
    try {
        const config = await liveKitConfig({ requireEnabled: false });
        await roomService(config).deleteRoom(call.provider_room);
    } catch (error) {
        if (error?.status !== 503) {
            console.error("IN-APP VOICE ROOM CLEANUP ERROR:", error);
        }
    }
}

function scheduleCallRoomCleanup(call) {
    const timer = setTimeout(() => {
        void deleteCallRoom(call);
    }, ENDED_ROOM_CLEANUP_DELAY_MS);
    timer.unref?.();
}

router.post("/create", auth, validateBranch, async (req, res) => {
    let createdRoom = "";
    try {
        const branchId = req.branch_id;
        const callerUsername = requestUsername(req);
        const caller = await getStaffCaller(branchId, callerUsername);
        const recipientPanel = String(req.body?.recipient_panel || "client").trim().toLowerCase();
        const clientUsername = String(req.body?.recipient_username || req.body?.client_username || "").trim();
        if (!["client", "ca", "enduser"].includes(recipientPanel)) {
            return res.status(400).json({
                success: false,
                message: "recipient_panel must be client, ca, or enduser",
            });
        }
        if (!clientUsername || clientUsername.length > 50) {
            return res.status(400).json({
                success: false,
                message: "A valid recipient_username is required",
            });
        }
        if (clientUsername === callerUsername) {
            return res.status(400).json({
                success: false,
                message: "You cannot call your own account",
            });
        }

        const rawKey =
            req.headers["idempotency-key"] || req.body?.idempotency_key || "";
        const idempotencyKey = String(rawKey).trim();
        if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
            return res.status(400).json({
                success: false,
                message: "A valid Idempotency-Key is required",
            });
        }

        const config = await liveKitConfig();
        const client = await getBranchRecipient(branchId, clientUsername, recipientPanel);
        const branchName = await getVoiceCallBranchName(branchId);
        await updateExpiredInvites();
        const [existingRows] = await pool.query(
            `SELECT call_id, client_username, status, expires_at, create_date, recipient_panel
             FROM in_app_voice_calls
             WHERE caller_username = ? AND idempotency_key = ?
             LIMIT 1`,
            [callerUsername, idempotencyKey]
        );
        if (existingRows.length) {
            const existing = existingRows[0];
            if (existing.client_username !== clientUsername || existing.recipient_panel !== recipientPanel) {
                return res.status(409).json({
                    success: false,
                    message: "Idempotency-Key was already used for a different client",
                });
            }
            return res.status(200).json({
                success: true,
                data: {
                    call_id: existing.call_id,
                    status: existing.status,
                    other_participant_name: client.name,
                    other_participant_username: clientUsername,
                    branch_id: branchId,
                    branch_name: branchName,
                    expires_at: existing.expires_at,
                    create_date: existing.create_date,
                },
            });
        }

        const callId = crypto.randomUUID();
        const providerRoom = `voice_${callId.replace(/-/g, "")}`;
        await roomService(config).createRoom({
            name: providerRoom,
            emptyTimeout: 60,
            maxParticipants: 2,
        });
        createdRoom = providerRoom;
        const connection = await pool.getConnection();
        let transactionStarted = false;
        try {
            await connection.beginTransaction();
            transactionStarted = true;

            const [lockedCallerRows] = await connection.query(
                `SELECT id
                 FROM branch_mapping
                 WHERE branch_id = ? AND username = ?
                   AND type IN ('admin', 'staff')
                   AND is_deleted = '0' AND status = '1' AND is_accepted = '1'
                 LIMIT 1 FOR UPDATE`,
                [branchId, callerUsername]
            );
            if (!lockedCallerRows.length) {
                const error = new Error("Only active branch admins and staff can place client calls");
                error.status = 403;
                throw error;
            }

            const [retryRows] = await connection.query(
                `SELECT call_id, client_username, status, expires_at, create_date, recipient_panel
                 FROM in_app_voice_calls
                 WHERE caller_username = ? AND idempotency_key = ?
                 LIMIT 1`,
                [callerUsername, idempotencyKey]
            );
            if (retryRows.length) {
                await connection.rollback();
                transactionStarted = false;
                await roomService(config).deleteRoom(providerRoom);
                createdRoom = "";
                if (retryRows[0].client_username !== clientUsername || retryRows[0].recipient_panel !== recipientPanel) {
                    return res.status(409).json({
                        success: false,
                        message: "Idempotency-Key was already used for a different client",
                    });
                }
                return res.status(200).json({
                    success: true,
                    data: {
                        call_id: retryRows[0].call_id,
                        status: retryRows[0].status,
                        other_participant_name: client.name,
                        other_participant_username: clientUsername,
                        branch_id: branchId,
                        branch_name: branchName,
                        expires_at: retryRows[0].expires_at,
                        create_date: retryRows[0].create_date,
                    },
                });
            }

            const [lockedClientRows] = recipientPanel === "enduser"
                ? await connection.query(
                    `SELECT id
                     FROM branch_mapping
                     WHERE branch_id = ? AND username = ?
                       AND type IN ('admin', 'staff')
                       AND is_deleted = '0' AND status = '1' AND is_accepted = '1'
                     LIMIT 1 FOR UPDATE`,
                    [branchId, clientUsername]
                )
                : await connection.query(
                    `SELECT username
                     FROM clients
                     WHERE username = ? AND branch_id = ?
                       AND user_type = ? AND status = '1' AND is_deleted = '0'
                     LIMIT 1 FOR UPDATE`,
                    [clientUsername, branchId, recipientPanel]
                );
            if (!lockedClientRows.length) {
                const error = new Error(
                    recipientPanel === "enduser"
                        ? "Staff member is no longer active in this branch"
                        : "Client is no longer active in this branch"
                );
                error.status = 404;
                throw error;
            }

            const activeRows = await findActiveCallsForParticipants(
                connection,
                config,
                callerUsername,
                clientUsername
            );
            if (activeRows.length) {
                await connection.rollback();
                transactionStarted = false;
                await roomService(config).deleteRoom(providerRoom);
                createdRoom = "";
                return res.status(409).json({
                    success: false,
                    message: "You or this recipient is already in another call",
                });
            }

            const [recentInviteRows] = await connection.query(
                `SELECT COUNT(*) AS total
                 FROM in_app_voice_calls
                 WHERE caller_username = ?
                   AND create_date >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)`,
                [callerUsername]
            );
            if (Number(recentInviteRows[0]?.total || 0) >= MAX_CALL_INVITES_PER_MINUTE) {
                await connection.rollback();
                transactionStarted = false;
                await roomService(config).deleteRoom(providerRoom);
                createdRoom = "";
                return res.status(429).json({
                    success: false,
                    message: "Too many voice call invitations. Try again shortly.",
                });
            }

            const recipientSessionIds = await recipientVoiceCallSessionIds(
                connection,
                clientUsername,
                recipientPanel
            );
            await connection.query(
                `INSERT INTO in_app_voice_calls
                    (call_id, branch_id, caller_username, client_username,
                     caller_name, client_name, initiated_by, recipient_panel, provider_room, status,
                     idempotency_key, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'staff', ?, ?, 'ringing', ?,
                         DATE_ADD(NOW(), INTERVAL ? SECOND))`,
                [
                    callId,
                    branchId,
                    callerUsername,
                    clientUsername,
                    caller.name,
                    client.name,
                    recipientPanel,
                    providerRoom,
                    idempotencyKey,
                    INVITE_TTL_SECONDS,
                ]
            );
            await saveRecipientVoiceCallSessions(connection, callId, recipientSessionIds);
            await connection.commit();
            transactionStarted = false;
        } catch (transactionError) {
            if (transactionStarted) await connection.rollback();
            throw transactionError;
        } finally {
            connection.release();
        }
        createdRoom = "";

        let socketDelivered = false;
        if (recipientPanel === "client") {
            const delivered = emitVoiceCallIncoming(clientUsername, {
                call_id: callId,
                status: "ringing",
                other_participant_name: caller.name,
                other_participant_username: callerUsername,
                branch_id: branchId,
                branch_name: branchName,
            });
            socketDelivered = delivered;
            
            if (!delivered) {
                console.warn("No authenticated client web socket was connected for incoming call", {
                    call_id: callId,
                });
            }
        } else if (recipientPanel === "enduser") {
            socketDelivered = hasConnectedStaffVoiceCallSocket(clientUsername);
            emitStaffVoiceCallIncoming(clientUsername, {
                call_id: callId,
                status: "ringing",
                other_participant_name: caller.name,
                other_participant_username: callerUsername,
                branch_id: branchId,
                branch_name: branchName,
                initiated_by: "staff",
                recipient_panel: "enduser",
            });
        } else if (recipientPanel === "ca") {
            socketDelivered = hasConnectedCAVoiceCallSocket(clientUsername);
            emitCAVoiceCallIncoming(clientUsername, {
                call_id: callId,
                status: "ringing",
                other_participant_name: caller.name,
                other_participant_username: callerUsername,
                branch_id: branchId,
                branch_name: branchName,
                initiated_by: "staff",
                recipient_panel: "ca",
            });
        }

        try {
            await sendPushToUser(
                clientUsername,
                recipientPanel,
                {
                    title: `${caller.name} is calling`,
                    body: `Branch: ${branchName || branchId}`,
                    data: {
                        type: "IN_APP_VOICE_CALL",
                        call_id: callId,
                        panel: recipientPanel,
                        caller_name: caller.name,
                        caller_username: callerUsername,
                        caller_role: caller.type,
                        branch_id: branchId,
                        branch_name: branchName,
                        direction: recipientPanel === "ca"
                            ? "incoming_ca"
                            : recipientPanel === "enduser"
                                ? "incoming_peer"
                                : "incoming",
                    },
                },
                { throwOnError: !socketDelivered }
            );
        } catch (pushError) {
            if (recipientPanel === "ca") {
                await pool.query(
                    `UPDATE in_app_voice_calls
                     SET status = 'failed', end_reason = 'notification_failed',
                         ended_at = NOW()
                     WHERE call_id = ? AND status = 'ringing'`,
                    [callId]
                );
                await deleteCallRoom({ provider_room: providerRoom });
                const error = new Error("Unable to notify the CA about this call");
                error.status = 502;
                error.cause = pushError;
                throw error;
            }
            console.warn(`Unable to push incoming voice call to ${recipientPanel} ${clientUsername}:`, pushError);
        }

        const [createdRows] = await pool.query(
            `SELECT expires_at, create_date
             FROM in_app_voice_calls WHERE call_id = ? LIMIT 1`,
            [callId]
        );
        return res.status(201).json({
            success: true,
            message: recipientPanel === "enduser" ? "Calling staff member" : "Calling client",
            data: {
                call_id: callId,
                status: "ringing",
                other_participant_name: client.name,
                other_participant_username: clientUsername,
                branch_id: branchId,
                branch_name: branchName,
                expires_at: createdRows[0]?.expires_at || null,
                create_date: createdRows[0]?.create_date || null,
            },
        });
    } catch (error) {
        if (createdRoom) {
            try {
                await roomService(await liveKitConfig({ requireEnabled: false })).deleteRoom(createdRoom);
            } catch (cleanupError) {
                console.error("IN-APP VOICE ROOM ROLLBACK ERROR:", cleanupError);
            }
        }
        return sendError(res, error, "Failed to create voice call");
    }
});

router.get("/capability", auth, validateBranch, async (req, res) => {
    try {
        const data = await resolveVoiceCallCapability({
            callerPanel: "enduser",
            callerUsername: requestUsername(req),
            branchId: req.branch_id,
            recipientUsername: req.query.recipient_username || req.query.client_username,
            recipientPanel: req.query.recipient_panel,
            mobileApp: req.query.mobile_app === "true",
        });
        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        return sendError(res, error, "Failed to check voice call availability");
    }
});

router.get("/client/capability", validateClientVoiceCallSession, async (req, res) => {
    try {
        const data = await resolveVoiceCallCapability({
            callerPanel: "client",
            callerUsername: req.client_username,
            branchId: req.branch_id,
            recipientUsername: req.query.staff_username,
            recipientPanel: "enduser",
            mobileApp: req.query.mobile_app === "true",
        });
        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        if (error?.status === 503) {
            return res.status(200).json({
                success: true,
                data: { can_call: false, reason: error.message },
            });
        }
        return sendError(res, error, "Failed to check assigned staff call availability");
    }
});

router.post("/client/create", validateClientVoiceCallSession, async (req, res) => {
    let createdRoom = "";
    try {
        const branchId = req.branch_id;
        const clientUsername = req.client_username;
        const staffUsername = String(req.body?.staff_username || "").trim();
        if (!staffUsername || staffUsername.length > 50 || staffUsername === clientUsername) {
            return res.status(400).json({
                success: false,
                message: "A valid staff_username is required",
            });
        }

        const rawKey = req.headers["idempotency-key"] || req.body?.idempotency_key || "";
        const idempotencyKey = String(rawKey).trim();
        if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
            return res.status(400).json({
                success: false,
                message: "A valid Idempotency-Key is required",
            });
        }

        const [client, staff, config] = await Promise.all([
            getClientIdentity(branchId, clientUsername),
            getAssignedStaff(branchId, clientUsername, staffUsername),
            liveKitConfig(),
        ]);
        const branchName = await getVoiceCallBranchName(branchId);
        await updateExpiredInvites();

        const [existingRows] = await pool.query(
            `SELECT call_id, branch_id, client_username, status, expires_at, create_date
             FROM in_app_voice_calls
             WHERE caller_username = ? AND initiated_by = 'client' AND idempotency_key = ?
             LIMIT 1`,
            [staffUsername, idempotencyKey]
        );
        if (existingRows.length) {
            const existing = existingRows[0];
            if (String(existing.branch_id) !== String(branchId) || existing.client_username !== clientUsername) {
                return res.status(409).json({
                    success: false,
                    message: "Idempotency-Key was already used for a different call",
                });
            }
            return res.status(200).json({
                success: true,
                data: {
                    call_id: existing.call_id,
                    status: existing.status,
                    other_participant_name: staff.name,
                    other_participant_username: staffUsername,
                    branch_id: branchId,
                    branch_name: branchName,
                    expires_at: existing.expires_at,
                    create_date: existing.create_date,
                },
            });
        }

        const connection = await pool.getConnection();
        let transactionStarted = false;
        let callId;
        let providerRoom;
        try {
            await connection.beginTransaction();
            transactionStarted = true;

            const [clientRows] = await connection.query(
                `SELECT username
                 FROM clients
                 WHERE username = ? AND branch_id = ?
                   AND user_type = 'client' AND status = '1' AND is_deleted = '0'
                 LIMIT 1 FOR UPDATE`,
                [clientUsername, branchId]
            );
            if (!clientRows.length) {
                const error = new Error("Client is no longer active in this branch");
                error.status = 404;
                throw error;
            }
            const [assignedRows] = await connection.query(
                `SELECT bm.id
                 FROM branch_mapping bm
                 WHERE bm.branch_id = ? AND bm.username = ?
                   AND bm.type IN ('admin', 'staff')
                   AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'
                   AND EXISTS (
                       SELECT 1
                       FROM task_staffs ts
                       JOIN tasks t ON t.task_id = ts.task_id AND t.branch_id = ts.branch_id
                       WHERE ts.branch_id = bm.branch_id
                         AND ts.username = bm.username AND ts.is_deleted = '0'
                         AND t.username = ?
                         AND t.status IN ('in process', 'pending from client', 'pending from department')
                   )
                 LIMIT 1 FOR UPDATE`,
                [branchId, staffUsername, clientUsername]
            );
            if (!assignedRows.length) {
                const error = new Error("This staff member is no longer assigned to your active tasks");
                error.status = 403;
                throw error;
            }

            const activeRows = await findActiveCallsForParticipants(
                connection,
                config,
                clientUsername,
                staffUsername
            );
            if (activeRows.length) {
                const error = new Error("You or this staff member is already in another call");
                error.status = 409;
                throw error;
            }

            const [recentRows] = await connection.query(
                `SELECT COUNT(*) AS total
                 FROM in_app_voice_calls
                 WHERE client_username = ?
                   AND initiated_by = 'client'
                   AND create_date >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)`,
                [clientUsername]
            );
            if (Number(recentRows[0]?.total || 0) >= MAX_CALL_INVITES_PER_MINUTE) {
                const error = new Error("Too many voice call invitations. Try again shortly.");
                error.status = 429;
                throw error;
            }

            const recipientSessionIds = await recipientVoiceCallSessionIds(
                connection,
                staffUsername,
                "enduser"
            );
            callId = crypto.randomUUID();
            providerRoom = `voice_${callId.replace(/-/g, "")}`;
            await roomService(config).createRoom({
                name: providerRoom,
                emptyTimeout: 60,
                maxParticipants: 2,
            });
            createdRoom = providerRoom;

            await connection.query(
                `INSERT INTO in_app_voice_calls
                    (call_id, branch_id, caller_username, client_username,
                     caller_name, client_name, initiated_by, recipient_panel,
                     provider_room, status, idempotency_key, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'client', 'enduser', ?, 'ringing', ?,
                         DATE_ADD(NOW(), INTERVAL ? SECOND))`,
                [
                    callId,
                    branchId,
                    staffUsername,
                    clientUsername,
                    staff.name,
                    client.name,
                    providerRoom,
                    idempotencyKey,
                    INVITE_TTL_SECONDS,
                ]
            );
            await saveRecipientVoiceCallSessions(connection, callId, recipientSessionIds);
            await connection.commit();
            transactionStarted = false;
            createdRoom = "";
        } catch (transactionError) {
            if (transactionStarted) await connection.rollback();
            throw transactionError;
        } finally {
            connection.release();
        }

        const socketDelivered = hasConnectedStaffVoiceCallSocket(staffUsername);
        emitStaffVoiceCallIncoming(staffUsername, {
            call_id: callId,
            status: "ringing",
            other_participant_name: client.name,
            other_participant_username: clientUsername,
            branch_id: branchId,
            branch_name: branchName,
            initiated_by: "client",
            recipient_panel: "enduser",
        });

        try {
            await sendPushToUser(
                staffUsername,
                "enduser",
                {
                    title: `${client.name} is calling`,
                    body: `Branch: ${branchName || branchId}`,
                    data: {
                        type: "IN_APP_VOICE_CALL",
                        call_id: callId,
                        panel: "enduser",
                        caller_name: client.name,
                        caller_username: clientUsername,
                        caller_role: "client",
                        branch_id: branchId,
                        branch_name: branchName,
                        direction: "incoming_staff",
                    },
                },
                { throwOnError: !socketDelivered }
            );
        } catch (pushError) {
            console.warn(`Unable to push incoming voice call to staff ${staffUsername}:`, pushError);
        }

        const [createdRows] = await pool.query(
            `SELECT expires_at, create_date
             FROM in_app_voice_calls WHERE call_id = ? LIMIT 1`,
            [callId]
        );
        return res.status(201).json({
            success: true,
            message: "Calling assigned staff",
            data: {
                call_id: callId,
                status: "ringing",
                other_participant_name: staff.name,
                other_participant_username: staffUsername,
                branch_id: branchId,
                branch_name: branchName,
                expires_at: createdRows[0]?.expires_at || null,
                create_date: createdRows[0]?.create_date || null,
            },
        });
    } catch (error) {
        if (createdRoom) {
            try {
                await roomService(await liveKitConfig({ requireEnabled: false })).deleteRoom(createdRoom);
            } catch (cleanupError) {
                console.error("IN-APP VOICE ROOM ROLLBACK ERROR:", cleanupError);
            }
        }
        return sendError(res, error, "Failed to create voice call");
    }
});

const VOICE_CALL_HISTORY_STATUSES = new Set([
    "ringing",
    "accepted",
    "rejected",
    "cancelled",
    "missed",
    "ended",
    "failed",
]);

async function loadVoiceCallHistory({ branchId, username, panel, page, limit, status, direction }) {
    const offset = (page - 1) * limit;
    let where;
    let whereParams;
    let otherName;
    let otherUsername;
    let callDirection;
    let selectParams = [];

    if (panel === "enduser") {
        where = `c.branch_id = ?
                 AND (c.caller_username = ?
                      OR (c.client_username = ? AND c.recipient_panel = 'enduser'))`;
        whereParams = [branchId, username, username];
        otherName = "CASE WHEN c.caller_username = ? THEN c.client_name ELSE c.caller_name END";
        otherUsername = "CASE WHEN c.caller_username = ? THEN c.client_username ELSE c.caller_username END";
        callDirection = `CASE
            WHEN (c.caller_username = ? AND c.initiated_by = 'client')
              OR (c.client_username = ? AND c.recipient_panel = 'enduser')
            THEN 'incoming' ELSE 'outgoing' END`;
        selectParams = [username, username, username, username];
    } else {
        where = "c.branch_id = ? AND c.client_username = ?";
        whereParams = [branchId, username];
        if (panel === "ca") where += " AND c.recipient_panel = 'ca'";
        otherName = "c.caller_name";
        otherUsername = "c.caller_username";
        callDirection = panel === "ca"
            ? "'incoming'"
            : "CASE WHEN c.initiated_by = 'client' THEN 'outgoing' ELSE 'incoming' END";
    }

    const baseQuery = `SELECT c.call_id, c.status, c.branch_id,
                              bl.name AS branch_name,
                              ${callDirection} AS direction,
                              ${otherName} AS other_participant_name,
                              ${otherUsername} AS other_participant_username,
                              c.initiated_by, c.recipient_panel,
                              c.create_date, c.accepted_at, c.ended_at, c.end_reason,
                              CASE WHEN c.accepted_at IS NULL THEN NULL
                                   ELSE TIMESTAMPDIFF(SECOND, c.accepted_at,
                                       COALESCE(c.ended_at, NOW())) END AS duration_seconds
                       FROM in_app_voice_calls c
                       LEFT JOIN branch_list bl ON bl.branch_id = c.branch_id
                       WHERE ${where}`;
    const filterSql = [];
    const filterParams = [];
    if (status) {
        filterSql.push("history.status = ?");
        filterParams.push(status);
    }
    if (direction) {
        filterSql.push("history.direction = ?");
        filterParams.push(direction);
    }
    const filtered = filterSql.length ? `WHERE ${filterSql.join(" AND ")}` : "";
    const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM (${baseQuery}) history ${filtered}`,
        [...selectParams, ...whereParams, ...filterParams]
    );
    const [rows] = await pool.query(
        `SELECT * FROM (${baseQuery}) history ${filtered}
         ORDER BY history.create_date DESC, history.call_id DESC
         LIMIT ? OFFSET ?`,
        [...selectParams, ...whereParams, ...filterParams, limit, offset]
    );
    const total = Number(countRows[0]?.total || 0);
    return {
        items: rows,
        pagination: {
            page,
            limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / limit)),
        },
    };
}

function voiceCallHistoryOptions(req) {
    const requestedPage = Number.parseInt(req.query?.page, 10);
    const requestedLimit = Number.parseInt(req.query?.limit, 10);
    const status = String(req.query?.status || "").trim().toLowerCase();
    const direction = String(req.query?.direction || "").trim().toLowerCase();
    if (status && !VOICE_CALL_HISTORY_STATUSES.has(status)) {
        const error = new Error("Invalid voice call status filter");
        error.status = 400;
        throw error;
    }
    if (direction && !["incoming", "outgoing"].includes(direction)) {
        const error = new Error("direction must be incoming or outgoing");
        error.status = 400;
        throw error;
    }
    return {
        page: Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1,
        limit: Number.isFinite(requestedLimit)
            ? Math.min(100, Math.max(1, requestedLimit))
            : 25,
        status: status || null,
        direction: direction || null,
    };
}

router.get("/history", auth, validateBranch, async (req, res) => {
    try {
        res.set("Cache-Control", "no-store");
        const data = await loadVoiceCallHistory({
            branchId: req.branch_id,
            username: requestUsername(req),
            panel: "enduser",
            ...voiceCallHistoryOptions(req),
        });
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call history");
    }
});

router.get("/client/history", validateClientVoiceCallSession, async (req, res) => {
    try {
        res.set("Cache-Control", "no-store");
        const data = await loadVoiceCallHistory({
            branchId: req.branch_id,
            username: req.client_username,
            panel: "client",
            ...voiceCallHistoryOptions(req),
        });
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call history");
    }
});

router.get("/ca/history", validateCaSession, async (req, res) => {
    try {
        res.set("Cache-Control", "no-store");
        const data = await loadVoiceCallHistory({
            branchId: req.branch_id,
            username: req.ca_username,
            panel: "ca",
            ...voiceCallHistoryOptions(req),
        });
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call history");
    }
});

router.get("/client/incoming", validateClientVoiceCallSession, async (req, res) => {
    try {
        res.set("Cache-Control", "no-store");
        await updateExpiredInvites();
        const [rows] = await pool.query(
            `SELECT call_id, status, caller_name AS other_participant_name,
                    expires_at, accepted_at, ended_at, end_reason, create_date
             FROM in_app_voice_calls
             WHERE branch_id = ? AND client_username = ?
               AND initiated_by = 'staff' AND recipient_panel = 'client'
               AND status = 'ringing' AND expires_at > NOW()
               AND NOT EXISTS (
                   SELECT 1 FROM in_app_voice_call_sessions s
                   WHERE s.call_id = in_app_voice_calls.call_id
                     AND s.session_id = ? AND s.status = 'declined'
               )
             ORDER BY create_date DESC
             LIMIT 1`,
            [req.branch_id, req.client_username, requestVoiceCallSessionId(req)]
        );
        return res.status(200).json({ success: true, data: rows[0] || null });
    } catch (error) {
        return sendError(res, error, "Failed to check incoming voice calls");
    }
});

router.get("/incoming", auth, validateBranch, async (req, res) => {
    try {
        await updateExpiredInvites();
        const [rows] = await pool.query(
            `SELECT call_id, status,
                    CASE WHEN initiated_by = 'staff'
                         THEN caller_name ELSE client_name END AS other_participant_name,
                    initiated_by, recipient_panel,
                    expires_at, accepted_at, ended_at, end_reason, create_date
             FROM in_app_voice_calls
             WHERE branch_id = ?
               AND (
                   (caller_username = ? AND initiated_by = 'client' AND recipient_panel = 'enduser')
                   OR (client_username = ? AND initiated_by = 'staff' AND recipient_panel = 'enduser')
               )
               AND status = 'ringing' AND expires_at > NOW()
               AND NOT EXISTS (
                   SELECT 1 FROM in_app_voice_call_sessions s
                   WHERE s.call_id = in_app_voice_calls.call_id
                     AND s.session_id = ? AND s.status = 'declined'
               )
             ORDER BY create_date DESC
             LIMIT 1`,
            [
                req.branch_id,
                requestUsername(req),
                requestUsername(req),
                requestVoiceCallSessionId(req),
            ]
        );
        return res.status(200).json({ success: true, data: rows[0] || null });
    } catch (error) {
        return sendError(res, error, "Failed to check incoming voice calls");
    }
});

router.get("/ca/incoming", validateCaSession, async (req, res) => {
    try {
        await updateExpiredInvites();
        const [rows] = await pool.query(
            `SELECT call_id, status, caller_name AS other_participant_name,
                    expires_at, accepted_at, ended_at, end_reason, create_date
             FROM in_app_voice_calls
             WHERE branch_id = ? AND client_username = ?
               AND initiated_by = 'staff' AND recipient_panel = 'ca'
               AND status = 'ringing' AND expires_at > NOW()
               AND NOT EXISTS (
                   SELECT 1 FROM in_app_voice_call_sessions s
                   WHERE s.call_id = in_app_voice_calls.call_id
                     AND s.session_id = ? AND s.status = 'declined'
               )
             ORDER BY create_date DESC
             LIMIT 1`,
            [req.branch_id, req.ca_username, requestVoiceCallSessionId(req)]
        );
        return res.status(200).json({ success: true, data: rows[0] || null });
    } catch (error) {
        return sendError(res, error, "Failed to check incoming voice calls");
    }
});

router.get("/:call_id", auth, validateBranch, async (req, res) => {
    try {
        await updateExpiredInvites();
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            requestUsername(req),
            "caller"
        );
        return res.status(200).json({
            success: true,
            data: {
                ...callView(call, "caller", await hasDeclinedCallSession(call.call_id, req)),
                accepted_on_another_device:
                    call.initiated_by === "client" &&
                    call.recipient_panel === "enduser" &&
                    call.status === "accepted" &&
                    Boolean(call.accepted_by_session_hash) &&
                    call.accepted_by_session_hash !== requestVoiceCallSessionHash(req),
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call");
    }
});

router.post("/:call_id/respond", auth, validateBranch, async (req, res) => {
    try {
        const action = String(req.body?.action || "").toLowerCase();
        if (!["accept", "decline"].includes(action)) {
            return res.status(400).json({
                success: false,
                message: "action must be accept or decline",
            });
        }
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            requestUsername(req),
            "caller"
        );
        if (call.initiated_by !== "client" || call.recipient_panel !== "enduser") {
            return res.status(403).json({
                success: false,
                message: "This call is not an incoming client call",
            });
        }
        if (call.status !== "ringing") {
            if (
                action === "accept" &&
                call.status === "accepted" &&
                call.accepted_by_session_hash === requestVoiceCallSessionHash(req)
            ) {
                return res.status(200).json({
                    success: true,
                    data: { call_id: call.call_id, status: "accepted" },
                });
            }
            await updateExpiredInvites();
            return res.status(409).json({
                success: false,
                message: "This call is no longer available",
            });
        }
        if (action === "decline") {
            const status = await declineCallSession(call, req, "staff_declined");
            if (status === "rejected") await deleteCallRoom(call);
            return res.status(200).json({
                success: true,
                data: { call_id: call.call_id, status, session_declined: true },
            });
        }
        const nextStatus = "accepted";
        const [result] = await pool.query(
            `UPDATE in_app_voice_calls
             SET status = ?, accepted_at = IF(? = 'accepted', NOW(), accepted_at),
                 accepted_by_session_hash = IF(? = 'accepted', ?, accepted_by_session_hash),
                 end_reason = IF(? = 'rejected', 'staff_declined', end_reason),
                 ended_at = IF(? = 'rejected', NOW(), ended_at)
             WHERE call_id = ? AND caller_username = ?
               AND initiated_by = 'client' AND recipient_panel = 'enduser'
               AND status = 'ringing' AND expires_at > NOW()`,
            [
                nextStatus,
                nextStatus,
                nextStatus,
                requestVoiceCallSessionHash(req),
                nextStatus,
                nextStatus,
                call.call_id,
                requestUsername(req),
            ]
        );
        if (result.affectedRows !== 1) {
            return res.status(409).json({
                success: false,
                message: "This call has already been answered or ended",
            });
        }
        if (action === "accept") {
            void notifyCallAnswered(
                call,
                requestUsername(req),
                "enduser",
                call.caller_name,
                requestVoiceCallSessionId(req),
                req.headers["x-fcm-token"]
            );
        }
        return res.status(200).json({
            success: true,
            data: { call_id: call.call_id, status: nextStatus },
        });
    } catch (error) {
        return sendError(res, error, "Failed to respond to voice call");
    }
});

router.post("/:call_id/token", auth, validateBranch, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            requestUsername(req),
            "caller"
        );
        if (
            call.initiated_by === "client" &&
            call.recipient_panel === "enduser" &&
            call.accepted_by_session_hash &&
            call.accepted_by_session_hash !== requestVoiceCallSessionHash(req)
        ) {
            return res.status(409).json({
                success: false,
                message: "This call was answered on another office session",
            });
        }
        const data = await issueParticipantToken(call, "caller");
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to join voice call");
    }
});

router.post("/:call_id/end", auth, validateBranch, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            requestUsername(req),
            "caller"
        );
        let nextStatus = call.status;
        if (ACTIVE_CALL_STATUSES.includes(call.status)) {
            nextStatus = call.status === "ringing" ? "cancelled" : "ended";
            const [endResult] = await pool.query(
                `UPDATE in_app_voice_calls
                 SET status = ?, end_reason = ?, ended_at = NOW()
                 WHERE call_id = ? AND caller_username = ?
                   AND status IN ('ringing', 'accepted')`,
                [
                    nextStatus,
                    nextStatus === "cancelled" ? "caller_cancelled" : "caller_ended",
                    call.call_id,
                    requestUsername(req),
                ]
            );
            if (endResult.affectedRows) {
                if (nextStatus === "cancelled") {
                    void notifyCallCancelled(call);
                    await deleteCallRoom(call);
                } else {
                    scheduleCallRoomCleanup(call);
                }
            }
        }
        const finalCall = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            requestUsername(req),
            "caller"
        );
        return res.status(200).json({
            success: true,
            data: {
                status: finalCall.status,
                ended_by_name: endedByName(finalCall),
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to end voice call");
    }
});

router.get("/staff/:call_id", auth, validateBranch, async (req, res) => {
    try {
        await updateExpiredInvites();
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            requestUsername(req),
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "enduser") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        await getStaffCaller(req.branch_id, requestUsername(req));
        return res.status(200).json({
            success: true,
            data: {
                ...callView(call, "client", await hasDeclinedCallSession(call.call_id, req)),
                accepted_on_another_device:
                    call.status === "accepted" &&
                    Boolean(call.accepted_by_session_hash) &&
                    call.accepted_by_session_hash !== requestVoiceCallSessionHash(req),
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to load incoming staff call");
    }
});

router.post("/staff/:call_id/respond", auth, validateBranch, async (req, res) => {
    try {
        const action = String(req.body?.action || "").toLowerCase();
        if (!["accept", "decline"].includes(action)) {
            return res.status(400).json({
                success: false,
                message: "action must be accept or decline",
            });
        }
        const username = requestUsername(req);
        await getStaffCaller(req.branch_id, username);
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            username,
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "enduser") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        if (call.status !== "ringing") {
            if (
                action === "accept" &&
                call.status === "accepted" &&
                call.accepted_by_session_hash === requestVoiceCallSessionHash(req)
            ) {
                return res.status(200).json({
                    success: true,
                    data: { call_id: call.call_id, status: "accepted" },
                });
            }
            await updateExpiredInvites();
            return res.status(409).json({
                success: false,
                message: "This call is no longer available",
            });
        }
        if (action === "decline") {
            const status = await declineCallSession(call, req, "staff_declined");
            if (status === "rejected") await deleteCallRoom(call);
            return res.status(200).json({
                success: true,
                data: { call_id: call.call_id, status, session_declined: true },
            });
        }
        const nextStatus = "accepted";
        const [result] = await pool.query(
            `UPDATE in_app_voice_calls
             SET status = ?, accepted_at = IF(? = 'accepted', NOW(), accepted_at),
                 accepted_by_session_hash = IF(? = 'accepted', ?, accepted_by_session_hash),
                 end_reason = IF(? = 'rejected', 'staff_declined', end_reason),
                 ended_at = IF(? = 'rejected', NOW(), ended_at)
             WHERE call_id = ? AND client_username = ?
               AND initiated_by = 'staff' AND recipient_panel = 'enduser'
               AND status = 'ringing' AND expires_at > NOW()`,
            [
                nextStatus,
                nextStatus,
                nextStatus,
                requestVoiceCallSessionHash(req),
                nextStatus,
                nextStatus,
                call.call_id,
                username,
            ]
        );
        if (result.affectedRows !== 1) {
            return res.status(409).json({
                success: false,
                message: "This call has already been answered or ended",
            });
        }
        if (action === "accept") {
            void notifyCallAnswered(
                call,
                username,
                "enduser",
                call.client_name,
                requestVoiceCallSessionId(req),
                req.headers["x-fcm-token"]
            );
        }
        return res.status(200).json({
            success: true,
            data: { call_id: call.call_id, status: nextStatus },
        });
    } catch (error) {
        return sendError(res, error, "Failed to respond to incoming staff call");
    }
});

router.post("/staff/:call_id/token", auth, validateBranch, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            requestUsername(req),
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "enduser") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        if (
            call.accepted_by_session_hash &&
            call.accepted_by_session_hash !== requestVoiceCallSessionHash(req)
        ) {
            return res.status(409).json({
                success: false,
                message: "This call was answered on another office session",
            });
        }
        await getStaffCaller(req.branch_id, requestUsername(req));
        const data = await issueParticipantToken(call, "client");
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to join incoming staff call");
    }
});

router.post("/staff/:call_id/end", auth, validateBranch, async (req, res) => {
    try {
        const username = requestUsername(req);
        await getStaffCaller(req.branch_id, username);
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            username,
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "enduser") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        if (ACTIVE_CALL_STATUSES.includes(call.status)) {
            const nextStatus = call.status === "ringing" ? "cancelled" : "ended";
            const [endResult] = await pool.query(
                `UPDATE in_app_voice_calls
                 SET status = ?, end_reason = ?, ended_at = NOW()
                 WHERE call_id = ? AND client_username = ?
                   AND status IN ('ringing', 'accepted')`,
                [
                    nextStatus,
                    nextStatus === "cancelled" ? "staff_cancelled" : "staff_ended",
                    call.call_id,
                    username,
                ]
            );
            if (endResult.affectedRows) {
                if (nextStatus === "cancelled") {
                    void notifyCallCancelled(call);
                    await deleteCallRoom(call);
                } else {
                    scheduleCallRoomCleanup(call);
                }
            }
        }
        const finalCall = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            username,
            "client"
        );
        return res.status(200).json({
            success: true,
            data: {
                status: finalCall.status,
                ended_by_name: endedByName(finalCall),
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to end incoming staff call");
    }
});

router.get("/client/:call_id", validateClientVoiceCallSession, async (req, res) => {
    try {
        await updateExpiredInvites();
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        if (call.recipient_panel !== "client" && call.initiated_by !== "client") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        return res.status(200).json({
            success: true,
            data: {
                ...callView(call, "client", await hasDeclinedCallSession(call.call_id, req)),
                accepted_on_another_device:
                    call.initiated_by === "staff" &&
                    call.recipient_panel === "client" &&
                    call.status === "accepted" &&
                    call.accepted_by_session_hash !== req.client_voice_call_session_hash,
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call");
    }
});

router.post("/client/:call_id/respond", validateClientVoiceCallSession, async (req, res) => {
    try {
        const action = String(req.body?.action || "").toLowerCase();
        if (!["accept", "decline"].includes(action)) {
            return res.status(400).json({
                success: false,
                message: "action must be accept or decline",
            });
        }
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "client") {
            return res.status(403).json({
                success: false,
                message: "This call is not an incoming staff call",
            });
        }
        if (
            action === "accept" &&
            call.status === "accepted" &&
            call.accepted_by_session_hash === req.client_voice_call_session_hash
        ) {
            return res.status(200).json({
                success: true,
                data: { call_id: call.call_id, status: "accepted" },
            });
        }
        if (call.status !== "ringing") {
            await updateExpiredInvites();
            return res.status(409).json({
                success: false,
                message: "This call is no longer available",
            });
        }
        if (action === "decline") {
            const status = await declineCallSession(call, req, "client_declined");
            if (status === "rejected") await deleteCallRoom(call);
            return res.status(200).json({
                success: true,
                data: { call_id: call.call_id, status, session_declined: true },
            });
        }
        const nextStatus = "accepted";
        const [result] = await pool.query(
            `UPDATE in_app_voice_calls
             SET status = ?, accepted_at = IF(? = 'accepted', NOW(), accepted_at),
                 accepted_by_session_hash = IF(? = 'accepted', ?, accepted_by_session_hash),
                 end_reason = IF(? = 'rejected', 'client_declined', end_reason),
                 ended_at = IF(? = 'rejected', NOW(), ended_at)
             WHERE call_id = ? AND client_username = ?
               AND status = 'ringing' AND expires_at > NOW()`,
            [
                nextStatus,
                nextStatus,
                nextStatus,
                req.client_voice_call_session_hash,
                nextStatus,
                nextStatus,
                call.call_id,
                req.client_username,
            ]
        );
        if (result.affectedRows !== 1) {
            return res.status(409).json({
                success: false,
                message: "This call has already been answered on another device or ended",
            });
        }
        if (action === "accept") {
            void notifyCallAnswered(
                call,
                req.client_username,
                "client",
                call.client_name,
                requestVoiceCallSessionId(req),
                req.headers["x-fcm-token"]
            );
        }
        return res.status(200).json({
            success: true,
            data: { call_id: call.call_id, status: nextStatus },
        });
    } catch (error) {
        return sendError(res, error, "Failed to respond to voice call");
    }
});

router.post("/client/:call_id/token", validateClientVoiceCallSession, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        if (
            call.initiated_by === "staff" &&
            call.recipient_panel === "client" &&
            call.accepted_by_session_hash !== req.client_voice_call_session_hash
        ) {
            return res.status(409).json({
                success: false,
                message: "This call was accepted on another device",
            });
        }
        const data = await issueParticipantToken(call, "client");
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to join voice call");
    }
});

router.post("/client/:call_id/end", validateClientVoiceCallSession, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        let nextStatus = call.status;
        if (ACTIVE_CALL_STATUSES.includes(call.status)) {
            nextStatus = call.status === "ringing" ? "cancelled" : "ended";
            const [endResult] = await pool.query(
                `UPDATE in_app_voice_calls
                 SET status = ?, end_reason = ?, ended_at = NOW()
                 WHERE call_id = ? AND client_username = ?
                   AND status IN ('ringing', 'accepted')`,
                [
                    nextStatus,
                    nextStatus === "cancelled" ? "client_cancelled" : "client_ended",
                    call.call_id,
                    req.client_username,
                ]
            );
            if (endResult.affectedRows) {
                if (nextStatus === "cancelled") {
                    void notifyCallCancelled(call);
                    await deleteCallRoom(call);
                } else {
                    scheduleCallRoomCleanup(call);
                }
            }
        }
        const finalCall = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        return res.status(200).json({
            success: true,
            data: {
                status: finalCall.status,
                ended_by_name: endedByName(finalCall),
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to end voice call");
    }
});

router.get("/ca/:call_id", validateCaSession, async (req, res) => {
    try {
        await updateExpiredInvites();
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.ca_username,
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "ca") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        return res.status(200).json({
            success: true,
            data: {
                ...callView(call, "client", await hasDeclinedCallSession(call.call_id, req)),
                accepted_on_another_device:
                    call.status === "accepted" &&
                    Boolean(call.accepted_by_session_hash) &&
                    call.accepted_by_session_hash !== req.ca_voice_call_session_hash,
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call");
    }
});

router.post("/ca/:call_id/respond", validateCaSession, async (req, res) => {
    try {
        const action = String(req.body?.action || "").toLowerCase();
        if (!["accept", "decline"].includes(action)) {
            return res.status(400).json({
                success: false,
                message: "action must be accept or decline",
            });
        }
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.ca_username,
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "ca") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        if (call.status !== "ringing") {
            if (
                action === "accept" &&
                call.status === "accepted" &&
                call.accepted_by_session_hash === req.ca_voice_call_session_hash
            ) {
                return res.status(200).json({
                    success: true,
                    data: { call_id: call.call_id, status: "accepted" },
                });
            }
            await updateExpiredInvites();
            return res.status(409).json({
                success: false,
                message: "This call is no longer available",
            });
        }
        if (action === "decline") {
            const status = await declineCallSession(call, req, "ca_declined");
            if (status === "rejected") await deleteCallRoom(call);
            return res.status(200).json({
                success: true,
                data: { call_id: call.call_id, status, session_declined: true },
            });
        }
        const nextStatus = "accepted";
        const [result] = await pool.query(
            `UPDATE in_app_voice_calls
             SET status = ?, accepted_at = IF(? = 'accepted', NOW(), accepted_at),
                 accepted_by_session_hash = IF(? = 'accepted', ?, accepted_by_session_hash),
                 end_reason = IF(? = 'rejected', 'ca_declined', end_reason),
                 ended_at = IF(? = 'rejected', NOW(), ended_at)
             WHERE call_id = ? AND client_username = ?
               AND initiated_by = 'staff' AND recipient_panel = 'ca'
               AND status = 'ringing' AND expires_at > NOW()`,
            [
                nextStatus,
                nextStatus,
                nextStatus,
                req.ca_voice_call_session_hash,
                nextStatus,
                nextStatus,
                call.call_id,
                req.ca_username,
            ]
        );
        if (result.affectedRows !== 1) {
            return res.status(409).json({
                success: false,
                message: "This call has already been answered or ended",
            });
        }
        if (action === "accept") {
            void notifyCallAnswered(
                call,
                req.ca_username,
                "ca",
                call.client_name,
                requestVoiceCallSessionId(req),
                req.headers["x-fcm-token"]
            );
        }
        return res.status(200).json({
            success: true,
            data: { call_id: call.call_id, status: nextStatus },
        });
    } catch (error) {
        return sendError(res, error, "Failed to respond to voice call");
    }
});

router.post("/ca/:call_id/token", validateCaSession, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.ca_username,
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "ca") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        if (
            call.accepted_by_session_hash &&
            call.accepted_by_session_hash !== req.ca_voice_call_session_hash
        ) {
            return res.status(409).json({
                success: false,
                message: "This call was answered on another device",
            });
        }
        const data = await issueParticipantToken(call, "client");
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to join voice call");
    }
});

router.post("/ca/:call_id/end", validateCaSession, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.ca_username,
            "client"
        );
        if (call.initiated_by !== "staff" || call.recipient_panel !== "ca") {
            return res.status(404).json({
                success: false,
                message: "Voice call not found",
            });
        }
        let nextStatus = call.status;
        if (ACTIVE_CALL_STATUSES.includes(call.status)) {
            nextStatus = call.status === "ringing" ? "cancelled" : "ended";
            const [endResult] = await pool.query(
                `UPDATE in_app_voice_calls
                 SET status = ?, end_reason = ?, ended_at = NOW()
                 WHERE call_id = ? AND client_username = ?
                   AND status IN ('ringing', 'accepted')`,
                [
                    nextStatus,
                    nextStatus === "cancelled" ? "ca_cancelled" : "ca_ended",
                    call.call_id,
                    req.ca_username,
                ]
            );
            if (endResult.affectedRows) {
                if (nextStatus === "cancelled") {
                    void notifyCallCancelled(call);
                    await deleteCallRoom(call);
                } else {
                    scheduleCallRoomCleanup(call);
                }
            }
        }
        const finalCall = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.ca_username,
            "client"
        );
        return res.status(200).json({
            success: true,
            data: {
                status: finalCall.status,
                ended_by_name: endedByName(finalCall),
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to end voice call");
    }
});

router.post("/webhook", async (req, res) => {
    try {
        const config = await liveKitConfig({ requireEnabled: false });
        if (!Buffer.isBuffer(req.rawBody)) {
            return res.status(503).json({
                success: false,
                message: "LiveKit webhook verification is not configured",
            });
        }
        const receiver = new WebhookReceiver(config.apiKey, config.apiSecret);
        const event = await receiver.receive(
            req.rawBody.toString("utf8"),
            req.headers.authorization
        );
        if (event.event === "participant_joined" && event.room?.name) {
            await pool.query(
                `UPDATE in_app_voice_calls
                 SET connected_at = COALESCE(connected_at, NOW())
                 WHERE provider_room = ? AND status = 'accepted'`,
                [event.room.name]
            );
        }
        if (event.event === "participant_left" && event.room?.name) {
            const rooms = await roomService(config).listRooms([event.room.name]);
            const room = rooms.find((candidate) => candidate.name === event.room.name);
            if (!room || Number(room.numParticipants) === 0) {
                await pool.query(
                    `UPDATE in_app_voice_calls
                     SET status = 'ended', end_reason = 'participants_disconnected',
                         ended_at = NOW()
                     WHERE provider_room = ? AND status = 'accepted'`,
                    [event.room.name]
                );
                scheduleCallRoomCleanup({ provider_room: event.room.name });
            }
        }
        if (event.event === "room_finished" && event.room?.name) {
            await pool.query(
                `UPDATE in_app_voice_calls
                 SET status = 'ended', end_reason = 'provider_ended', ended_at = NOW()
                 WHERE provider_room = ? AND status IN ('ringing', 'accepted')`,
                [event.room.name]
            );
        }
        return res.status(200).json({ success: true });
    } catch (error) {
        if (
            error?.message?.toLowerCase().includes("authorization") ||
            error?.message?.toLowerCase().includes("token")
        ) {
            return res.status(401).json({
                success: false,
                message: "Invalid LiveKit webhook signature",
            });
        }
        return sendError(res, error, "Failed to process LiveKit webhook");
    }
});

export default router;
