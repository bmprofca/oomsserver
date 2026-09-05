import { UNIQUE_RANDOM_STRING, ID_LENGTH } from "./function.js";

export const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || "Asia/Kolkata";

export function getAttendanceDateString(date = new Date(), timeZone = ATTENDANCE_TIMEZONE) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date instanceof Date ? date : new Date(date));
}

export function daysInMonthFromDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return null;
    const [y, m] = String(dateStr).split("-").map(Number);
    if (!y || !m) return null;
    return new Date(y, m, 0).getDate();
}

export function clearWageColumns() {
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

export async function getActiveSalaryForDate(conn, { branch_id, username, date }) {
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

/** Full-day paid leave wage (same as manual manage/mark leave). */
export function buildLeaveWageForDate(salary, date) {
    const amount = Number(salary?.amount);
    const days = daysInMonthFromDate(date);
    if (!Number.isFinite(amount) || amount <= 0 || !days) {
        return clearWageColumns();
    }
    const daily = amount / days;
    return {
        ...clearWageColumns(),
        daily_wage: Number(daily.toFixed(4)),
        net_day_amount: Number(daily.toFixed(4)),
    };
}

/**
 * Insert leave attendance when no row exists (system or manual method).
 * Does not update existing rows.
 */
export async function insertLeaveAttendanceMark(
    conn,
    {
        branch_id,
        username,
        date,
        actor,
        salary = null,
        in_method = "system",
        out_method = "system",
    } = {}
) {
    const [existing] = await conn.query(
        `SELECT id FROM attendance
         WHERE branch_id = ? AND username = ? AND date = ?
         LIMIT 1`,
        [branch_id, username, date]
    );
    if (existing.length) {
        return { inserted: false, reason: "attendance_exists" };
    }

    const activeSalary =
        salary ||
        (await getActiveSalaryForDate(conn, { branch_id, username, date }));
    const wage = buildLeaveWageForDate(activeSalary, date);

    const attendance_id = await UNIQUE_RANDOM_STRING("attendance", "attendance_id", {
        length: ID_LENGTH,
        conn,
    });

    await conn.query(
        `INSERT INTO attendance
         (branch_id, attendance_id, username, date, in_time, out_time, status, in_method, out_method,
          is_approved, approved_by, create_by, modify_by,
          expected_hours, worked_minutes, extra_minutes, less_minutes,
          overtime_enabled, fine_enabled, daily_wage, overtime_amount, fine_amount, net_day_amount)
         VALUES (?, ?, ?, ?, NULL, NULL, 'leave', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            branch_id,
            attendance_id,
            username,
            date,
            in_method,
            out_method,
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

    return { inserted: true, attendance_id };
}
