import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";

const router = express.Router();

const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || "Asia/Kolkata";
const PUNCH_METHODS = new Set(["manual", "gps", "ip", "face", "fingerprint", "qr"]);
const MARK_STATUSES = new Set(["absent", "present", "leave", "half day"]);

function getAttendanceDateString(date = new Date(), timeZone = ATTENDANCE_TIMEZONE) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date instanceof Date ? date : new Date(date));
}

/** MySQL DATETIME for modify_date / audit (not DB NOW()). */
function getAttendanceNowString(date = new Date(), timeZone = ATTENDANCE_TIMEZONE) {
    const d = date instanceof Date ? date : new Date(date);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(d);

    const map = Object.fromEntries(
        parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );
    const hour = map.hour === "24" ? "00" : map.hour;
    return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}:${map.second}`;
}

/** MySQL TIME `HH:mm:ss` in attendance timezone (in_time / out_time / break times). */
function getAttendanceNowTimeString(date = new Date(), timeZone = ATTENDANCE_TIMEZONE) {
    const d = date instanceof Date ? date : new Date(date);
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(d);
    const map = Object.fromEntries(
        parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );
    const hour = map.hour === "24" ? "00" : map.hour;
    return `${hour}:${map.minute}:${map.second}`;
}

/** Normalize client/DB time to `HH:mm:ss` or null. */
function normalizeTimeValue(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const h = String(value.getHours()).padStart(2, "0");
        const m = String(value.getMinutes()).padStart(2, "0");
        const s = String(value.getSeconds()).padStart(2, "0");
        return `${h}:${m}:${s}`;
    }
    const raw = String(value).trim();
    const iso = raw.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (iso) {
        return `${iso[1]}:${iso[2]}:${iso[3] || "00"}`;
    }
    const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const hour = Math.min(23, Math.max(0, Number(m[1])));
    const minute = Math.min(59, Math.max(0, Number(m[2])));
    const second = Math.min(59, Math.max(0, Number(m[3] || 0)));
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function normalizeMethod(value) {
    const method = value != null ? String(value).trim().toLowerCase() : "manual";
    return PUNCH_METHODS.has(method) ? method : "manual";
}

function normalizeMarkStatus(value) {
    const status = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/_/g, " ");
    if (status === "halfday") return "half day";
    return MARK_STATUSES.has(status) ? status : null;
}

function getUsername(req) {
    return String(req.headers.username || req.headers.Username || "").trim();
}

/** Branch owners (`branch_mapping.type = 'admin'`) cannot use attendance. */
async function assertStaffAttendanceAccess(req, res) {
    const username = getUsername(req);
    const branch_id = req.branch_id;
    if (!username || !branch_id) {
        res.status(400).json({ success: false, message: "Username and branch are required" });
        return false;
    }

    const [rows] = await pool.query(
        `SELECT type
         FROM branch_mapping
         WHERE username = ?
           AND branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [username, branch_id]
    );
    const mapping = rows[0];
    if (!mapping) {
        res.status(403).json({
            success: false,
            message: "You are not mapped to this branch",
        });
        return false;
    }
    if (String(mapping.type || "").toLowerCase() === "admin") {
        res.status(403).json({
            success: false,
            message: "Attendance is available for staff only",
        });
        return false;
    }
    return true;
}

async function requireStaffAttendance(req, res, next) {
    try {
        const allowed = await assertStaffAttendanceAccess(req, res);
        if (allowed) next();
    } catch (error) {
        console.error("ATTENDANCE STAFF CHECK ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to verify attendance access",
        });
    }
}

function buildState(attendance, openBreak) {
    if (!attendance) return "not_punched";
    const mark = String(attendance.status || "").toLowerCase();
    if (mark === "leave") return "leave";
    if (mark === "half day") return "half_day";
    if (mark === "absent") return "absent";
    if (attendance.out_time) return "punched_out";
    if (openBreak) return "on_break";
    if (attendance.in_time) return "punched_in";
    if (mark === "present") return "present";
    return "not_punched";
}

/** Office-managed day statuses — personal punch/break not applicable. */
function isOfficeMarkedStatus(attendance) {
    const mark = String(attendance?.status || "").toLowerCase();
    return mark === "leave" || mark === "half day" || mark === "absent";
}

function buildListState(attendance, openBreak) {
    if (!attendance) return "not_marked";
    const state = buildState(attendance, openBreak);
    if (state === "not_punched") return "absent";
    return state;
}

function formatAttendanceRow(row) {
    if (!row) return null;
    return {
        attendance_id: row.attendance_id,
        branch_id: row.branch_id,
        username: row.username,
        date: row.date,
        in_time: normalizeTimeValue(row.in_time),
        out_time: normalizeTimeValue(row.out_time),
        status: row.status,
        in_method: row.in_method,
        out_method: row.out_method,
        is_approved: row.is_approved,
        expected_hours: row.expected_hours != null ? Number(row.expected_hours) : null,
        worked_minutes: row.worked_minutes != null ? Number(row.worked_minutes) : null,
        extra_minutes: Number(row.extra_minutes) || 0,
        less_minutes: Number(row.less_minutes) || 0,
        overtime_enabled: Number(row.overtime_enabled) === 1,
        fine_enabled: Number(row.fine_enabled) === 1,
        daily_wage: row.daily_wage != null ? Number(row.daily_wage) : null,
        overtime_amount: Number(row.overtime_amount) || 0,
        fine_amount: Number(row.fine_amount) || 0,
        net_day_amount: row.net_day_amount != null ? Number(row.net_day_amount) : null,
    };
}

