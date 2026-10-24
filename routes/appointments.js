import crypto from "crypto";
import express from "express";
import pool from "../db.js";
import { auth, checkSubscription, requireFeature, validateBranch } from "../middleware/auth.js";
import { syncAppointment } from "../services/appointmentSyncWorker.js";
import { isGoogleCalendarConfigured } from "../services/googleCalendarService.js";
import { notifyAppointmentAttendeesPush } from "../helpers/fcmPush.js";

const router = express.Router();
const coreAccess = [auth, validateBranch, checkSubscription, requireFeature("core")];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sessionUsername(req) {
    return String(req.headers.username || req.headers.Username || "").trim();
}

function sendError(res, error, fallback) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({ success: false, message: error?.message || fallback });
}

async function verifyScheduler(req) {
    const [rows] = await pool.query(
        `SELECT type FROM branch_mapping
         WHERE branch_id = ? AND username = ?
           AND LOWER(type) IN ('staff','admin')
           AND (is_deleted = '0' OR is_deleted = 0)
           AND (status = '1' OR status = 1)
           AND (is_accepted = '1' OR is_accepted = 1)
         LIMIT 1`,
        [req.branch_id, sessionUsername(req)]
    );
    if (!rows.length) throw Object.assign(new Error("Only active staff and admins can manage appointments"), { status: 403 });
    return String(rows[0].type || "").toLowerCase();
}

export function parseAppointmentInput(body) {
    const client_username = String(body?.client_username || "").trim();
    const notes = String(body?.notes || "").trim();
    const timezone = String(body?.timezone || "").trim();
    const startValue = String(body?.start_at || "").trim();
    const endValue = String(body?.end_at || "").trim();
    const hasExplicitOffset = (value) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
    const startDate = new Date(startValue);
    const endDate = new Date(endValue);
    const attendees = [...new Set((Array.isArray(body?.attendee_usernames) ? body.attendee_usernames : [])
        .map((value) => String(value).trim()).filter(Boolean))];

    if (!client_username) throw Object.assign(new Error("client_username is required"), { status: 400 });
    if (!hasExplicitOffset(startValue) || !hasExplicitOffset(endValue)
        || !Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate >= endDate) {
        throw Object.assign(new Error("A valid appointment start and end time are required"), { status: 400 });
    }
    if (!timezone || timezone.length > 64) throw Object.assign(new Error("A valid IANA timezone is required"), { status: 400 });
    try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
        throw Object.assign(new Error("A valid IANA timezone is required"), { status: 400 });
    }
    if (!attendees.length) throw Object.assign(new Error("Select at least one staff member or admin"), { status: 400 });
    if (attendees.length > 50) throw Object.assign(new Error("An appointment can have at most 50 attendees"), { status: 400 });
    if (notes.length > 10000) throw Object.assign(new Error("Notes must be 10,000 characters or fewer"), { status: 400 });

    return {
        client_username,
        notes,
        timezone,
        start_at: startDate.toISOString().slice(0, 19).replace("T", " "),
        end_at: endDate.toISOString().slice(0, 19).replace("T", " "),
        attendee_usernames: attendees,
    };
}

async function getClient(clientUsername, branchId) {
    const [rows] = await pool.query(
        `SELECT c.username, p.name
         FROM clients c
         JOIN profile p ON p.username = c.username AND p.status = '1'
         WHERE c.username = ? AND c.branch_id = ? AND c.status = '1'
           AND c.user_type = 'client' AND (c.is_deleted = '0' OR c.is_deleted = 0)
         ORDER BY p.id DESC LIMIT 1`,
        [clientUsername, branchId]
    );
    if (!rows.length) throw Object.assign(new Error("Active client not found in this branch"), { status: 404 });
    return rows[0];
}

async function getAttendees(usernames, branchId) {
    const placeholders = usernames.map(() => "?").join(",");
    const [rows] = await pool.query(
        `SELECT bm.username, p.name, p.email
         FROM branch_mapping bm
         JOIN profile p ON p.username = bm.username AND p.status = '1'
         WHERE bm.branch_id = ? AND bm.username IN (${placeholders})
           AND LOWER(bm.type) IN ('staff','admin')
           AND (bm.is_deleted = '0' OR bm.is_deleted = 0)
           AND (bm.status = '1' OR bm.status = 1)
           AND (bm.is_accepted = '1' OR bm.is_accepted = 1)
         GROUP BY bm.username, p.name, p.email
         ORDER BY p.name`,
        [branchId, ...usernames]
    );
    if (rows.length !== usernames.length) {
        throw Object.assign(new Error("One or more selected attendees are not active staff or admins in this branch"), { status: 400 });
    }
    const noEmail = rows.filter((row) => !EMAIL_PATTERN.test(String(row.email || "").trim()));
    if (noEmail.length) {
        throw Object.assign(new Error(`Add a valid profile email for: ${noEmail.map((row) => row.name || row.username).join(", ")}`), { status: 400 });
    }
    return rows.map((row) => ({
        attendee_username: row.username,
        attendee_name: row.name || row.username,
        attendee_email: String(row.email).trim(),
    }));
}

