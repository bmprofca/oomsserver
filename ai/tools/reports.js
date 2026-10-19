import * as z from "zod";
import { chartBlock, kpiBlock, tableBlock } from "../blocks.js";
import { clientBalanceCountParams, clientBalanceCountSql } from "../../helpers/clientBalanceSql.js";
import { canSeeAllStaff, dateRangeFields, has, resolveRange, toNumber } from "./common.js";

/**
 * Report tools.
 * - Expenses mirror GET /expense/list: expense_entries in the period, excluding rows that are
 *   really discounts (discount_entries) or payslips (payslip_entries) by transaction_id.
 * - Sales mirror GET /report/sales-top-summary: SUM(sale_items.total) by DATE(invoice.create_date).
 */

const C = "COLLATE utf8mb4_unicode_ci"; // same collation guards used in routes/expense.js

const EXPENSE_WHERE = `
    ee.branch_id ${C} = ? ${C}
    AND NOT EXISTS (
        SELECT 1 FROM discount_entries de
        WHERE de.branch_id ${C} = ee.branch_id ${C}
          AND de.transaction_id ${C} = ee.transaction_id ${C}
    )
    AND NOT EXISTS (
        SELECT 1 FROM payslip_entries pe
        WHERE pe.branch_id ${C} = ee.branch_id ${C}
          AND pe.transaction_id ${C} = ee.transaction_id ${C}
          AND pe.is_deleted = '0'
    )
    AND ee.expense_date >= ? AND ee.expense_date <= ?`;

function canSeeSales(ctx) {
    return has(ctx, "finance_report") || has(ctx, "sales_overview_view");
}

export const expenseReport = {
    name: "expense_report",
    description:
        "Office expense totals for a period (this month, last month, a date range...), grouped by expense item, " +
        "expense type (direct / indirect / reimbursement) or month. To compare two periods, call it once per period.",
    input: z.object({
        group_by: z.enum(["item", "type", "month"]).default("item"),
        ...dateRangeFields,
    }).strict(),
    allowed: (ctx) => has(ctx, "finance_report"),
    async handler(ctx, args, { db }) {
        const range = resolveRange(args, ctx, { maxDays: 366, defaultPreset: "this_month" });
        const base = [ctx.branch_id, range.from, range.to];

        const [[totals]] = await db.query(
            `SELECT COUNT(*) AS entries, COALESCE(SUM(ee.amount), 0) AS total
             FROM expense_entries ee
             WHERE ${EXPENSE_WHERE}`,
            base
        );

        let rows;
        if (args.group_by === "month") {
            [rows] = await db.query(
                `SELECT DATE_FORMAT(ee.expense_date, '%Y-%m') AS label, COUNT(*) AS entries, COALESCE(SUM(ee.amount), 0) AS amount
                 FROM expense_entries ee
                 WHERE ${EXPENSE_WHERE}
                 GROUP BY label
                 ORDER BY label ASC`,
                base
            );
        } else {
            const labelExpr = args.group_by === "type" ? "COALESCE(ei.type, 'uncategorised')" : "COALESCE(ei.name, 'Unknown item')";
            [rows] = await db.query(
                `SELECT ${labelExpr} AS label, COUNT(DISTINCT ee.expense_id) AS entries, COALESCE(SUM(eei.amount), 0) AS amount
                 FROM expense_entries ee
                 INNER JOIN expense_entries_items eei
                    ON eei.expense_id ${C} = ee.expense_id ${C}
                   AND eei.branch_id ${C} = ee.branch_id ${C}
                 LEFT JOIN expense_items ei
                    ON ei.item_id ${C} = eei.item_id ${C}
                   AND ei.branch_id ${C} = eei.branch_id ${C}
                 WHERE ${EXPENSE_WHERE}
                 GROUP BY label
                 ORDER BY amount DESC
                 LIMIT 50`,
                base
            );
        }

        const groups = rows.map((r) => ({ label: r.label, entries: Number(r.entries) || 0, amount: toNumber(r.amount) }));
        const total = toNumber(totals?.total);
        return {
            data: {
                period: { from: range.from, to: range.to },
                total_expense: total,
                entries: Number(totals?.entries) || 0,
                group_by: args.group_by,
                groups,
                note: args.group_by !== "month"
                    ? "Group amounts come from expense line items; the total comes from expense entries."
                    : undefined,
            },
            blocks: [
                kpiBlock({
                    title: `Expenses ${range.from} to ${range.to}`,
                    items: [
                        { label: "Total expense", value: total, format: "money" },
                        { label: "Entries", value: Number(totals?.entries) || 0 },
                    ],
                }),
                ...(groups.length
                    ? [
                        tableBlock({
                            title: `Expenses by ${args.group_by}`,
                            columns: [
                                { key: "label", label: args.group_by === "month" ? "Month" : args.group_by === "type" ? "Type" : "Item" },
                                { key: "entries", label: "Entries", type: "number" },
                                { key: "amount", label: "Amount", type: "money" },
                            ],
                            rows: groups,
                        }),
                        chartBlock({
                            title: `Expenses by ${args.group_by}`,
                            kind: args.group_by === "month" ? "line" : "bar",
                            xKey: "label",
                            series: [{ key: "amount", label: "Amount" }],
                            data: groups,
                        }),
                    ]
                    : []),
            ],
        };
    },
};

