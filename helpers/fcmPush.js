import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import pool from "../db.js";

/**
 * FCM Push Notification Helper (Firebase Admin SDK / HTTP v1 API)
 *
 * Uses Firebase Service Account JSON credentials to send push notifications.
 *
 * Credentials can be provided via:
 *   - FIREBASE_SERVICE_ACCOUNT_PATH (in .env, relative or absolute path)
 *   - GOOGLE_APPLICATION_CREDENTIALS (in .env)
 *   - FIREBASE_SERVICE_ACCOUNT_KEY (in .env, raw JSON string)
 *   - Fallback to ooms-e7b32-firebase-adminsdk-fbsvc-ff7d1d9126.json in project root
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

let messagingInstance = null;

function getFirebaseMessaging() {
    if (messagingInstance) {
        return messagingInstance;
    }

    try {
        let serviceAccount = null;

        // 1. Direct JSON string from env (useful for container/serverless deployments)
        if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
            } catch (e) {
                console.error("[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:", e.message);
            }
        }

        // 2. Service account JSON file path
        if (!serviceAccount) {
            const credentialPath =
                process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
                process.env.GOOGLE_APPLICATION_CREDENTIALS ||
                "ooms-e7b32-firebase-adminsdk-fbsvc-ff7d1d9126.json";

            const resolvedPath = path.isAbsolute(credentialPath)
                ? credentialPath
                : path.resolve(projectRoot, credentialPath);

            if (fs.existsSync(resolvedPath)) {
                const raw = fs.readFileSync(resolvedPath, "utf-8");
                serviceAccount = JSON.parse(raw);
            } else {
                console.warn(`[FCM] Firebase service account file not found at: ${resolvedPath}`);
            }
        }

        if (!serviceAccount) {
            console.warn("[FCM] Firebase service account credentials not found – push notifications will be skipped.");
            return null;
        }

        const app = getApps().length === 0
            ? initializeApp({ credential: cert(serviceAccount) })
            : getApps()[0];

        messagingInstance = getMessaging(app);
        console.log(`[FCM] Firebase Admin Messaging initialized for project: ${serviceAccount.project_id || "default"}`);
        return messagingInstance;
    } catch (err) {
        console.error("[FCM] Failed to initialize Firebase Admin SDK:", err.message || err);
        return null;
    }
}

/**
 * Send a push notification to ALL registered FCM tokens for a given username + panel.
 *
 * @param {string} username  - The user to notify
 * @param {string} panel     - 'enduser' | 'client' | 'ca'
 * @param {object} payload   - { title, body, data? }
 */
export async function sendPushToUser(username, panel, { title, body, data = {} }) {
    const messaging = getFirebaseMessaging();
    if (!messaging) return;

    try {
        // Fetch all tokens for this username+panel (multiple devices)
        const [rows] = await pool.query(
            "SELECT fcm_token FROM fcm_tokens WHERE username = ? AND panel = ?",
            [username, panel]
        );

        if (!rows || rows.length === 0) return;

        const tokens = rows.map((r) => String(r.fcm_token)).filter(Boolean);
        if (tokens.length === 0) return;

        // Ensure all values in data payload are strings for FCM HTTP v1 / Admin SDK
        const stringData = {};
        if (data && typeof data === "object") {
            for (const [k, v] of Object.entries(data)) {
                if (v !== undefined && v !== null) {
                    stringData[String(k)] = typeof v === "object" ? JSON.stringify(v) : String(v);
                }
            }
        }
        if (!stringData.click_action) {
            stringData.click_action = "FLUTTER_NOTIFICATION_CLICK";
        }

        // FCM Admin SDK allows up to 500 tokens per batch with sendEachForMulticast
        const BATCH_SIZE = 500;
        for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
            const batch = tokens.slice(i, i + BATCH_SIZE);

            const message = {
                tokens: batch,
                notification: {
                    title: String(title || ""),
                    body: String(body || ""),
                },
                data: stringData,
                android: {
                    priority: "high",
                    notification: {
                        sound: "default",
                        channelId: "ooms_task_updates",
                    },
                },
                apns: {
                    payload: {
                        aps: { sound: "default" },
                    },
                },
            };

            const response = await messaging.sendEachForMulticast(message);

            // Clean up stale or unregistered tokens
            const staleTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success && resp.error) {
                    const errCode = resp.error.code;
                    if (
                        errCode === "messaging/registration-token-not-registered" ||
                        errCode === "messaging/invalid-registration-token" ||
                        errCode === "messaging/invalid-argument"
                    ) {
                        staleTokens.push(batch[idx]);
                    }
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
                `[FCM] Sent to ${batch.length} token(s) for [${panel}] ${username} – success: ${response.successCount}, failure: ${response.failureCount}`
            );
        }
    } catch (err) {
        console.error(`[FCM] Push to ${username}/${panel} failed:`, err?.message || err);
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