async function fetchAppointment(appointmentId, branchId) {
    const [rows] = await pool.query(
        `SELECT a.* FROM appointments a
         WHERE a.appointment_id = ? AND a.branch_id = ? LIMIT 1`,
        [appointmentId, branchId]
    );
    if (!rows.length) return null;
    const [attendees] = await pool.query(
        `SELECT attendee_username, attendee_name, attendee_email
         FROM appointment_attendees WHERE appointment_id = ? ORDER BY attendee_name`,
        [appointmentId]
    );
    return { ...rows[0], attendees };
}

async function persistAttendees(connection, appointmentId, attendees) {
    await connection.query(`DELETE FROM appointment_attendees WHERE appointment_id = ?`, [appointmentId]);
    for (const attendee of attendees) {
        await connection.query(
            `INSERT INTO appointment_attendees
             (appointment_id, attendee_username, attendee_name, attendee_email)
             VALUES (?, ?, ?, ?)`,
            [appointmentId, attendee.attendee_username, attendee.attendee_name, attendee.attendee_email]
        );
    }
}

async function syncAndReturn(res, appointmentId, statusCode = 200) {
    await syncAppointment(appointmentId);
    const data = await fetchAppointment(appointmentId, res.locals.branchId);
    return res.status(statusCode).json({
        success: true,
        data,
        calendar: {
            configured: await isGoogleCalendarConfigured(),
            status: data.calendar_sync_status,
            error: data.calendar_sync_error,
        },
    });
}

function actorRole(req) {
    return String(req.appointmentRole || "").toLowerCase();
}

async function ensureAppointmentManageAccess(req, appointment) {
    if (actorRole(req) === "admin" || appointment.created_by === sessionUsername(req)) return;
    const [rows] = await pool.query(
        `SELECT 1 FROM appointment_attendees
         WHERE appointment_id = ? AND attendee_username = ? LIMIT 1`,
        [appointment.appointment_id, sessionUsername(req)]
    );
    if (!rows.length) throw Object.assign(new Error("You can only edit appointments you created or are attending"), { status: 403 });
}

router.use(...coreAccess);
router.use(async (req, res, next) => {
    try {
        req.appointmentRole = await verifyScheduler(req);
        res.locals.branchId = req.branch_id;
        next();
    } catch (error) {
        sendError(res, error, "Failed to verify appointment access");
    }
});

