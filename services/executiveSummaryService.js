import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { performance } from "node:perf_hooks";
import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import { getConfigWithDecryptedPassword } from "./emailConfigService.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TIMEZONE = "Asia/Kolkata";
const MAX_DETAIL_ROWS = 5000;

const SECTION_KEYS = [
    "tasks_completed",
    "new_tasks",
    "sales",
    "collections",
    "expenses",
    "unpaid_debtors",
    "due_tasks",
    "clients_without_service",
];

const DEFAULT_SECTIONS = {
    tasks_completed: { enabled: true },
    new_tasks: { enabled: true },
    sales: { enabled: true },
    collections: { enabled: true },
    expenses: { enabled: true },
    unpaid_debtors: { enabled: true, sort: "outstanding_desc" },
    due_tasks: { enabled: true, mode: "open_at_period_end" },
    clients_without_service: { enabled: true },
};

function parseJson(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function isValidDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function dateFromUtc(value) {
    return new Date(`${value}T00:00:00Z`);
}

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

function dateOnly(value) {
    if (!value) return null;
    if (typeof value === "string") return value.slice(0, 10);
    if (value instanceof Date && !Number.isNaN(value.getTime())) return formatDate(value);
    return String(value).slice(0, 10);
}

function addDays(value, days) {
    const date = dateFromUtc(value);
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return formatDate(date);
}

function localToday(timezone = DEFAULT_TIMEZONE) {
    try {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(new Date());
        const get = (type) => parts.find((part) => part.type === type)?.value;
        const value = `${get("year")}-${get("month")}-${get("day")}`;
        return isValidDate(value) ? value : formatDate(new Date());
    } catch (_) {
        return formatDate(new Date());
    }
}

function normalizeTimezone(value) {
    const timezone = String(value || DEFAULT_TIMEZONE).trim();
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
        return timezone;
    } catch (_) {
        return DEFAULT_TIMEZONE;
    }
}

function assertTimezone(value) {
    const timezone = String(value || DEFAULT_TIMEZONE).trim();
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch (_) {
        throw httpError(400, "timezone must be a valid IANA timezone");
    }
    return timezone;
}

function isScheduleDue(config) {
    try {
        const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: config.timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).formatToParts(new Date());
        const hour = Number(parts.find((part) => part.type === "hour")?.value);
        const minute = Number(parts.find((part) => part.type === "minute")?.value);
        return hour === Number(config.send_hour) && minute === Number(config.send_minute);
    } catch (_) {
        return false;
    }
}

function normalizeEmails(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(/[;,\s]+/);
    return [...new Set(values.map((email) => String(email || "").trim().toLowerCase()).filter(Boolean))];
}

function validateEmails(value, { required = false } = {}) {
    const emails = normalizeEmails(value);
    if (required && emails.length === 0) throw httpError(400, "At least one recipient email is required when automated delivery is enabled");
    if (emails.some((email) => !EMAIL_RE.test(email))) throw httpError(400, "Every recipient email must be valid");
    if (emails.length > 20) throw httpError(400, "A maximum of 20 recipient emails is supported");
    return emails;
}

function normalizeSections(value) {
    const input = value && typeof value === "object" ? value : {};
    const output = {};
    for (const key of SECTION_KEYS) {
        const item = input[key] && typeof input[key] === "object" ? input[key] : {};
        output[key] = {
            ...DEFAULT_SECTIONS[key],
            enabled: item.enabled === undefined ? DEFAULT_SECTIONS[key].enabled : Boolean(item.enabled),
        };
        if (key === "unpaid_debtors") {
            output[key].sort = ["outstanding_desc", "last_payment_asc", "name_asc"].includes(item.sort)
                ? item.sort
                : DEFAULT_SECTIONS[key].sort;
        }
        if (key === "due_tasks") {
            output[key].mode = ["due_in_period", "open_at_period_end"].includes(item.mode)
                ? item.mode
                : DEFAULT_SECTIONS[key].mode;
        }
    }
    return output;
}

function normalizeConfig(row, fallback = {}) {
    const config = row || {};
    return {
        config_id: config.config_id || fallback.config_id || null,
        branch_id: config.branch_id || fallback.branch_id || null,
        enabled: Boolean(Number(config.enabled ?? fallback.enabled ?? 0)),
        schedule_type: ["weekly", "monthly"].includes(config.schedule_type || fallback.schedule_type)
            ? (config.schedule_type || fallback.schedule_type)
            : "weekly",
        send_hour: Math.min(23, Math.max(0, Number(config.send_hour ?? fallback.send_hour ?? 9))),
        send_minute: Math.min(59, Math.max(0, Number(config.send_minute ?? fallback.send_minute ?? 0))),
        timezone: normalizeTimezone(config.timezone || fallback.timezone),
        week_starts_on: Math.min(6, Math.max(0, Number(config.week_starts_on ?? fallback.week_starts_on ?? 1))),
        inactivity_days: Math.min(3650, Math.max(0, Number(config.inactivity_days ?? fallback.inactivity_days ?? 30))),
        recipient_emails: normalizeEmails(parseJson(config.recipient_emails_json, config.recipient_emails || fallback.recipient_emails || [])),
        sections: normalizeSections(parseJson(config.sections_json, config.sections || fallback.sections)),
        last_successful_period_key: config.last_successful_period_key || null,
        last_attempt_at: config.last_attempt_at || null,
        last_success_at: config.last_success_at || null,
        last_error: config.last_error || null,
    };
}

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizePeriod({ fromDate, toDate, scheduleType = "monthly", timezone = DEFAULT_TIMEZONE, weekStartsOn = 1 } = {}) {
    if (fromDate || toDate) {
        if (!isValidDate(fromDate) || !isValidDate(toDate) || fromDate > toDate) {
            throw httpError(400, "from_date and to_date must be valid dates with from_date <= to_date");
        }
        return { start: fromDate, end: toDate };
    }

    const today = localToday(timezone);
    if (scheduleType === "monthly") {
        const current = dateFromUtc(today);
        const previousMonthEnd = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
        const previousMonthStart = new Date(Date.UTC(previousMonthEnd.getUTCFullYear(), previousMonthEnd.getUTCMonth(), 1));
        return { start: formatDate(previousMonthStart), end: formatDate(previousMonthEnd) };
    }

    const weekday = dateFromUtc(today).getUTCDay();
    const startDay = Math.min(6, Math.max(0, Number(weekStartsOn) || 0));
    const daysSinceWeekStart = (weekday - startDay + 7) % 7;
    const currentWeekStart = addDays(today, -daysSinceWeekStart);
    return { start: addDays(currentWeekStart, -7), end: addDays(currentWeekStart, -1) };
}