export const salesReport = {
    name: "sales_report",
    description:
        "Sales (invoiced service amounts) for a period, grouped by month, service or client. Same calculation as the " +
        "OOMS sales dashboard. To compare two periods, call it once per period.",
    input: z.object({
        group_by: z.enum(["month", "service", "client"]).default("service"),
        ...dateRangeFields,
    }).strict(),
    allowed: canSeeSales,
    async handler(ctx, args, { db }) {
        const range = resolveRange(args, ctx, { maxDays: 366, defaultPreset: "this_month" });
        const base = [ctx.branch_id, range.from, range.to];
        const FROM = `
            FROM sale_items si
            INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
            WHERE si.branch_id = ? AND DATE(i.create_date) BETWEEN ? AND ?`;

        const [[totals]] = await db.query(
            `SELECT COALESCE(SUM(si.total), 0) AS total, COUNT(DISTINCT si.invoice_id) AS invoices ${FROM}`,
            base
        );

        let rows;
        if (args.group_by === "month") {
            [rows] = await db.query(
                `SELECT DATE_FORMAT(i.create_date, '%Y-%m') AS label, COUNT(DISTINCT si.invoice_id) AS invoices,
                        COALESCE(SUM(si.total), 0) AS amount
                 ${FROM}
                 GROUP BY label ORDER BY label ASC`,
                base
            );
        } else if (args.group_by === "service") {
            [rows] = await db.query(
                `SELECT COALESCE(s.name, 'Unknown service') AS label, COUNT(DISTINCT si.invoice_id) AS invoices,
                        COALESCE(SUM(si.total), 0) AS amount
                 FROM sale_items si
                 INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                 LEFT JOIN services s ON s.service_id = si.service_id
                 WHERE si.branch_id = ? AND DATE(i.create_date) BETWEEN ? AND ?
                 GROUP BY si.service_id, s.name
                 ORDER BY amount DESC LIMIT 50`,
                base
            );
        } else {
            [rows] = await db.query(
                `SELECT COALESCE(
                            (SELECT p.name FROM profile p WHERE p.username = se.party_id ORDER BY p.id DESC LIMIT 1),
                            se.party_id, 'Unknown') AS label,
                        COUNT(DISTINCT si.invoice_id) AS invoices,
                        COALESCE(SUM(si.total), 0) AS amount
                 FROM sale_items si
                 INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                 LEFT JOIN sale_entries se ON se.invoice_id = si.invoice_id AND se.branch_id = si.branch_id
                 WHERE si.branch_id = ? AND DATE(i.create_date) BETWEEN ? AND ?
                 GROUP BY se.party_id
                 ORDER BY amount DESC LIMIT 50`,
                base
            );
        }

        const groups = rows.map((r) => ({ label: r.label, invoices: Number(r.invoices) || 0, amount: toNumber(r.amount) }));
        const total = toNumber(totals?.total);
        return {
            data: { period: { from: range.from, to: range.to }, total_sales: total, invoices: Number(totals?.invoices) || 0, group_by: args.group_by, groups },
            blocks: [
                kpiBlock({
                    title: `Sales ${range.from} to ${range.to}`,
                    items: [
                        { label: "Total sales", value: total, format: "money" },
                        { label: "Invoices", value: Number(totals?.invoices) || 0 },
                    ],
                }),
                ...(groups.length
                    ? [
                        tableBlock({
                            title: `Sales by ${args.group_by}`,
                            columns: [
                                { key: "label", label: args.group_by === "month" ? "Month" : args.group_by === "service" ? "Service" : "Client" },
                                { key: "invoices", label: "Invoices", type: "number" },
                                { key: "amount", label: "Amount", type: "money" },
                            ],
                            rows: groups,
                        }),
                        chartBlock({
                            title: `Sales by ${args.group_by}`,
                            kind: args.group_by === "month" ? "line" : "bar",
                            xKey: "label",
                            series: [{ key: "amount", label: "Amount" }],
                            data: groups.slice(0, 15),
                        }),
                    ]
                    : []),
            ],
        };
    },
};

