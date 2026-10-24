import { OAuth2Client } from "google-auth-library";
import { getPlatformSettingFresh } from "../helpers/platformSettings.js";

let oauthClient;
let oauthConfig;

async function getOAuthClient() {
    const [clientId, clientSecret, refreshToken] = await Promise.all([
        getPlatformSettingFresh("GOOGLE_CALENDAR_CLIENT_ID"),
        getPlatformSettingFresh("GOOGLE_CALENDAR_CLIENT_SECRET"),
        getPlatformSettingFresh("GOOGLE_CALENDAR_REFRESH_TOKEN"),
    ]);
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error("Google Calendar is not configured on the server");
    }

    const signature = `${clientId}\0${clientSecret}\0${refreshToken}`;
    if (!oauthClient || oauthConfig !== signature) {
        oauthClient = new OAuth2Client(clientId, clientSecret);
        oauthClient.setCredentials({ refresh_token: refreshToken });
        oauthConfig = signature;
    }
    return oauthClient;
}

async function calendarEventsUrl(eventId = "") {
    const calendarId = encodeURIComponent((await getPlatformSettingFresh("GOOGLE_CALENDAR_ID")) || "primary");
    const eventPath = eventId ? `/${encodeURIComponent(eventId)}` : "";
    return `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events${eventPath}`;
}

async function calendarRequest(url, method, body, { allowMissing = false } = {}) {
    const client = await getOAuthClient();
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
    if (response.ok || (allowMissing && response.status === 404)) {
        return { status: response.status };
    }

    const result = await response.json().catch(() => ({}));
    const message = result?.error?.message || `Google Calendar request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
}

export function buildCalendarEvent(appointment, attendees) {
    const asUtcIso = (value) => {
        const source = value instanceof Date ? value.toISOString() : String(value || "").trim();
        const normalized = source.includes(" ") ? source.replace(" ", "T") : source;
        const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
        const date = new Date(hasOffset ? normalized : `${normalized}Z`);
        if (Number.isNaN(date.getTime())) throw new Error("Appointment has an invalid stored date");
        return date.toISOString();
    };
    return {
        id: appointment.google_event_id,
        summary: `Appointment with ${appointment.client_name}`,
        description: appointment.notes || "",
        start: { dateTime: asUtcIso(appointment.start_at), timeZone: appointment.timezone },
        end: { dateTime: asUtcIso(appointment.end_at), timeZone: appointment.timezone },
        attendees: attendees.map((attendee) => ({ email: attendee.attendee_email, displayName: attendee.attendee_name })),
    };
}

export async function syncAppointmentToGoogle(appointment, attendees) {
    const event = buildCalendarEvent(appointment, attendees);
    const eventUrl = await calendarEventsUrl(appointment.google_event_id);
    const sendUpdates = "?sendUpdates=all";

    if (appointment.status === "cancelled") {
        await calendarRequest(`${eventUrl}${sendUpdates}`, "DELETE", undefined, { allowMissing: true });
        return;
    }

    if (appointment.calendar_synced_at) {
        await calendarRequest(`${eventUrl}${sendUpdates}`, "PATCH", event);
        return;
    }

    try {
        await calendarRequest(`${await calendarEventsUrl()}${sendUpdates}`, "POST", event);
    } catch (error) {
        if (error.status !== 409) throw error;
        await calendarRequest(`${eventUrl}${sendUpdates}`, "PATCH", event);
    }
}

export async function isGoogleCalendarConfigured() {
    const [clientId, clientSecret, refreshToken] = await Promise.all([
        getPlatformSettingFresh("GOOGLE_CALENDAR_CLIENT_ID"),
        getPlatformSettingFresh("GOOGLE_CALENDAR_CLIENT_SECRET"),
        getPlatformSettingFresh("GOOGLE_CALENDAR_REFRESH_TOKEN"),
    ]);
    return Boolean(clientId && clientSecret && refreshToken);
}

export async function testGoogleCalendarConnection() {
    const url = `${await calendarEventsUrl()}?maxResults=1`;
    await calendarRequest(url, "GET");
    return { connected: true };
}
