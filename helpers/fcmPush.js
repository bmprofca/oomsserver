import "dotenv/config";
import axios from "axios";
import pool from "../db.js";

/**
 * FCM Push Notification Helper (Legacy HTTP API)
 *
 * Uses FIREBASE_SERVER_KEY from .env to send push notifications
 * via the Firebase Cloud Messaging legacy HTTP endpoint.
 *
 * To get your server key:
 *   Firebase Console → Project Settings → Cloud Messaging → Server key
 */

const FCM_ENDPOINT = "https://fcm.googleapis.com/fcm/send";

function getServerKey() {
    const key = process.env.FIREBASE_SERVER_KEY;
    if (!key) {
        console.warn("[FCM] FIREBASE_SERVER_KEY is not set in .env – push notifications will be skipped.");
    }
    return key || null;
}

/**
 * Send a push notification to ALL registered FCM tokens for a given username + panel.
 *
 * @param {string} username  - The user to notify
 * @param {string} panel     - 'enduser' | 'client' | 'ca'
 * @param {object} payload   - { title, body, data? }
 */
export async function sendPushToUser(username, panel, { title, body, data = {} }) {
    const serverKey = getServerKey();
    if (!serverKey) return;

    try {
        // Fetch all tokens for this username+panel (multiple devices)
        const [rows] = await pool.query(
            "SELECT fcm_token FROM fcm_tokens WHERE username = ? AND panel = ?",
            [username, panel]
        );

        if (!rows || rows.length === 0) return;

        const tokens = rows.map((r) => String(r.fcm_token)).filter(Boolean);
        if (tokens.length === 0) return;

        // FCM allows up to 1000 tokens per batch; split if needed
        const BATCH_SIZE = 1000;
        for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
            const batch = tokens.slice(i, i + BATCH_SIZE);

            const payload = {
                registration_ids: batch,
                notification: {
                    title: String(title || ""),
                    body: String(body || ""),
                    sound: "default",
                },
                data: {
                    ...data,
                    click_action: "FLUTTER_NOTIFICATION_CLICK",
                },
                priority: "high",
                android: {
                    priority: "high",
                    notification: {
                        sound: "default",
                        channel_id: "ooms_task_updates",
                    },
                },
                apns: {
                    payload: {
                        aps: { sound: "default" },
                    },
                },
            };

            const response = await axios.post(FCM_ENDPOINT, payload, {
                headers: {
                    Authorization: `key=${serverKey}`,
                    "Content-Type": "application/json",
                },
                timeout: 10000,
            });

            // Clean up stale tokens (NotRegistered / InvalidRegistration)
            const results = response.data?.results || [];
            const staleTokens = [];
            results.forEach((result, idx) => {
                if (
                    result.error === "NotRegistered" ||
                    result.error === "InvalidRegistration"
                ) {
                    staleTokens.push(batch[idx]);
                }
            });

            if (staleTokens.length > 0) {
                // Fire-and-forget cleanup – do not await to avoid blocking caller
                const placeholders = staleTokens.map(() => "?").join(",");
                pool.query(
                    `DELETE FROM fcm_tokens WHERE username = ? AND panel = ? AND fcm_token IN (${placeholders})`,
                    [username, panel, ...staleTokens]
                ).catch((err) =>
                    console.warn("[FCM] Failed to clean up stale tokens:", err?.message)
                );
            }

            console.log(
                `[FCM] Sent to ${batch.length} token(s) for [${panel}] ${username} – success: ${response.data?.success}, failure: ${response.data?.failure}`
            );
        }
    } catch (err) {
        console.error(`[FCM] Push to ${username}/${panel} failed:`, err?.response?.data || err?.message || err);
    }
}

/**
 * Send a push notification to multiple users at once.
 * Each user may have multiple registered devices.
 *
 * @param {Array<{username: string, panel: string}>} targets
 * @param {object} payload  - { title, body, data? }
 */
export async function sendPushToUsers(targets, payload) {
    if (!targets || targets.length === 0) return;
    // Send in parallel but don't let one failure block others
    await Promise.allSettled(
        targets.map((t) => sendPushToUser(t.username, t.panel, payload))
    );
}

/**
 * Automatically find affected clients and assignees for tasks whose status changed,
 * and dispatch FCM push notifications.
 *
 * @param {object} params
 * @param {string|number} params.branch_id
 * @param {string[]} params.task_ids
 * @param {string} params.status
 * @param {string} [params.updated_by]
 */
export async function notifyTaskStatusPush({ branch_id, task_ids, status, updated_by }) {
    if (!branch_id || !task_ids || !task_ids.length || !status) return;

    try {
        const placeholders = task_ids.map(() => "?").join(",");
        const [tasks] = await pool.query(
            `SELECT
                t.task_id,
                t.service_id,
                t.username AS task_username,
                s.name AS service_name,
                f.username AS client_username,
                f.firm_name
             FROM tasks t
             LEFT JOIN firms f
               ON f.firm_id = t.firm_id
              AND f.branch_id = t.branch_id
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LEFT JOIN services s ON s.service_id = t.service_id
             WHERE t.branch_id = ? AND t.task_id IN (${placeholders})`,
            [branch_id, ...task_ids]
        );

        if (!tasks || tasks.length === 0) return;

        const displayStatus = String(status).toUpperCase();

        for (const task of tasks) {
            const serviceName = task.service_name || "Task";
            const taskLabel = `#${task.task_id} (${serviceName})`;

            // 1. Notify client panel user
            const clientUser = task.client_username || task.task_username;
            if (clientUser && clientUser !== updated_by) {
                sendPushToUser(clientUser, "client", {
                    title: `Task Update: ${displayStatus}`,
                    body: `Your task ${taskLabel} status has been updated to "${status}".`,
                    data: {
                        type: "TASK_STATUS_UPDATE",
                        taskId: String(task.task_id),
                        status: String(status),
                        panel: "client",
                    },
                }).catch((err) => console.error(`[FCM] Client push error for task ${task.task_id}:`, err?.message));
            }

            // 2. Notify enduser/staff if assigned
            if (task.task_username && task.task_username !== clientUser && task.task_username !== updated_by) {
                sendPushToUser(task.task_username, "enduser", {
                    title: `Task Update: ${displayStatus}`,
                    body: `Task ${taskLabel} status has been updated to "${status}".`,
                    data: {
                        type: "TASK_STATUS_UPDATE",
                        taskId: String(task.task_id),
                        status: String(status),
                        panel: "enduser",
                    },
                }).catch((err) => console.error(`[FCM] Enduser push error for task ${task.task_id}:`, err?.message));
            }
        }
    } catch (err) {
        console.error("[FCM] Error in notifyTaskStatusPush:", err?.message || err);
    }
}