function timeStringToMinutes(value) {
    const normalized = normalizeTimeValue(value);
    if (!normalized) return null;
    const [h, m, s] = normalized.split(":").map(Number);
    return h * 60 + m + Math.floor((s || 0) / 60);
}

function daysInMonthFromDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return null;
    const [y, m] = String(dateStr).split("-").map(Number);
    if (!y || !m) return null;
    return new Date(y, m, 0).getDate();
}

function parseBoolFlag(value) {
    return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Day wage + optional OT / fine from worked vs expected minutes.
 * daily = monthly / daysInMonth; perMinute = daily / expectedMinutes.
 * expectedHours (legacy) still accepted and converted to minutes.
 */
function computePresentWageBreakdown({
    inTime,
    outTime,
    date,
    monthlyAmount,
    expectedMinutes: expectedMinutesInput,
    expectedHours,
    overtimeEnabled = false,
    fineEnabled = false,
    statusMultiplier = 1,
}) {
    const empty = {
        expected_hours: null,
        worked_minutes: null,
        extra_minutes: 0,
        less_minutes: 0,
        overtime_enabled: 0,
        fine_enabled: 0,
        daily_wage: null,
        overtime_amount: 0,
        fine_amount: 0,
        net_day_amount: null,
    };

    const amount = Number(monthlyAmount);
    let expectedMinutes = Number(expectedMinutesInput);
    if (!Number.isFinite(expectedMinutes) || expectedMinutes <= 0) {
        const eh = Number(expectedHours);
        expectedMinutes = Number.isFinite(eh) && eh > 0 ? Math.round(eh * 60) : NaN;
    }
    const days = daysInMonthFromDate(date);
    const inMins = timeStringToMinutes(inTime);
    const outMins = timeStringToMinutes(outTime);

    if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !days ||
        inMins == null ||
        outMins == null ||
        outMins < inMins
    ) {
        return empty;
    }

    const dailyWage = (amount / days) * statusMultiplier;
    const workedMinutes = outMins - inMins;

    if (!Number.isFinite(expectedMinutes) || expectedMinutes <= 0) {
        return {
            ...empty,
            worked_minutes: workedMinutes,
            daily_wage: Number(dailyWage.toFixed(4)),
            net_day_amount: Number(dailyWage.toFixed(4)),
        };
    }

    const extraMinutes = Math.max(0, workedMinutes - expectedMinutes);
    const lessMinutes = Math.max(0, expectedMinutes - workedMinutes);
    const perMinute = dailyWage / expectedMinutes;
    const applyOt = Boolean(overtimeEnabled) && extraMinutes > 0;
    const applyFine = Boolean(fineEnabled) && lessMinutes > 0;
    const overtimeAmount = applyOt ? extraMinutes * perMinute : 0;
    const fineAmount = applyFine ? lessMinutes * perMinute : 0;
    const net = dailyWage + overtimeAmount - fineAmount;

    return {
        expected_hours: expectedMinutes / 60,
        worked_minutes: workedMinutes,
        extra_minutes: extraMinutes,
        less_minutes: lessMinutes,
        overtime_enabled: applyOt ? 1 : 0,
        fine_enabled: applyFine ? 1 : 0,
        daily_wage: Number(dailyWage.toFixed(4)),
        overtime_amount: Number(overtimeAmount.toFixed(4)),
        fine_amount: Number(fineAmount.toFixed(4)),
        net_day_amount: Number(net.toFixed(4)),
    };
}

function clearWageColumns() {
    return {
        expected_hours: null,
        worked_minutes: null,
        extra_minutes: 0,
        less_minutes: 0,
        overtime_enabled: 0,
        fine_enabled: 0,
        daily_wage: null,
        overtime_amount: 0,
        fine_amount: 0,
        net_day_amount: null,
    };
}

async function getActiveSalaryForDate(conn, { branch_id, username, date }) {
    try {
        const [rows] = await conn.query(
            `SELECT salary_id, salary_type, amount, monthly_working_minutes,
                    working_hours_start, working_hours_end, expected_minutes,
                    grace_period_minutes, overtime_enabled, fine_enabled
             FROM staff_salaries
             WHERE branch_id = ?
               AND username = ?
               AND is_active = '1'
               AND is_deleted = '0'
               AND effective_from <= ?
               AND (effective_to IS NULL OR effective_to >= ?)
             ORDER BY effective_from DESC
             LIMIT 1`,
            [branch_id, username, date, date]
        );
        return rows[0] || null;
    } catch (error) {
        const code = error?.code || error?.errno;
        if (code === "ER_NO_SUCH_TABLE" || code === 1146) return null;
        throw error;
    }
}

function formatBreakRow(row) {
    if (!row) return null;
    return {
        break_id: row.break_id,
        branch_id: row.branch_id,
        username: row.username,
        date: row.date,
        start_time: normalizeTimeValue(row.start_time),
        end_time: normalizeTimeValue(row.end_time),
        create_by: row.create_by,
    };
}

async function getTodayAttendance(conn, { branch_id, username, date }) {
    const [rows] = await conn.query(
        `SELECT *
         FROM attendance
         WHERE branch_id = ?
           AND username = ?
           AND date = ?
         LIMIT 1
         FOR UPDATE`,
        [branch_id, username, date]
    );
    return rows[0] || null;
}

