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
import { validateClientSession } from "../middleware/validateClientSession.js";
import { sendPushToUser } from "../helpers/fcmPush.js";

const router = express.Router();
const INVITE_TTL_SECONDS = 45;
const MAX_CALL_INVITES_PER_MINUTE = 10;
const ACTIVE_CALL_STATUSES = ["ringing", "accepted"];

function liveKitConfig() {
    if (String(process.env.IN_APP_VOICE_CALLS_ENABLED).toLowerCase() !== "true") {
        const error = new Error("In-app voice calling is not enabled");
        error.status = 503;
        throw error;
    }

    const serverUrl = String(process.env.LIVEKIT_URL || "").trim().replace(/\/+$/, "");
    const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
    const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
    if (!serverUrl || !apiKey || !apiSecret) {
        const error = new Error("In-app voice calling is not configured");
        error.status = 503;
        throw error;
    }

    let parsed;
    try {
        parsed = new URL(serverUrl);
    } catch {
        const error = new Error("LIVEKIT_URL must be a valid secure WebSocket URL");
        error.status = 503;
        throw error;
    }
    if (parsed.protocol !== "wss:") {
        const error = new Error("LIVEKIT_URL must use wss://");
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

async function getBranchClient(branchId, username) {
    const [rows] = await pool.query(
        `SELECT c.username, c.status, p.name
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

    const [deviceRows] = await pool.query(
        "SELECT 1 FROM fcm_tokens WHERE username = ? AND panel = 'client' LIMIT 1",
        [username]
    );
    if (!deviceRows.length) {
        const error = new Error("This client has not registered the OOMS mobile app");
        error.status = 409;
        throw error;
    }

    return {
        username,
        name: String(rows[0].name || "Client"),
    };
}

export async function updateExpiredInvites() {
    await pool.query(
        `UPDATE in_app_voice_calls
         SET status = 'missed', end_reason = 'timeout', ended_at = NOW()
         WHERE status = 'ringing' AND expires_at <= NOW()`
    );
}

async function loadAuthorizedCall(callId, branchId, username, participant) {
    const [rows] = await pool.query(
        `SELECT call_id, branch_id, caller_username, client_username,
                caller_name, client_name, provider_room, status,
                expires_at, accepted_at, ended_at, end_reason, create_date
         FROM in_app_voice_calls
         WHERE call_id = ?
           AND branch_id = ?
           AND ${participant === "client" ? "client_username" : "caller_username"} = ?
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

function callView(call, participant) {
    return {
        call_id: call.call_id,
        status: call.status,
        other_participant_name:
            participant === "client" ? call.caller_name : call.client_name,
        expires_at: call.expires_at,
        accepted_at: call.accepted_at,
        ended_at: call.ended_at,
        end_reason: call.end_reason,
        create_date: call.create_date,
    };
}

async function issueParticipantToken(call, participant) {
    const config = liveKitConfig();
    if (call.status !== "accepted") {
        const error = new Error("The call must be accepted before joining audio");
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
        canPublishSources: [TrackSource.MICROPHONE],
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
        const config = liveKitConfig();
        await roomService(config).deleteRoom(call.provider_room);
    } catch (error) {
        if (error?.status !== 503) {
            console.error("IN-APP VOICE ROOM CLEANUP ERROR:", error);
        }
    }
}

router.post("/create", auth, validateBranch, async (req, res) => {
    let createdRoom = "";
    try {
        const branchId = req.branch_id;
        const callerUsername = requestUsername(req);
        const caller = await getStaffCaller(branchId, callerUsername);
        const clientUsername = String(req.body?.client_username || "").trim();
        if (!clientUsername || clientUsername.length > 50) {
            return res.status(400).json({
                success: false,
                message: "A valid client_username is required",
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

        const config = liveKitConfig();
        const client = await getBranchClient(branchId, clientUsername);
        await updateExpiredInvites();
        const [existingRows] = await pool.query(
            `SELECT call_id, client_username, status, expires_at, create_date
             FROM in_app_voice_calls
             WHERE caller_username = ? AND idempotency_key = ?
             LIMIT 1`,
            [callerUsername, idempotencyKey]
        );
        if (existingRows.length) {
            const existing = existingRows[0];
            if (existing.client_username !== clientUsername) {
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
                `SELECT call_id, client_username, status, expires_at, create_date
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
                if (retryRows[0].client_username !== clientUsername) {
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
                        expires_at: retryRows[0].expires_at,
                        create_date: retryRows[0].create_date,
                    },
                });
            }

            const [lockedClientRows] = await connection.query(
                `SELECT username
                 FROM clients
                 WHERE username = ? AND branch_id = ?
                   AND user_type = 'client' AND status = '1' AND is_deleted = '0'
                 LIMIT 1 FOR UPDATE`,
                [clientUsername, branchId]
            );
            if (!lockedClientRows.length) {
                const error = new Error("Client is no longer active in this branch");
                error.status = 404;
                throw error;
            }

            const [activeRows] = await connection.query(
                `SELECT call_id
                 FROM in_app_voice_calls
                 WHERE client_username = ? AND status IN ('ringing', 'accepted')
                 LIMIT 1`,
                [clientUsername]
            );
            if (activeRows.length) {
                await connection.rollback();
                transactionStarted = false;
                await roomService(config).deleteRoom(providerRoom);
                createdRoom = "";
                return res.status(409).json({
                    success: false,
                    message: "This client is already in another call",
                });
            }

            const [callerActiveRows] = await connection.query(
                `SELECT call_id
                 FROM in_app_voice_calls
                 WHERE caller_username = ? AND status IN ('ringing', 'accepted')
                 LIMIT 1`,
                [callerUsername]
            );
            if (callerActiveRows.length) {
                await connection.rollback();
                transactionStarted = false;
                await roomService(config).deleteRoom(providerRoom);
                createdRoom = "";
                return res.status(409).json({
                    success: false,
                    message: "You already have another active voice call",
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

            await connection.query(
                `INSERT INTO in_app_voice_calls
                    (call_id, branch_id, caller_username, client_username,
                     caller_name, client_name, provider_room, status,
                     idempotency_key, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'ringing', ?,
                         DATE_ADD(NOW(), INTERVAL ? SECOND))`,
                [
                    callId,
                    branchId,
                    callerUsername,
                    clientUsername,
                    caller.name,
                    client.name,
                    providerRoom,
                    idempotencyKey,
                    INVITE_TTL_SECONDS,
                ]
            );
            await connection.commit();
            transactionStarted = false;
        } catch (transactionError) {
            if (transactionStarted) await connection.rollback();
            throw transactionError;
        } finally {
            connection.release();
        }
        createdRoom = "";

        try {
            await sendPushToUser(
                clientUsername,
                "client",
                {
                    title: "Incoming voice call",
                    body: `${caller.name} is calling you`,
                    data: {
                        type: "IN_APP_VOICE_CALL",
                        call_id: callId,
                        panel: "client",
                    },
                },
                { throwOnError: true }
            );
        } catch (pushError) {
            await pool.query(
                `UPDATE in_app_voice_calls
                 SET status = 'failed', end_reason = 'notification_failed',
                     ended_at = NOW()
                 WHERE call_id = ? AND status = 'ringing'`,
                [callId]
            );
            await deleteCallRoom({ provider_room: providerRoom });
            const error = new Error("Unable to notify the client about this call");
            error.status = 502;
            error.cause = pushError;
            throw error;
        }

        const [createdRows] = await pool.query(
            `SELECT expires_at, create_date
             FROM in_app_voice_calls WHERE call_id = ? LIMIT 1`,
            [callId]
        );
        return res.status(201).json({
            success: true,
            message: "Calling client",
            data: {
                call_id: callId,
                status: "ringing",
                other_participant_name: client.name,
                expires_at: createdRows[0]?.expires_at || null,
                create_date: createdRows[0]?.create_date || null,
            },
        });
    } catch (error) {
        if (createdRoom) {
            try {
                await roomService(liveKitConfig()).deleteRoom(createdRoom);
            } catch (cleanupError) {
                console.error("IN-APP VOICE ROOM ROLLBACK ERROR:", cleanupError);
            }
        }
        return sendError(res, error, "Failed to create voice call");
    }
});

router.get("/capability", auth, validateBranch, async (req, res) => {
    try {
        const caller = await getStaffCaller(req.branch_id, requestUsername(req));
        const clientUsername = String(req.query.client_username || "").trim();
        if (!clientUsername || clientUsername.length > 50) {
            return res.status(400).json({
                success: false,
                message: "A valid client_username is required",
            });
        }

        if (String(process.env.IN_APP_VOICE_CALLS_ENABLED).toLowerCase() !== "true") {
            return res.status(200).json({
                success: true,
                data: { can_call: false, reason: "disabled" },
            });
        }

        try {
            liveKitConfig();
        } catch (error) {
            if (error?.status === 503) {
                return res.status(200).json({
                    success: true,
                    data: { can_call: false, reason: "provider_not_configured" },
                });
            }
            throw error;
        }

        await getBranchClient(req.branch_id, clientUsername);
        return res.status(200).json({
            success: true,
            data: {
                can_call: true,
                caller_role: caller.type,
            },
        });
    } catch (error) {
        return sendError(res, error, "Failed to check voice call availability");
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
            data: callView(call, "caller"),
        });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call");
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
        if (ACTIVE_CALL_STATUSES.includes(call.status)) {
            const nextStatus = call.status === "ringing" ? "cancelled" : "ended";
            await pool.query(
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
            await deleteCallRoom(call);
        }
        return res.status(200).json({ success: true, data: { status: "ended" } });
    } catch (error) {
        return sendError(res, error, "Failed to end voice call");
    }
});

router.get("/client/:call_id", validateClientSession, async (req, res) => {
    try {
        await updateExpiredInvites();
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        return res.status(200).json({
            success: true,
            data: callView(call, "client"),
        });
    } catch (error) {
        return sendError(res, error, "Failed to load voice call");
    }
});

router.post("/client/:call_id/respond", validateClientSession, async (req, res) => {
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
        if (call.status !== "ringing") {
            await updateExpiredInvites();
            return res.status(409).json({
                success: false,
                message: "This call is no longer available",
            });
        }
        const nextStatus = action === "accept" ? "accepted" : "rejected";
        const [result] = await pool.query(
            `UPDATE in_app_voice_calls
             SET status = ?, accepted_at = IF(? = 'accepted', NOW(), accepted_at),
                 end_reason = IF(? = 'rejected', 'client_declined', end_reason),
                 ended_at = IF(? = 'rejected', NOW(), ended_at)
             WHERE call_id = ? AND client_username = ?
               AND status = 'ringing' AND expires_at > NOW()`,
            [
                nextStatus,
                nextStatus,
                nextStatus,
                nextStatus,
                call.call_id,
                req.client_username,
            ]
        );
        if (result.affectedRows !== 1) {
            return res.status(409).json({
                success: false,
                message: "This call has already been answered or ended",
            });
        }
        if (action === "decline") await deleteCallRoom(call);
        return res.status(200).json({
            success: true,
            data: { call_id: call.call_id, status: nextStatus },
        });
    } catch (error) {
        return sendError(res, error, "Failed to respond to voice call");
    }
});

router.post("/client/:call_id/token", validateClientSession, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        const data = await issueParticipantToken(call, "client");
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendError(res, error, "Failed to join voice call");
    }
});

router.post("/client/:call_id/end", validateClientSession, async (req, res) => {
    try {
        const call = await loadAuthorizedCall(
            req.params.call_id,
            req.branch_id,
            req.client_username,
            "client"
        );
        if (ACTIVE_CALL_STATUSES.includes(call.status)) {
            await pool.query(
                `UPDATE in_app_voice_calls
                 SET status = 'ended', end_reason = 'client_ended', ended_at = NOW()
                 WHERE call_id = ? AND client_username = ?
                   AND status IN ('ringing', 'accepted')`,
                [call.call_id, req.client_username]
            );
            await deleteCallRoom(call);
        }
        return res.status(200).json({ success: true, data: { status: "ended" } });
    } catch (error) {
        return sendError(res, error, "Failed to end voice call");
    }
});

router.post("/webhook", async (req, res) => {
    try {
        const config = liveKitConfig();
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
