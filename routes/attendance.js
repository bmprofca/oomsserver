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
 * Grace threshold: variance within grace → 0 billable minutes.
 * Variance beyond grace → full variance counts (not variance − grace).
 * e.g. expected 8h, grace 15m: 8h15 → 0 OT; 8h16 → 16m OT.
 */
function applyGraceThreshold(varianceMinutes, gracePeriodMinutes) {
    const raw = Math.max(0, Number(varianceMinutes) || 0);
    const grace = Math.max(0, Number(gracePeriodMinutes) || 0);
    if (raw <= grace) return 0;
    return raw;
}

/**
 * Day wage + optional OT / fine from worked vs expected minutes.
 * daily = monthly / daysInMonth; perMinute = daily / expectedMinutes.
 * expectedHours (legacy) still accepted and converted to minutes.
 * Grace: OT/fine only when extra/less exceeds grace_period_minutes; then full minutes count.
 */
function computePresentWageBreakdown({
    inTime,
    outTime,
    date,
    monthlyAmount,
    expectedMinutes: expectedMinutesInput,
    expectedHours,
    gracePeriodMinutes = 0,
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

    const rawExtra = Math.max(0, workedMinutes - expectedMinutes);
    const rawLess = Math.max(0, expectedMinutes - workedMinutes);
    const extraMinutes = applyGraceThreshold(rawExtra, gracePeriodMinutes);
    const lessMinutes = applyGraceThreshold(rawLess, gracePeriodMinutes);
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

/** Closed breaks only — open breaks excluded from total duration. */
function computeBreakTotalMinutes(breakRows) {
    let total = 0;
    if (!Array.isArray(breakRows)) return 0;
    for (const row of breakRows) {
        const start = timeStringToMinutes(row.start_time);
        const end = timeStringToMinutes(row.end_time);
        if (start == null || end == null || end < start) continue;
        total += end - start;
    }
    return total;
}

function isValidYmd(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function shiftYmd(dateStr, days) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    if (!y || !m || !d) return getAttendanceDateString();
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
}

function enumerateYmdRange(fromDate, toDate) {
    const dates = [];
    if (!isValidYmd(fromDate) || !isValidYmd(toDate)) return dates;
    let cur = fromDate <= toDate ? fromDate : toDate;
    const end = fromDate <= toDate ? toDate : fromDate;
    let guard = 0;
    while (cur <= end && guard < 400) {
        dates.push(cur);
        cur = shiftYmd(cur, 1);
        guard += 1;
    }
    return dates;
}

function resolveDayListDateRange(query) {
    const today = getAttendanceDateString();
    let from =
        String(query?.from_date || query?.start_date || "").trim() ||
        String(query?.date || "").trim();
    let to =
        String(query?.to_date || query?.end_date || "").trim() ||
        String(query?.date || "").trim();

    if (!isValidYmd(from)) from = today;
    if (!isValidYmd(to)) to = from;
    if (from > to) {
        const swap = from;
        from = to;
        to = swap;
    }
    if (from > today) from = today;
    if (to > today) to = today;
    if (from > to) from = to;

    const dates = enumerateYmdRange(from, to);
    const MAX_DAYS = 186;
    if (dates.length > MAX_DAYS) {
        return {
            error: `Date range cannot exceed ${MAX_DAYS} days`,
            from_date: from,
            to_date: to,
            dates: [],
        };
    }
    return { from_date: from, to_date: to, dates, error: null };
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

        const range = resolveDayListDateRange(req.query);
        if (range.error) {
            return res.status(400).json({ success: false, message: range.error });
        }
        const { from_date, to_date, dates } = range;
        const isRange = from_date !== to_date;

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

        const attendanceByKey = new Map();
        const openBreakByKey = new Map();
        const breakCountByKey = new Map();
        const breaksByKey = new Map();
        const salaryRowsByUser = new Map();

        if (usernames.length > 0 && dates.length > 0) {
            const placeholders = usernames.map(() => "?").join(",");

            const [attendanceRows] = await pool.query(
                `SELECT *
                 FROM attendance
                 WHERE branch_id = ?
                   AND date >= ?
                   AND date <= ?
                   AND username IN (${placeholders})`,
                [branch_id, from_date, to_date, ...usernames]
            );
            for (const row of attendanceRows) {
                const ymd = toYmdValue(row.date) || String(row.date).slice(0, 10);
                attendanceByKey.set(`${row.username}::${ymd}`, row);
            }

            const [breakRows] = await pool.query(
                `SELECT username, break_id, start_time, end_time, date
                 FROM \`break\`
                 WHERE branch_id = ?
                   AND date >= ?
                   AND date <= ?
                   AND username IN (${placeholders})`,
                [branch_id, from_date, to_date, ...usernames]
            );
            for (const row of breakRows) {
                const ymd = toYmdValue(row.date) || String(row.date).slice(0, 10);
                const key = `${row.username}::${ymd}`;
                const nextBreaks = breaksByKey.get(key) || [];
                nextBreaks.push(formatBreakRow(row));
                breaksByKey.set(key, nextBreaks);
                breakCountByKey.set(key, (breakCountByKey.get(key) || 0) + 1);
                if (!row.end_time && !openBreakByKey.has(key)) {
                    openBreakByKey.set(key, row);
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
                        fine_enabled,
                        effective_from,
                        effective_to
                     FROM staff_salaries
                     WHERE branch_id = ?
                       AND username IN (${placeholders})
                       AND is_deleted = '0'
                       AND effective_from <= ?
                       AND (effective_to IS NULL OR effective_to >= ?)
                     ORDER BY effective_from DESC`,
                    [branch_id, ...usernames, to_date, from_date]
                );
                for (const row of salaryRows) {
                    const key = String(row.username);
                    const list = salaryRowsByUser.get(key) || [];
                    list.push(row);
                    salaryRowsByUser.set(key, list);
                }
            } catch (salaryError) {
                const code = salaryError?.code || salaryError?.errno;
                if (code !== "ER_NO_SUCH_TABLE" && code !== 1146) {
                    throw salaryError;
                }
            }
        }

        const pickSalaryForDate = (username, ymd) => {
            const list = salaryRowsByUser.get(String(username)) || [];
            for (const s of list) {
                const from = toYmdValue(s.effective_from);
                const to = s.effective_to != null ? toYmdValue(s.effective_to) : null;
                if (from && from <= ymd && (to == null || to >= ymd)) {
                    return mapActiveSalaryRow(s);
                }
            }
            return null;
        };

        const summary = {
            total: 0,
            present: 0,
            absent: 0,
            punched_in: 0,
            on_break: 0,
            punched_out: 0,
            leave: 0,
            half_day: 0,
            approved: 0,
        };

        const allRows = [];
        for (const ymd of dates) {
            for (const row of staffRows) {
                const key = `${row.username}::${ymd}`;
                const attendance = attendanceByKey.get(key) || null;
                const openBreak = openBreakByKey.get(key) || null;
                const dayBreaks = breaksByKey.get(key) || [];
                const state = buildListState(attendance, openBreak);
                const approved = Number(attendance?.is_approved) === 1;
                const breakTotalMinutes = computeBreakTotalMinutes(dayBreaks);

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

                allRows.push({
                    map_id: row.map_id,
                    username: row.username,
                    name: row.name || row.username,
                    designation: row.designation || "",
                    mobile: row.mobile || "",
                    country_code: row.country_code || "",
                    email: row.email || "",
                    image: row.image || "",
                    date: ymd,
                    state,
                    is_approved: approved,
                    attendance: formatAttendanceRow(attendance),
                    open_break: formatBreakRow(openBreak),
                    break_count: breakCountByKey.get(key) || 0,
                    break_total_minutes: breakTotalMinutes,
                    breaks: dayBreaks,
                    active_salary: pickSalaryForDate(row.username, ymd),
                });
            }
        }

        summary.total = allRows.length;

        const total = allRows.length;
        const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
        const safePage = Math.min(page, totalPages);
        const offset = (safePage - 1) * limit;
        const staff = allRows.slice(offset, offset + limit);

        return res.status(200).json({
            success: true,
            message: "Attendance day list fetched successfully",
            data: {
                date: from_date,
                from_date,
                to_date,
                is_range: isRange,
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

function mapActiveSalaryRow(row) {
    if (!row) return null;
    const monthlyMins =
        row.monthly_working_minutes != null ? Number(row.monthly_working_minutes) : null;
    const expectedMins = row.expected_minutes != null ? Number(row.expected_minutes) : null;
    return {
        salary_id: row.salary_id,
        salary_type: row.salary_type || "fixed",
        amount: row.amount != null ? Number(row.amount) : null,
        monthly_working_minutes: monthlyMins,
        monthly_working_hours: monthlyMins != null ? monthlyMins / 60 : null,
        working_hours_start: row.working_hours_start || null,
        working_hours_end: row.working_hours_end || null,
        expected_minutes: expectedMins,
        expected_hours: expectedMins != null ? expectedMins / 60 : null,
        grace_period_minutes:
            row.grace_period_minutes != null ? Number(row.grace_period_minutes) : null,
        overtime_enabled:
            row.overtime_enabled === "1" ||
            row.overtime_enabled === 1 ||
            row.overtime_enabled === true,
        fine_enabled:
            row.fine_enabled === "1" ||
            row.fine_enabled === 1 ||
            row.fine_enabled === true,
        effective_from: row.effective_from || null,
        effective_to: row.effective_to || null,
    };
}

function toYmdValue(value) {
    if (value == null) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, "0");
        const d = String(value.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return null;
}

/**
 * Monthly attendance for one staff (profile calendar).
 * Query: username, year, month
 */
router.get("/staff-month", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = String(req.query.username || "").trim();
        const year = Number(req.query.year);
        const month = Number(req.query.month);

        if (!username) {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (!Number.isFinite(year) || year < 2000 || year > 2100) {
            return res.status(400).json({ success: false, message: "Invalid year" });
        }
        if (!Number.isFinite(month) || month < 1 || month > 12) {
            return res.status(400).json({ success: false, message: "Invalid month" });
        }

        const okStaff = await assertTargetStaffUser(branch_id, username);
        if (!okStaff) {
            return res.status(404).json({
                success: false,
                message: "Staff not found on this branch",
            });
        }

        const [staffRows] = await pool.query(
            `SELECT
                bm.map_id,
                bm.username,
                bm.designation,
                p.name,
                p.mobile,
                p.country_code,
                p.email,
                p.image
             FROM branch_mapping bm
             INNER JOIN profile p ON bm.username = p.username
             WHERE bm.branch_id = ?
               AND bm.username = ?
               AND bm.type = 'staff'
               AND bm.is_deleted = '0'
             LIMIT 1`,
            [branch_id, username]
        );
        const staffRow = staffRows[0];
        if (!staffRow) {
            return res.status(404).json({ success: false, message: "Staff profile not found" });
        }

        const daysInMonth = new Date(year, month, 0).getDate();
        const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        const endDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

        const [attendanceRows] = await pool.query(
            `SELECT *
             FROM attendance
             WHERE branch_id = ?
               AND username = ?
               AND date >= ?
               AND date <= ?
             ORDER BY date ASC`,
            [branch_id, username, startDate, endDate]
        );

        const [breakRows] = await pool.query(
            `SELECT username, break_id, start_time, end_time, date
             FROM \`break\`
             WHERE branch_id = ?
               AND username = ?
               AND date >= ?
               AND date <= ?
             ORDER BY date ASC, start_time ASC`,
            [branch_id, username, startDate, endDate]
        );

        let salaryRows = [];
        try {
            const [rows] = await pool.query(
                `SELECT
                    salary_id,
                    salary_type,
                    amount,
                    monthly_working_minutes,
                    working_hours_start,
                    working_hours_end,
                    expected_minutes,
                    grace_period_minutes,
                    overtime_enabled,
                    fine_enabled,
                    effective_from,
                    effective_to
                 FROM staff_salaries
                 WHERE branch_id = ?
                   AND username = ?
                   AND is_deleted = '0'
                   AND effective_from <= ?
                   AND (effective_to IS NULL OR effective_to >= ?)
                 ORDER BY effective_from DESC`,
                [branch_id, username, endDate, startDate]
            );
            salaryRows = rows;
        } catch (salaryError) {
            const code = salaryError?.code || salaryError?.errno;
            if (code !== "ER_NO_SUCH_TABLE" && code !== 1146) throw salaryError;
        }

        const attendanceByDate = new Map();
        for (const row of attendanceRows) {
            const ymd = toYmdValue(row.date);
            if (ymd) attendanceByDate.set(ymd, row);
        }

        const breaksByDate = new Map();
        for (const row of breakRows) {
            const ymd = toYmdValue(row.date);
            if (!ymd) continue;
            const list = breaksByDate.get(ymd) || [];
            list.push(formatBreakRow(row));
            breaksByDate.set(ymd, list);
        }

        const pickSalaryForDate = (ymd) => {
            for (const s of salaryRows) {
                const from = toYmdValue(s.effective_from);
                const to = s.effective_to != null ? toYmdValue(s.effective_to) : null;
                if (from && from <= ymd && (to == null || to >= ymd)) {
                    return mapActiveSalaryRow(s);
                }
            }
            return null;
        };

        const summary = {
            present: 0,
            absent: 0,
            leave: 0,
            half_day: 0,
            not_marked: 0,
            approved: 0,
            marked: 0,
        };

        const days = [];
        for (let day = 1; day <= daysInMonth; day += 1) {
            const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const attendance = attendanceByDate.get(ymd) || null;
            const dayBreaks = breaksByDate.get(ymd) || [];
            const openBreak = dayBreaks.find((b) => !b.end_time) || null;
            const state = attendance
                ? buildListState(attendance, openBreak)
                : "not_marked";
            const approved = Number(attendance?.is_approved) === 1;

            if (state === "not_marked") summary.not_marked += 1;
            else if (state === "absent") {
                summary.absent += 1;
                summary.marked += 1;
            } else if (state === "leave") {
                summary.leave += 1;
                summary.marked += 1;
            } else if (state === "half_day") {
                summary.half_day += 1;
                summary.marked += 1;
            } else {
                summary.present += 1;
                summary.marked += 1;
            }
            if (approved) summary.approved += 1;

            days.push({
                date: ymd,
                state,
                is_approved: approved,
                attendance: formatAttendanceRow(attendance),
                breaks: dayBreaks,
                break_count: dayBreaks.length,
                open_break: openBreak,
                active_salary: pickSalaryForDate(ymd),
            });
        }

        return res.status(200).json({
            success: true,
            message: "Staff month attendance fetched successfully",
            data: {
                year,
                month,
                start_date: startDate,
                end_date: endDate,
                timezone: ATTENDANCE_TIMEZONE,
                staff: {
                    map_id: staffRow.map_id,
                    username: staffRow.username,
                    name: staffRow.name || staffRow.username,
                    designation: staffRow.designation || "",
                    mobile: staffRow.mobile || "",
                    country_code: staffRow.country_code || "",
                    email: staffRow.email || "",
                    image: staffRow.image || "",
                },
                summary,
                days,
            },
        });
    } catch (error) {
        console.error("GET ATTENDANCE STAFF MONTH ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch staff month attendance",
            error: error.message,
        });
    }
});

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
 * Body:
 *   { usernames: string[], date?: "YYYY-MM-DD", apply_overtime?, apply_fine? }
 *   { items: [{ username, date }], apply_overtime?, apply_fine? }
 *   { select_all: true, from_date?, to_date?, date?, search?, apply_overtime?, apply_fine? }
 */
router.post("/manage/bulk-approve", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = getUsername(req);
        const branch_id = req.branch_id;
        if (!actor) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const applyOvertime = parseBoolFlag(req.body?.apply_overtime);
        const applyFine = parseBoolFlag(req.body?.apply_fine);
        const selectAll = parseBoolFlag(req.body?.select_all);
        const now = getAttendanceNowString();

        /** @type {{ username: string, date: string }[]} */
        let targets = [];

        if (selectAll) {
            const range = resolveDayListDateRange({
                from_date: req.body?.from_date || req.body?.start_date,
                to_date: req.body?.to_date || req.body?.end_date,
                date: req.body?.date,
            });
            if (range.error) {
                return res.status(400).json({ success: false, message: range.error });
            }
            const search = String(req.body?.search || "").trim();
            let staffSql = `
                SELECT bm.username
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
            const [staffRows] = await connection.query(staffSql, staffParams);
            for (const ymd of range.dates) {
                for (const row of staffRows) {
                    targets.push({ username: String(row.username), date: ymd });
                }
            }
        } else {
            const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
            if (rawItems.length > 0) {
                const seen = new Set();
                for (const item of rawItems) {
                    const username = String(item?.username || "").trim();
                    const date = isValidYmd(item?.date)
                        ? String(item.date).trim()
                        : normalizeManageDate(item?.date || req.body?.date);
                    if (!username || !date) continue;
                    const key = `${username}::${date}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    targets.push({ username, date });
                }
            } else {
                const rawList = Array.isArray(req.body?.usernames)
                    ? req.body.usernames
                    : Array.isArray(req.body?.username)
                        ? req.body.username
                        : [];
                const date = normalizeManageDate(req.body?.date);
                const seen = new Set();
                for (const u of rawList) {
                    const username = String(u || "").trim();
                    if (!username) continue;
                    const key = `${username}::${date}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    targets.push({ username, date });
                }
            }
        }

        if (targets.length === 0) {
            return res.status(400).json({
                success: false,
                message: "At least one staff/day is required",
            });
        }

        let done = 0;
        let not_done = 0;
        const done_usernames = [];
        const skipped_usernames = [];
        const done_items = [];
        const skipped_items = [];

        await connection.beginTransaction();

        for (const target of targets) {
            const targetUsername = target.username;
            const date = target.date;

            const okStaff = await assertTargetStaffUser(branch_id, targetUsername);
            if (!okStaff) {
                not_done += 1;
                skipped_usernames.push(targetUsername);
                skipped_items.push({ username: targetUsername, date });
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
                skipped_items.push({ username: targetUsername, date });
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
                skipped_items.push({ username: targetUsername, date });
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
                gracePeriodMinutes: salary?.grace_period_minutes,
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
            done_items.push({ username: targetUsername, date });
        }

        await connection.commit();

        const rangeMeta = resolveDayListDateRange({
            from_date: req.body?.from_date || req.body?.start_date,
            to_date: req.body?.to_date || req.body?.end_date,
            date: req.body?.date,
        });

        return res.status(200).json({
            success: true,
            message: `Approved ${done} staff. Skipped ${not_done} staff.`,
            data: {
                date: rangeMeta.from_date,
                from_date: rangeMeta.from_date,
                to_date: rangeMeta.to_date,
                select_all: selectAll,
                done,
                not_done,
                done_usernames,
                skipped_usernames,
                done_items,
                skipped_items,
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
        const todayYmd = getAttendanceDateString();
        if (
            date > todayYmd &&
            (markStatus === "present" || markStatus === "half day")
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Present and Half Day cannot be marked for future dates. Use Absent or Leave.",
            });
        }
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
                gracePeriodMinutes: salary?.grace_period_minutes,
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