async function getOpenBreak(conn, { branch_id, username, date, forUpdate = false }) {
    const lock = forUpdate ? " FOR UPDATE" : "";
    const [rows] = await conn.query(
        `SELECT *
         FROM \`break\`
         WHERE branch_id = ?
           AND username = ?
           AND date = ?
           AND end_time IS NULL
         ORDER BY id DESC
         LIMIT 1${lock}`,
        [branch_id, username, date]
    );
    return rows[0] || null;
}

async function getTodayBreaks(conn, { branch_id, username, date }) {
    const [rows] = await conn.query(
        `SELECT *
         FROM \`break\`
         WHERE branch_id = ?
           AND username = ?
           AND date = ?
         ORDER BY start_time ASC, id ASC`,
        [branch_id, username, date]
    );
    return rows;
}

async function loadTodayStatusPayload(conn, { branch_id, username, date }) {
    const [attendanceRows] = await conn.query(
        `SELECT *
         FROM attendance
         WHERE branch_id = ?
           AND username = ?
           AND date = ?
         LIMIT 1`,
        [branch_id, username, date]
    );
    const attendance = attendanceRows[0] || null;
    const breakRows = await getTodayBreaks(conn, { branch_id, username, date });
    const openBreak = breakRows.find((row) => !row.end_time) || null;
    const officeMarked = isOfficeMarkedStatus(attendance);
    const markStatus = attendance
        ? String(attendance.status || "").trim().toLowerCase() || null
        : null;

    return {
        date,
        timezone: ATTENDANCE_TIMEZONE,
        state: buildState(attendance, openBreak),
        mark_status: markStatus,
        office_marked: officeMarked,
        attendance: formatAttendanceRow(attendance),
        open_break: formatBreakRow(openBreak),
        breaks: breakRows.map(formatBreakRow),
    };
}

router.get("/today-status", auth, validateBranch, requireStaffAttendance, async (req, res) => {
    try {
        const username = getUsername(req);
        const branch_id = req.branch_id;
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const date = getAttendanceDateString();
        const data = await loadTodayStatusPayload(pool, { branch_id, username, date });

        return res.status(200).json({
            success: true,
            message: "Attendance status fetched successfully",
            data,
        });
    } catch (error) {
        console.error("GET ATTENDANCE TODAY STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch attendance status",
        });
    }
});

router.post("/punch-in", auth, validateBranch, requireStaffAttendance, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const username = getUsername(req);
        const branch_id = req.branch_id;
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const method = normalizeMethod(req.body?.method);
        const date = getAttendanceDateString();
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username,
            date,
        });

        if (existing) {
            await connection.rollback();
            if (isOfficeMarkedStatus(existing)) {
                const mark = String(existing.status || "").toLowerCase();
                const label =
                    mark === "half day" ? "half day" : mark === "leave" ? "leave" : "absent";
                return res.status(400).json({
                    success: false,
                    message: `Attendance is marked as ${label} for today. Punch in is not available.`,
                });
            }
            if (existing.out_time) {
                return res.status(400).json({
                    success: false,
                    message: "Already punched out today. Another punch in is not allowed.",
                });
            }
            return res.status(400).json({
                success: false,
                message: "Already punched in. Punch out before starting a new session.",
            });
        }

        const attendance_id = await UNIQUE_RANDOM_STRING("attendance", "attendance_id", {
            length: ID_LENGTH,
            conn: connection,
        });

        await connection.query(
            `INSERT INTO attendance
             (branch_id, attendance_id, username, date, in_time, out_time, status, in_method, out_method, is_approved, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, NULL, 'present', ?, 'manual', 0, ?, ?)`,
            [branch_id, attendance_id, username, date, nowTime, method, username, username]
        );

        await connection.commit();

        const data = await loadTodayStatusPayload(pool, { branch_id, username, date });
        return res.status(200).json({
            success: true,
            message: "Punched in successfully",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE PUNCH IN ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to punch in",
        });
    } finally {
        connection.release();
    }
});

router.post("/punch-out", auth, validateBranch, requireStaffAttendance, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const username = getUsername(req);
        const branch_id = req.branch_id;
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const method = normalizeMethod(req.body?.method);
        const date = getAttendanceDateString();
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username,
            date,
        });

        if (!existing) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Not punched in. Punch in first.",
            });
        }

        if (isOfficeMarkedStatus(existing)) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Attendance was marked by the office for today. Punch out is not available.",
            });
        }

        if (existing.out_time) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Already punched out today.",
            });
        }

        const openBreak = await getOpenBreak(connection, {
            branch_id,
            username,
            date,
            forUpdate: true,
        });

        if (openBreak) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "End your break before punching out.",
            });
        }

        await connection.query(
            `UPDATE attendance
             SET out_time = ?,
                 out_method = ?,
                 modify_by = ?,
                 modify_date = ?
             WHERE id = ?`,
            [nowTime, method, username, now, existing.id]
        );

        await connection.commit();

        const data = await loadTodayStatusPayload(pool, { branch_id, username, date });
        return res.status(200).json({
            success: true,
            message: "Punched out successfully",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE PUNCH OUT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to punch out",
        });
    } finally {
        connection.release();
    }
});

