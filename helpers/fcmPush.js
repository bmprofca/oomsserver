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

export function buildPushNotificationPayload({
    action,
    title,
    body,
    panel = "enduser",
    taskId,
    requestId,
    status,
    type,
    data = {},
}) {
    const safeType = String((type || action || "GENERIC_NOTIFICATION")).trim().toUpperCase();
    const normalizedPanel = String(panel || "enduser").trim().toLowerCase();
    const payloadData = { ...data, type: safeType, panel: normalizedPanel };

    if (taskId !== undefined && taskId !== null && taskId !== "") {
        payloadData.taskId = String(taskId);
    }
    if (requestId !== undefined && requestId !== null && requestId !== "") {
        payloadData.requestId = String(requestId);
    }
    if (status !== undefined && status !== null && status !== "") {
        payloadData.status = String(status);
    }

    return {
        title: String(title || "OOMS Notification"),
        body: String(body || "You have a new update."),
        data: payloadData,
    };
}

export function resolveNotificationTargets(action, context = {}) {
    const {
        clientUsername,
        assignedUsername,
        caUsername,
        staffUsernames = [],
        updatedBy,
        username,
        panel,
    } = context;

    const targets = [];
    const seen = new Set();

    const addTarget = (targetUsername, targetPanel) => {
        if (!targetUsername) return;
        const value = `${String(targetUsername).trim()}::${String(targetPanel || "enduser").trim().toLowerCase()}`;
        if (seen.has(value)) return;
        seen.add(value);
        targets.push({ username: String(targetUsername).trim(), panel: String(targetPanel || "enduser").trim().toLowerCase() });
    };

    const shouldSkip = (targetUsername) => {
        if (!targetUsername) return true;
        return targetUsername === updatedBy || targetUsername === username;
    };

    switch (String(action || "").toUpperCase()) {
        case "TASK_CREATED":
        case "TASK_STATUS_UPDATED":
        case "TASK_COMPLETED":
        case "TASK_CANCELLED":
            if (clientUsername && !shouldSkip(clientUsername)) addTarget(clientUsername, "client");
            if (assignedUsername && !shouldSkip(assignedUsername)) addTarget(assignedUsername, "enduser");
            if (caUsername && !shouldSkip(caUsername)) addTarget(caUsername, "ca");
            for (const staffUsername of Array.isArray(staffUsernames) ? staffUsernames : []) {
                if (!shouldSkip(staffUsername)) addTarget(staffUsername, "enduser");
            }
            break;

        case "CA_APPROVAL_UPDATE":
            if (clientUsername && !shouldSkip(clientUsername)) addTarget(clientUsername, "client");
            if (caUsername && !shouldSkip(caUsername)) addTarget(caUsername, "ca");
            if (assignedUsername && !shouldSkip(assignedUsername)) addTarget(assignedUsername, "enduser");
            break;

        case "DOCUMENT_SHARED":
        case "SERVICE_REQUEST_UPDATE":
        case "SERVICE_REQUEST_APPROVED":
        case "SERVICE_REQUEST_REJECTED":
        case "PAYMENT_REMINDER":
            if (clientUsername && !shouldSkip(clientUsername)) addTarget(clientUsername, "client");
            if (assignedUsername && !shouldSkip(assignedUsername)) addTarget(assignedUsername, "enduser");
            if (caUsername && !shouldSkip(caUsername)) addTarget(caUsername, "ca");
            for (const staffUsername of Array.isArray(staffUsernames) ? staffUsernames : []) {
                if (!shouldSkip(staffUsername)) addTarget(staffUsername, "enduser");
            }
            break;

        default:
            if (panel && username) {
                addTarget(username, panel);
            }
            break;
    }

    return targets;
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

export async function getBranchNotificationTargets(branch_id) {
    if (!branch_id) return [];

    const [rows] = await pool.query(
        `SELECT username, type
         FROM branch_mapping
         WHERE branch_id = ?
           AND status = '1'
           AND is_deleted = '0'
           AND is_accepted = '1'
           AND type IN ('admin','staff')
         GROUP BY username, type`,
        [branch_id]
    );

    return Array.isArray(rows) ? rows.map((row) => ({
        username: String(row.username).trim(),
        panel: 'enduser',
    })).filter((row) => row.username) : [];
}

export async function notifyServiceRequestCreatedPush({ branch_id, request_id, client_username, service_name }) {
    if (!branch_id || !request_id) return;

    const targets = await getBranchNotificationTargets(branch_id);
    if (!targets.length) return;

    const serviceLabel = service_name ? ` (${service_name})` : "";
    await Promise.allSettled(
        targets.map((target) =>
            sendPushToUser(target.username, target.panel, {
                title: 'New Service Request',
                body: `Client ${client_username || 'customer'} raised a new service request${serviceLabel}.`,
                data: {
                    type: 'SERVICE_REQUEST_CREATED',
                    requestId: String(request_id),
                    branchId: String(branch_id),
                    panel: 'enduser',
                },
            })
        )
    );
}

export async function notifyServiceRequestStatusPush({ branch_id, request_id, client_username, status, message }) {
    if (!client_username || !request_id) return;

    const normalizedStatus = String(status || '').trim().toLowerCase();
    const statusLabel = normalizedStatus === 'approved' ? 'Approved' : normalizedStatus === 'rejected' ? 'Rejected' : normalizedStatus === 'pending' ? 'Pending' : 'Updated';

    await sendPushToUser(client_username, 'client', {
        title: `Service Request ${statusLabel}`,
        body: message || `Your service request #${request_id} has been updated.`,
        data: {
            type: 'SERVICE_REQUEST_UPDATE',
            requestId: String(request_id),
            branchId: branch_id ? String(branch_id) : '',
            status: normalizedStatus,
            panel: 'client',
        },
    });
}

export async function notifyCaApprovalCompletePush({ branch_id, task_id, client_username, ca_username, task_label }) {
    if (!branch_id || !task_id) return;

    const uniqueTargets = new Map();
    const pushTarget = (username, panel) => {
        if (!username) return;
        const key = `${String(username).trim()}::${String(panel || 'enduser').trim().toLowerCase()}`;
        if (!uniqueTargets.has(key)) {
            uniqueTargets.set(key, { username: String(username).trim(), panel: String(panel || 'enduser').trim().toLowerCase() });
        }
    };

    if (client_username) pushTarget(client_username, 'client');
    if (ca_username) pushTarget(ca_username, 'ca');

    const branchTargets = await getBranchNotificationTargets(branch_id);
    for (const target of branchTargets) {
        pushTarget(target.username, target.panel || 'enduser');
    }

    if (!uniqueTargets.size) return;

    const label = task_label || `Task #${task_id}`;
    const body = `${label} has been completed by the CA and is ready for review.`;

    await Promise.allSettled(
        [...uniqueTargets.values()].map((target) =>
            sendPushToUser(target.username, target.panel, {
                title: 'CA Approval Complete',
                body,
                data: {
                    type: 'CA_APPROVAL_COMPLETE',
                    taskId: String(task_id),
                    branchId: String(branch_id),
                    panel: target.panel,
                },
            })
        )
    );
}

export async function notifyTaskActionPush({
    branch_id,
    task_id,
    task_username,
    client_username,
    ca_username,
    staffUsernames = [],
    action,
    title,
    body,
    status,
    updated_by,
}) {
    if (!task_id || !action || !title || !body) return;

    const targets = resolveNotificationTargets(action, {
        clientUsername: client_username || task_username,
        assignedUsername: task_username,
        caUsername: ca_username,
        staffUsernames,
        updatedBy: updated_by,
    });

    for (const target of targets) {
        const payload = buildPushNotificationPayload({
            action,
            title,
            body,
            panel: target.panel,
            taskId: task_id,
            status,
            data: {
                branchId: branch_id ? String(branch_id) : undefined,
            },
        });

        sendPushToUser(target.username, target.panel, payload).catch((err) =>
            console.error(`[FCM] ${target.panel} push error for task ${task_id}:`, err?.message)
        );
    }
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

            const targets = resolveNotificationTargets("TASK_STATUS_UPDATED", {
                clientUsername: task.client_username || task.task_username,
                assignedUsername: task.task_username,
                caUsername: task.ca_username || null,
                updatedBy: updated_by,
            });

            for (const target of targets) {
                const payload = buildPushNotificationPayload({
                    action: "TASK_STATUS_UPDATED",
                    title: `Task Update: ${displayStatus}`,
                    body: target.panel === "client"
                        ? `Your task ${taskLabel} status has been updated to "${status}".`
                        : `Task ${taskLabel} status has been updated to "${status}".`,
                    panel: target.panel,
                    taskId: task.task_id,
                    status,
                    data: {
                        taskLabel,
                    },
                });

                sendPushToUser(target.username, target.panel, payload).catch((err) =>
                    console.error(`[FCM] ${target.panel} push error for task ${task.task_id}:`, err?.message)
                );
            }
        }
    } catch (err) {
        console.error("[FCM] Error in notifyTaskStatusPush:", err?.message || err);
    }
}
