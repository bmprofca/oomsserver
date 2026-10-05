import { Server } from "socket.io";
import pool from "../db.js";
import { checkToken } from "../middleware/auth.js";
import { resolveClientTokenSession } from "../middleware/authClient.js";
import { resolveCaTokenSession } from "../middleware/authCa.js";
import {
    normalizeCountryCode,
    normalizeMobileDigits,
    PROFILE_COUNTRY_CODE_SQL,
    PROFILE_MOBILE_SQL,
} from "./clientPhone.js";

let socketServer;
let resolveCapability;

function voiceCallRoom(panel, username) {
    return `voice-call:${panel}:${String(username || "").trim().toLowerCase()}`;
}

function watchKey(panel, username) {
    return `${panel}:${String(username || "").trim().toLowerCase()}`;
}

async function notifyCapabilityWatchers(panel, username) {
    if (!socketServer || typeof resolveCapability !== "function") return;
    const targetKey = watchKey(panel, username);
    const watchers = [];
    for (const socket of socketServer.sockets.sockets.values()) {
        const subscriptions = socket.data.voiceCallWatchers;
        if (!subscriptions) continue;
        for (const [subscriptionId, subscription] of Object.entries(subscriptions)) {
            if (watchKey(subscription.recipientPanel, subscription.recipientUsername) === targetKey) {
                watchers.push({ socket, subscriptionId, subscription });
            }
        }
    }

    await Promise.all(watchers.map(async ({ socket, subscriptionId, subscription }) => {
        try {
            const data = await resolveCapability({
                callerPanel: socket.data.voiceCallIdentity.panel,
                callerUsername: socket.data.voiceCallIdentity.username,
                branchId: socket.data.voiceCallIdentity.branchId,
                ...subscription,
            });
            socket.emit("voice_call_capability_update", {
                subscription_id: subscriptionId,
                success: true,
                data,
            });
        } catch (error) {
            socket.emit("voice_call_capability_update", {
                subscription_id: subscriptionId,
                success: false,
                message: error?.message || "Failed to refresh voice call availability",
            });
        }
    }));
}

export function emitVoiceCallIncoming(username, call) {
    if (!socketServer) return false;
    const room = voiceCallRoom("client", username);
    const connectedClients = socketServer.sockets.adapter.rooms.get(room)?.size || 0;
    socketServer.to(room).emit("voice_call_incoming", call);
    return connectedClients > 0;
}

export function hasConnectedClientVoiceCallSocket(username) {
    const room = voiceCallRoom("client", username);
    return Boolean(socketServer?.sockets.adapter.rooms.get(room)?.size);
}

export function hasConnectedStaffVoiceCallSocket(username) {
    const room = voiceCallRoom("staff", username);
    return Boolean(socketServer?.sockets.adapter.rooms.get(room)?.size);
}

export function hasConnectedCAVoiceCallSocket(username) {
    const room = voiceCallRoom("ca", username);
    return Boolean(socketServer?.sockets.adapter.rooms.get(room)?.size);
}

export function emitStaffVoiceCallIncoming(username, call) {
    if (!socketServer) return;
    socketServer.to(voiceCallRoom("staff", username)).emit("voice_call_incoming", call);
}

export function emitCAVoiceCallIncoming(username, call) {
    if (!socketServer) return;
    socketServer.to(voiceCallRoom("ca", username)).emit("voice_call_incoming", call);
}