router.post("/break/start", auth, validateBranch, requireStaffAttendance, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const username = getUsername(req);
        const branch_id = req.branch_id;
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const date = getAttendanceDateString();
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username,
            date,
        });

        if (!existing || existing.out_time) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Punch in first before starting a break.",
            });
        }

        const openBreak = await getOpenBreak(connection, {
            branch_id,
            username,
            date,
            forUpdate: true,
        });

        if (openBreak) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "A break is already in progress. End it first.",
            });
        }

        const break_id = await UNIQUE_RANDOM_STRING("break", "break_id", {
            length: ID_LENGTH,
            conn: connection,
        });

        await connection.query(
            `INSERT INTO \`break\`
             (branch_id, break_id, username, date, start_time, end_time, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
            [branch_id, break_id, username, date, nowTime, username, username]
        );

        await connection.commit();

        const data = await loadTodayStatusPayload(pool, { branch_id, username, date });
        return res.status(200).json({
            success: true,
            message: "Break started successfully",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE BREAK START ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to start break",
        });
    } finally {
        connection.release();
    }
});

router.post("/break/end", auth, validateBranch, requireStaffAttendance, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const username = getUsername(req);
        const branch_id = req.branch_id;
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const date = getAttendanceDateString();
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const openBreak = await getOpenBreak(connection, {
            branch_id,
            username,
            date,
            forUpdate: true,
        });

        if (!openBreak) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "No open break to end.",
            });
        }

        await connection.query(
            `UPDATE \`break\`
             SET end_time = ?,
                 modify_by = ?,
                 modify_date = ?
             WHERE id = ?`,
            [nowTime, username, now, openBreak.id]
        );

        await connection.commit();

        const data = await loadTodayStatusPayload(pool, { branch_id, username, date });
        return res.status(200).json({
            success: true,
            message: "Break ended successfully",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE BREAK END ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to end break",
        });
    } finally {
        connection.release();
    }
});

/**
 * Day-wise staff attendance list for manage page.
 * Staff source: branch_mapping (type=staff, not deleted, active, accepted) + users active.
 * Missing attendance row for the date ⇒ absent.
 * Query: date, search, page (default 1), limit (default 100, max 100).
 */