export const dashboardSummary = {
    name: "dashboard_summary",
    description:
        "Snapshot of the office today: active and overdue tasks, today's attendance, this month's sales and " +
        "expenses, and total receivables — each item only when the user is allowed to see it. Good for " +
        "'summarize my office' questions.",
    input: z.object({}).strict(),
    allowed: (ctx) => has(ctx, "dashboard_statistics_view"),
    async handler(ctx, _args, { db }) {
        const items = [];
        const data = { as_of: ctx.today };
        const monthStart = `${ctx.today.slice(0, 8)}01`;

        // Tasks (scoped to own tasks for non-managers).
        const scopeSql = canSeeAllStaff(ctx)
            ? ""
            : `AND EXISTS (SELECT 1 FROM task_staffs ts WHERE ts.task_id = t.task_id AND ts.branch_id = t.branch_id
                            AND ts.username = ? AND ts.is_deleted = '0')`;
        const [[tasks]] = await db.query(
            `SELECT SUM(t.status IN ('in process','pending from client','pending from department')) AS active,
                    SUM(t.status IN ('in process','pending from client','pending from department') AND t.due_date < ?) AS overdue,
                    SUM(t.status IN ('in process','pending from client','pending from department') AND t.due_date = ?) AS due_today,
                    SUM(t.status = 'complete' AND DATE(t.complete_date) >= ?) AS completed_this_month
             FROM tasks t
             WHERE t.branch_id = ? ${scopeSql}`,
            [ctx.today, ctx.today, monthStart, ctx.branch_id, ...(canSeeAllStaff(ctx) ? [] : [ctx.username])]
        );
        data.tasks = {
            scope: canSeeAllStaff(ctx) ? "office" : "assigned to you",
            active: Number(tasks?.active) || 0,
            overdue: Number(tasks?.overdue) || 0,
            due_today: Number(tasks?.due_today) || 0,
            completed_this_month: Number(tasks?.completed_this_month) || 0,
        };
        items.push(
            { label: "Active tasks", value: data.tasks.active },
            { label: "Overdue tasks", value: data.tasks.overdue },
            { label: "Due today", value: data.tasks.due_today },
            { label: "Completed this month", value: data.tasks.completed_this_month }
        );

        if (canSeeAllStaff(ctx)) {
            const [[att]] = await db.query(
                `SELECT COUNT(*) AS staff,
                        SUM(a.username IS NOT NULL AND a.status NOT IN ('absent', 'leave', 'half day')) AS present,
                        SUM(a.status = 'leave') AS on_leave,
                        SUM(a.username IS NULL OR a.status = 'absent') AS absent_or_not_marked
                 FROM branch_mapping bm
                 INNER JOIN users u ON u.username = bm.username AND u.status = '1'
                 LEFT JOIN attendance a ON a.username = bm.username AND a.branch_id = bm.branch_id AND a.date = ?
                 WHERE bm.branch_id = ? AND bm.type = 'staff'
                   AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'`,
                [ctx.today, ctx.branch_id]
            );
            data.attendance_today = {
                staff: Number(att?.staff) || 0,
                present: Number(att?.present) || 0,
                on_leave: Number(att?.on_leave) || 0,
                absent_or_not_marked: Number(att?.absent_or_not_marked) || 0,
            };
            items.push(
                { label: "Present today", value: data.attendance_today.present },
                { label: "Absent / not marked", value: data.attendance_today.absent_or_not_marked }
            );
        }

        if (canSeeSales(ctx)) {
            const [[sales]] = await db.query(
                `SELECT COALESCE(SUM(si.total), 0) AS total
                 FROM sale_items si
                 INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                 WHERE si.branch_id = ? AND DATE(i.create_date) BETWEEN ? AND ?`,
                [ctx.branch_id, monthStart, ctx.today]
            );
            data.sales_this_month = toNumber(sales?.total);
            items.push({ label: "Sales this month", value: data.sales_this_month, format: "money" });
        }

        if (has(ctx, "finance_report")) {
            const [[exp]] = await db.query(
                `SELECT COALESCE(SUM(ee.amount), 0) AS total FROM expense_entries ee WHERE ${EXPENSE_WHERE}`,
                [ctx.branch_id, monthStart, ctx.today]
            );
            data.expenses_this_month = toNumber(exp?.total);
            items.push({ label: "Expenses this month", value: data.expenses_this_month, format: "money" });
        }

        if (has(ctx, "finance_balance_view")) {
            const [[deb]] = await db.query(clientBalanceCountSql("debtor"), clientBalanceCountParams(ctx.branch_id));
            data.receivables = { clients: Number(deb?.total_count) || 0, amount: toNumber(deb?.total_amount) };
            items.push({ label: "Total receivable", value: data.receivables.amount, format: "money" });
        }

        return { data, blocks: [kpiBlock({ title: `Office snapshot — ${ctx.today}`, items })] };
    },
};

export default [expenseReport, salesReport, dashboardSummary];
