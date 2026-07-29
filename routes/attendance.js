import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";

const router = express.Router();

const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || "Asia/Kolkata";
const PUNCH_METHODS = new Set(["manual", "gps", "ip", "face", "fingerprint", "qr"]);

function getAttendanceDateString(date = new Date(), timeZone = ATTENDANCE_TIMEZONE) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date instanceof Date ? date : new Date(date));
}

/** MySQL DATETIME string in attendance timezone (not DB server NOW()). */
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

function normalizeMethod(value) {
    const method = value != null ? String(value).trim().toLowerCase() : "manual";
    return PUNCH_METHODS.has(method) ? method : "manual";
}

function getUsername(req) {
    return String(req.headers.username || req.headers.Username || "").trim();
}

function buildState(attendance, openBreak) {
    if (!attendance) return "not_punched";
    if (attendance.out_time) return "punched_out";
    if (openBreak) return "on_break";
    return "punched_in";
}

function formatAttendanceRow(row) {
    if (!row) return null;
    return {
        attendance_id: row.attendance_id,
        branch_id: row.branch_id,
        username: row.username,
        date: row.date,
        in_time: row.in_time,
        out_time: row.out_time,
        status: row.status,
        in_method: row.in_method,
        out_method: row.out_method,
        is_approved: row.is_approved,
    };
}

function formatBreakRow(row) {
    if (!row) return null;
    return {
        break_id: row.break_id,
        branch_id: row.branch_id,
        username: row.username,
        date: row.date,
        start_time: row.start_time,
        end_time: row.end_time,
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

    return {
        date,
        timezone: ATTENDANCE_TIMEZONE,
        state: buildState(attendance, openBreak),
        attendance: formatAttendanceRow(attendance),
        open_break: formatBreakRow(openBreak),
        breaks: breakRows.map(formatBreakRow),
    };
}

router.get("/today-status", auth, validateBranch, async (req, res) => {
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

router.post("/punch-in", auth, validateBranch, async (req, res) => {
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

        await connection.beginTransaction();

        const existing = await getTodayAttendance(connection, {
            branch_id,
            username,
            date,
        });

        if (existing) {
            await connection.rollback();
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
            [branch_id, attendance_id, username, date, now, method, username, username]
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

router.post("/punch-out", auth, validateBranch, async (req, res) => {
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
            [now, method, username, now, existing.id]
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

router.post("/break/start", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const username = getUsername(req);
        const branch_id = req.branch_id;
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const date = getAttendanceDateString();
        const now = getAttendanceNowString();

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
            [branch_id, break_id, username, date, now, username, username]
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

router.post("/break/end", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const username = getUsername(req);
        const branch_id = req.branch_id;
        if (!username) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }

        const date = getAttendanceDateString();
        const now = getAttendanceNowString();

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
            [now, username, now, openBreak.id]
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

export default router;
