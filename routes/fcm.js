import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";
import { validateClientSession } from "../middleware/validateClientSession.js";

const router = express.Router();

const VALID_PANELS = new Set(["enduser", "client", "ca"]);

/**
 * POST /api/v1/fcm/register
 *
 * Registers (or updates) the device FCM token for an enduser/staff/admin session.
 * Called by the mobile app immediately after login or branch switch.
 *
 * Headers: username, token  (standard auth middleware)
 * Body:
 *   - fcm_token  {string}  required  – the Firebase device token
 *   - panel      {string}  required  – one of: enduser | client | ca
 *   - device_id  {string}  optional  – unique device identifier (e.g. Android ID)
 */
router.post("/register", auth, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const { fcm_token, panel, device_id } = req.body || {};

        if (!username) {
            return res.status(400).json({ success: false, message: "Missing username header" });
        }
        if (!fcm_token || String(fcm_token).trim() === "") {
            return res.status(400).json({ success: false, message: "fcm_token is required" });
        }
        if (!panel || !VALID_PANELS.has(String(panel).toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: `panel must be one of: ${[...VALID_PANELS].join(", ")}`,
            });
        }

        const normalizedPanel = String(panel).toLowerCase();
        const normalizedToken = String(fcm_token).trim();
        const normalizedDeviceId = device_id ? String(device_id).trim() : null;

        if (normalizedDeviceId) {
            // Upsert: update token if same device already registered, otherwise insert
            await pool.query(
                `INSERT INTO fcm_tokens (username, panel, fcm_token, device_id)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   fcm_token  = VALUES(fcm_token),
                   updated_at = CURRENT_TIMESTAMP`,
                [username, normalizedPanel, normalizedToken, normalizedDeviceId]
            );
        } else {
            // No device_id: remove old token(s) for this user+panel and insert fresh
            // This avoids accumulating stale tokens for users who reinstall the app
            await pool.query(
                `DELETE FROM fcm_tokens WHERE username = ? AND panel = ? AND device_id IS NULL`,
                [username, normalizedPanel]
            );
            await pool.query(
                `INSERT INTO fcm_tokens (username, panel, fcm_token, device_id)
                 VALUES (?, ?, ?, NULL)`,
                [username, normalizedPanel, normalizedToken]
            );
        }

        return res.status(200).json({ success: true, message: "FCM token registered" });
    } catch (error) {
        console.error("[FCM Register] Error:", error);
        return res.status(500).json({ success: false, message: "Failed to register FCM token" });
    }
});

/**
 * POST /api/v1/fcm/register-client
 *
 * Same as /register but uses the client session middleware.
 * Called by the mobile app on the *client panel* after login.
 *
 * Headers: token, countrycode, mobile, username  (client session middleware)
 * Body: same as above (panel will be forced to 'client')
 */
router.post("/register-client", validateClientSession, async (req, res) => {
    try {
        const username = req.client_username;
        const { fcm_token, device_id } = req.body || {};

        if (!fcm_token || String(fcm_token).trim() === "") {
            return res.status(400).json({ success: false, message: "fcm_token is required" });
        }

        const normalizedToken = String(fcm_token).trim();
        const normalizedDeviceId = device_id ? String(device_id).trim() : null;

        if (normalizedDeviceId) {
            await pool.query(
                `INSERT INTO fcm_tokens (username, panel, fcm_token, device_id)
                 VALUES (?, 'client', ?, ?)
                 ON DUPLICATE KEY UPDATE
                   fcm_token  = VALUES(fcm_token),
                   updated_at = CURRENT_TIMESTAMP`,
                [username, normalizedToken, normalizedDeviceId]
            );
        } else {
            await pool.query(
                `DELETE FROM fcm_tokens WHERE username = ? AND panel = 'client' AND device_id IS NULL`,
                [username]
            );
            await pool.query(
                `INSERT INTO fcm_tokens (username, panel, fcm_token, device_id)
                 VALUES (?, 'client', ?, NULL)`,
                [username, normalizedToken]
            );
        }

        return res.status(200).json({ success: true, message: "FCM token registered" });
    } catch (error) {
        console.error("[FCM Register Client] Error:", error);
        return res.status(500).json({ success: false, message: "Failed to register FCM token" });
    }
});

/**
 * DELETE /api/v1/fcm/unregister
 *
 * Removes the FCM token for the current device on logout.
 *
 * Headers: username, token
 * Body:
 *   - fcm_token  {string}  required
 *   - panel      {string}  required
 */
router.delete("/unregister", async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || req.body?.username || "";
        const { fcm_token, panel } = req.body || {};

        if (!fcm_token) {
            return res.status(400).json({ success: false, message: "fcm_token is required" });
        }

        let query = "DELETE FROM fcm_tokens WHERE fcm_token = ?";
        const params = [String(fcm_token).trim()];

        if (panel) {
            query += " AND panel = ?";
            params.push(String(panel).toLowerCase());
        }
        if (username) {
            query += " AND username = ?";
            params.push(String(username).trim());
        }

        await pool.query(query, params);

        return res.status(200).json({ success: true, message: "FCM token removed" });
    } catch (error) {
        console.error("[FCM Unregister] Error:", error);
        return res.status(500).json({ success: false, message: "Failed to remove FCM token" });
    }
});

export default router;