router.get("/day-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));

        let date = String(req.query.date || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            date = getAttendanceDateString();
        }

        let staffSql = `
            SELECT
                bm.map_id,
                bm.username,
                bm.designation,
                bm.status AS mapping_status,
                bm.is_accepted,
                p.name,
                p.mobile,
                p.country_code,
                p.email,
                p.image
            FROM branch_mapping bm
            INNER JOIN profile p ON bm.username = p.username
            INNER JOIN users u ON bm.username = u.username
            WHERE bm.branch_id = ?
              AND bm.type = 'staff'
              AND bm.is_deleted = '0'
              AND bm.status = '1'
              AND bm.is_accepted = '1'
              AND u.status = '1'
        `;
        const staffParams = [branch_id];

        if (search) {
            staffSql += ` AND (p.name LIKE ? OR bm.username LIKE ? OR bm.designation LIKE ? OR p.mobile LIKE ?)`;
            const pattern = `%${search}%`;
            staffParams.push(pattern, pattern, pattern, pattern);
        }

        staffSql += ` ORDER BY p.name ASC, bm.username ASC`;

        const [staffRows] = await pool.query(staffSql, staffParams);
        const usernames = staffRows.map((row) => row.username);

        const attendanceByUser = new Map();
        const openBreakByUser = new Map();
        const breakCountByUser = new Map();
        const breaksByUser = new Map();
        const activeSalaryByUser = new Map();

        if (usernames.length > 0) {
            const placeholders = usernames.map(() => "?").join(",");

            const [attendanceRows] = await pool.query(
                `SELECT *
                 FROM attendance
                 WHERE branch_id = ?
                   AND date = ?
                   AND username IN (${placeholders})`,
                [branch_id, date, ...usernames]
            );
            for (const row of attendanceRows) {
                attendanceByUser.set(String(row.username), row);
            }

            const [breakRows] = await pool.query(
                `SELECT username, break_id, start_time, end_time
                 FROM \`break\`
                 WHERE branch_id = ?
                   AND date = ?
                   AND username IN (${placeholders})`,
                [branch_id, date, ...usernames]
            );
            for (const row of breakRows) {
                const key = String(row.username);
                const nextBreaks = breaksByUser.get(key) || [];
                nextBreaks.push(formatBreakRow(row));
                breaksByUser.set(key, nextBreaks);
                breakCountByUser.set(key, (breakCountByUser.get(key) || 0) + 1);
                if (!row.end_time && !openBreakByUser.has(key)) {
                    openBreakByUser.set(key, row);
                }
            }

            try {
                const [salaryRows] = await pool.query(
                    `SELECT
                        username,
                        salary_id,
                        salary_type,
                        amount,
                        monthly_working_minutes,
                        working_hours_start,
                        working_hours_end,
                        expected_minutes,
                        grace_period_minutes,
                        overtime_enabled,
                        fine_enabled
                     FROM staff_salaries
                     WHERE branch_id = ?
                       AND username IN (${placeholders})
                       AND is_active = '1'
                       AND is_deleted = '0'
                       AND effective_from <= ?
                       AND (effective_to IS NULL OR effective_to >= ?)
                     ORDER BY effective_from DESC`,
                    [branch_id, ...usernames, date, date]
                );
                for (const row of salaryRows) {
                    const key = String(row.username);
                    if (activeSalaryByUser.has(key)) continue;
                    const monthlyMins =
                        row.monthly_working_minutes != null
                            ? Number(row.monthly_working_minutes)
                            : null;
                    const expectedMins =
                        row.expected_minutes != null ? Number(row.expected_minutes) : null;
                    activeSalaryByUser.set(key, {
                        salary_id: row.salary_id,
                        salary_type: row.salary_type || "fixed",
                        amount: row.amount != null ? Number(row.amount) : null,
                        monthly_working_minutes: monthlyMins,
                        monthly_working_hours:
                            monthlyMins != null ? monthlyMins / 60 : null,
                        working_hours_start: row.working_hours_start || null,
                        working_hours_end: row.working_hours_end || null,
                        expected_minutes: expectedMins,
                        expected_hours:
                            expectedMins != null ? expectedMins / 60 : null,
                        grace_period_minutes:
                            row.grace_period_minutes != null
                                ? Number(row.grace_period_minutes)
                                : null,
                        overtime_enabled:
                            row.overtime_enabled === "1" ||
                            row.overtime_enabled === 1 ||
                            row.overtime_enabled === true,
                        fine_enabled:
                            row.fine_enabled === "1" ||
                            row.fine_enabled === 1 ||
                            row.fine_enabled === true,
                    });
                }
            } catch (salaryError) {
                const code = salaryError?.code || salaryError?.errno;
                if (code !== "ER_NO_SUCH_TABLE" && code !== 1146) {
                    throw salaryError;
                }
            }
        }

        const summary = {
            total: staffRows.length,
            present: 0,
            absent: 0,
            punched_in: 0,
            on_break: 0,
            punched_out: 0,
            leave: 0,
            half_day: 0,
            approved: 0,
        };

        const allStaff = staffRows.map((row) => {
            const key = String(row.username);
            const attendance = attendanceByUser.get(key) || null;
            const openBreak = openBreakByUser.get(key) || null;
            const state = buildListState(attendance, openBreak);
            const approved = Number(attendance?.is_approved) === 1;

            if (state === "absent" || state === "not_marked") summary.absent += 1;
            else if (state === "leave") summary.leave += 1;
            else if (state === "half_day") summary.half_day += 1;
            else {
                summary.present += 1;
                if (state === "punched_in" || state === "present") summary.punched_in += 1;
                else if (state === "on_break") summary.on_break += 1;
                else if (state === "punched_out") summary.punched_out += 1;
            }
            if (approved) summary.approved += 1;

            return {
                map_id: row.map_id,
                username: row.username,
                name: row.name || row.username,
                designation: row.designation || "",
                mobile: row.mobile || "",
                country_code: row.country_code || "",
                email: row.email || "",
                image: row.image || "",
                state,
                is_approved: approved,
                attendance: formatAttendanceRow(attendance),
                open_break: formatBreakRow(openBreak),
                break_count: breakCountByUser.get(key) || 0,
                breaks: breaksByUser.get(key) || [],
                active_salary: activeSalaryByUser.get(key) || null,
            };
        });

        const total = allStaff.length;
        const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
        const safePage = Math.min(page, totalPages);
        const offset = (safePage - 1) * limit;
        const staff = allStaff.slice(offset, offset + limit);

        return res.status(200).json({
            success: true,
            message: "Attendance day list fetched successfully",
            data: {
                date,
                timezone: ATTENDANCE_TIMEZONE,
                summary,
                staff,
                pagination: {
                    page: safePage,
                    limit,
                    total,
                    totalPages,
                    is_last_page: safePage >= totalPages,
                },
            },
        });
    } catch (error) {
        console.error("GET ATTENDANCE DAY LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch attendance day list",
        });
    }
});

async function assertTargetStaffUser(branch_id, username) {
    const [rows] = await pool.query(
        `SELECT bm.username
         FROM branch_mapping bm
         INNER JOIN users u ON bm.username = u.username
         WHERE bm.branch_id = ?
           AND bm.username = ?
           AND bm.type = 'staff'
           AND bm.is_deleted = '0'
           AND bm.status = '1'
           AND bm.is_accepted = '1'
           AND u.status = '1'
         LIMIT 1`,
        [branch_id, username]
    );
    return Boolean(rows[0]);
}

function normalizeManageDate(value) {
    const date = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return getAttendanceDateString();
}

function isAttendanceApproved(row) {
    return Number(row?.is_approved) === 1;
}

router.post("/manage/punch-in", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        const targetUsername = String(req.body?.username || "").trim();
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        if (!targetUsername) {
            return res.status(400).json({ success: false, message: "Staff username is required" });
        }

        const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found on this branch" });
        }

        const method = normalizeMethod(req.body?.method);
        const date = normalizeManageDate(req.body?.date);
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username: targetUsername,
            date,
        });

        if (existing) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: existing.out_time
                    ? "Already punched out for this date."
                    : "Already punched in for this date.",
            });
        }

        const attendance_id = await UNIQUE_RANDOM_STRING("attendance", "attendance_id", {
            length: ID_LENGTH,
            conn: connection,
        });

        await connection.query(
            `INSERT INTO attendance
             (branch_id, attendance_id, username, date, in_time, out_time, status, in_method, out_method, is_approved, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, NULL, 'present', ?, 'manual', 0, ?, ?)`,
            [branch_id, attendance_id, targetUsername, date, nowTime, method, actor, actor]
        );

        await connection.commit();
        const data = await loadTodayStatusPayload(pool, {
            branch_id,
            username: targetUsername,
            date,
        });
        return res.status(200).json({
            success: true,
            message: "Marked punched in",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE MANAGE PUNCH IN ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to mark punch in",
        });
    } finally {
        connection.release();
    }
});

