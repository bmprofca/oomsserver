import * as z from "zod";
import { chartBlock, kpiBlock, tableBlock } from "../blocks.js";
import {
    ACTIVE_TASK_STATUSES,
    DUE_CATEGORY_LABELS,
    TASK_STATUSES,
    ToolError,
    assertStaffScope,
    canSeeAllStaff,
    dateRangeFields,
    dueCategory,
    has,
    idString,
    limitField,
    loadBranchMember,
    pageField,
    resolveRange,
    searchString,
    toNumber,
    ymd,
} from "./common.js";

/**
 * Task tools. Status values and the overdue rule mirror routes/task.js and
 * routes/report.js: overdue = active status (in process / pending from client /
 * pending from department) with due_date before today (Asia/Kolkata).
 * Tasks have no priority column in OOMS.
 */

const DUE_FILTERS = ["overdue", "due_today", "due_next_7_days", "pending"];

/**
 * WHERE builder shared by list + aggregate queries so counts and rows always agree.
 * Assignment is via task_staffs; t.username is the CLIENT, not the staff member.
 */
function buildTaskWhere(ctx, filters) {
    const clauses = ["t.branch_id = ?"];
    const params = [ctx.branch_id];
    const assignedTo = (username) => {
        clauses.push(
            `EXISTS (SELECT 1 FROM task_staffs ts
                     WHERE ts.task_id = t.task_id AND ts.branch_id = t.branch_id
                       AND ts.username = ? AND ts.is_deleted = '0')`
        );
        params.push(username);
    };

    // Row-level scope: non-managers only ever see tasks assigned to themselves.
    if (!canSeeAllStaff(ctx)) assignedTo(ctx.username);
    if (filters.staff_username) assignedTo(filters.staff_username);

    if (filters.statuses?.length) {
        clauses.push(`t.status IN (${filters.statuses.map(() => "?").join(", ")})`);
        params.push(...filters.statuses);
    }
    if (filters.due_filter) {
        const active = ACTIVE_TASK_STATUSES.map(() => "?").join(", ");
        if (filters.due_filter === "pending") {
            clauses.push(`t.status IN (${active})`);
            params.push(...ACTIVE_TASK_STATUSES);
        } else if (filters.due_filter === "overdue") {
            clauses.push(`t.status IN (${active}) AND t.due_date < ?`);
            params.push(...ACTIVE_TASK_STATUSES, ctx.today);
        } else if (filters.due_filter === "due_today") {
            clauses.push(`t.status IN (${active}) AND t.due_date = ?`);
            params.push(...ACTIVE_TASK_STATUSES, ctx.today);
        } else if (filters.due_filter === "due_next_7_days") {
            clauses.push(`t.status IN (${active}) AND t.due_date > ? AND t.due_date <= DATE_ADD(?, INTERVAL 7 DAY)`);
            params.push(...ACTIVE_TASK_STATUSES, ctx.today, ctx.today);
        }
    }
    if (filters.due_range) {
        clauses.push("t.due_date BETWEEN ? AND ?");
        params.push(filters.due_range.from, filters.due_range.to);
    }
    if (filters.created_range) {
        clauses.push("DATE(t.create_date) BETWEEN ? AND ?");
        params.push(filters.created_range.from, filters.created_range.to);
    }
    if (filters.completed_range) {
        clauses.push("t.status = 'complete' AND DATE(t.complete_date) BETWEEN ? AND ?");
        params.push(filters.completed_range.from, filters.completed_range.to);
    }
    if (filters.search) {
        const p = `%${filters.search}%`;
        clauses.push(
            `(t.task_id LIKE ? OR f.firm_name LIKE ? OR s.name LIKE ?
              OR EXISTS (SELECT 1 FROM profile cp WHERE cp.username = t.username AND cp.name LIKE ?))`
        );
        params.push(p, p, p, p);
    }
    return { where: clauses.join(" AND "), params };
}

const TASK_FROM = `
    FROM tasks t
    LEFT JOIN firms f ON f.firm_id = t.firm_id AND f.branch_id = t.branch_id
    LEFT JOIN services s ON s.service_id = t.service_id`;