function periodMeta(period, inactivityDays) {
    return {
        from_date: period.start,
        to_date: period.end,
        end_exclusive: addDays(period.end, 1),
        inactivity_cutoff_date: addDays(period.end, -Number(inactivityDays || 0)),
        period_key: `${period.start}:${period.end}`,
    };
}

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value) {
    return Math.max(0, Math.round(number(value)));
}

function filterRows(rows, { staffUsername, search } = {}) {
    const normalizedStaff = String(staffUsername || "").trim().toLowerCase();
    const normalizedSearch = String(search || "").trim().toLowerCase();
    return (rows || []).filter((row) => {
        if (normalizedStaff && String(row.username || row.staff_username || "").toLowerCase() !== normalizedStaff) return false;
        if (!normalizedSearch) return true;
        return Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch));
    });
}

async function getBranchName(branchId) {
    const [rows] = await pool.query("SELECT name FROM branch_list WHERE branch_id = ? LIMIT 1", [branchId]);
    return rows[0]?.name || "OOMS Office";
}

async function fetchReport({ branchId, period, config, filters = {} }) {
    const meta = periodMeta(period, filters.inactivityDays ?? config.inactivity_days);
    const start = meta.from_date;
    const endExclusive = meta.end_exclusive;
    const cutoff = meta.inactivity_cutoff_date;
    const sections = {};
    const totals = {};
    const sectionTasks = [];
    const sectionTimings = {};
    const reportStartedAt = performance.now();
    const scheduleSection = (key, task) => sectionTasks.push(async () => {
        const startedAt = performance.now();
        try {
            await task();
        } finally {
            sectionTimings[key] = Math.round(performance.now() - startedAt);
        }
    });
    const branchNamePromise = getBranchName(branchId);
    const requestedSections = Array.isArray(filters.sections) && filters.sections.length
        ? new Set(filters.sections)
        : null;
    const enabled = (key) => config.sections[key]?.enabled !== false && (!requestedSections || requestedSections.has(key));

    if (enabled("tasks_completed")) scheduleSection("tasks_completed", async () => {
        const [rows] = await pool.query(
            `SELECT t.complete_by AS username,
                    COALESCE(MAX(NULLIF(TRIM(p.name), '')), t.complete_by, 'Unassigned') AS staff_name,
                    MAX(bm.designation) AS designation,
                    COUNT(DISTINCT t.task_id) AS completed_count
             FROM tasks t
             LEFT JOIN profile p ON p.username = t.complete_by
                 AND p.status = '1'
                 AND LOWER(TRIM(p.user_type)) IN ('user','staff','admin')
             LEFT JOIN branch_mapping bm ON bm.username = t.complete_by
                 AND bm.branch_id = t.branch_id
                 AND bm.type = 'staff'
                 AND bm.is_deleted = '0'
             WHERE t.branch_id = ? AND t.complete_date >= ? AND t.complete_date < ?
               AND LOWER(COALESCE(t.status, '')) = 'complete'
             GROUP BY t.complete_by
             ORDER BY completed_count DESC, staff_name ASC`,
            [branchId, start, endExclusive]
        );
        sections.tasks_completed = { rows: filterRows(rows, filters).map((row) => ({
            username: row.username || null,
            staff_name: row.staff_name || "Unassigned",
            designation: row.designation || null,
            completed_count: integer(row.completed_count),
        })) };
        totals.tasks_completed = sections.tasks_completed.rows.reduce((sum, row) => sum + row.completed_count, 0);
    });

    if (enabled("new_tasks")) scheduleSection("new_tasks", async () => {
        const [rows] = await pool.query(
            `SELECT t.create_by AS username,
                    COALESCE(MAX(p.name), t.create_by, 'Unknown') AS staff_name,
                    COUNT(*) AS new_task_count
             FROM tasks t
             LEFT JOIN profile p ON p.username = t.create_by AND LOWER(TRIM(p.user_type)) IN ('user','staff','admin')
             WHERE t.branch_id = ? AND t.create_date >= ? AND t.create_date < ?
             GROUP BY t.create_by
             ORDER BY new_task_count DESC, staff_name ASC`,
            [branchId, start, endExclusive]
        );
        sections.new_tasks = { rows: filterRows(rows, filters).map((row) => ({
            username: row.username || null,
            staff_name: row.staff_name || "Unknown",
            new_task_count: integer(row.new_task_count),
        })) };
        totals.new_tasks = sections.new_tasks.rows.reduce((sum, row) => sum + row.new_task_count, 0);
    });

    if (enabled("sales")) scheduleSection("sales", async () => {
        const [rows] = await pool.query(
            `SELECT se.create_by AS username,
                    COALESCE(MAX(p.name), se.create_by, 'Unknown') AS staff_name,
                    COUNT(DISTINCT se.sale_id) AS sale_count,
                    COALESCE(SUM(se.total), 0) AS sale_amount
             FROM sale_entries se
             LEFT JOIN profile p ON p.username = se.create_by AND LOWER(TRIM(p.user_type)) IN ('user','staff','admin')
             WHERE se.branch_id = ? AND se.sale_date >= ? AND se.sale_date < ?
             GROUP BY se.create_by
             ORDER BY sale_amount DESC, staff_name ASC`,
            [branchId, start, endExclusive]
        );
        sections.sales = { rows: filterRows(rows, filters).map((row) => ({
            username: row.username || null,
            staff_name: row.staff_name || "Unknown",
            sale_count: integer(row.sale_count),
            sale_amount: number(row.sale_amount),
        })) };
        totals.sales = sections.sales.rows.reduce((sum, row) => sum + row.sale_amount, 0);
    });

    if (enabled("collections")) scheduleSection("collections", async () => {
        const [rows] = await pool.query(
            `SELECT t.create_by AS username,
                    COALESCE(MAX(p.name), t.create_by, 'Unknown') AS staff_name,
                    COUNT(*) AS collection_count,
                    COALESCE(SUM(ABS(t.amount)), 0) AS collection_amount
             FROM transactions t
             LEFT JOIN profile p ON p.username = t.create_by AND LOWER(TRIM(p.user_type)) IN ('user','staff','admin')
             WHERE t.branch_id = ? AND t.transaction_date >= ? AND t.transaction_date < ?
               AND LOWER(COALESCE(t.transaction_type, '')) IN ('receive','received')
               AND (t.party1_type = 'client' OR t.party2_type = 'client')
             GROUP BY t.create_by
             ORDER BY collection_amount DESC, staff_name ASC`,
            [branchId, start, endExclusive]
        );
        sections.collections = { rows: filterRows(rows, filters).map((row) => ({
            username: row.username || null,
            staff_name: row.staff_name || "Unknown",
            collection_count: integer(row.collection_count),
            collection_amount: number(row.collection_amount),
        })) };
        totals.collections = sections.collections.rows.reduce((sum, row) => sum + row.collection_amount, 0);
    });

    if (enabled("expenses")) scheduleSection("expenses", async () => {
        const [rows] = await pool.query(
            `SELECT ee.create_by AS username,
                    COALESCE(MAX(p.name), ee.create_by, 'Unknown') AS staff_name,
                    COUNT(*) AS expense_count,
                    COALESCE(SUM(ABS(ee.amount)), 0) AS expense_amount
             FROM expense_entries ee
             LEFT JOIN profile p ON p.username = ee.create_by AND LOWER(TRIM(p.user_type)) IN ('user','staff','admin')
             WHERE ee.branch_id = ? AND ee.expense_date >= ? AND ee.expense_date < ?
             GROUP BY ee.create_by
             ORDER BY expense_amount DESC, staff_name ASC`,
            [branchId, start, endExclusive]
        );
        sections.expenses = { rows: filterRows(rows, filters).map((row) => ({
            username: row.username || null,
            staff_name: row.staff_name || "Unknown",
            expense_count: integer(row.expense_count),
            expense_amount: number(row.expense_amount),
        })) };
        totals.expenses = sections.expenses.rows.reduce((sum, row) => sum + row.expense_amount, 0);
    });

    if (enabled("unpaid_debtors")) scheduleSection("unpaid_debtors", async () => {
        const sort = config.sections.unpaid_debtors.sort;
        const clientNameExpression = "COALESCE(MAX(p.name), c.username)";
        const outstandingExpression = "COALESCE(SUM(t.outstanding_amount), 0)";
        const lastPaymentExpression = "MAX(t.last_payment_date)";
        const orderBy = sort === "last_payment_asc"
            ? `(${lastPaymentExpression} IS NULL) DESC, ${lastPaymentExpression} ASC, ${outstandingExpression} DESC`
            : sort === "name_asc"
                ? `${clientNameExpression} ASC, ${outstandingExpression} DESC`
                : `${outstandingExpression} DESC, ${lastPaymentExpression} ASC, ${clientNameExpression} ASC`;
        const [rows] = await pool.query(
            `SELECT c.username,
                    ${clientNameExpression} AS client_name,
                    ${outstandingExpression} AS outstanding_amount,
                    ${lastPaymentExpression} AS last_payment_date
             FROM clients c
             INNER JOIN profile p ON p.username = c.username AND LOWER(TRIM(p.user_type)) = 'client'
             LEFT JOIN (
                 SELECT movement.username,
                        SUM(movement.balance_amount) AS outstanding_amount,
                        MAX(movement.last_payment_date) AS last_payment_date
                 FROM (
                     SELECT t.party1_id AS username,
                            SUM(CASE
                                WHEN t.party2_type = 'client' THEN ABS(t.amount)
                                WHEN t.party1_type = 'client' THEN -ABS(t.amount)
                                ELSE 0
                            END) AS balance_amount,
                            MAX(CASE
                                WHEN t.party1_type = 'client'
                                 AND LOWER(COALESCE(t.transaction_type, '')) IN ('receive','received')
                                THEN t.transaction_date
                            END) AS last_payment_date
                     FROM transactions t
                     WHERE t.branch_id = ? AND t.party1_id IS NOT NULL
                     GROUP BY t.party1_id

                     UNION ALL

                     SELECT t.party2_id AS username,
                            SUM(CASE
                                WHEN t.party2_type = 'client' THEN ABS(t.amount)
                                WHEN t.party1_type = 'client' THEN -ABS(t.amount)
                                ELSE 0
                            END) AS balance_amount,
                            NULL AS last_payment_date
                     FROM transactions t
                     WHERE t.branch_id = ? AND t.party2_id IS NOT NULL
                       AND (t.party1_id IS NULL OR t.party1_id <> t.party2_id)
                     GROUP BY t.party2_id
                 ) movement
                 GROUP BY movement.username
             ) t ON t.username = c.username
             WHERE c.branch_id = ? AND c.user_type = 'client'
               AND (c.is_deleted = '0' OR c.is_deleted = 0)
             GROUP BY c.username
             HAVING ${outstandingExpression} > 0.02
                AND (${lastPaymentExpression} IS NULL OR DATE(${lastPaymentExpression}) < ?)
             ORDER BY ${orderBy}
             LIMIT ${MAX_DETAIL_ROWS}`,
            [branchId, branchId, branchId, cutoff]
        );
        sections.unpaid_debtors = { rows: filterRows(rows, filters).map((row) => ({
            username: row.username,
            client_name: row.client_name,
            outstanding_amount: number(row.outstanding_amount),
            last_payment_date: row.last_payment_date || null,
            days_since_payment: row.last_payment_date
                ? Math.max(0, Math.floor((dateFromUtc(meta.to_date) - dateFromUtc(dateOnly(row.last_payment_date))) / 86400000))
                : null,
        })) };
        totals.unpaid_debtors = sections.unpaid_debtors.rows.length;
    });

    if (enabled("due_tasks")) scheduleSection("due_tasks", async () => {
        const mode = config.sections.due_tasks.mode;
        const dateClause = mode === "due_in_period"
            ? "t.due_date >= ? AND t.due_date < ?"
            : "t.due_date < ?";
        const dateParams = mode === "due_in_period" ? [start, endExclusive] : [endExclusive];
        const [rows] = await pool.query(
            `SELECT t.task_id, t.username AS staff_username,
                    COALESCE(sp.name, t.username, 'Unassigned') AS staff_name,
                    t.firm_id, t.service_id, t.due_date, t.status,
                    DATEDIFF(?, DATE(t.due_date)) AS days_overdue
             FROM tasks t
             LEFT JOIN profile sp ON sp.username = t.username AND LOWER(TRIM(sp.user_type)) IN ('user','staff','admin')
             WHERE t.branch_id = ? AND ${dateClause}
               AND LOWER(COALESCE(t.status, '')) NOT IN ('complete','cancel','cancelled')
             ORDER BY t.due_date ASC, t.task_id ASC
             LIMIT ${MAX_DETAIL_ROWS}`,
            [meta.to_date, branchId, ...dateParams]
        );
        sections.due_tasks = { rows: filterRows(rows, filters).map((row) => ({
            task_id: row.task_id,
            staff_username: row.staff_username || null,
            staff_name: row.staff_name,
            firm_id: row.firm_id || null,
            service_id: row.service_id || null,
            due_date: row.due_date,
            status: row.status,
            days_overdue: integer(row.days_overdue),
        })) };
        totals.due_tasks = sections.due_tasks.rows.length;
    });

    if (enabled("clients_without_service")) scheduleSection("clients_without_service", async () => {
        const lastServiceExpression = "se.last_service_date";
        const latestServiceExpression = `MAX(${lastServiceExpression})`;
        const [rows] = await pool.query(
            `SELECT c.username,
                    COALESCE(MAX(p.name), c.username) AS client_name,
                    ${latestServiceExpression} AS last_service_date
             FROM clients c
             INNER JOIN profile p ON p.username = c.username AND LOWER(TRIM(p.user_type)) = 'client'
             LEFT JOIN (
                 SELECT party_id, MAX(sale_date) AS last_service_date
                 FROM sale_entries
                 WHERE branch_id = ? AND party_type = 'client'
                 GROUP BY party_id
             ) se ON se.party_id = c.username
             WHERE c.branch_id = ? AND c.user_type = 'client'
               AND (c.is_deleted = '0' OR c.is_deleted = 0)
             GROUP BY c.username
             HAVING ${latestServiceExpression} IS NULL OR ${latestServiceExpression} < ?
             ORDER BY (${latestServiceExpression} IS NULL) DESC, ${latestServiceExpression} ASC, client_name ASC
             LIMIT ${MAX_DETAIL_ROWS}`,
            [branchId, branchId, cutoff]
        );
        sections.clients_without_service = { rows: filterRows(rows, filters).map((row) => ({
            username: row.username,
            client_name: row.client_name,
            last_service_date: row.last_service_date || null,
        })) };
        totals.clients_without_service = sections.clients_without_service.rows.length;
    });

    const sectionWorkers = Array.from({ length: Math.min(4, sectionTasks.length) }, async () => {
        while (sectionTasks.length) {
            const task = sectionTasks.shift();
            await task();
        }
    });
    const [branchName] = await Promise.all([branchNamePromise, ...sectionWorkers]);
    if (process.env.EXECUTIVE_SUMMARY_PERF_LOGS === "1") {
        console.info("[executive-summary] report timings", JSON.stringify({
            section_ms: sectionTimings,
            total_ms: Math.round(performance.now() - reportStartedAt),
            rows: Object.fromEntries(Object.entries(sections).map(([key, section]) => [key, section.rows.length])),
        }));
    }
    for (const key of Object.keys(sections)) {
        sections[key].total_count = sections[key].rows.length;
    }

    return {
        meta: {
            branch_id: branchId,
            branch_name: branchName,
            period: meta,
            timezone: config.timezone,
            inactivity_days: Number(filters.inactivityDays ?? config.inactivity_days),
            due_tasks_mode: config.sections.due_tasks?.mode,
            generated_at: new Date().toISOString(),
        },
        totals,
        sections,
        filters: {
            staff_username: filters.staffUsername || null,
            search: filters.search || null,
        },
    };
}

