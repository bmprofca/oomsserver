import {
    beginBranchGoogleCalendarConnect,
    completeBranchGoogleCalendarConnect,
    getBranchCalendarStatus,
    getCalendarConfigForNewAppointment,
    getOfficeCalendarReturnUrl,
    isCalendarConfiguredForAppointment,
    syncAppointmentCalendar,
    testBranchGoogleCalendar,
} from "./branchGoogleCalendar.js";

export {
    beginBranchGoogleCalendarConnect,
    completeBranchGoogleCalendarConnect,
    getBranchCalendarStatus,
    getCalendarConfigForNewAppointment,
    getOfficeCalendarReturnUrl,
    isCalendarConfiguredForAppointment,
    testBranchGoogleCalendar,
};

export function buildCalendarEvent(appointment, attendees) {
    const asUtcIso = (value) => {
        const source = value instanceof Date ? value.toISOString() : String(value || "").trim();
        const normalized = source.includes(" ") ? source.replace(" ", "T") : source;
        const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
        const date = new Date(hasOffset ? normalized : `${normalized}Z`);
        if (Number.isNaN(date.getTime())) throw new Error("Appointment has an invalid stored date");
        return date.toISOString();
    };
    const companyName = String(appointment.branch_name || "").trim();
    const notes = String(appointment.notes || "").trim();
    return {
        id: appointment.google_event_id,
        summary: `${companyName ? `${companyName} - ` : ""}Appointment with ${appointment.client_name}`,
        description: [companyName ? `Company: ${companyName}` : "", notes].filter(Boolean).join("\n\n"),
        start: { dateTime: asUtcIso(appointment.start_at), timeZone: appointment.timezone },
        end: { dateTime: asUtcIso(appointment.end_at), timeZone: appointment.timezone },
        attendees: attendees.map((attendee) => ({ email: attendee.attendee_email, displayName: attendee.attendee_name })),
    };
}

export async function syncAppointmentToGoogle(appointment, attendees) {
    const event = buildCalendarEvent(appointment, attendees);
    await syncAppointmentCalendar(appointment, event);
}