export function setupSocketIO(server, capabilityResolver) {
    resolveCapability = capabilityResolver;
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 60000,
        pingInterval: 25000
    });
    socketServer = io;

    io.on("connection", (socket) => {
        socket.on("auth", async (credentials = {}) => {
            try {
                const username = String(credentials.username || "").trim();
                const token = String(credentials.token || "").trim();
                const branch = String(credentials.branch || "").trim();
                if (!username || !token || !(await checkToken(username, token))) {
                    socket.emit("auth_status", false);
                    socket.disconnect();
                    return;
                }

                await socket.join(username);
                await socket.join(voiceCallRoom("staff", username));
                let voiceCallBranchId = "";
                if (branch) {
                    const [branchRows] = await pool.query(
                        `SELECT id FROM branch_mapping
                         WHERE username = ? AND branch_id = ?
                           AND is_accepted = '1' AND status = '1' AND is_deleted = '0'
                         LIMIT 1`,
                        [username, branch]
                    ).catch(() => [[]]);
                    if (branchRows.length) {
                        voiceCallBranchId = branch;
                        await socket.join(`branch:${branch}`);
                    }
                }
                await socket.join(`user:${username}`);
                socket.data.voiceCallIdentity = {
                    panel: "enduser",
                    username,
                    branchId: voiceCallBranchId,
                };
                socket.emit("auth_status", true);
                if (voiceCallBranchId) {
                    void notifyCapabilityWatchers("enduser", username);
                }
            } catch (error) {
                console.error("OFFICE SOCKET AUTH ERROR:", error);
                socket.emit("auth_status", false);
                socket.disconnect();
            }
        });
        socket.on("voice_call_auth", async (credentials = {}, acknowledge) => {
            try {
                const username = String(credentials.username || "").trim();
                const token = String(credentials.token || "").trim();
                if (!username || !token) {
                    if (typeof acknowledge === "function") {
                        acknowledge({ authenticated: false });
                    }
                    return;
                }

                const session = await resolveClientTokenSession(token);
                if (!session) {
                    if (typeof acknowledge === "function") {
                        acknowledge({ authenticated: false });
                    }
                    return;
                }

                const [profiles] = await pool.query(
                    `SELECT p.username
                     FROM profile p
                     INNER JOIN clients c ON c.username = p.username
                       AND c.user_type = 'client'
                       AND (c.is_deleted = '0' OR c.is_deleted = 0)
                     WHERE p.username = ?
                       AND p.user_type = 'client'
                       AND p.status = '1'
                       AND ${PROFILE_MOBILE_SQL} = ?
                       AND ${PROFILE_COUNTRY_CODE_SQL} = ?
                     LIMIT 1`,
                    [username, session.mobile, session.country_code]
                );
                if (!profiles.length) {
                    if (typeof acknowledge === "function") {
                        acknowledge({ authenticated: false });
                    }
                    return;
                }

                await socket.join(voiceCallRoom("client", username));
                const [clientRows] = await pool.query(
                    `SELECT branch_id FROM clients
                     WHERE username = ? AND user_type = 'client'
                       AND status = '1'
                       AND (is_deleted = '0' OR is_deleted = 0)
                     LIMIT 1`,
                    [username]
                );
                if (!clientRows.length) {
                    if (typeof acknowledge === "function") acknowledge({ authenticated: false });
                    return;
                }
                socket.data.voiceCallIdentity = {
                    panel: "client",
                    username,
                    branchId: String(clientRows[0].branch_id || "").trim(),
                };

                if (typeof acknowledge === "function") {
                    acknowledge({ authenticated: true });
                }
                void notifyCapabilityWatchers("client", username);
            } catch (error) {
                console.error("CLIENT VOICE-CALL SOCKET AUTH ERROR:", error);
                if (typeof acknowledge === "function") {
                    acknowledge({ authenticated: false });
                }
            }
        });
        socket.on("ca_voice_call_auth", async (credentials = {}, acknowledge) => {
            try {
                const username = String(credentials.username || "").trim();
                const token = String(credentials.token || "").trim();
                const mobile = String(credentials.mobile || "").trim();
                const countryCode = String(credentials.countrycode || credentials.country_code || "").trim();
                const branchId = String(credentials.branch || credentials.branch_id || "").trim();
                const session = token && await resolveCaTokenSession(token);
                if (!username || !mobile || !countryCode || !branchId || !session ||
                    session.mobile !== normalizeMobileDigits(mobile) ||
                    session.country_code !== normalizeCountryCode(countryCode)) {
                    if (typeof acknowledge === "function") acknowledge({ authenticated: false });
                    return;
                }
                const [rows] = await pool.query(
                    `SELECT c.username
                     FROM clients c
                     JOIN profile p ON p.username = c.username AND p.status = '1'
                     WHERE c.username = ? AND c.branch_id = ? AND c.user_type = 'ca'
                       AND c.status = '1' AND (c.is_deleted = '0' OR c.is_deleted = 0)
                       AND ${PROFILE_MOBILE_SQL} = ?
                       AND ${PROFILE_COUNTRY_CODE_SQL} = ?
                     LIMIT 1`,
                    [username, branchId, session.mobile, session.country_code]
                );
                if (!rows.length) {
                    if (typeof acknowledge === "function") acknowledge({ authenticated: false });
                    return;
                }
                await socket.join(voiceCallRoom("ca", username));
                socket.data.voiceCallIdentity = { panel: "ca", username, branchId };
                if (typeof acknowledge === "function") acknowledge({ authenticated: true });
                void notifyCapabilityWatchers("ca", username);
            } catch (error) {
                console.error("CA VOICE-CALL SOCKET AUTH ERROR:", error);
                if (typeof acknowledge === "function") acknowledge({ authenticated: false });
            }
        });
        socket.on("voice_call_capability_check", async (request = {}, acknowledge) => {
            if (typeof acknowledge !== "function") return;
            try {
                if (!socket.data.voiceCallIdentity) {
                    acknowledge({ success: false, message: "Authenticate before checking call availability" });
                    return;
                }
                if (typeof resolveCapability !== "function") {
                    throw new Error("Voice-call capability service is unavailable");
                }
                const data = await resolveCapability({
                    callerPanel: socket.data.voiceCallIdentity.panel,
                    callerUsername: socket.data.voiceCallIdentity.username,
                    branchId: socket.data.voiceCallIdentity.branchId,
                    recipientUsername: request.recipient_username,
                    recipientPanel: request.recipient_panel,
                    mobileApp: request.mobile_app === true,
                });
                acknowledge({ success: true, data });
            } catch (error) {
                acknowledge({ success: false, message: error?.message || "Failed to check voice call availability" });
            }
        });
        socket.on("voice_call_capability_watch", async (request = {}, acknowledge) => {
            if (typeof acknowledge !== "function") return;
            try {
                const identity = socket.data.voiceCallIdentity;
                if (!identity) {
                    acknowledge({ success: false, message: "Authenticate before checking call availability" });
                    return;
                }
                const subscriptionId = String(request.subscription_id || "").trim();
                const recipientUsername = String(request.recipient_username || "").trim();
                const recipientPanel = String(request.recipient_panel || "client").trim().toLowerCase();
                if (!subscriptionId || subscriptionId.length > 100) {
                    acknowledge({ success: false, message: "A valid subscription_id is required" });
                    return;
                }
                const subscription = {
                    recipientUsername,
                    recipientPanel,
                    mobileApp: request.mobile_app === true,
                };
                const data = await resolveCapability({
                    callerPanel: identity.panel,
                    callerUsername: identity.username,
                    branchId: identity.branchId,
                    ...subscription,
                });
                socket.data.voiceCallWatchers = socket.data.voiceCallWatchers || Object.create(null);
                socket.data.voiceCallWatchers[subscriptionId] = subscription;
                acknowledge({ success: true, data });
            } catch (error) {
                acknowledge({
                    success: false,
                    message: error?.message || "Failed to watch voice call availability",
                });
            }
        });
        socket.on("voice_call_capability_unwatch", (subscriptionId) => {
            const id = String(subscriptionId || "").trim();
            if (socket.data.voiceCallWatchers) {
                delete socket.data.voiceCallWatchers[id];
            }
        });
        socket.on("disconnect", (reason) => {
            const identity = socket.data.voiceCallIdentity;
            if (identity) {
                const panel = identity.panel === "enduser" ? "enduser" : identity.panel;
                setTimeout(() => {
                    void notifyCapabilityWatchers(panel, identity.username);
                }, 0);
            }
            // console.log(`❌ Socket ${socket.id} disconnected:`, reason);
        });
    });

    return io;
}