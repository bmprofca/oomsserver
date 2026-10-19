import * as z from "zod";
import { chartBlock, kpiBlock, tableBlock } from "../blocks.js";
import {
    ToolError,
    assertStaffScope,
    canSeeAllStaff,
    dateRangeFields,
    idString,
    loadBranchMember,
    resolveRange,
    ymd,
} from "./common.js";

/**
 * Attendance tools. Day states follow buildListState in routes/attendance.js:
 *   no attendance row        -> not_marked (shown as absent in the office summary)
 *   status leave / half day  -> leave / half_day
 *   status absent            -> absent
 *   anything else (punched / present) -> present
 * Only staff-type members are tracked (bm.type = 'staff'), same as /attendance/day-list.
 * OOMS has no separate leave table: leave is attendance.status = 'leave'.
 */

const MAX_DAYS = 186;

function dayState(row) {
    if (!row) return "not_marked";
    const mark = String(row.status || "").toLowerCase();
    if (mark === "leave") return "leave";
    if (mark === "half day") return "half_day";
    if (mark === "absent") return "absent";
    return "present";
}

function eachDate(from, to) {
    const out = [];
    let d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (d <= end) {
        out.push(d.toISOString().slice(0, 10));
        d = new Date(d.getTime() + 86400000);
    }
    return out;
}

async function loadTrackedStaff(db, ctx, username) {
    const params = [ctx.branch_id];
    let filter = "";
    // Non-managers only ever see their own attendance.
    const scopeUser = canSeeAllStaff(ctx) ? username : ctx.username;
    if (scopeUser) {
        filter = "AND bm.username = ?";
        params.push(scopeUser);
    }
    const [rows] = await db.query(
        `SELECT bm.username, bm.designation,
                (SELECT p.name FROM profile p WHERE p.username = bm.username ORDER BY p.id DESC LIMIT 1) AS name
         FROM branch_mapping bm
         INNER JOIN users u ON u.username = bm.username
         WHERE bm.branch_id = ?
           AND bm.type = 'staff'
           AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'
           AND u.status = '1'
           ${filter}
         ORDER BY name ASC, bm.username ASC
         LIMIT 200`,
        params
    );
    return rows;
}

async function loadAttendance(db, ctx, usernames, range) {
    if (!usernames.length) return new Map();
    const [rows] = await db.query(
        `SELECT username, date, status, in_time, out_time, worked_minutes
         FROM attendance
         WHERE branch_id = ? AND date >= ? AND date <= ?
           AND username IN (${usernames.map(() => "?").join(", ")})`,
        [ctx.branch_id, range.from, range.to, ...usernames]
    );
    const byKey = new Map();
    for (const r of rows) byKey.set(`${r.username}::${ymd(r.date)}`, r);
    return byKey;
}

