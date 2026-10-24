import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import pool from "../db.js";
import { decryptSecret, encryptSecret } from "../helpers/secretBox.js";
import { getPlatformSettingFresh } from "../helpers/platformSettings.js";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const BASE_DOMAIN = String(process.env.BASE_DOMAIN || "https://server.ooms.in").trim().replace(/\/+$/, "");
const CALLBACK_URL = `${BASE_DOMAIN}/api/v1/appointments/google-calendar/callback`;

async function getOAuthCredentials() {
    const [clientId, clientSecret] = await Promise.all([
        getPlatformSettingFresh("GOOGLE_CALENDAR_OAUTH_CLIENT_ID"),
        getPlatformSettingFresh("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET"),
    ]);
    return {
        client_id: String(clientId || "").trim(),
        client_secret: String(clientSecret || "").trim(),
    };
}

async function configuredOAuthClient() {
    const { client_id: clientId, client_secret: clientSecret } = await getOAuthCredentials();
    if (!clientId || !clientSecret) {
        throw new Error("Configure the OOMS Google Calendar OAuth client in Admin Panel → Platform Settings");
    }
    return new OAuth2Client(clientId, clientSecret, CALLBACK_URL);
}

function calendarEventsUrl(calendarId, eventId = "") {
    const calendar = encodeURIComponent(calendarId || "primary");
    return `https://www.googleapis.com/calendar/v3/calendars/${calendar}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;
}

async function requestCalendar(config, url, method = "GET", body, allowMissing = false) {
    const { client_id, client_secret } = await getOAuthCredentials();
    if (!client_id || !client_secret) {
        throw new Error("Configure the OOMS Google Calendar OAuth client in Admin Panel → Platform Settings");
    }
    const client = new OAuth2Client(client_id, client_secret, CALLBACK_URL);
    client.setCredentials({ refresh_token: config.refresh_token });
    const tokenResponse = await client.getAccessToken();
    const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
    if (!token) throw new Error("Google Calendar access token could not be obtained");

    const response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.ok || (allowMissing && response.status === 404)) return;

    const result = await response.json().catch(() => ({}));
    const error = new Error(result?.error?.message || `Google Calendar request failed (${response.status})`);
    error.status = response.status;
    throw error;
}

export async function getActiveBranchCalendarConnection(branchId) {
    const [rows] = await pool.query(
        `SELECT connection_id, branch_id, calendar_id, connected_at
         FROM branch_google_calendar_connections
         WHERE branch_id = ? AND is_active = 1
         ORDER BY connected_at DESC LIMIT 1`,
        [branchId]
    );
    return rows[0] || null;
}

export async function getBranchCalendarStatus(branchId) {
    const connection = await getActiveBranchCalendarConnection(branchId);
    return {
        configured: Boolean(connection),
        calendar_id: connection?.calendar_id || "",
        connected_at: connection?.connected_at || null,
    };
}

export async function beginBranchGoogleCalendarConnect({ branchId, username, calendarId }) {
    const state = crypto.randomBytes(32).toString("hex");
    const normalizedCalendarId = String(calendarId || "primary").trim();
    if (!normalizedCalendarId || normalizedCalendarId.length > 255) {
        throw Object.assign(new Error("Enter a valid Google Calendar ID"), { status: 400 });
    }
    const oauth = await configuredOAuthClient();
    await pool.query(
        `DELETE FROM branch_google_calendar_oauth_states WHERE expires_at <= UTC_TIMESTAMP()`
    );
    await pool.query(
        `INSERT INTO branch_google_calendar_oauth_states
         (state_hash, branch_id, username, calendar_id, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`,
        [crypto.createHash("sha256").update(state).digest("hex"), branchId, username, normalizedCalendarId]
    );
    return {
        authorization_url: oauth.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: true,
            scope: [CALENDAR_SCOPE],
            state,
        }),
    };
}

export async function completeBranchGoogleCalendarConnect({ state, code }) {
    const stateHash = crypto.createHash("sha256").update(String(state || "")).digest("hex");
    const connection = await pool.getConnection();
    let stateRow;
    try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
            `SELECT state_hash, branch_id, username, calendar_id
             FROM branch_google_calendar_oauth_states
             WHERE state_hash = ? AND expires_at > UTC_TIMESTAMP()
             LIMIT 1 FOR UPDATE`,
            [stateHash]
        );
        stateRow = rows[0];
        if (!stateRow) {
            throw Object.assign(new Error("Google authorization expired or was already used. Return to Office Settings and try again."), { status: 400 });
        }
        await connection.query(
            `DELETE FROM branch_google_calendar_oauth_states WHERE state_hash = ?`,
            [stateHash]
        );
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    const [admins] = await pool.query(
        `SELECT 1 FROM branch_mapping
         WHERE branch_id = ? AND username = ? AND LOWER(type) = 'admin'
           AND (is_deleted = '0' OR is_deleted = 0)
           AND (status = '1' OR status = 1)
           AND (is_accepted = '1' OR is_accepted = 1)
         LIMIT 1`,
        [stateRow.branch_id, stateRow.username]
    );
    if (!admins.length) throw Object.assign(new Error("The initiating user is no longer an active branch admin"), { status: 403 });

    const oauth = await configuredOAuthClient();
    const { tokens } = await oauth.getToken(String(code || ""));
    if (!tokens.refresh_token) {
        throw new Error("Google did not issue a refresh token. Revoke OOMS access from your Google Account and connect again.");
    }
    const config = {
        ...await getOAuthCredentials(),
        refresh_token: tokens.refresh_token,
        calendar_id: stateRow.calendar_id || "primary",
    };
    await requestCalendar(config, calendarEventsUrl(config.calendar_id));

    const connectionId = `gcal_${crypto.randomUUID()}`;
    const dbConnection = await pool.getConnection();
    try {
        await dbConnection.beginTransaction();
        const [branchRows] = await dbConnection.query(
            `SELECT branch_id FROM branch_list WHERE branch_id = ? FOR UPDATE`,
            [stateRow.branch_id]
        );
        if (!branchRows.length) throw new Error("The company branch no longer exists");
        await dbConnection.query(
            `UPDATE branch_google_calendar_connections SET is_active = 0 WHERE branch_id = ?`,
            [stateRow.branch_id]
        );
        await dbConnection.query(
            `INSERT INTO branch_google_calendar_connections
             (connection_id, branch_id, refresh_token_encrypted, calendar_id,
              is_active, created_by, connected_at)
             VALUES (?, ?, ?, ?, 1, ?, UTC_TIMESTAMP())`,
            [connectionId, stateRow.branch_id, encryptSecret(tokens.refresh_token), config.calendar_id, stateRow.username]
        );
        await dbConnection.commit();
    } catch (error) {
        await dbConnection.rollback();
        throw error;
    } finally {
        dbConnection.release();
    }
    return { branch_id: stateRow.branch_id, connection_id: connectionId };
}

async function getLegacyCalendarConfig() {
    const [rows] = await pool.query(
        `SELECT setting_key, setting_value, is_secret
         FROM platform_settings
         WHERE setting_key IN (
           'GOOGLE_CALENDAR_CLIENT_ID',
           'GOOGLE_CALENDAR_CLIENT_SECRET',
           'GOOGLE_CALENDAR_REFRESH_TOKEN',
           'GOOGLE_CALENDAR_ID'
         )`
    );
    const settings = new Map(rows.map((row) => [
        row.setting_key,
        row.is_secret ? decryptSecret(row.setting_value) : String(row.setting_value || ""),
    ]));
    const clientId = settings.get("GOOGLE_CALENDAR_CLIENT_ID") || "";
    const clientSecret = settings.get("GOOGLE_CALENDAR_CLIENT_SECRET") || "";
    const refreshToken = settings.get("GOOGLE_CALENDAR_REFRESH_TOKEN") || "";
    if (!clientId || !clientSecret || !refreshToken) return null;
    return {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        calendar_id: settings.get("GOOGLE_CALENDAR_ID") || "primary",
    };
}

async function getAppointmentCalendarConfig(appointment) {
    const connectionId = appointment.google_calendar_connection_id;
    if (connectionId === "legacy" || !connectionId) {
        const legacy = await getLegacyCalendarConfig();
        if (!legacy) {
            throw new Error("This older appointment still uses the legacy shared Google Calendar, whose credentials are unavailable");
        }
        return legacy;
    }

    const [rows] = await pool.query(
        `SELECT c.refresh_token_encrypted, c.calendar_id
         FROM branch_google_calendar_connections c
         WHERE c.connection_id = ? AND c.branch_id = ? LIMIT 1`,
        [connectionId, appointment.branch_id]
    );
    if (!rows[0]) throw new Error("The Google Calendar connection for this appointment is unavailable");
    return {
        ...await getOAuthCredentials(),
        refresh_token: decryptSecret(rows[0].refresh_token_encrypted),
        calendar_id: rows[0].calendar_id || "primary",
    };
}

export async function getCalendarConfigForNewAppointment(branchId) {
    configuredOAuthClient();
    const connection = await getActiveBranchCalendarConnection(branchId);
    if (!connection) {
        throw Object.assign(new Error("Connect this company's Google Calendar in Settings before scheduling appointments"), { status: 409 });
    }
    return connection.connection_id;
}

export async function syncAppointmentCalendar(appointment, event) {
    const config = await getAppointmentCalendarConfig(appointment);
    if (!config.client_id || !config.client_secret || !config.refresh_token) {
        throw new Error("Google Calendar credentials are unavailable for this appointment");
    }
    const eventUrl = calendarEventsUrl(config.calendar_id, appointment.google_event_id);
    const sendUpdates = "?sendUpdates=all";
    if (appointment.status === "cancelled") {
        await requestCalendar(config, `${eventUrl}${sendUpdates}`, "DELETE", undefined, true);
        return;
    }
    if (appointment.calendar_synced_at) {
        await requestCalendar(config, `${eventUrl}${sendUpdates}`, "PATCH", event);
        return;
    }
    try {
        await requestCalendar(config, `${calendarEventsUrl(config.calendar_id)}${sendUpdates}`, "POST", event);
    } catch (error) {
        if (error.status !== 409) throw error;
        await requestCalendar(config, `${eventUrl}${sendUpdates}`, "PATCH", event);
    }
}

export async function isCalendarConfiguredForAppointment(appointment) {
    if (appointment?.google_calendar_connection_id === "legacy" || !appointment?.google_calendar_connection_id) {
        return Boolean(await getLegacyCalendarConfig());
    }
    const [rows] = await pool.query(
        `SELECT 1 FROM branch_google_calendar_connections
         WHERE connection_id = ? AND branch_id = ? LIMIT 1`,
        [appointment.google_calendar_connection_id, appointment.branch_id]
    );
    return Boolean(rows[0]);
}

export async function testBranchGoogleCalendar(branchId) {
    const connection = await getActiveBranchCalendarConnection(branchId);
    if (!connection) throw Object.assign(new Error("Connect this company's Google Calendar first"), { status: 400 });
    const [rows] = await pool.query(
        `SELECT refresh_token_encrypted, calendar_id
         FROM branch_google_calendar_connections
         WHERE connection_id = ? AND branch_id = ? LIMIT 1`,
        [connection.connection_id, branchId]
    );
    const config = {
        ...await getOAuthCredentials(),
        refresh_token: decryptSecret(rows[0]?.refresh_token_encrypted),
        calendar_id: rows[0]?.calendar_id || "primary",
    };
    if (!config.client_id || !config.client_secret || !config.refresh_token) {
        throw new Error("Google Calendar credentials are unavailable. Reconnect this branch's account.");
    }
    await requestCalendar(config, calendarEventsUrl(config.calendar_id));
    await pool.query(
        `UPDATE branch_google_calendar_connections SET last_tested_at = UTC_TIMESTAMP() WHERE connection_id = ?`,
        [connection.connection_id]
    );
    return { connected: true, calendar_id: config.calendar_id };
}

export function getOfficeCalendarReturnUrl(success, message = "") {
    const configuredOrigin = String(process.env.OFFICE_WEB_ORIGIN || "").trim();
    const fallback = process.env.NODE_ENV === "production" ? "" : "http://localhost:3000";
    const origin = configuredOrigin || fallback;
    if (!origin) throw new Error("OFFICE_WEB_ORIGIN must be configured for the Google Calendar OAuth callback");
    const url = new URL("/settings/google-calendar", origin);
    if (success) url.searchParams.set("calendar_connected", "1");
    else url.searchParams.set("calendar_error", message || "Google Calendar connection failed");
    return url.toString();
}