function safeText(value) {
    return String(value ?? "-").replace(/\s+/g, " ").trim();
}

function money(value) {
    return `Rs. ${number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compactPdfAmount(value) {
    const amount = number(value);
    if (Math.abs(amount) >= 10000000) return `Rs.${(amount / 10000000).toFixed(1)}Cr`;
    if (Math.abs(amount) >= 100000) return `Rs.${(amount / 100000).toFixed(1)}L`;
    if (Math.abs(amount) >= 1000) return `Rs.${(amount / 1000).toFixed(1)}k`;
    return `Rs.${Math.round(amount)}`;
}

const PDF_CHART_COLORS = ["#4f46e5", "#0f766e", "#ea580c"];
const PDF_KPI_COLORS = [
    { background: "#eef2ff", accent: "#4f46e5", label: "#4338ca" },
    { background: "#ecfdf5", accent: "#0f766e", label: "#047857" },
    { background: "#fff7ed", accent: "#ea580c", label: "#c2410c" },
    { background: "#fdf2f8", accent: "#c026d3", label: "#a21caf" },
    { background: "#ecfeff", accent: "#0891b2", label: "#0e7490" },
    { background: "#fffbeb", accent: "#ca8a04", label: "#a16207" },
    { background: "#fff1f2", accent: "#be123c", label: "#be123c" },
    { background: "#f5f3ff", accent: "#7c3aed", label: "#6d28d9" },
];
const PDF_SECTION_STYLES = {
    "#4f46e5": { background: "#eef2ff", text: "#4338ca" },
    "#0f766e": { background: "#ecfdf5", text: "#047857" },
    "#ea580c": { background: "#fff7ed", text: "#c2410c" },
    "#c026d3": { background: "#fdf2f8", text: "#a21caf" },
    "#0891b2": { background: "#ecfeff", text: "#0e7490" },
    "#ca8a04": { background: "#fffbeb", text: "#a16207" },
    "#be123c": { background: "#fff1f2", text: "#be123c" },
    "#7c3aed": { background: "#f5f3ff", text: "#6d28d9" },
};

function staffChartRows(report, metrics) {
    const staff = new Map();
    for (const [sectionKey, sourceKey, targetKey] of metrics) {
        for (const source of report.sections[sectionKey]?.rows || []) {
            const key = source.username || source.staff_username || source.staff_name || "unassigned";
            const row = staff.get(key) || { staff_name: source.staff_name || "Unassigned" };
            row[targetKey] = (row[targetKey] || 0) + (sourceKey ? number(source[sourceKey]) : 1);
            staff.set(key, row);
        }
    }
    const keys = metrics.map(([, , targetKey]) => targetKey);
    const rows = [...staff.values()].sort((first, second) =>
        keys.reduce((total, key) => total + (second[key] || 0) - (first[key] || 0), 0)
    );
    if (rows.length <= 6) return rows;
    const remaining = rows.slice(5);
    return [
        ...rows.slice(0, 5),
        {
            staff_name: `Others (${remaining.length})`,
            ...Object.fromEntries(keys.map((key) => [key, remaining.reduce((sum, row) => sum + (row[key] || 0), 0)])),
        },
    ];
}

function drawPdfBarChart(doc, { x, y, width, title, rows, metrics }) {
    const height = 184;
    doc.save();
    doc.roundedRect(x, y, width, height, 8).fillAndStroke("#f8fafc", "#e2e8f0");
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(10)
        .text(title, x + 10, y + 10, { width: width - 20, lineBreak: false, ellipsis: true });

    let legendX = x + 10;
    const legendY = y + 29;
    for (const [index, metric] of metrics.entries()) {
        doc.roundedRect(legendX, legendY + 1, 5, 5, 2).fill(PDF_CHART_COLORS[index]);
        doc.fillColor("#475569").font("Helvetica").fontSize(6.5)
            .text(metric.label, legendX + 8, legendY, { lineBreak: false });
        legendX += 12 + metric.label.length * 3.5;
    }

    const chartTop = y + 55;
    const chartBottom = y + height - 10;
    const labelWidth = Math.min(72, width * 0.31);
    const chartX = x + labelWidth + 8;
    const chartWidth = width - labelWidth - 20;
    const maximum = Math.max(1, ...rows.flatMap((row) => metrics.map((metric) => number(row[metric.key]))));
    const rowHeight = rows.length ? (chartBottom - chartTop) / rows.length : 0;

    for (let tick = 0; tick <= 4; tick += 1) {
        const tickX = chartX + chartWidth * tick / 4;
        doc.moveTo(tickX, chartTop).lineTo(tickX, chartBottom).strokeColor("#e2e8f0").lineWidth(0.5).stroke();
        const tickValue = maximum * tick / 4;
        doc.fillColor("#64748b").font("Helvetica").fontSize(5.5)
            .text(metrics[0]?.format === "money" ? compactPdfAmount(tickValue) : Math.round(tickValue).toLocaleString("en-IN"), tickX - 16, chartTop - 10, {
                width: 32,
                align: "center",
                lineBreak: false,
            });
    }

    if (!rows.length) {
        doc.fillColor("#94a3b8").font("Helvetica").fontSize(7)
            .text("No data for this period", chartX, chartTop + 20, { width: chartWidth, align: "center" });
    }

    rows.forEach((row, rowIndex) => {
        const rowY = chartTop + rowHeight * rowIndex;
        doc.fillColor("#475569").font("Helvetica").fontSize(6.5)
            .text(safeText(row.staff_name), x + 8, rowY + rowHeight / 2 - 4, {
                width: labelWidth - 10,
                lineBreak: false,
                ellipsis: true,
            });
        metrics.forEach((metric, metricIndex) => {
            const barY = rowY + rowHeight * 0.17 + metricIndex * Math.min(4, rowHeight * 0.2);
            const barWidth = Math.max(0, chartWidth * number(row[metric.key]) / maximum);
            if (barWidth > 0) {
                doc.roundedRect(chartX, barY, Math.max(1.5, barWidth), 2.8, 1.2)
                    .fill(PDF_CHART_COLORS[metricIndex]);
            }
        });
    });
    doc.restore();
}

function buildPdfDashboard(doc, report, state) {
    const activity = staffChartRows(report, [
        ["tasks_completed", "completed_count", "completed"],
        ["new_tasks", "new_task_count", "new_tasks"],
        ["due_tasks", null, "due_tasks"],
    ]);
    const financial = staffChartRows(report, [
        ["sales", "sale_amount", "sales"],
        ["collections", "collection_amount", "collections"],
        ["expenses", "expense_amount", "expenses"],
    ]);
    const left = 42;
    const pageWidth = doc.page.width - 84;
    const gap = 10;
    const panelWidth = (pageWidth - gap) / 2;
    const chartHeight = 184;
    const followUpHeight = 91;
    const headerY = 42;
    const headerHeight = 62;
    const cardGap = 7;
    const cardWidth = (pageWidth - cardGap * 3) / 4;
    const cardHeight = 48;

    doc.save();
    doc.roundedRect(left, headerY, pageWidth, headerHeight, 10).fill("#1e3a8a");
    doc.roundedRect(left, headerY, 6, headerHeight, 3).fill("#818cf8");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(19)
        .text("Executive Summary", left + 17, headerY + 10, { width: pageWidth - 34, lineBreak: false });
    doc.fillColor("#dbeafe").font("Helvetica").fontSize(8)
        .text(`${safeText(report.meta.branch_name)}  ·  ${report.meta.period.from_date} to ${report.meta.period.to_date}  ·  ${safeText(report.meta.timezone)}`, left + 18, headerY + 39, {
            width: pageWidth - 36,
            lineBreak: false,
            ellipsis: true,
        });
    doc.restore();

    const cards = [
        ["Tasks completed", number(report.totals.tasks_completed)],
        ["New tasks", number(report.totals.new_tasks)],
        ["Sales", money(report.totals.sales)],
        ["Collections", money(report.totals.collections)],
        ["Expenses", money(report.totals.expenses)],
        ["Unpaid debtors", number(report.totals.unpaid_debtors)],
        ["Due tasks", number(report.totals.due_tasks)],
        ["No recent service", number(report.totals.clients_without_service)],
    ];
    const cardsY = headerY + headerHeight + 12;
    cards.forEach(([label, value], index) => {
        const column = index % 4;
        const row = Math.floor(index / 4);
        const x = left + column * (cardWidth + cardGap);
        const y = cardsY + row * (cardHeight + cardGap);
        const color = PDF_KPI_COLORS[index];
        doc.save();
        doc.roundedRect(x, y, cardWidth, cardHeight, 7).fillAndStroke(color.background, "#e2e8f0");
        doc.roundedRect(x, y, 4, cardHeight, 2).fill(color.accent);
        doc.fillColor(color.label).font("Helvetica-Bold").fontSize(7)
            .text(label.toUpperCase(), x + 9, y + 8, { width: cardWidth - 16, lineBreak: false, ellipsis: true });
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(9)
            .text(safeText(value), x + 9, y + 24, { width: cardWidth - 16, lineBreak: false, ellipsis: true });
        doc.restore();
    });

    state.y = cardsY + 2 * cardHeight + cardGap + 14;
    doc.fillColor("#1e293b").font("Helvetica-Bold").fontSize(13).text("Statistical overview", left, state.y);
    state.y += 21;
    drawPdfBarChart(doc, {
        x: left,
        y: state.y,
        width: panelWidth,
        title: "Staff activity",
        rows: activity,
        metrics: [
            { key: "completed", label: "Completed" },
            { key: "new_tasks", label: "New" },
            { key: "due_tasks", label: "Due" },
        ],
    });
    drawPdfBarChart(doc, {
        x: left + panelWidth + gap,
        y: state.y,
        width: panelWidth,
        title: "Financial performance",
        rows: financial,
        metrics: [
            { key: "sales", label: "Sales", format: "money" },
            { key: "collections", label: "Collections", format: "money" },
            { key: "expenses", label: "Expenses", format: "money" },
        ],
    });
    state.y += chartHeight + 10;

    const followUps = [
        ["Unpaid debtors", number(report.totals.unpaid_debtors), "#4f46e5"],
        ["Due tasks", number(report.totals.due_tasks), "#0f766e"],
        ["No recent service", number(report.totals.clients_without_service), "#ea580c"],
    ];
    const maxFollowUps = Math.max(1, ...followUps.map(([, value]) => value));
    const labelWidth = 116;
    const valueWidth = 44;
    const barX = left + labelWidth;
    const barWidth = pageWidth - labelWidth - valueWidth - 16;
    doc.save();
    doc.roundedRect(left, state.y, pageWidth, followUpHeight, 8).fillAndStroke("#fffbeb", "#f1e7c9");
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(9)
        .text("Client & task follow-up", left + 10, state.y + 9);
    followUps.forEach(([label, value, color], index) => {
        const rowY = state.y + 29 + index * 18;
        doc.fillColor("#475569").font("Helvetica").fontSize(7)
            .text(label, left + 10, rowY + 2, { width: labelWidth - 16, lineBreak: false });
        doc.roundedRect(barX, rowY, barWidth, 9, 4).fill("#f1f5f9");
        if (value > 0) {
            doc.roundedRect(barX, rowY, Math.max(3, barWidth * value / maxFollowUps), 9, 4).fill(color);
        }
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(7)
            .text(value.toLocaleString("en-IN"), barX + barWidth + 8, rowY + 1, { width: valueWidth, lineBreak: false });
    });
    doc.restore();
    state.y += followUpHeight + 14;
}

function buildPdfTable(doc, title, columns, rows, state, accent = "#4338ca") {
    const left = 42;
    const width = doc.page.width - 84;
    const rowHeight = 19;
    const headerHeight = 24;
    const sectionStyle = PDF_SECTION_STYLES[accent] || { background: "#eef2ff", text: accent };
    const ensure = (height) => {
        if (state.y + height <= doc.page.height - 48) return;
        doc.addPage();
        state.y = 42;
    };

    ensure(42);
    doc.save();
    const titleWidth = Math.min(width - 10, title.length * 5.8 + 18);
    doc.roundedRect(left, state.y - 2, titleWidth, 19, 6).fill(sectionStyle.background);
    doc.roundedRect(left, state.y - 2, 4, 19, 2).fill(accent);
    doc.fillColor(sectionStyle.text).font("Helvetica-Bold").fontSize(10).text(title, left + 10, state.y + 2, { lineBreak: false });
    doc.restore();
    state.y += 18;
    if (!rows.length) {
        doc.fillColor("#64748b").font("Helvetica").fontSize(9).text("No records to show.", left, state.y);
        state.y += 22;
        return;
    }

    const colWidth = width / columns.length;
    const drawHeader = () => {
        ensure(headerHeight + rowHeight);
        doc.roundedRect(left, state.y, width, headerHeight, 4).fill(accent);
        columns.forEach((column, index) => {
            doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5)
                .text(column.label, left + index * colWidth + 4, state.y + 7, { width: colWidth - 8, lineBreak: false });
        });
        state.y += headerHeight;
    };
    drawHeader();
    rows.forEach((row, rowIndex) => {
        ensure(rowHeight);
        if (state.y + rowHeight > doc.page.height - 48) drawHeader();
        if (rowIndex % 2 === 1) doc.rect(left, state.y, width, rowHeight).fill("#f8fafc");
        columns.forEach((column, index) => {
            const raw = typeof column.value === "function" ? column.value(row) : row[column.value];
            const emphasize = index === 0 || column.highlight === true;
            const cellX = left + index * colWidth + 3;
            const cellWidth = colWidth - 6;
            if (emphasize) {
                doc.save();
                doc.roundedRect(cellX, state.y + 3, cellWidth, rowHeight - 6, 4).fill(sectionStyle.background);
                doc.fillColor(sectionStyle.text).font("Helvetica-Bold").fontSize(7.5)
                    .text(safeText(raw), cellX + 4, state.y + 6, { width: cellWidth - 8, lineBreak: false, ellipsis: true });
                doc.restore();
            } else {
                doc.fillColor("#334155").font("Helvetica").fontSize(7.5)
                    .text(safeText(raw), left + index * colWidth + 4, state.y + 6, { width: colWidth - 8, lineBreak: false, ellipsis: true });
            }
        });
        state.y += rowHeight;
    });
    state.y += 12;
}

export async function buildExecutiveSummaryPdf(report) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 42, info: { Title: "Executive Summary" } });
        const chunks = [];
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const state = { y: 42 };
        const meta = report.meta;
        buildPdfDashboard(doc, report, state);

        doc.addPage();
        doc.save();
        doc.roundedRect(42, 42, doc.page.width - 84, 54, 8).fill("#1e3a8a");
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(15).text("Detailed report", 54, 51);
        doc.fillColor("#dbeafe").font("Helvetica").fontSize(8)
            .text(`${meta.branch_name}  ·  ${meta.period.from_date} to ${meta.period.to_date}`, 54, 76, {
                width: doc.page.width - 108,
                lineBreak: false,
                ellipsis: true,
            });
        doc.restore();
        state.y = 112;

        const definitions = [
            ["tasks_completed", "Tasks completed by staff", [{ label: "Staff", value: "staff_name" }, { label: "Completed", value: "completed_count", highlight: true }], "#4f46e5"],
            ["new_tasks", "New tasks", [{ label: "Staff", value: "staff_name" }, { label: "New tasks", value: "new_task_count", highlight: true }], "#0f766e"],
            ["sales", "Sales", [{ label: "Staff", value: "staff_name" }, { label: "Count", value: "sale_count", highlight: true }, { label: "Amount", value: (row) => money(row.sale_amount), highlight: true }], "#4f46e5"],
            ["collections", "Collections from debtors", [{ label: "Staff", value: "staff_name" }, { label: "Count", value: "collection_count", highlight: true }, { label: "Amount", value: (row) => money(row.collection_amount), highlight: true }], "#0f766e"],
            ["expenses", "Expenses", [{ label: "Staff", value: "staff_name" }, { label: "Count", value: "expense_count", highlight: true }, { label: "Amount", value: (row) => money(row.expense_amount), highlight: true }], "#ea580c"],
            ["unpaid_debtors", "Unpaid debtors", [{ label: "Client", value: "client_name" }, { label: "Outstanding", value: (row) => money(row.outstanding_amount), highlight: true }, { label: "Last payment", value: "last_payment_date" }], "#c026d3"],
            ["due_tasks", "Due tasks", [{ label: "Task", value: "task_id" }, { label: "Staff", value: "staff_name" }, { label: "Due date", value: "due_date" }, { label: "Status", value: "status" }], "#ca8a04"],
            ["clients_without_service", "Clients without recent service", [{ label: "Client", value: "client_name" }, { label: "Last service", value: "last_service_date" }], "#0891b2"],
        ];
        for (const [key, title, columns, accent] of definitions) {
            if (report.sections[key]) buildPdfTable(doc, title, columns, report.sections[key].rows || [], state, accent);
        }
        doc.end();
    });
}

async function ensureConfig(branchId, username = null) {
    const [rows] = await pool.query("SELECT * FROM executive_summary_configs WHERE branch_id = ? LIMIT 1", [branchId]);
    if (rows.length) return normalizeConfig(rows[0]);
    const configId = await UNIQUE_RANDOM_STRING("executive_summary_configs", "config_id", { prefix: "es_" });
    const config = normalizeConfig(null, { config_id: configId, branch_id: branchId });
    try {
        await pool.query(
            `INSERT INTO executive_summary_configs
             (config_id, branch_id, enabled, schedule_type, send_hour, send_minute, timezone,
              week_starts_on, inactivity_days, recipient_emails_json, sections_json, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [config.config_id, branchId, config.enabled ? 1 : 0, config.schedule_type, config.send_hour,
                config.send_minute, config.timezone, config.week_starts_on, config.inactivity_days,
                JSON.stringify(config.recipient_emails), JSON.stringify(config.sections), username, username]
        );
    } catch (error) {
        // GET /config and GET / can arrive together on first use. If both
        // observed no row, one insert wins and the other receives the branch
        // unique-key error. Re-read the winner instead of exposing a 500.
        if (error?.code !== "ER_DUP_ENTRY") throw error;
        const [existingRows] = await pool.query(
            "SELECT * FROM executive_summary_configs WHERE branch_id = ? LIMIT 1",
            [branchId]
        );
        if (existingRows.length) return normalizeConfig(existingRows[0]);
        throw error;
    }
    return config;
}