router.post("/manage/punch-out", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        const targetUsername = String(req.body?.username || "").trim();
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        if (!targetUsername) {
            return res.status(400).json({ success: false, message: "Staff username is required" });
        }

        const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found on this branch" });
        }

        const method = normalizeMethod(req.body?.method);
        const date = normalizeManageDate(req.body?.date);
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username: targetUsername,
            date,
        });

        if (!existing) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "Not punched in for this date." });
        }
        if (isAttendanceApproved(existing)) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Unapprove attendance before making changes.",
            });
        }
        if (existing.out_time) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "Already punched out for this date." });
        }

        const openBreak = await getOpenBreak(connection, {
            branch_id,
            username: targetUsername,
            date,
            forUpdate: true,
        });
        if (openBreak) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "End the open break before punching out.",
            });
        }

        await connection.query(
            `UPDATE attendance
             SET out_time = ?,
                 out_method = ?,
                 modify_by = ?,
                 modify_date = ?
             WHERE id = ?`,
            [nowTime, method, actor, now, existing.id]
        );

        await connection.commit();
        const data = await loadTodayStatusPayload(pool, {
            branch_id,
            username: targetUsername,
            date,
        });
        return res.status(200).json({
            success: true,
            message: "Marked punched out",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE MANAGE PUNCH OUT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to mark punch out",
        });
    } finally {
        connection.release();
    }
});

router.post("/manage/break/start", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        const targetUsername = String(req.body?.username || "").trim();
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        if (!targetUsername) {
            return res.status(400).json({ success: false, message: "Staff username is required" });
        }

        const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found on this branch" });
        }

        const date = normalizeManageDate(req.body?.date);
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username: targetUsername,
            date,
        });

        if (!existing || existing.out_time) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Staff must be punched in before starting a break.",
            });
        }
        if (isAttendanceApproved(existing)) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Unapprove attendance before making changes.",
            });
        }

        const openBreak = await getOpenBreak(connection, {
            branch_id,
            username: targetUsername,
            date,
            forUpdate: true,
        });
        if (openBreak) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "A break is already in progress.",
            });
        }

        const break_id = await UNIQUE_RANDOM_STRING("break", "break_id", {
            length: ID_LENGTH,
            conn: connection,
        });

        await connection.query(
            `INSERT INTO \`break\`
             (branch_id, break_id, username, date, start_time, end_time, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
            [branch_id, break_id, targetUsername, date, nowTime, actor, actor]
        );

        await connection.commit();
        const data = await loadTodayStatusPayload(pool, {
            branch_id,
            username: targetUsername,
            date,
        });
        return res.status(200).json({
            success: true,
            message: "Break started",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE MANAGE BREAK START ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to start break",
        });
    } finally {
        connection.release();
    }
});

router.post("/manage/break/end", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        const targetUsername = String(req.body?.username || "").trim();
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        if (!targetUsername) {
            return res.status(400).json({ success: false, message: "Staff username is required" });
        }

        const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found on this branch" });
        }

        const date = normalizeManageDate(req.body?.date);
        const now = getAttendanceNowString();
        const nowTime = getAttendanceNowTimeString();

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username: targetUsername,
            date,
        });
        if (existing && isAttendanceApproved(existing)) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Unapprove attendance before making changes.",
            });
        }

        const openBreak = await getOpenBreak(connection, {
            branch_id,
            username: targetUsername,
            date,
            forUpdate: true,
        });
        if (!openBreak) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "No open break to end." });
        }

        await connection.query(
            `UPDATE \`break\`
             SET end_time = ?,
                 modify_by = ?,
                 modify_date = ?
             WHERE id = ?`,
            [nowTime, actor, now, openBreak.id]
        );

        await connection.commit();
        const data = await loadTodayStatusPayload(pool, {
            branch_id,
            username: targetUsername,
            date,
        });
        return res.status(200).json({
            success: true,
            message: "Break ended",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE MANAGE BREAK END ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to end break",
        });
    } finally {
        connection.release();
    }
});

router.post("/manage/approve", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        const targetUsername = String(req.body?.username || "").trim();
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        if (!targetUsername) {
            return res.status(400).json({ success: false, message: "Staff username is required" });
        }

        const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found on this branch" });
        }

        const date = normalizeManageDate(req.body?.date);
        const now = getAttendanceNowString();
        const approve =
            req.body?.is_approved === true ||
            req.body?.is_approved === 1 ||
            req.body?.is_approved === "1";

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username: targetUsername,
            date,
        });
        if (!existing) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "No attendance record to approve for this date.",
            });
        }

        const openBreak = await getOpenBreak(connection, {
            branch_id,
            username: targetUsername,
            date,
            forUpdate: true,
        });
        if (approve && openBreak) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "End open break before approving attendance.",
            });
        }

        await connection.query(
            `UPDATE attendance
             SET is_approved = ?,
                 modify_by = ?,
                 modify_date = ?
             WHERE id = ?`,
            [approve ? 1 : 0, actor, now, existing.id]
        );

        await connection.commit();
        const data = await loadTodayStatusPayload(pool, {
            branch_id,
            username: targetUsername,
            date,
        });
        return res.status(200).json({
            success: true,
            message: approve ? "Attendance approved" : "Attendance unapproved",
            data,
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE MANAGE APPROVE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update approval",
        });
    } finally {
        connection.release();
    }
});

