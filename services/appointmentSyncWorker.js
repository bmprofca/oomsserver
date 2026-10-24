import cron from "node-cron";
import pool from "../db.js";
import { syncAppointmentToGoogle } from "./googleCalendarService.js";

function mysqlDate(date) {
    return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function syncAppointment(appointmentId) {
    const lockConnection = await pool.getConnection();
    const lockName = `appointment_${appointmentId}`;
    let lockAcquired = false;
    try {
        const [lockRows] = await lockConnection.query(`SELECT GET_LOCK(?, 5) AS acquired`, [lockName]);
        lockAcquired = Number(lockRows?.[0]?.acquired) === 1;
        if (!lockAcquired) return;

        const [rows] = await pool.query(
            `SELECT * FROM appointments WHERE appointment_id = ? LIMIT 1`,
            [appointmentId]
        );
        const appointment = rows[0];
        if (!appointment) throw new Error("Appointment not found");

        const [attendees] = await pool.query(
            `SELECT attendee_username, attendee_name, attendee_email
             FROM appointment_attendees WHERE appointment_id = ?`,
            [appointmentId]
        );

        try {
            await syncAppointmentToGoogle(appointment, attendees);
            const cancelled = appointment.status === "cancelled";
            await pool.query(
                `UPDATE appointments
                 SET calendar_sync_status = ?, calendar_sync_error = NULL,
                     calendar_synced_at = ?, calendar_retry_at = NULL
                 WHERE appointment_id = ?`,
                [cancelled ? "cancelled" : "synced", cancelled ? null : mysqlDate(new Date()), appointmentId]
            );
        } catch (error) {
            const attempts = Number(appointment.calendar_sync_attempts || 0) + 1;
            const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
            const retryAt = new Date(Date.now() + delayMinutes * 60 * 1000);
            await pool.query(
                `UPDATE appointments
                 SET calendar_sync_status = 'failed', calendar_sync_error = ?,
                     calendar_sync_attempts = ?, calendar_retry_at = ?, calendar_synced_at = NULL
                 WHERE appointment_id = ?`,
                [String(error?.message || "Google Calendar synchronization failed").slice(0, 2000), attempts, mysqlDate(retryAt), appointmentId]
            );
        }
    } finally {
        if (lockAcquired) {
            await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName]).catch((error) => {
                console.error("[Appointment sync worker] Could not release appointment lock:", error?.message || error);
            });
        }
        lockConnection.release();
    }
}

export async function retryDueAppointmentCalendarSyncs() {
    const [rows] = await pool.query(
        `SELECT appointment_id FROM appointments
         WHERE calendar_sync_status IN ('pending','failed')
           AND calendar_retry_at IS NOT NULL AND calendar_retry_at <= UTC_TIMESTAMP()
         ORDER BY calendar_retry_at ASC LIMIT 25`
    );
    for (const row of rows) {
        await syncAppointment(row.appointment_id);
    }
}

export function startAppointmentSyncWorker() {
    cron.schedule("*/5 * * * *", async () => {
        try {
            await retryDueAppointmentCalendarSyncs();
        } catch (error) {
            console.error("[Appointment sync worker] Retry batch failed:", error?.message || error);
        }
    });
}
