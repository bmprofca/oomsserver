import assert from "node:assert/strict";
import test from "node:test";
import { parseAppointmentInput } from "../routes/appointments.js";
import { getGoogleCalendarCallbackUrl, getOfficeCalendarReturnUrl } from "../services/branchGoogleCalendar.js";
import { buildCalendarEvent } from "../services/googleCalendarService.js";

const validInput = {
    client_username: "client-1",
    notes: "Tax review",
    start_at: "2026-11-01T10:00:00+05:30",
    end_at: "2026-11-01T10:30:00+05:30",
    timezone: "Asia/Kolkata",
    attendee_usernames: ["staff-1", "admin-1", "staff-1"],
};

test("appointment input normalizes instants and de-duplicates attendees", () => {
    assert.deepEqual(parseAppointmentInput(validInput), {
        client_username: "client-1",
        notes: "Tax review",
        timezone: "Asia/Kolkata",
        start_at: "2026-11-01 04:30:00",
        end_at: "2026-11-01 05:00:00",
        attendee_usernames: ["staff-1", "admin-1"],
    });
});

test("appointment input rejects invalid times, implicit timezones, and oversized attendee lists", () => {
    assert.throws(() => parseAppointmentInput({ ...validInput, end_at: validInput.start_at }), { status: 400 });
    assert.throws(() => parseAppointmentInput({ ...validInput, start_at: "2026-11-01T10:00:00" }), { status: 400 });
    assert.throws(() => parseAppointmentInput({ ...validInput, timezone: "Not/A_Timezone" }), { status: 400 });
    assert.throws(() => parseAppointmentInput({
        ...validInput,
        attendee_usernames: Array.from({ length: 51 }, (_, index) => `staff-${index}`),
    }), { status: 400 });
});

test("Google Calendar event payload uses the stored UTC instant and selected profile emails", () => {
    const event = buildCalendarEvent({
        google_event_id: "a123456789abcdef",
        client_name: "Example Client",
        branch_name: "Example Company",
        notes: "Review documents",
        start_at: "2026-11-01 04:30:00",
        end_at: "2026-11-01 05:00:00",
        timezone: "Asia/Kolkata",
    }, [{
        attendee_name: "Staff One",
        attendee_email: "staff@example.com",
    }]);

    assert.equal(event.summary, "Example Company - Appointment with Example Client");
    assert.equal(event.description, "Company: Example Company\n\nReview documents");
    assert.equal(event.start.dateTime, "2026-11-01T04:30:00.000Z");
    assert.equal(event.start.timeZone, "Asia/Kolkata");
    assert.deepEqual(event.attendees, [{ email: "staff@example.com", displayName: "Staff One" }]);
});

test("Google Calendar callback returns to the configured Office origin", () => {
    const previousOrigin = process.env.OFFICE_WEB_ORIGIN;
    process.env.OFFICE_WEB_ORIGIN = "https://custom-office.example/";

    try {
        assert.equal(
            getOfficeCalendarReturnUrl(true),
            "https://custom-office.example/settings/google-calendar?calendar_connected=1"
        );
    } finally {
        if (previousOrigin === undefined) delete process.env.OFFICE_WEB_ORIGIN;
        else process.env.OFFICE_WEB_ORIGIN = previousOrigin;
    }
});

test("Google Calendar callback supports a distinct local OAuth redirect URI", () => {
    assert.equal(
        getGoogleCalendarCallbackUrl({
            BASE_DOMAIN: "https://server.ooms.in",
            GOOGLE_CALENDAR_CALLBACK_URL: "http://localhost:8877/api/v1/appointments/google-calendar/callback",
        }),
        "http://localhost:8877/api/v1/appointments/google-calendar/callback"
    );
    assert.equal(
        getGoogleCalendarCallbackUrl({ BASE_DOMAIN: "https://server.ooms.in/" }),
        "https://server.ooms.in/api/v1/appointments/google-calendar/callback"
    );
});

test("Google Calendar callback defaults to production Office outside development", () => {
    const previousOrigin = process.env.OFFICE_WEB_ORIGIN;
    const previousNodeEnv = process.env.NODE_ENV;
    delete process.env.OFFICE_WEB_ORIGIN;
    delete process.env.NODE_ENV;

    try {
        assert.equal(
            getOfficeCalendarReturnUrl(true),
            "https://app.ooms.in/settings/google-calendar?calendar_connected=1"
        );

        process.env.NODE_ENV = "development";
        assert.equal(
            getOfficeCalendarReturnUrl(true),
            "http://localhost:3000/settings/google-calendar?calendar_connected=1"
        );
    } finally {
        if (previousOrigin === undefined) delete process.env.OFFICE_WEB_ORIGIN;
        else process.env.OFFICE_WEB_ORIGIN = previousOrigin;
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
    }
});