/**
 * Bulk approve: set is_approved = 1 only when punch in AND punch out exist for the date.
 * Optional apply_overtime / apply_fine: compute and store OT/fine when salary has expected_hours.
 * Body: { usernames: string[], date?: "YYYY-MM-DD", apply_overtime?: boolean, apply_fine?: boolean }
 */
router.post("/manage/bulk-approve", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const rawList = Array.isArray(req.body?.usernames)
            ? req.body.usernames
            : Array.isArray(req.body?.username)
                ? req.body.username
                : [];
        const usernames = [
            ...new Set(
                rawList
                    .map((u) => String(u || "").trim())
                    .filter(Boolean)
            ),
        ];
        if (usernames.length === 0) {
            return res.status(400).json({
                success: false,
                message: "At least one username is required",
            });
        }

        const date = normalizeManageDate(req.body?.date);
        const now = getAttendanceNowString();
        const applyOvertime = parseBoolFlag(req.body?.apply_overtime);
        const applyFine = parseBoolFlag(req.body?.apply_fine);

        let done = 0;
        let not_done = 0;
        const done_usernames = [];
        const skipped_usernames = [];

        await connection.beginTransaction();

        for (const targetUsername of usernames) {
            const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
            if (!okStaff) {
                not_done += 1;
                skipped_usernames.push(targetUsername);
                continue;
            }

            const existing = await getTodayAttendance(connection, {
                branch_id,
                username: targetUsername,
                date,
            });
            const hasPunchIn = Boolean(existing?.in_time);
            const hasPunchOut = Boolean(existing?.out_time);
            if (!existing || !hasPunchIn || !hasPunchOut) {
                not_done += 1;
                skipped_usernames.push(targetUsername);
                continue;
            }

            const openBreak = await getOpenBreak(connection, {
                branch_id,
                username: targetUsername,
                date,
                forUpdate: true,
            });
            if (openBreak) {
                not_done += 1;
                skipped_usernames.push(targetUsername);
                continue;
            }

            const salary = await getActiveSalaryForDate(connection, {
                branch_id,
                username: targetUsername,
                date,
            });
            const salaryOtAllowed =
                salary?.overtime_enabled === "1" ||
                salary?.overtime_enabled === 1 ||
                salary?.overtime_enabled === true;
            const salaryFineAllowed =
                salary?.fine_enabled === "1" ||
                salary?.fine_enabled === 1 ||
                salary?.fine_enabled === true;
            const wage = computePresentWageBreakdown({
                inTime: existing.in_time,
                outTime: existing.out_time,
                date,
                monthlyAmount: salary?.amount,
                expectedMinutes: salary?.expected_minutes,
                expectedHours: salary?.expected_hours,
                overtimeEnabled: applyOvertime && salaryOtAllowed,
                fineEnabled: applyFine && salaryFineAllowed,
                statusMultiplier: 1,
            });

            await connection.query(
                `UPDATE attendance
                 SET is_approved = 1,
                     approved_by = ?,
                     modify_by = ?,
                     modify_date = ?,
                     expected_hours = ?,
                     worked_minutes = ?,
                     extra_minutes = ?,
                     less_minutes = ?,
                     overtime_enabled = ?,
                     fine_enabled = ?,
                     daily_wage = ?,
                     overtime_amount = ?,
                     fine_amount = ?,
                     net_day_amount = ?
                 WHERE id = ?`,
                [
                    actor,
                    actor,
                    now,
                    wage.expected_hours,
                    wage.worked_minutes,
                    wage.extra_minutes,
                    wage.less_minutes,
                    wage.overtime_enabled,
                    wage.fine_enabled,
                    wage.daily_wage,
                    wage.overtime_amount,
                    wage.fine_amount,
                    wage.net_day_amount,
                    existing.id,
                ]
            );
            done += 1;
            done_usernames.push(targetUsername);
        }

        await connection.commit();

        return res.status(200).json({
            success: true,
            message: `Approved ${done} staff. Skipped ${not_done} staff.`,
            data: {
                date,
                done,
                not_done,
                done_usernames,
                skipped_usernames,
                apply_overtime: applyOvertime,
                apply_fine: applyFine,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE MANAGE BULK APPROVE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to bulk approve attendance",
        });
    } finally {
        connection.release();
    }
});

/**
 * Manage-page mark: Absent | Present | Half Day | Leave.
 * Always sets is_approved = 1. Times are MySQL TIME only.
 * Present may include in_time / out_time + optional overtime_enabled / fine_enabled.
 */