export async function getExecutiveSummaryConfig(branchId, username) {
    return ensureConfig(branchId, username);
}

export async function updateExecutiveSummaryConfig(branchId, username, payload = {}) {
    const current = await ensureConfig(branchId, username);
    if (payload.schedule_type !== undefined && !["weekly", "monthly"].includes(payload.schedule_type)) {
        throw httpError(400, "schedule_type must be weekly or monthly");
    }
    if (payload.timezone !== undefined) assertTimezone(payload.timezone);
    for (const [key, min, max] of [["send_hour", 0, 23], ["send_minute", 0, 59], ["week_starts_on", 0, 6], ["inactivity_days", 0, 3650]]) {
        if (payload[key] !== undefined && (!Number.isInteger(Number(payload[key])) || Number(payload[key]) < min || Number(payload[key]) > max)) {
            throw httpError(400, `${key} must be an integer from ${min} to ${max}`);
        }
    }
    const next = normalizeConfig({ ...current, ...payload, branch_id: branchId, config_id: current.config_id }, current);
    next.recipient_emails = validateEmails(payload.recipient_emails ?? next.recipient_emails, { required: next.enabled });
    if (next.enabled && next.recipient_emails.length === 0) throw httpError(400, "Add at least one recipient before enabling automated delivery");
    next.schedule_type = payload.schedule_type || next.schedule_type;
    next.timezone = payload.timezone ? assertTimezone(payload.timezone) : next.timezone;
    next.sections = normalizeSections(payload.sections ?? next.sections);
    await pool.query(
        `UPDATE executive_summary_configs
         SET enabled = ?, schedule_type = ?, send_hour = ?, send_minute = ?, timezone = ?,
             week_starts_on = ?, inactivity_days = ?, recipient_emails_json = ?, sections_json = ?,
             modify_by = ?, modify_date = NOW(), last_error = NULL
         WHERE branch_id = ? AND config_id = ?`,
        [next.enabled ? 1 : 0, next.schedule_type, next.send_hour, next.send_minute, next.timezone,
            next.week_starts_on, next.inactivity_days, JSON.stringify(next.recipient_emails), JSON.stringify(next.sections),
            username, branchId, current.config_id]
    );
    return getExecutiveSummaryConfig(branchId, username);
}