export const attendanceReport = {
    name: "attendance_report",
    description:
        "Attendance of staff for a day or period (today, yesterday, last month, a date range...). Returns per-staff " +
        "counts of present, absent, leave, half day and not-marked days, and for a single day the list of each " +
        "staff member's status. Use it for questions like 'who is absent today' or 'attendance report for last month'. " +
        "Optionally limit to one staff username.",
    input: z.object({
        staff_username: idString("staff_username").optional(),
        ...dateRangeFields,
    }).strict(),
    allowed: () => true,
    async handler(ctx, args, { db }) {
        assertStaffScope(ctx, args.staff_username);
        const range = resolveRange(args, ctx, { maxDays: MAX_DAYS, defaultPreset: "today" });
        if (range.from > ctx.today) throw new ToolError("INVALID", "Attendance is not available for future dates.");
        const to = range.to > ctx.today ? ctx.today : range.to;
        const dates = eachDate(range.from, to);

        if (args.staff_username && canSeeAllStaff(ctx)) {
            const member = await loadBranchMember(db, ctx.branch_id, args.staff_username);
            if (!member) throw new ToolError("NOT_FOUND", "No active team member with that username in this office.");
        }
        const staff = await loadTrackedStaff(db, ctx, args.staff_username);
        if (!staff.length) {
            return {
                data: { period: { from: range.from, to }, staff_count: 0, message: "No attendance-tracked staff found." },
                blocks: [],
            };
        }
        const byKey = await loadAttendance(db, ctx, staff.map((s) => s.username), { from: range.from, to });

        const totals = { present: 0, absent: 0, leave: 0, half_day: 0, not_marked: 0 };
        const perStaff = staff.map((s) => {
            const c = { present: 0, absent: 0, leave: 0, half_day: 0, not_marked: 0 };
            let todayRow = null;
            for (const d of dates) {
                const row = byKey.get(`${s.username}::${d}`) || null;
                const state = dayState(row);
                c[state] += 1;
                totals[state] += 1;
                if (dates.length === 1) todayRow = row;
            }
            return {
                username: s.username,
                name: s.name || s.username,
                designation: s.designation || null,
                ...c,
                ...(dates.length === 1
                    ? {
                        status: dayState(todayRow).replace("_", " "),
                        in_time: todayRow?.in_time ? String(todayRow.in_time).slice(0, 5) : null,
                        out_time: todayRow?.out_time ? String(todayRow.out_time).slice(0, 5) : null,
                    }
                    : {}),
            };
        });

        const single = dates.length === 1;
        const title = single ? `Attendance on ${range.from}` : `Attendance ${range.from} to ${to}`;
        const blocks = [
            kpiBlock({
                title,
                items: [
                    { label: single ? "Present" : "Present days", value: totals.present },
                    { label: single ? "Absent" : "Absent days", value: totals.absent },
                    { label: "Not marked", value: totals.not_marked },
                    { label: "Leave", value: totals.leave },
                    { label: "Half day", value: totals.half_day },
                ],
            }),
            single
                ? tableBlock({
                    title,
                    columns: [
                        { key: "name", label: "Staff" },
                        { key: "designation", label: "Designation" },
                        { key: "status", label: "Status", type: "status" },
                        { key: "in_time", label: "In" },
                        { key: "out_time", label: "Out" },
                    ],
                    rows: perStaff,
                })
                : tableBlock({
                    title,
                    columns: [
                        { key: "name", label: "Staff" },
                        { key: "present", label: "Present", type: "number" },
                        { key: "absent", label: "Absent", type: "number" },
                        { key: "not_marked", label: "Not marked", type: "number" },
                        { key: "leave", label: "Leave", type: "number" },
                        { key: "half_day", label: "Half day", type: "number" },
                    ],
                    rows: perStaff,
                }),
        ];
        if (!single && perStaff.length > 1) {
            blocks.push(chartBlock({
                title: "Present vs absent days by staff",
                kind: "bar",
                xKey: "name",
                series: [
                    { key: "present", label: "Present" },
                    { key: "absent", label: "Absent" },
                    { key: "leave", label: "Leave" },
                ],
                data: perStaff,
            }));
        }

        return {
            data: {
                period: { from: range.from, to, days: dates.length },
                rules: "not_marked = no attendance entry for that day; office summaries count it as absent",
                totals,
                staff: perStaff,
            },
            blocks,
        };
    },
};

export const leaveSummary = {
    name: "leave_summary",
    description:
        "Leave and half-day counts per staff member for a period, from attendance marks. OOMS records leave as an " +
        "attendance status; there are no leave balances or leave types.",
    input: z.object({
        staff_username: idString("staff_username").optional(),
        ...dateRangeFields,
    }).strict(),
    allowed: () => true,
    async handler(ctx, args, { db }) {
        assertStaffScope(ctx, args.staff_username);
        const range = resolveRange(args, ctx, { maxDays: 366, defaultPreset: "this_fy" });
        const params = [ctx.branch_id, range.from, range.to];
        let filter = "";
        const scopeUser = canSeeAllStaff(ctx) ? args.staff_username : ctx.username;
        if (scopeUser) {
            filter = "AND a.username = ?";
            params.push(scopeUser);
        }
        const [rows] = await db.query(
            `SELECT a.username,
                    (SELECT p.name FROM profile p WHERE p.username = a.username ORDER BY p.id DESC LIMIT 1) AS name,
                    SUM(a.status = 'leave') AS leave_days,
                    SUM(a.status = 'half day') AS half_days
             FROM attendance a
             INNER JOIN branch_mapping bm ON bm.username = a.username AND bm.branch_id = a.branch_id
               AND bm.is_deleted = '0'
             WHERE a.branch_id = ? AND a.date >= ? AND a.date <= ?
               AND a.status IN ('leave', 'half day')
               ${filter}
             GROUP BY a.username
             ORDER BY leave_days DESC
             LIMIT 100`,
            params
        );
        const staff = rows.map((r) => ({
            username: r.username,
            name: r.name || r.username,
            leave_days: Number(r.leave_days) || 0,
            half_days: Number(r.half_days) || 0,
        }));
        return {
            data: { period: { from: range.from, to: range.to }, staff, note: staff.length ? undefined : "No leave or half-day marks in this period." },
            blocks: staff.length
                ? [tableBlock({
                    title: `Leave ${range.from} to ${range.to}`,
                    columns: [
                        { key: "name", label: "Staff" },
                        { key: "leave_days", label: "Leave days", type: "number" },
                        { key: "half_days", label: "Half days", type: "number" },
                    ],
                    rows: staff,
                })]
                : [],
        };
    },
};

export default [attendanceReport, leaveSummary];