router.get("/attendees", async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT bm.username, p.name, p.email, LOWER(bm.type) AS role
             FROM branch_mapping bm
             JOIN profile p ON p.username = bm.username AND p.status = '1'
             WHERE bm.branch_id = ? AND LOWER(bm.type) IN ('staff','admin')
               AND (bm.is_deleted = '0' OR bm.is_deleted = 0)
               AND (bm.status = '1' OR bm.status = 1)
               AND (bm.is_accepted = '1' OR bm.is_accepted = 1)
             GROUP BY bm.username, p.name, p.email, bm.type
             ORDER BY p.name`,
            [req.branch_id]
        );
        return res.json({
            success: true,
            data: rows.map((row) => ({ ...row, can_receive_invite: EMAIL_PATTERN.test(String(row.email || "").trim()) })),
        });
    } catch (error) {
        return sendError(res, error, "Failed to fetch appointment attendees");
    }
});

router.get("/clients", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const searchValue = `%${search}%`;
        const [rows] = await pool.query(
            `SELECT c.username, p.name, p.email
             FROM clients c
             JOIN profile p ON p.username = c.username AND p.status = '1'
             WHERE c.branch_id = ? AND c.user_type = 'client'
               AND c.status = '1'
               AND (c.is_deleted = '0' OR c.is_deleted = 0)
               AND (? = '' OR p.name LIKE ? OR p.email LIKE ? OR c.username LIKE ?)
             GROUP BY c.username, p.name, p.email
             ORDER BY p.name LIMIT 25`,
            [req.branch_id, search, searchValue, searchValue, searchValue]
        );
        return res.json({ success: true, data: rows });
    } catch (error) {
        return sendError(res, error, "Failed to search clients");
    }
});

router.get("/", async (req, res) => {
    try {
        const params = [req.branch_id];
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
        const offset = (page - 1) * limit;
        let where = "a.branch_id = ?";
        const search = String(req.query.search || "").trim();
        const fromDate = String(req.query.from_date || "").trim();
        const toDate = String(req.query.to_date || "").trim();
        const isDate = (value) => {
            if (!value) return true;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
            const parsed = new Date(`${value}T00:00:00.000Z`);
            return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
        };
        if (!isDate(fromDate) || !isDate(toDate) || (fromDate && toDate && fromDate > toDate)) {
            return res.status(400).json({ success: false, message: "Invalid appointment date range" });
        }
        if (String(req.query.include_cancelled || "false") !== "true") where += " AND a.status = 'scheduled'";
        if (req.query.client_username) {
            where += " AND a.client_username = ?";
            params.push(String(req.query.client_username));
        }
        if (String(req.query.mine || "false") === "true") {
            where += " AND a.start_at >= UTC_TIMESTAMP() AND EXISTS (SELECT 1 FROM appointment_attendees mine WHERE mine.appointment_id = a.appointment_id AND mine.attendee_username = ?)";
            params.push(sessionUsername(req));
        } else if (actorRole(req) !== "admin") {
            where += " AND (a.created_by = ? OR EXISTS (SELECT 1 FROM appointment_attendees mine WHERE mine.appointment_id = a.appointment_id AND mine.attendee_username = ?))";
            params.push(sessionUsername(req), sessionUsername(req));
        }
        if (search) {
            where += " AND (a.client_name LIKE ? OR a.client_username LIKE ? OR EXISTS (SELECT 1 FROM appointment_attendees matching WHERE matching.appointment_id = a.appointment_id AND (matching.attendee_name LIKE ? OR matching.attendee_username LIKE ?)))";
            const searchValue = `%${search}%`;
            params.push(searchValue, searchValue, searchValue, searchValue);
        }
        if (fromDate) {
            where += " AND a.start_at >= ?";
            params.push(`${fromDate} 00:00:00`);
        }
        if (toDate) {
            where += " AND a.start_at < DATE_ADD(?, INTERVAL 1 DAY)";
            params.push(`${toDate} 00:00:00`);
        }
        const [countRows] = await pool.query(
            `SELECT COUNT(*) AS total FROM appointments a WHERE ${where}`,
            params
        );
        const total = Number(countRows?.[0]?.total || 0);
        const [rows] = await pool.query(
            `SELECT a.* FROM appointments a WHERE ${where}
             ORDER BY a.start_at ${String(req.query.mine || "false") === "true" ? "ASC" : "DESC"}
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        if (!rows.length) return res.json({
            success: true,
            data: [],
            pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
        });
        const ids = rows.map((row) => row.appointment_id);
        const [attendees] = await pool.query(
            `SELECT appointment_id, attendee_username, attendee_name, attendee_email
             FROM appointment_attendees WHERE appointment_id IN (${ids.map(() => "?").join(",")})
             ORDER BY attendee_name`,
            ids
        );
        const byAppointment = new Map();
        for (const attendee of attendees) {
            const list = byAppointment.get(attendee.appointment_id) || [];
            list.push(attendee);
            byAppointment.set(attendee.appointment_id, list);
        }
        return res.json({
            success: true,
            data: rows.map((row) => ({ ...row, attendees: byAppointment.get(row.appointment_id) || [] })),
            pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        return sendError(res, error, "Failed to fetch appointments");
    }
});