export async function getExecutiveSummary({ branchId, username, fromDate, toDate, filters = {} } = {}) {
    const config = await ensureConfig(branchId, username);
    const period = normalizePeriod({ fromDate, toDate, scheduleType: config.schedule_type, timezone: config.timezone, weekStartsOn: config.week_starts_on });
    const report = await fetchReport({ branchId, period, config, filters });
    return { ...report, config: { inactivity_days: config.inactivity_days, sections: config.sections } };
}

async function getActiveSmtpConfig(branchId) {
    const [rows] = await pool.query(
        `SELECT config_id FROM email_configs
         WHERE branch_id = ? AND status = 'active'
         ORDER BY is_default DESC, id ASC LIMIT 1`,
        [branchId]
    );
    if (!rows.length) throw httpError(400, "No active branch email configuration is available");
    return getConfigWithDecryptedPassword({ branch_id: branchId, config_id: rows[0].config_id });
}

async function createRun({ branchId, config, period, triggerType, username }) {
    const runId = await UNIQUE_RANDOM_STRING("executive_summary_runs", "run_id", { prefix: "esr_" });
    const periodInfo = periodMeta(period, config.inactivity_days);
    const idempotencyKey = triggerType === "scheduled"
        ? `${branchId}:${periodInfo.period_key}:scheduled`
        : `${branchId}:${periodInfo.period_key}:${triggerType}:${runId}`;
    try {
        await pool.query(
            `INSERT INTO executive_summary_runs
             (run_id, config_id, branch_id, period_start, period_end, inactivity_cutoff_date,
              period_key, idempotency_key, trigger_type, status, recipient_emails_json,
              sections_json, effective_config_json, create_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
            [runId, config.config_id, branchId, period.start, period.end, periodInfo.inactivity_cutoff_date,
                periodInfo.period_key, idempotencyKey, triggerType, JSON.stringify(config.recipient_emails),
                JSON.stringify(config.sections), JSON.stringify(config), username]
        );
        return { run_id: runId, created: true };
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY" && triggerType === "scheduled") {
            const [existingRows] = await pool.query(
                "SELECT run_id, status FROM executive_summary_runs WHERE idempotency_key = ? LIMIT 1",
                [idempotencyKey]
            );
            const existing = existingRows[0];
            if (!existing || ["sent", "generating", "queued", "downloaded"].includes(existing.status)) {
                return { created: false, skipped: true };
            }
            await pool.query(
                `UPDATE executive_summary_runs
                 SET status = 'queued', error_message = NULL, finished_at = NULL
                 WHERE run_id = ? AND status = 'failed'`,
                [existing.run_id]
            );
            return { run_id: existing.run_id, created: true, retry: true };
        }
        throw error;
    }
}

export async function runExecutiveSummary({ branchId, username, period, triggerType = "manual", sendEmail = true, config: passedConfig = null } = {}) {
    const config = passedConfig || await ensureConfig(branchId, username);
    const actualPeriod = period || normalizePeriod({ scheduleType: config.schedule_type, timezone: config.timezone, weekStartsOn: config.week_starts_on });
    const run = await createRun({ branchId, config, period: actualPeriod, triggerType, username });
    if (run.skipped) return { skipped: true, period: actualPeriod };

    await pool.query("UPDATE executive_summary_runs SET status = 'generating', started_at = NOW(), attempt_count = attempt_count + 1 WHERE run_id = ?", [run.run_id]);
    try {
        const report = await fetchReport({ branchId, period: actualPeriod, config });
        const pdf = await buildExecutiveSummaryPdf(report);
        const filename = `executive-summary-${actualPeriod.start}-to-${actualPeriod.end}.pdf`;
        let messageId = null;
        if (sendEmail) {
            const recipients = validateEmails(config.recipient_emails, { required: true });
            const smtp = await getActiveSmtpConfig(branchId);
            const transporter = nodemailer.createTransport({
                host: smtp.host,
                port: Number(smtp.port),
                secure: Number(smtp.secure) === 1 || Number(smtp.port) === 465,
                auth: { user: smtp.username, pass: smtp.password },
            });
            const result = await transporter.sendMail({
                from: smtp.from_name ? `${smtp.from_name} <${smtp.from_email}>` : smtp.from_email,
                to: recipients,
                replyTo: smtp.reply_to || undefined,
                subject: `Executive Summary: ${actualPeriod.start} to ${actualPeriod.end}`,
                text: `Attached is the OOMS Executive Summary for ${actualPeriod.start} to ${actualPeriod.end}.`,
                attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
            });
            transporter.close();
            messageId = result?.messageId || null;
        }
        await pool.query(
            `UPDATE executive_summary_runs
             SET status = ?, pdf_filename = ?, pdf_size_bytes = ?, message_id = ?, finished_at = NOW(), error_message = NULL
             WHERE run_id = ?`,
            [sendEmail ? "sent" : "downloaded", filename, pdf.length, messageId, run.run_id]
        );
        await pool.query(
            `UPDATE executive_summary_configs
             SET last_successful_period_key = ?, last_attempt_at = NOW(), last_success_at = NOW(), last_error = NULL
             WHERE branch_id = ?`,
            [`${actualPeriod.start}:${actualPeriod.end}`, branchId]
        );
        return { run_id: run.run_id, status: sendEmail ? "sent" : "downloaded", filename, pdf, report };
    } catch (error) {
        await pool.query(
            "UPDATE executive_summary_runs SET status = 'failed', error_message = ?, finished_at = NOW() WHERE run_id = ?",
            [String(error.message || "Executive Summary delivery failed").slice(0, 2000), run.run_id]
        );
        await pool.query("UPDATE executive_summary_configs SET last_attempt_at = NOW(), last_error = ? WHERE branch_id = ?", [String(error.message || "Delivery failed").slice(0, 2000), branchId]);
        error.runId = run.run_id;
        throw error;
    }
}

export async function listExecutiveSummaryRuns(branchId, { page = 1, limit = 20 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;
    const [[countRow]] = await pool.query("SELECT COUNT(*) AS total FROM executive_summary_runs WHERE branch_id = ?", [branchId]);
    const [rows] = await pool.query(
        `SELECT run_id, period_start, period_end, inactivity_cutoff_date, trigger_type, status,
                pdf_filename, pdf_size_bytes, message_id, attempt_count, error_message,
                started_at, finished_at, create_date
         FROM executive_summary_runs WHERE branch_id = ?
         ORDER BY create_date DESC, id DESC LIMIT ? OFFSET ?`,
        [branchId, safeLimit, offset]
    );
    return { rows, pagination: { page: safePage, limit: safeLimit, total: integer(countRow?.total) } };
}

export async function getExecutiveSummaryRun(branchId, runId) {
    const [rows] = await pool.query("SELECT * FROM executive_summary_runs WHERE branch_id = ? AND run_id = ? LIMIT 1", [branchId, runId]);
    if (!rows.length) throw httpError(404, "Executive Summary run not found");
    const row = rows[0];
    return {
        ...row,
        effective_config: parseJson(row.effective_config_json, {}),
        sections: normalizeSections(parseJson(row.sections_json, {})),
        recipient_emails: normalizeEmails(parseJson(row.recipient_emails_json, [])),
    };
}

export async function buildRunPdf(branchId, runId) {
    const run = await getExecutiveSummaryRun(branchId, runId);
    const config = normalizeConfig(run.effective_config, { branch_id: branchId, config_id: run.config_id });
    const report = await fetchReport({ branchId, period: { start: String(run.period_start).slice(0, 10), end: String(run.period_end).slice(0, 10) }, config });
    return { pdf: await buildExecutiveSummaryPdf(report), filename: run.pdf_filename || `executive-summary-${run.period_start}-to-${run.period_end}.pdf` };
}

export async function processDueExecutiveSummarySchedules() {
    const [configs] = await pool.query("SELECT * FROM executive_summary_configs WHERE enabled = 1 ORDER BY id ASC");
    const results = [];
    for (const row of configs) {
        const config = normalizeConfig(row);
        if (!isScheduleDue(config)) continue;
        const period = normalizePeriod({ scheduleType: config.schedule_type, timezone: config.timezone, weekStartsOn: config.week_starts_on });
        try {
            results.push(await runExecutiveSummary({ branchId: config.branch_id, username: config.modify_by || config.create_by, period, triggerType: "scheduled", sendEmail: true, config }));
        } catch (error) {
            results.push({ branch_id: config.branch_id, status: "failed", error: error.message });
        }
    }
    return results;
}

export { normalizePeriod, normalizeConfig, normalizeSections, periodMeta };
