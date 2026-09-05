import pool from "../db.js";
import {
    ATTENDANCE_TIMEZONE,
    getAttendanceDateString,
    getActiveSalaryForDate,
    insertLeaveAttendanceMark,
} from "./attendanceMarkHelpers.js";

const WEEKLY_OFF_DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

export function weekdayNameForDate(ymd, timeZone = ATTENDANCE_TIMEZONE) {
    const [y, m, d] = String(ymd || "").split("-").map(Number);
    if (!y || !m || !d) return "";
    const instant = new Date(Date.UTC(y, m - 1, d, 6, 30, 0));
    return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(instant);
}

export function addDaysYmd(ymd, days) {
    const [y, m, d] = String(ymd).split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function endOfMonthYmd(ymd) {
    const [y, m] = String(ymd).split("-").map(Number);
    if (!y || !m) return ymd;
    const lastDay = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

export async function getActiveWeeklyOffDays(conn, { branch_id, username }) {
    const [rows] = await conn.query(
        `SELECT weekly_off_day
         FROM employee_weekly_off
         WHERE branch_id = ?
           AND username = ?
           AND is_deleted = '0'
           AND is_active = '1'
         ORDER BY FIELD(weekly_off_day, 'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`,
        [branch_id, username]
    );
    return rows
        .map((row) => String(row.weekly_off_day || "").trim())
        .filter((day) => WEEKLY_OFF_DAYS.includes(day));
}

export async function getActiveFixedSalaryForDate(conn, { branch_id, username, date }) {
    const salary = await getActiveSalaryForDate(conn, { branch_id, username, date });
    if (!salary) return null;
    if (String(salary.salary_type || "").toLowerCase() !== "fixed") return null;
    return salary;
}

export async function autoMarkWeeklyOffDayIfEligible(
    conn,
    { branch_id, username, date, actor = "system", weeklyOffDays = null }
) {
    const today = getAttendanceDateString();
    if (date < today) {
        return { marked: false, skipped: true, reason: "past_date" };
    }

    const offDays =
        weeklyOffDays ??
        (await getActiveWeeklyOffDays(conn, { branch_id, username }));
    if (!offDays.length) {
        return { marked: false, skipped: true, reason: "no_weekly_off" };
    }

    const weekday = weekdayNameForDate(date);
    if (!offDays.includes(weekday)) {
        return { marked: false, skipped: true, reason: "not_weekly_off_day" };
    }

    const salary = await getActiveFixedSalaryForDate(conn, {
        branch_id,
        username,
        date,
    });
    if (!salary) {
        return { marked: false, skipped: true, reason: "no_fixed_salary" };
    }

    const result = await insertLeaveAttendanceMark(conn, {
        branch_id,
        username,
        date,
        actor,
        salary,
        in_method: "system",
        out_method: "system",
    });

    if (!result.inserted) {
        return { marked: false, skipped: true, reason: result.reason || "not_inserted" };
    }

    return {
        marked: true,
        skipped: false,
        attendance_id: result.attendance_id,
    };
}

export async function autoMarkWeeklyOffRange(
    conn,
    { branch_id, username, fromDate, toDate, actor = "system" }
) {
    const weeklyOffDays = await getActiveWeeklyOffDays(conn, { branch_id, username });
    if (!weeklyOffDays.length) {
        return { marked: 0, skipped: 0 };
    }

    let marked = 0;
    let skipped = 0;
    let cursor = fromDate;
    while (cursor <= toDate) {
        const result = await autoMarkWeeklyOffDayIfEligible(conn, {
            branch_id,
            username,
            date: cursor,
            actor,
            weeklyOffDays,
        });
        if (result.marked) marked += 1;
        else skipped += 1;
        cursor = addDaysYmd(cursor, 1);
    }

    return { marked, skipped };
}

export async function autoMarkWeeklyOffAfterConfigChange({
    branch_id,
    username,
    actor = "system",
    connection = pool,
}) {
    const today = getAttendanceDateString();
    const endDate = endOfMonthYmd(today);
    return autoMarkWeeklyOffRange(connection, {
        branch_id,
        username,
        fromDate: today,
        toDate: endDate,
        actor,
    });
}

export async function autoMarkWeeklyOffForAllStaffOnDate(
    conn,
    { branch_id, date, actor = "system" }
) {
    const weekday = weekdayNameForDate(date);
    const [staffRows] = await conn.query(
        `SELECT DISTINCT ewo.username
         FROM employee_weekly_off ewo
         INNER JOIN branch_mapping bm
           ON bm.username = ewo.username
          AND bm.branch_id = ewo.branch_id
          AND bm.type = 'staff'
          AND bm.is_deleted = '0'
          AND bm.is_accepted = '1'
          AND bm.status = '1'
         WHERE ewo.branch_id = ?
           AND ewo.weekly_off_day = ?
           AND ewo.is_deleted = '0'
           AND ewo.is_active = '1'`,
        [branch_id, weekday]
    );

    let marked = 0;
    let skipped = 0;
    for (const row of staffRows) {
        const result = await autoMarkWeeklyOffDayIfEligible(conn, {
            branch_id,
            username: row.username,
            date,
            actor,
        });
        if (result.marked) marked += 1;
        else skipped += 1;
    }

    return { marked, skipped };
}

export async function runWeeklyOffAutoMarkForToday(actor = "system") {
    const date = getAttendanceDateString();
    const [branchRows] = await pool.query(
        `SELECT DISTINCT branch_id
         FROM employee_weekly_off
         WHERE is_deleted = '0'
           AND is_active = '1'`
    );

    let marked = 0;
    let skipped = 0;
    for (const row of branchRows) {
        const result = await autoMarkWeeklyOffForAllStaffOnDate(pool, {
            branch_id: row.branch_id,
            date,
            actor,
        });
        marked += result.marked;
        skipped += result.skipped;
    }

    return { date, marked, skipped };
}