router.post("/", async (req, res) => {
    let connection;
    try {
        const input = parseAppointmentInput(req.body);
        const [client, attendees] = await Promise.all([
            getClient(input.client_username, req.branch_id),
            getAttendees(input.attendee_usernames, req.branch_id),
        ]);
        const appointmentId = `apt_${crypto.randomUUID()}`;
        const eventId = crypto.randomBytes(20).toString("hex");
        connection = await pool.getConnection();
        await connection.beginTransaction();
        await connection.query(
            `INSERT INTO appointments
             (appointment_id, branch_id, client_username, client_name, created_by, notes,
              start_at, end_at, timezone, google_event_id, calendar_retry_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
            [appointmentId, req.branch_id, client.username, client.name, sessionUsername(req),
                input.notes, input.start_at, input.end_at, input.timezone, eventId]
        );
        await persistAttendees(connection, appointmentId, attendees);
        await connection.commit();
        connection.release();
        connection = null;
        notifyAppointmentAttendeesPush({
            action: "APPOINTMENT_CREATED",
            appointmentId,
            branchId: req.branch_id,
            clientName: client.name,
            startAt: input.start_at,
            timezone: input.timezone,
            attendeeUsernames: attendees.map((attendee) => attendee.attendee_username),
        }).catch((pushError) => console.error("[FCM] Appointment create push error:", pushError?.message || pushError));
        return syncAndReturn(res, appointmentId, 201);
    } catch (error) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        return sendError(res, error, "Failed to create appointment");
    }
});

router.put("/:appointmentId", async (req, res) => {
    let connection;
    try {
        const existing = await fetchAppointment(req.params.appointmentId, req.branch_id);
        if (!existing) return res.status(404).json({ success: false, message: "Appointment not found" });
        await ensureAppointmentManageAccess(req, existing);
        if (existing.status === "cancelled") return res.status(409).json({ success: false, message: "Cancelled appointments cannot be edited" });

        const input = parseAppointmentInput(req.body);
        const [client, attendees] = await Promise.all([
            getClient(input.client_username, req.branch_id),
            getAttendees(input.attendee_usernames, req.branch_id),
        ]);
        connection = await pool.getConnection();
        await connection.beginTransaction();
        await connection.query(
            `UPDATE appointments SET client_username = ?, client_name = ?, notes = ?,
             start_at = ?, end_at = ?, timezone = ?, calendar_sync_status = 'pending',
             calendar_sync_error = NULL, calendar_retry_at = UTC_TIMESTAMP()
             WHERE appointment_id = ? AND branch_id = ?`,
            [client.username, client.name, input.notes, input.start_at, input.end_at, input.timezone,
                existing.appointment_id, req.branch_id]
        );
        await persistAttendees(connection, existing.appointment_id, attendees);
        await connection.commit();
        connection.release();
        connection = null;
        notifyAppointmentAttendeesPush({
            action: "APPOINTMENT_UPDATED",
            appointmentId: existing.appointment_id,
            branchId: req.branch_id,
            clientName: client.name,
            startAt: input.start_at,
            timezone: input.timezone,
            attendeeUsernames: [...new Set([
                ...existing.attendees.map((attendee) => attendee.attendee_username),
                ...attendees.map((attendee) => attendee.attendee_username),
            ])],
        }).catch((pushError) => console.error("[FCM] Appointment update push error:", pushError?.message || pushError));
        return syncAndReturn(res, existing.appointment_id);
    } catch (error) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        return sendError(res, error, "Failed to update appointment");
    }
});

router.delete("/:appointmentId", async (req, res) => {
    try {
        const existing = await fetchAppointment(req.params.appointmentId, req.branch_id);
        if (!existing) return res.status(404).json({ success: false, message: "Appointment not found" });
        await ensureAppointmentManageAccess(req, existing);
        if (existing.status === "cancelled") return res.json({ success: true, data: existing });
        await pool.query(
            `UPDATE appointments SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(),
             calendar_sync_status = 'pending', calendar_sync_error = NULL,
             calendar_retry_at = UTC_TIMESTAMP()
             WHERE appointment_id = ? AND branch_id = ?`,
            [existing.appointment_id, req.branch_id]
        );
        notifyAppointmentAttendeesPush({
            action: "APPOINTMENT_CANCELLED",
            appointmentId: existing.appointment_id,
            branchId: req.branch_id,
            clientName: existing.client_name,
            startAt: existing.start_at,
            timezone: existing.timezone,
            attendeeUsernames: existing.attendees.map((attendee) => attendee.attendee_username),
        }).catch((pushError) => console.error("[FCM] Appointment cancellation push error:", pushError?.message || pushError));
        return syncAndReturn(res, existing.appointment_id);
    } catch (error) {
        return sendError(res, error, "Failed to cancel appointment");
    }
});

router.post("/:appointmentId/sync", async (req, res) => {
    try {
        const existing = await fetchAppointment(req.params.appointmentId, req.branch_id);
        if (!existing) return res.status(404).json({ success: false, message: "Appointment not found" });
        await ensureAppointmentManageAccess(req, existing);
        await syncAppointment(existing.appointment_id);
        const data = await fetchAppointment(existing.appointment_id, req.branch_id);
        return res.json({ success: true, data, calendar: { configured: await isGoogleCalendarConfigured(), status: data.calendar_sync_status, error: data.calendar_sync_error } });
    } catch (error) {
        return sendError(res, error, "Failed to retry calendar synchronization");
    }
});

export default router;