async function queryTasks(db, ctx, filters, { limit, page }) {
    const { where, params } = buildTaskWhere(ctx, filters);
    const offset = (page - 1) * limit;

    const [[agg]] = await db.query(
        `SELECT COUNT(*) AS total,
                SUM(t.status = 'in process') AS in_process,
                SUM(t.status = 'pending from client') AS pending_from_client,
                SUM(t.status = 'pending from department') AS pending_from_department,
                SUM(t.status = 'complete') AS complete,
                SUM(t.status = 'cancel') AS cancel,
                SUM(t.status IN ('in process','pending from client','pending from department') AND t.due_date < ?) AS overdue
         ${TASK_FROM}
         WHERE ${where}`,
        [ctx.today, ...params]
    );

    const [rows] = await db.query(
        `SELECT t.task_id, t.task_type, t.status, t.due_date, t.target_date, t.create_date, t.complete_date,
                t.fees, t.total, t.compliance_period, t.compliance_year, t.username AS client_username,
                s.name AS service_name, f.firm_name,
                (SELECT cp.name FROM profile cp WHERE cp.username = t.username ORDER BY cp.id DESC LIMIT 1) AS client_name,
                (SELECT GROUP_CONCAT(DISTINCT COALESCE(sp.name, ts.username) ORDER BY sp.name SEPARATOR ', ')
                   FROM task_staffs ts
                   LEFT JOIN profile sp ON sp.username = ts.username
                     AND sp.id = (SELECT MAX(p3.id) FROM profile p3 WHERE p3.username = ts.username)
                  WHERE ts.task_id = t.task_id AND ts.branch_id = t.branch_id AND ts.is_deleted = '0') AS assigned_to
         ${TASK_FROM}
         WHERE ${where}
         ORDER BY (t.due_date IS NULL), t.due_date ASC, t.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    const showFees = has(ctx, "task_fees_view");
    const tasks = rows.map((r) => {
        const active = ACTIVE_TASK_STATUSES.includes(r.status);
        const due = ymd(r.due_date);
        return {
            task_id: r.task_id,
            service: r.service_name || "Task",
            client: r.client_name || r.client_username || null,
            client_username: r.client_username || null,
            firm: r.firm_name || null,
            status: r.status,
            due_date: due,
            due_category: active ? dueCategory(due, ctx.today) : null,
            overdue: active && Boolean(due) && due < ctx.today,
            created: ymd(r.create_date),
            completed: ymd(r.complete_date),
            period: [r.compliance_period, r.compliance_year].filter(Boolean).join(" ") || null,
            assigned_to: r.assigned_to || null,
            ...(showFees ? { fees: toNumber(r.fees), total: toNumber(r.total) } : {}),
        };
    });

    const summary = {
        total: Number(agg?.total) || 0,
        in_process: Number(agg?.in_process) || 0,
        pending_from_client: Number(agg?.pending_from_client) || 0,
        pending_from_department: Number(agg?.pending_from_department) || 0,
        complete: Number(agg?.complete) || 0,
        cancel: Number(agg?.cancel) || 0,
        overdue: Number(agg?.overdue) || 0,
    };
    return { summary, tasks, page, limit, has_more: offset + tasks.length < summary.total, showFees };
}

function taskTable(title, result) {
    const columns = [
        // task_id is internal: it only travels hidden inside the link.
        { key: "service", label: "Task", href: "/task/{task_id}" },
        { key: "client", label: "Client" },
        { key: "firm", label: "Firm" },
        { key: "status", label: "Status", type: "status" },
        { key: "due_date", label: "Due date", type: "date" },
        { key: "assigned_to", label: "Assigned to" },
        ...(result.showFees ? [{ key: "total", label: "Total", type: "money" }] : []),
    ];
    const rows = result.tasks.map((t) => ({ ...t, status: t.overdue ? `${t.status} (overdue)` : t.status }));
    return tableBlock({
        title,
        columns,
        rows,
        total: result.summary.total,
        truncated: result.has_more,
        note: result.has_more ? `Showing ${result.tasks.length} of ${result.summary.total}. Ask for the next page to see more.` : null,
    });
}

function summaryKpi(summary) {
    return kpiBlock({
        items: [
            { label: "Total", value: summary.total },
            { label: "In process", value: summary.in_process },
            { label: "Pending (client)", value: summary.pending_from_client },
            { label: "Pending (dept.)", value: summary.pending_from_department },
            { label: "Completed", value: summary.complete },
            { label: "Overdue", value: summary.overdue },
        ],
    });
}

function forModel(result) {
    // Drop presentation-only fields; the model gets the facts plus pagination state.
    return {
        summary: result.summary,
        page: result.page,
        has_more: result.has_more,
        tasks: result.tasks.map(({ client_username, ...t }) => t),
    };
}

export const searchTasks = {
    name: "search_tasks",
    description:
        "List tasks of the current office with filters: assigned staff username, status, due filter " +
        "(overdue, due_today, due_next_7_days, pending), due-date range, created-date range, completed-date range " +
        "and free-text search on task id, service, firm or client name. Returns status counts for ALL matching tasks " +
        "plus one page of rows. Tasks have no priority field.",
    input: z.object({
        staff_username: idString("staff_username").optional()
            .describe("Only tasks assigned to this staff username (resolve names with search_staff first)"),
        status: z.array(z.enum(TASK_STATUSES)).max(5).optional(),
        due_filter: z.enum(DUE_FILTERS).optional(),
        search: searchString.optional(),
        date_field: z.enum(["due", "created", "completed"]).optional()
            .describe("Which date the preset/from/to range applies to (default: due)"),
        ...dateRangeFields,
        limit: limitField,
        page: pageField,
    }).strict(),
    allowed: () => true,
    async handler(ctx, args, { db }) {
        assertStaffScope(ctx, args.staff_username);
        if (args.staff_username && !(await loadBranchMember(db, ctx.branch_id, args.staff_username))) {
            throw new ToolError("NOT_FOUND", "No active team member with that username in this office.");
        }
        const filters = {
            staff_username: args.staff_username,
            statuses: args.status,
            due_filter: args.due_filter,
            search: args.search,
        };
        if (args.preset || args.from || args.to) {
            const range = resolveRange(args, ctx, { maxDays: 366 });
            const field = args.date_field || "due";
            filters[`${field === "due" ? "due" : field}_range`] = range;
            filters.range_label = `${field} ${range.from} to ${range.to}`;
        }
        const result = await queryTasks(db, ctx, filters, { limit: args.limit, page: args.page });
        return {
            data: { filters_applied: { ...filters, today: ctx.today }, ...forModel(result) },
            blocks: [summaryKpi(result.summary), taskTable("Tasks", result)],
        };
    },
};

export const getStaffTasks = {
    name: "get_staff_tasks",
    description:
        "Tasks assigned to one staff member (by username), with counts by status and overdue for all of their " +
        "matching tasks. Optionally filter by status or due filter. Resolve a person's name with search_staff first.",
    input: z.object({
        staff_username: idString("staff_username"),
        status: z.array(z.enum(TASK_STATUSES)).max(5).optional(),
        due_filter: z.enum(DUE_FILTERS).optional(),
        limit: limitField,
        page: pageField,
    }).strict(),
    allowed: () => true,
    async handler(ctx, args, { db }) {
        assertStaffScope(ctx, args.staff_username);
        const member = await loadBranchMember(db, ctx.branch_id, args.staff_username);
        if (!member) throw new ToolError("NOT_FOUND", "No active team member with that username in this office.");
        const result = await queryTasks(
            db,
            ctx,
            { staff_username: args.staff_username, statuses: args.status, due_filter: args.due_filter },
            { limit: args.limit, page: args.page }
        );
        const name = member.name || member.username;
        return {
            data: { staff: { username: member.username, name, designation: member.designation }, today: ctx.today, ...forModel(result) },
            blocks: [summaryKpi(result.summary), taskTable(`Tasks assigned to ${name}`, result)],
        };
    },
};

export const getTaskDetails = {
    name: "get_task_details",
    description: "Full details of one task by task id: service, client, firm, status, dates, assigned staff and recent status history.",
    input: z.object({ task_id: idString("task_id") }).strict(),
    allowed: () => true,
    async handler(ctx, args, { db }) {
        const { where, params } = buildTaskWhere(ctx, {});
        const result = await db.query(
            `SELECT t.task_id, t.task_type, t.status, t.due_date, t.target_date, t.create_date, t.complete_date,
                    t.fees, t.total, t.billing_status, t.compliance_period, t.compliance_year, t.username AS client_username,
                    s.name AS service_name, f.firm_name,
                    (SELECT cp.name FROM profile cp WHERE cp.username = t.username ORDER BY cp.id DESC LIMIT 1) AS client_name
             ${TASK_FROM}
             WHERE ${where} AND t.task_id = ?
             LIMIT 1`,
            [...params, args.task_id]
        );
        const task = result[0]?.[0];
        if (!task) throw new ToolError("NOT_FOUND", "No task with that id is visible to you in this office.");

        const [staffRows] = await db.query(
            `SELECT ts.username,
                    (SELECT p.name FROM profile p WHERE p.username = ts.username ORDER BY p.id DESC LIMIT 1) AS name
             FROM task_staffs ts
             WHERE ts.task_id = ? AND ts.branch_id = ? AND ts.is_deleted = '0'`,
            [args.task_id, ctx.branch_id]
        );
        const [history] = await db.query(
            `SELECT status, create_date, create_by FROM task_status
             WHERE task_id = ? AND branch_id = ?
             ORDER BY id DESC LIMIT 5`,
            [args.task_id, ctx.branch_id]
        );

        const showFees = has(ctx, "task_fees_view");
        const active = ACTIVE_TASK_STATUSES.includes(task.status);
        const due = ymd(task.due_date);
        const details = {
            task_id: task.task_id,
            type: task.task_type,
            service: task.service_name || null,
            client: task.client_name || task.client_username || null,
            firm: task.firm_name || null,
            status: task.status,
            overdue: active && Boolean(due) && due < ctx.today,
            due_date: due,
            target_date: ymd(task.target_date),
            created: ymd(task.create_date),
            completed: ymd(task.complete_date),
            period: [task.compliance_period, task.compliance_year].filter(Boolean).join(" ") || null,
            assigned_to: staffRows.map((s) => s.name || s.username),
            ...(showFees
                ? {
                    fees: toNumber(task.fees),
                    total: toNumber(task.total),
                    billing: task.billing_status === "1" ? "billed" : task.billing_status === "2" ? "non billable" : "pending",
                }
                : {}),
            status_history: history.map((h) => ({ status: h.status, date: String(h.create_date || "").slice(0, 16) })),
        };
        return {
            data: details,
            blocks: [
                tableBlock({
                    title: ["Task", details.service, details.client].filter(Boolean).join(" · "),
                    columns: [
                        { key: "field", label: "Field" },
                        { key: "value", label: "Value" },
                    ],
                    rows: [
                        ["Service", details.service],
                        ["Client", details.client],
                        ["Firm", details.firm],
                        ["Status", details.overdue ? `${details.status} (overdue)` : details.status],
                        ["Due date", details.due_date],
                        ["Target date", details.target_date],
                        ["Created", details.created],
                        ["Completed", details.completed],
                        ["Period", details.period],
                        ["Assigned to", details.assigned_to.join(", ")],
                        ...(showFees ? [["Total", details.total], ["Billing", details.billing]] : []),
                    ].map(([field, value]) => ({ field, value })),
                }),
            ],
        };
    },
};

export const taskSummary = {
    name: "task_summary",
    description:
        "Task statistics for the office or one staff member: counts by status and by due category " +
        "(overdue, due today, due within 7 days, future) for active tasks, plus per-staff completion stats. " +
        "Optional date range filters tasks by due date.",
    input: z.object({
        staff_username: idString("staff_username").optional(),
        ...dateRangeFields,
    }).strict(),
    allowed: (ctx) => has(ctx, "task_summary_view"),
    async handler(ctx, args, { db }) {
        assertStaffScope(ctx, args.staff_username);
        const filters = { staff_username: args.staff_username };
        let rangeLabel = "all dates";
        if (args.preset || args.from || args.to) {
            filters.due_range = resolveRange(args, ctx, { maxDays: 366 });
            rangeLabel = `due ${filters.due_range.from} to ${filters.due_range.to}`;
        }
        const { where, params } = buildTaskWhere(ctx, filters);

        const [[agg]] = await db.query(
            `SELECT COUNT(*) AS total,
                    SUM(t.status = 'in process') AS in_process,
                    SUM(t.status = 'pending from client') AS pending_from_client,
                    SUM(t.status = 'pending from department') AS pending_from_department,
                    SUM(t.status = 'complete') AS complete,
                    SUM(t.status = 'cancel') AS cancel,
                    SUM(t.status IN ('in process','pending from client','pending from department') AND t.due_date < ?) AS od,
                    SUM(t.status IN ('in process','pending from client','pending from department') AND t.due_date = ?) AS dt,
                    SUM(t.status IN ('in process','pending from client','pending from department')
                        AND t.due_date > ? AND t.due_date <= DATE_ADD(?, INTERVAL 7 DAY)) AS d7,
                    SUM(t.status IN ('in process','pending from client','pending from department')
                        AND t.due_date > DATE_ADD(?, INTERVAL 7 DAY)) AS ft
             ${TASK_FROM}
             WHERE ${where}`,
            [ctx.today, ctx.today, ctx.today, ctx.today, ctx.today, ...params]
        );

        // Per-staff breakdown (each task counts once per assigned staff member).
        const [perStaff] = await db.query(
            `SELECT ts.username,
                    (SELECT p.name FROM profile p WHERE p.username = ts.username ORDER BY p.id DESC LIMIT 1) AS name,
                    COUNT(DISTINCT t.task_id) AS total,
                    COUNT(DISTINCT CASE WHEN t.status = 'complete' THEN t.task_id END) AS complete,
                    COUNT(DISTINCT CASE WHEN t.status IN ('in process','pending from client','pending from department') THEN t.task_id END) AS active,
                    COUNT(DISTINCT CASE WHEN t.status IN ('in process','pending from client','pending from department') AND t.due_date < ? THEN t.task_id END) AS overdue
             ${TASK_FROM}
             INNER JOIN task_staffs ts ON ts.task_id = t.task_id AND ts.branch_id = t.branch_id AND ts.is_deleted = '0'
             WHERE ${where}
             GROUP BY ts.username
             ORDER BY total DESC
             LIMIT 50`,
            [ctx.today, ...params]
        );

        const counts = {
            total: Number(agg?.total) || 0,
            in_process: Number(agg?.in_process) || 0,
            pending_from_client: Number(agg?.pending_from_client) || 0,
            pending_from_department: Number(agg?.pending_from_department) || 0,
            complete: Number(agg?.complete) || 0,
            cancel: Number(agg?.cancel) || 0,
        };
        const due = {
            OD: Number(agg?.od) || 0,
            DT: Number(agg?.dt) || 0,
            D7: Number(agg?.d7) || 0,
            FT: Number(agg?.ft) || 0,
        };
        const staff = perStaff.map((r) => {
            const total = Number(r.total) || 0;
            const complete = Number(r.complete) || 0;
            return {
                username: r.username,
                name: r.name || r.username,
                total,
                complete,
                active: Number(r.active) || 0,
                overdue: Number(r.overdue) || 0,
                completion_rate_pct: total ? Math.round((complete / total) * 1000) / 10 : 0,
            };
        });

        return {
            data: { scope: rangeLabel, today: ctx.today, counts, active_by_due: due, per_staff: staff },
            blocks: [
                kpiBlock({
                    title: `Task summary (${rangeLabel})`,
                    items: [
                        { label: "Total", value: counts.total },
                        { label: "Completed", value: counts.complete },
                        { label: "Overdue", value: due.OD },
                        { label: "Due today", value: due.DT },
                        { label: "Due in 7 days", value: due.D7 },
                        { label: "Cancelled", value: counts.cancel },
                    ],
                }),
                chartBlock({
                    title: "Active tasks by due date",
                    kind: "bar",
                    xKey: "category",
                    series: [{ key: "count", label: "Tasks" }],
                    data: Object.entries(due).map(([k, v]) => ({ category: DUE_CATEGORY_LABELS[k], count: v })),
                }),
                ...(staff.length > 1
                    ? [
                        tableBlock({
                            title: "Staff-wise completion",
                            columns: [
                                { key: "name", label: "Staff" },
                                { key: "total", label: "Total", type: "number" },
                                { key: "complete", label: "Completed", type: "number" },
                                { key: "active", label: "Active", type: "number" },
                                { key: "overdue", label: "Overdue", type: "number" },
                                { key: "completion_rate_pct", label: "Completion %", type: "number" },
                            ],
                            rows: staff,
                        }),
                    ]
                    : []),
            ],
        };
    },
};

export default [searchTasks, getStaffTasks, getTaskDetails, taskSummary];