router.post("/manage/mark", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        const targetUsername = String(req.body?.username || "").trim();
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        if (!targetUsername) {
            return res.status(400).json({ success: false, message: "Staff username is required" });
        }

        const markStatus = normalizeMarkStatus(req.body?.status);
        if (!markStatus) {
            return res.status(400).json({
                success: false,
                message: "Status must be absent, present, leave, or half day",
            });
        }

        const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found on this branch" });
        }

        const date = normalizeManageDate(req.body?.date);
        const now = getAttendanceNowString();
        let inTime = null;
        let outTime = null;
        let wage = clearWageColumns();

        if (markStatus === "present") {
            inTime = normalizeTimeValue(req.body?.in_time);
            outTime = normalizeTimeValue(req.body?.out_time);
            if (!inTime) {
                return res.status(400).json({
                    success: false,
                    message: "In time is required for present",
                });
            }
            if (!outTime) {
                return res.status(400).json({
                    success: false,
                    message: "Out time is required for present",
                });
            }
            if (outTime < inTime) {
                return res.status(400).json({
                    success: false,
                    message: "Out time must be after in time",
                });
            }

            const salary = await getActiveSalaryForDate(connection, {
                branch_id,
                username: targetUsername,
                date,
            });
            const salaryOtAllowed =
                salary?.overtime_enabled === "1" ||
                salary?.overtime_enabled === 1 ||
                salary?.overtime_enabled === true;
            const salaryFineAllowed =
                salary?.fine_enabled === "1" ||
                salary?.fine_enabled === 1 ||
                salary?.fine_enabled === true;
            wage = computePresentWageBreakdown({
                inTime,
                outTime,
                date,
                monthlyAmount: salary?.amount,
                expectedMinutes: salary?.expected_minutes,
                expectedHours: salary?.expected_hours,
                overtimeEnabled:
                    parseBoolFlag(req.body?.overtime_enabled) && salaryOtAllowed,
                fineEnabled:
                    parseBoolFlag(req.body?.fine_enabled) && salaryFineAllowed,
                statusMultiplier: 1,
            });
        } else if (markStatus === "half day") {
            const salary = await getActiveSalaryForDate(connection, {
                branch_id,
                username: targetUsername,
                date,
            });
            const amount = Number(salary?.amount);
            const days = daysInMonthFromDate(date);
            if (Number.isFinite(amount) && amount > 0 && days) {
                const daily = amount / days / 2;
                wage = {
                    ...clearWageColumns(),
                    daily_wage: Number(daily.toFixed(4)),
                    net_day_amount: Number(daily.toFixed(4)),
                };
            }
        } else if (markStatus === "leave") {
            // Leave: full calendar-day wage (same base as present, no OT/fine)
            const salary = await getActiveSalaryForDate(connection, {
                branch_id,
                username: targetUsername,
                date,
            });
            const amount = Number(salary?.amount);
            const days = daysInMonthFromDate(date);
            if (Number.isFinite(amount) && amount > 0 && days) {
                const daily = amount / days;
                wage = {
                    ...clearWageColumns(),
                    daily_wage: Number(daily.toFixed(4)),
                    net_day_amount: Number(daily.toFixed(4)),
                };
            }
        }

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username: targetUsername,
            date,
        });

        if (existing) {
            await connection.query(
                `UPDATE attendance
                 SET status = ?,
                     in_time = ?,
                     out_time = ?,
                     in_method = 'manual',
                     out_method = 'manual',
                     is_approved = 1,
                     approved_by = ?,
                     modify_by = ?,
                     modify_date = ?,
                     expected_hours = ?,
                     worked_minutes = ?,
                     extra_minutes = ?,
                     less_minutes = ?,
                     overtime_enabled = ?,
                     fine_enabled = ?,
                     daily_wage = ?,
                     overtime_amount = ?,
                     fine_amount = ?,
                     net_day_amount = ?
                 WHERE id = ?`,
                [
                    markStatus,
                    inTime,
                    outTime,
                    actor,
                    actor,
                    now,
                    wage.expected_hours,
                    wage.worked_minutes,
                    wage.extra_minutes,
                    wage.less_minutes,
                    wage.overtime_enabled,
                    wage.fine_enabled,
                    wage.daily_wage,
                    wage.overtime_amount,
                    wage.fine_amount,
                    wage.net_day_amount,
                    existing.id,
                ]
            );
        } else {
            const attendance_id = await UNIQUE_RANDOM_STRING("attendance", "attendance_id", {
                length: ID_LENGTH,
                conn: connection,
            });
            await connection.query(
                `INSERT INTO attendance
                 (branch_id, attendance_id, username, date, in_time, out_time, status, in_method, out_method,
                  is_approved, approved_by, create_by, modify_by,
                  expected_hours, worked_minutes, extra_minutes, less_minutes,
                  overtime_enabled, fine_enabled, daily_wage, overtime_amount, fine_amount, net_day_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    attendance_id,
                    targetUsername,
                    date,
                    inTime,
                    outTime,
                    markStatus,
                    actor,
                    actor,
                    actor,
                    wage.expected_hours,
                    wage.worked_minutes,
                    wage.extra_minutes,
                    wage.less_minutes,
                    wage.overtime_enabled,
                    wage.fine_enabled,
                    wage.daily_wage,
                    wage.overtime_amount,
                    wage.fine_amount,
                    wage.net_day_amount,
                ]
            );
        }

        await connection.commit();
        const data = await loadTodayStatusPayload(pool, {
            branch_id,
            username: targetUsername,
            date,
        });
        return res.status(200).json({
            success: true,
            message: "Attendance marked successfully",
            data: {
                ...(data || {}),
                wage,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error("POST ATTENDANCE MANAGE MARK ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to mark attendance",
        });
    } finally {
        connection.release();
    }
});

export default router;
