import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { RANDOM_STRING, SINGLE_FIRM_DATA, SINGLE_SERVICE_DATA, SINGLE_TASK_STAFF_LIST, USER_SNIPPED_DATA } from "../helpers/function.js";
import {
    formatMySqlDate,
    getPeriodDueDate,
    getPeriodStartDate,
    normalizeFinancialYear,
    parseComplianceEffectiveFrom,
    isCompliancePeriodOnOrAfterEffective,
    formatComplianceEffectiveFromHint,
    getPeriodsForFrequency,
    getFinancialYearForDate,
    filterSchedulesByRecurringRules,
    getCompliancePeriodOptions,
    isYearlyComplianceFrequency,
    resolveCompliancePeriodInput,
    normalizeComplianceFrequency,
} from "../helpers/recurringTaskHelper.js";
import { notifyTaskCompletedEmail } from "../helpers/taskStaticEmail.js";
import { notifyTaskCompletedWhatsapp } from "../helpers/whatsappNotification.js";

const router = express.Router();

const COMPLIANCE_TASK_STATUSES = [
    "in process",
    "pending from client",
    "pending from department",
    "complete",
    "cancel",
];

function parseServiceId(value) {
    const service_id = value != null ? String(value).trim() : "";
    return service_id || null;
}

function parseFirmId(value) {
    const firm_id = value != null ? String(value).trim() : "";
    return firm_id || null;
}

function parseRequiredText(value, fieldName) {
    const text = value != null ? String(value).trim() : "";
    return text || { error: `${fieldName} is required` };
}

function parseComplianceStatus(value) {
    const status = value != null ? String(value).trim() : "";
    if (!status) {
        return { error: "status is required" };
    }
    if (!COMPLIANCE_TASK_STATUSES.includes(status)) {
        return {
            error: `status must be one of: ${COMPLIANCE_TASK_STATUSES.join(", ")}`,
        };
    }
    return { status };
}

function splitCsvFirst(value) {
    if (value == null || value === "") return null;
    const first = String(value)
        .split(",")
        .map((item) => item.trim())
        .find(Boolean);
    return first || null;
}

function splitCsvList(value) {
    if (value == null || value === "") return [];
    return String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

async function loadComplianceService(branch_id, serviceId) {
    const [serviceRows] = await pool.query(
        `SELECT service_id, name, type, frequency
         FROM services
         WHERE service_id = ?
         LIMIT 1`,
        [serviceId]
    );
    if (!serviceRows.length) {
        return { error: { status: 404, message: "Service not found" } };
    }
    if (serviceRows[0].type !== "compliance") {
        return {
            error: {
                status: 400,
                message: "service_id must belong to a compliance service",
            },
        };
    }

    const [branchServiceRows] = await pool.query(
        `SELECT id
         FROM branch_services
         WHERE branch_id = ?
           AND service_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id, serviceId]
    );
    if (!branchServiceRows.length) {
        return {
            error: {
                status: 400,
                message: "Service is not added to this branch. Add it to branch_services first.",
            },
        };
    }

    return { service: serviceRows[0] };
}

async function loadComplianceFirm(branch_id, serviceId, firmId) {
    const [complianceFirmRows] = await pool.query(
        `SELECT *
         FROM compliance_firms
         WHERE branch_id = ?
           AND service_id = ?
           AND firm_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id, serviceId, firmId]
    );
    if (!complianceFirmRows.length) {
        return {
            error: {
                status: 404,
                message: "Firm is not added to this compliance service",
            },
        };
    }
    return { complianceFirm: complianceFirmRows[0] };
}

function buildComplianceTaskDueDate(complianceYear, compliancePeriod, dueDay) {
    const normalizedYear = normalizeFinancialYear(complianceYear);
    const dueDate = getPeriodDueDate(compliancePeriod, normalizedYear, dueDay);
    return formatMySqlDate(dueDate);
}

async function insertTaskStaffs(conn, branch_id, task_id, staffsCsv, createdBy) {
    const staffIds = splitCsvList(staffsCsv);
    for (const staffId of staffIds) {
        await conn.query(
            `INSERT INTO task_staffs (branch_id, assign_id, task_id, username, create_by)
             VALUES (?, ?, ?, ?, ?)`,
            [branch_id, RANDOM_STRING(30), task_id, staffId, createdBy]
        );
    }
}

async function applyComplianceTaskStatus(conn, {
    branch_id,
    task_id,
    statusVal,
    username,
    previousStatus,
}) {
    if (previousStatus === "complete" && statusVal !== "complete") {
        return {
            error: {
                status: 400,
                message: "Cannot change status of a task that is already complete",
            },
        };
    }

    if (statusVal === "complete") {
        await conn.query(
            `UPDATE tasks
             SET status = ?, complete_date = ?, complete_by = ?
             WHERE branch_id = ? AND task_id = ?`,
            [statusVal, new Date(), username || null, branch_id, task_id]
        );
    } else if (statusVal === "cancel") {
        await conn.query(
            `UPDATE tasks
             SET status = ?, cancelled_date = ?, cancelled_by = ?
             WHERE branch_id = ? AND task_id = ?`,
            [statusVal, new Date(), username || null, branch_id, task_id]
        );
    } else {
        await conn.query(
            `UPDATE tasks
             SET status = ?
             WHERE branch_id = ? AND task_id = ?`,
            [statusVal, branch_id, task_id]
        );
    }

    if (previousStatus !== statusVal) {
        await conn.query(
            `INSERT INTO task_status (branch_id, task_id, create_by, status)
             VALUES (?, ?, ?, ?)`,
            [branch_id, task_id, username, statusVal]
        );
    }

    if (statusVal === "complete" && previousStatus !== "complete") {
        notifyTaskCompletedEmail({
            branch_id,
            task_id,
            completed_by: username || "system",
        });
        notifyTaskCompletedWhatsapp({
            branch_id,
            task_id,
            completed_by: username || "system",
        });
    }

    return { changed: previousStatus !== statusVal };
}

function parseDueDate(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    const dueDate = Number(value);
    if (!Number.isInteger(dueDate) || dueDate < 1 || dueDate > 31) {
        return null;
    }
    return dueDate;
}

function parseFeesTax(fees, tax_rate) {
    const feesNum = Number(fees);
    const taxRateNum = Number(tax_rate);

    if (Number.isNaN(feesNum) || feesNum < 0) {
        return { error: "fees must be a valid non-negative number" };
    }
    if (Number.isNaN(taxRateNum) || taxRateNum < 0) {
        return { error: "tax_rate must be a valid non-negative number" };
    }

    const tax_value = Number(((feesNum * taxRateNum) / 100).toFixed(2));
    return { feesNum, taxRateNum, tax_value };
}

function normalizeCommaSeparated(value) {
    if (value == null || value === "") {
        return null;
    }
    if (Array.isArray(value)) {
        const items = value.map((item) => String(item).trim()).filter(Boolean);
        return items.length ? items.join(",") : null;
    }
    const text = String(value).trim();
    return text || null;
}

function csvFieldMatches(columnRef, username) {
    const value = username != null ? String(username).trim() : "";
    if (!value) return null;
    return `(CONCAT(',', ${columnRef}, ',') LIKE CONCAT('%,', ?, ',%'))`;
}

function parseListPagination(query) {
    const pageNum = Math.max(1, parseInt(query?.page_no ?? query?.page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(query?.limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;
    return { pageNum, limitNum, offset };
}

function formatDateOnly(value) {
    if (value == null) return null;
    if (value instanceof Date) {
        return value.toISOString().split("T")[0];
    }
    return String(value).split("T")[0];
}

function normalizeInUser(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

async function resolveAssignedStaffList(task, staffsCsv) {
    if (task?.task_id) {
        return SINGLE_TASK_STAFF_LIST(task.task_id);
    }

    const usernames = splitCsvList(staffsCsv);
    const list = [];

    for (const staffUsername of usernames) {
        const profile = await USER_SNIPPED_DATA(staffUsername);
        if (!profile) continue;

        list.push({
            assign_id: null,
            name: profile.name ?? null,
            username: profile.username ?? staffUsername,
            mobile: profile.mobile ?? null,
            country_code: profile.country_code ?? null,
            email: profile.email ?? null,
        });
    }

    return list;
}

async function formatComplianceTaskListRow(row, task) {
    const computedDueDate = buildComplianceTaskDueDate(
        row.compliance_year,
        row.compliance_period,
        row.due_date
    );

    const clientUsername = task?.username ?? row.username ?? null;
    const create_by = task?.create_by ? await USER_SNIPPED_DATA(task.create_by) : null;
    const modify_by = task?.create_by
        ? await USER_SNIPPED_DATA(task.create_by)
        : null;
    const client_profile = clientUsername ? await USER_SNIPPED_DATA(clientUsername) : null;
    const firm_data = await SINGLE_FIRM_DATA(row.firm_id);
    const service_data = await SINGLE_SERVICE_DATA(row.service_id);

    const fees = Number(task?.fees ?? row.fees) || 0;
    const tax_rate = Number(task?.tax_rate ?? row.tax_rate) || 0;
    const tax_value = Number(task?.tax_value ?? row.tax_value) || 0;
    const total =
        Number(task?.total) ||
        Number((fees + tax_value).toFixed(2)) ||
        0;

    const caId = task?.ca_id ?? splitCsvFirst(row.ca);
    const agentId = task?.agent_id ?? splitCsvFirst(row.agent);
    const has_ca = task ? task.has_ca === "1" : Boolean(caId);
    const has_agent = task ? task.has_agent === "1" : Boolean(agentId);

    const dueDate = task?.due_date ?? computedDueDate;
    const targetDate = task?.target_date ?? dueDate;

    const object = {
        task_id: task?.task_id ?? null,
        client: {
            username: clientUsername,
            profile: client_profile,
        },
        firm: {
            firm_id: firm_data?.firm_id ?? row.firm_id,
            firm_name: firm_data?.firm_name ?? row.firm_name ?? null,
            firm_type: firm_data?.firm_type ?? null,
        },
        service: {
            service_id: service_data?.service_id ?? row.service_id,
            name: service_data?.name ?? row.service_name ?? null,
        },
        charges: {
            fees,
            tax_rate,
            tax_value,
            total,
        },
        dates: {
            due_date: dueDate,
            create_date: task?.create_date ?? null,
            target_date: targetDate,
        },
        compliance_year: row.compliance_year,
        compliance_period: isYearlyComplianceFrequency(row.frequency)
            ? null
            : row.compliance_period,
        billing_status: task
            ? task.billing_status == "0"
                ? "pending"
                : task.billing_status == "1"
                    ? "complete"
                    : "non billable"
            : null,
        status: task?.status ?? null,
        create_by,
        modify_by,
        is_recurring: task ? task.is_recurring === "1" : true,
        staffs: task?.task_id
            ? await SINGLE_TASK_STAFF_LIST(task.task_id)
            : await resolveAssignedStaffList(null, row.staffs),
        has_ca,
        has_agent,
    };

    if (has_ca) {
        object.ca = await USER_SNIPPED_DATA(caId);
    }
    if (has_agent) {
        object.agent = await USER_SNIPPED_DATA(agentId);
    }

    const inUser = normalizeInUser(task?.in_user);
    object.in_user = inUser ? await USER_SNIPPED_DATA(inUser) : null;

    return object;
}

function formatComplianceFirmRow(row) {
    const staffs = splitCsvList(row.staffs);
    const caList = splitCsvList(row.ca);
    const agentList = splitCsvList(row.agent);

    return {
        id: row.id,
        branch_id: row.branch_id,
        service_id: row.service_id,
        service_name: row.service_name ?? null,
        firm_id: row.firm_id,
        firm_name: row.firm_name ?? null,
        username: row.username ?? null,
        client: {
            username: row.username ?? null,
            name: row.client_name ?? null,
            mobile: row.client_mobile ?? null,
            email: row.client_email ?? null,
        },
        fees: row.fees != null ? Number(row.fees) : 0,
        tax_rate: row.tax_rate != null ? Number(row.tax_rate) : 0,
        tax_value: row.tax_value != null ? Number(row.tax_value) : 0,
        due_date: row.due_date != null ? Number(row.due_date) : null,
        effective_from: row.effective_from ?? null,
        frequency: row.frequency ?? null,
        staffs,
        staffs_csv: row.staffs ?? null,
        ca: caList,
        ca_csv: row.ca ?? null,
        agent: agentList,
        agent_csv: row.agent ?? null,
        create_date: row.create_date,
        create_by: row.create_by ?? null,
        modify_date: row.modify_date,
        modify_by: row.modify_by ?? null,
    };
}

const COMPLIANCE_FIRM_SELECT = `
    cf.id,
    cf.branch_id,
    cf.service_id,
    cf.username,
    cf.firm_id,
    cf.fees,
    cf.tax_rate,
    cf.tax_value,
    cf.staffs,
    cf.ca,
    cf.agent,
    cf.due_date,
    cf.effective_from,
    cf.create_date,
    cf.create_by,
    cf.modify_date,
    cf.modify_by,
    s.name AS service_name,
    s.frequency,
    f.firm_name,
    p.name AS client_name,
    p.mobile AS client_mobile,
    p.email AS client_email
`;

const COMPLIANCE_FIRM_JOINS = `
    FROM compliance_firms cf
    INNER JOIN services s ON s.service_id = cf.service_id
    INNER JOIN firms f
        ON f.firm_id = cf.firm_id
       AND f.branch_id = cf.branch_id
       AND f.is_deleted = '0'
    LEFT JOIN profile p
        ON p.username = f.username
       AND p.id = (
           SELECT MAX(p2.id)
           FROM profile p2
           WHERE p2.username = f.username
       )
`;

async function loadComplianceFirmRecord(branch_id, { id, serviceId, firmId }) {
    const recordId = id != null ? Number(id) : null;
    const hasRecordId = recordId != null && !Number.isNaN(recordId) && recordId > 0;
    const hasPair = serviceId && firmId;

    if (!hasRecordId && !hasPair) {
        return {
            error: {
                status: 400,
                message: "Provide id or both service_id and firm_id",
            },
        };
    }

    const where = ["cf.branch_id = ?", "cf.is_deleted = '0'"];
    const params = [branch_id];

    if (hasRecordId) {
        where.push("cf.id = ?");
        params.push(recordId);
    } else {
        where.push("cf.service_id = ?", "cf.firm_id = ?");
        params.push(serviceId, firmId);
    }

    const [rows] = await pool.query(
        `SELECT ${COMPLIANCE_FIRM_SELECT}
         ${COMPLIANCE_FIRM_JOINS}
         WHERE ${where.join(" AND ")}
         LIMIT 1`,
        params
    );

    if (!rows.length) {
        return {
            error: {
                status: 404,
                message: "Compliance firm record not found",
            },
        };
    }

    return { row: rows[0] };
}

async function findActiveComplianceFirmMapping(branch_id, serviceId, firmId, excludeId = null) {
    const params = [branch_id, serviceId, firmId];
    let sql = `SELECT id
               FROM compliance_firms
               WHERE branch_id = ?
                 AND service_id = ?
                 AND firm_id = ?
                 AND is_deleted = '0'`;
    if (excludeId != null) {
        sql += ` AND id != ?`;
        params.push(excludeId);
    }
    sql += ` LIMIT 1`;
    const [rows] = await pool.query(sql, params);
    return rows.length ? rows[0] : null;
}

function buildComplianceFirmFilters(query, branch_id) {
    const {
        service_id,
        firm_id,
        username,
        staff,
        ca,
        agent,
        search,
        effective_from,
    } = query || {};

    const where = ["cf.branch_id = ?", "cf.is_deleted = '0'", "s.type = 'compliance'"];
    const params = [branch_id];

    const serviceId = parseServiceId(service_id);
    if (serviceId) {
        where.push("cf.service_id = ?");
        params.push(serviceId);
    }

    const firmId = parseFirmId(firm_id);
    if (firmId) {
        where.push("cf.firm_id = ?");
        params.push(firmId);
    }

    const clientUsername = username != null ? String(username).trim() : "";
    if (clientUsername) {
        where.push("(cf.username = ? OR f.username = ?)");
        params.push(clientUsername, clientUsername);
    }

    const staffUsername = staff != null ? String(staff).trim() : "";
    if (staffUsername) {
        where.push(csvFieldMatches("cf.staffs", staffUsername));
        params.push(staffUsername);
    }

    const caUsername = ca != null ? String(ca).trim() : "";
    if (caUsername) {
        where.push(csvFieldMatches("cf.ca", caUsername));
        params.push(caUsername);
    }

    const agentUsername = agent != null ? String(agent).trim() : "";
    if (agentUsername) {
        where.push(csvFieldMatches("cf.agent", agentUsername));
        params.push(agentUsername);
    }

    const effectiveFrom = effective_from != null ? String(effective_from).trim() : "";
    if (effectiveFrom) {
        where.push("cf.effective_from = ?");
        params.push(effectiveFrom);
    }

    if (search != null && String(search).trim() !== "") {
        const searchPattern = `%${String(search).trim()}%`;
        where.push(`(
            cf.service_id LIKE ?
            OR cf.firm_id LIKE ?
            OR cf.username LIKE ?
            OR cf.staffs LIKE ?
            OR cf.ca LIKE ?
            OR cf.agent LIKE ?
            OR cf.effective_from LIKE ?
            OR f.firm_name LIKE ?
            OR f.username LIKE ?
            OR f.pan_no LIKE ?
            OR f.gst_no LIKE ?
            OR s.name LIKE ?
            OR p.name LIKE ?
            OR p.mobile LIKE ?
            OR p.email LIKE ?
        )`);
        params.push(
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern
        );
    }

    return { whereClause: where.join(" AND "), params };
}

function buildComplianceTaskFilters(query, branch_id, { complianceYear, compliancePeriod }) {
    const { service_id, firm_id, username, search, ca, agent } = query || {};

    const where = [
        "t.branch_id = ?",
        "t.task_type = 'compliance'",
        "s.type = 'compliance'",
    ];
    const params = [branch_id];

    const serviceId = parseServiceId(service_id);
    if (serviceId) {
        where.push("t.service_id = ?");
        params.push(serviceId);
    }

    const firmId = parseFirmId(firm_id);
    if (firmId) {
        where.push("t.firm_id = ?");
        params.push(firmId);
    }

    const clientUsername = username != null ? String(username).trim() : "";
    if (clientUsername) {
        where.push("(t.username = ? OR f.username = ?)");
        params.push(clientUsername, clientUsername);
    }

    const caUsername = ca != null ? String(ca).trim() : "";
    if (caUsername) {
        where.push("t.ca_id = ?");
        params.push(caUsername);
    }

    const agentUsername = agent != null ? String(agent).trim() : "";
    if (agentUsername) {
        where.push("t.agent_id = ?");
        params.push(agentUsername);
    }

    if (complianceYear) {
        where.push("t.compliance_year = ?");
        params.push(complianceYear);
    }

    if (compliancePeriod) {
        where.push("t.compliance_period = ?");
        params.push(compliancePeriod);
    }

    if (search != null && String(search).trim() !== "") {
        const searchPattern = `%${String(search).trim()}%`;
        where.push(`(
            t.service_id LIKE ?
            OR t.firm_id LIKE ?
            OR t.username LIKE ?
            OR t.ca_id LIKE ?
            OR t.agent_id LIKE ?
            OR f.firm_name LIKE ?
            OR f.username LIKE ?
            OR f.pan_no LIKE ?
            OR f.gst_no LIKE ?
            OR s.name LIKE ?
            OR p.name LIKE ?
            OR p.mobile LIKE ?
            OR p.email LIKE ?
        )`);
        params.push(
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern
        );
    }

    return { whereClause: where.join(" AND "), params };
}

async function fetchExistingComplianceTaskRows(branch_id, query, { complianceYear, compliancePeriod }) {
    const { whereClause, params } = buildComplianceTaskFilters(query, branch_id, {
        complianceYear,
        compliancePeriod,
    });

    const [tasks] = await pool.query(
        `SELECT t.branch_id,
                t.service_id,
                t.firm_id,
                t.username,
                t.fees,
                t.tax_rate,
                t.tax_value,
                t.compliance_year,
                t.compliance_period,
                t.create_date,
                t.ca_id AS ca,
                t.agent_id AS agent,
                s.name AS service_name,
                s.frequency,
                f.firm_name
         FROM tasks t
         INNER JOIN services s ON s.service_id = t.service_id
         INNER JOIN firms f
            ON f.firm_id = t.firm_id
           AND f.branch_id = t.branch_id
           AND f.is_deleted = '0'
         LEFT JOIN profile p
            ON p.username = f.username
           AND p.id = (
               SELECT MAX(p2.id)
               FROM profile p2
               WHERE p2.username = f.username
           )
         WHERE ${whereClause}`,
        params
    );

    return tasks.map((task) => ({
        ...task,
        due_date: null,
        staffs: null,
        effective_from: null,
        period_name: task.compliance_period,
        financial_year: task.compliance_year,
    }));
}

function mergeComplianceTaskListRows(expandedRows, existingTaskRows) {
    const keys = new Set(expandedRows.map(getComplianceTaskLookupKey));
    const merged = [...expandedRows];

    for (const row of existingTaskRows) {
        const key = getComplianceTaskLookupKey(row);
        if (!keys.has(key)) {
            keys.add(key);
            merged.push(row);
        }
    }

    return merged;
}

function expandComplianceFirmPeriods(firmRows, { complianceYear, compliancePeriod }) {
    const now = new Date();
    const targetYear = complianceYear
        ? normalizeFinancialYear(complianceYear)
        : getFinancialYearForDate(now);
    const currentFy = getFinancialYearForDate(now);
    const explicitPeriod = compliancePeriod != null ? String(compliancePeriod).trim() : "";
    const expanded = [];

    for (const firm of firmRows) {
        const isYearly = isYearlyComplianceFrequency(firm.frequency);
        const periods = isYearly
            ? ["Annual"]
            : explicitPeriod
                ? [explicitPeriod]
                : getPeriodsForFrequency(firm.frequency);

        for (const period of periods) {
            if (
                !isCompliancePeriodOnOrAfterEffective(
                    targetYear,
                    period,
                    firm.effective_from,
                    firm.frequency
                )
            ) {
                continue;
            }

            expanded.push({
                ...firm,
                compliance_year: targetYear,
                compliance_period: period,
                period_name: period,
                financial_year: targetYear,
                create_date: firm.create_date,
            });
        }
    }

    if (!explicitPeriod && targetYear === currentFy) {
        return filterSchedulesByRecurringRules(expanded, now);
    }

    return expanded;
}

function getComplianceTaskLookupKey(row) {
    const period = isYearlyComplianceFrequency(row.frequency) ? "Annual" : row.compliance_period;
    return `${row.service_id}|${row.firm_id}|${row.compliance_year}|${period}`;
}

function sortComplianceTaskListRows(rows) {
    return rows.sort((a, b) => {
        const yearCompare = String(b.compliance_year).localeCompare(String(a.compliance_year));
        if (yearCompare !== 0) return yearCompare;

        const periodStartA = getPeriodStartDate(a.compliance_period, a.compliance_year);
        const periodStartB = getPeriodStartDate(b.compliance_period, b.compliance_year);
        const periodCompare = periodStartB - periodStartA;
        if (periodCompare !== 0) return periodCompare;

        return String(a.firm_name || a.firm_id).localeCompare(String(b.firm_name || b.firm_id));
    });
}

async function fetchComplianceTasksMap(branch_id, rows) {
    if (!rows.length) return new Map();

    const serviceIds = [...new Set(rows.map((row) => row.service_id))];
    const firmIds = [...new Set(rows.map((row) => row.firm_id))];
    const years = [...new Set(rows.map((row) => row.compliance_year))];

    const [tasks] = await pool.query(
        `SELECT task_id, service_id, firm_id, compliance_year, compliance_period, username,
                fees, tax_rate, tax_value, total, status, due_date, target_date,
                complete_date, complete_by, create_date, create_by, in_user,
                billing_status, has_ca, ca_id, has_agent, agent_id, is_recurring
         FROM tasks
         WHERE branch_id = ?
           AND task_type = 'compliance'
           AND service_id IN (?)
           AND firm_id IN (?)
           AND compliance_year IN (?)`,
        [branch_id, serviceIds, firmIds, years]
    );

    const taskMap = new Map();
    for (const task of tasks) {
        const key = `${task.service_id}|${task.firm_id}|${task.compliance_year}|${task.compliance_period}`;
        taskMap.set(key, task);
    }
    return taskMap;
}

router.post("/add-firm", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const createdBy = req.headers["username"] || req.headers["Username"] || "";
        const {
            service_id,
            firm_id,
            fees,
            tax_rate,
            due_date,
            effective_from,
            staffs,
            ca,
            agent,
        } = req.body || {};

        const serviceId = parseServiceId(service_id);
        const firmId = parseFirmId(firm_id);

        if (!serviceId) {
            return res.status(400).json({ success: false, message: "service_id is required" });
        }
        if (!firmId) {
            return res.status(400).json({ success: false, message: "firm_id is required" });
        }
        if (fees == null || fees === "") {
            return res.status(400).json({ success: false, message: "fees is required" });
        }
        if (tax_rate == null || tax_rate === "") {
            return res.status(400).json({ success: false, message: "tax_rate is required" });
        }

        const dueDateVal = parseDueDate(due_date);
        if (dueDateVal === null) {
            return res.status(400).json({
                success: false,
                message: "due_date is required and must be an integer between 1 and 31",
            });
        }

        const parsedAmounts = parseFeesTax(fees, tax_rate);
        if (parsedAmounts.error) {
            return res.status(400).json({ success: false, message: parsedAmounts.error });
        }
        const { feesNum, taxRateNum, tax_value } = parsedAmounts;

        const [serviceRows] = await pool.query(
            `SELECT service_id, name, type, frequency
             FROM services
             WHERE service_id = ?
             LIMIT 1`,
            [serviceId]
        );
        if (!serviceRows.length) {
            return res.status(404).json({ success: false, message: "Service not found" });
        }
        if (serviceRows[0].type !== "compliance") {
            return res.status(400).json({
                success: false,
                message: "service_id must belong to a compliance service",
            });
        }

        const parsedEffectiveFrom = parseComplianceEffectiveFrom(
            effective_from,
            serviceRows[0].frequency
        );
        if (parsedEffectiveFrom.error) {
            return res.status(400).json({
                success: false,
                message: parsedEffectiveFrom.error,
                hint: formatComplianceEffectiveFromHint(serviceRows[0].frequency),
            });
        }

        const [branchServiceRows] = await pool.query(
            `SELECT id
             FROM branch_services
             WHERE branch_id = ?
               AND service_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [branch_id, serviceId]
        );
        if (!branchServiceRows.length) {
            return res.status(400).json({
                success: false,
                message: "Service is not added to this branch. Add it to branch_services first.",
            });
        }

        const [firmRows] = await pool.query(
            `SELECT firm_id, firm_name, username
             FROM firms
             WHERE firm_id = ?
               AND branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [firmId, branch_id]
        );
        if (!firmRows.length) {
            return res.status(404).json({
                success: false,
                message: "Firm not found or does not belong to this branch",
            });
        }

        const duplicate = await findActiveComplianceFirmMapping(branch_id, serviceId, firmId);
        if (duplicate) {
            return res.status(409).json({
                success: false,
                message: "Firm is already assigned to this compliance service",
            });
        }

        const staffsVal = normalizeCommaSeparated(staffs);
        const caVal = normalizeCommaSeparated(ca);
        const agentVal = normalizeCommaSeparated(agent);
        const clientUsername = firmRows[0].username ? String(firmRows[0].username).trim() : null;

        const [insertResult] = await pool.query(
            `INSERT INTO compliance_firms
             (branch_id, service_id, username, firm_id, effective_from, fees, tax_rate, tax_value, staffs, ca, agent, due_date, create_by, modify_by, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
            [
                branch_id,
                serviceId,
                clientUsername,
                firmId,
                parsedEffectiveFrom.value,
                feesNum,
                taxRateNum,
                tax_value,
                staffsVal,
                caVal,
                agentVal,
                dueDateVal,
                createdBy,
                createdBy,
            ]
        );

        return res.status(201).json({
            success: true,
            message: "Compliance firm added successfully",
            data: {
                id: insertResult.insertId,
                branch_id,
                service_id: serviceId,
                service_name: serviceRows[0].name,
                frequency: serviceRows[0].frequency,
                firm_id: firmId,
                firm_name: firmRows[0].firm_name,
                username: clientUsername,
                effective_from: parsedEffectiveFrom.value,
                fees: feesNum,
                tax_rate: taxRateNum,
                tax_value,
                due_date: dueDateVal,
                staffs: staffsVal,
                ca: caVal,
                agent: agentVal,
            },
        });
    } catch (error) {
        console.error("POST COMPLIANCE ADD FIRM ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to add compliance firm",
            error: error.message,
        });
    }
});

router.post("/change-task-status", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const { service_id, firm_id, status, compliance_year, compliance_period } = req.body || {};

        const serviceId = parseServiceId(service_id);
        const firmId = parseFirmId(firm_id);
        const complianceYearRaw = parseRequiredText(compliance_year, "compliance_year");
        const parsedStatus = parseComplianceStatus(status);

        if (!serviceId) {
            return res.status(400).json({ success: false, message: "service_id is required" });
        }
        if (!firmId) {
            return res.status(400).json({ success: false, message: "firm_id is required" });
        }
        if (complianceYearRaw?.error) {
            return res.status(400).json({ success: false, message: complianceYearRaw.error });
        }
        if (parsedStatus.error) {
            return res.status(400).json({ success: false, message: parsedStatus.error });
        }

        const serviceResult = await loadComplianceService(branch_id, serviceId);
        if (serviceResult.error) {
            return res.status(serviceResult.error.status).json({
                success: false,
                message: serviceResult.error.message,
            });
        }

        const resolvedPeriod = resolveCompliancePeriodInput(
            compliance_period,
            serviceResult.service.frequency
        );
        if (resolvedPeriod.error) {
            return res.status(400).json({
                success: false,
                message: resolvedPeriod.error,
                period_options: getCompliancePeriodOptions(serviceResult.service.frequency),
            });
        }

        const complianceYear = normalizeFinancialYear(complianceYearRaw);
        const compliancePeriod = resolvedPeriod.period;
        const statusVal = parsedStatus.status;

        const complianceFirmResult = await loadComplianceFirm(branch_id, serviceId, firmId);
        if (complianceFirmResult.error) {
            return res.status(complianceFirmResult.error.status).json({
                success: false,
                message: complianceFirmResult.error.message,
            });
        }

        const complianceFirm = complianceFirmResult.complianceFirm;

        if (
            !isCompliancePeriodOnOrAfterEffective(
                complianceYear,
                compliancePeriod,
                complianceFirm.effective_from,
                serviceResult.service.frequency
            )
        ) {
            return res.status(400).json({
                success: false,
                message: `Task period ${compliancePeriod} (${complianceYear}) is before the firm assignment effective_from (${complianceFirm.effective_from})`,
            });
        }

        const dueDateSql = buildComplianceTaskDueDate(
            complianceYear,
            compliancePeriod,
            complianceFirm.due_date
        );

        await conn.beginTransaction();

        const [existingTasks] = await conn.query(
            `SELECT task_id, status
             FROM tasks
             WHERE branch_id = ?
               AND service_id = ?
               AND firm_id = ?
               AND compliance_year = ?
               AND compliance_period = ?
               AND task_type = 'compliance'
             LIMIT 1`,
            [branch_id, serviceId, firmId, complianceYear, compliancePeriod]
        );

        let taskId;
        let action;
        let previousStatus = null;

        if (!existingTasks.length) {
            action = "created";
            taskId = RANDOM_STRING(30);

            const caId = splitCsvFirst(complianceFirm.ca);
            const agentId = splitCsvFirst(complianceFirm.agent);
            const feesNum = Number(complianceFirm.fees);
            const taxRateNum = Number(complianceFirm.tax_rate);
            const taxValueNum = Number(complianceFirm.tax_value);
            const totalNum = Number((feesNum + taxValueNum).toFixed(2));

            const completeDate = statusVal === "complete" ? new Date() : null;
            const completeBy = statusVal === "complete" ? username || null : null;
            const cancelledDate = statusVal === "cancel" ? new Date() : null;
            const cancelledBy = statusVal === "cancel" ? username || null : null;

            await conn.query(
                `INSERT INTO tasks
                 (branch_id, task_id, task_type, compliance_year, compliance_period, username, firm_id, service_id,
                  has_ca, ca_id, has_agent, agent_id, fees, tax_rate, tax_value, total, create_by, is_recurring,
                  due_date, target_date, billing_status, status, complete_date, complete_by, cancelled_date, cancelled_by)
                 VALUES (?, ?, 'compliance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', ?, ?, '0', ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    taskId,
                    complianceYear,
                    compliancePeriod,
                    complianceFirm.username || null,
                    firmId,
                    serviceId,
                    caId ? "1" : "0",
                    caId,
                    agentId ? "1" : "0",
                    agentId,
                    feesNum,
                    taxRateNum,
                    taxValueNum,
                    totalNum,
                    username || null,
                    dueDateSql,
                    dueDateSql,
                    statusVal,
                    completeDate,
                    completeBy,
                    cancelledDate,
                    cancelledBy,
                ]
            );

            await conn.query(
                `INSERT INTO task_status (branch_id, task_id, create_by, status)
                 VALUES (?, ?, ?, ?)`,
                [branch_id, taskId, username, statusVal]
            );

            await insertTaskStaffs(
                conn,
                branch_id,
                taskId,
                complianceFirm.staffs,
                username
            );

            if (statusVal === "complete") {
                notifyTaskCompletedEmail({
                    branch_id,
                    task_id: taskId,
                    completed_by: username || "system",
                });
                notifyTaskCompletedWhatsapp({
                    branch_id,
                    task_id: taskId,
                    completed_by: username || "system",
                });
            }
        } else {
            action = "updated";
            taskId = existingTasks[0].task_id;
            previousStatus = existingTasks[0].status;

            const statusResult = await applyComplianceTaskStatus(conn, {
                branch_id,
                task_id: taskId,
                statusVal,
                username,
                previousStatus,
            });
            if (statusResult.error) {
                await conn.rollback();
                return res.status(statusResult.error.status).json({
                    success: false,
                    message: statusResult.error.message,
                });
            }
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message:
                action === "created"
                    ? "Compliance task created successfully"
                    : "Compliance task status updated successfully",
            data: {
                action,
                task_id: taskId,
                branch_id,
                service_id: serviceId,
                service_name: serviceResult.service.name,
                firm_id: firmId,
                compliance_year: complianceYear,
                compliance_period: isYearlyComplianceFrequency(serviceResult.service.frequency)
                    ? null
                    : compliancePeriod,
                effective_from: complianceFirm.effective_from ?? null,
                status: statusVal,
                due_date: dueDateSql,
                previous_status: previousStatus,
            },
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch {
            // ignore rollback errors
        }
        console.error("POST COMPLIANCE CHANGE TASK STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to change compliance task status",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.get("/period-options", auth, validateBranch, async (req, res) => {
    try {
        const serviceId = parseServiceId(req.query.service_id);
        if (!serviceId) {
            return res.status(400).json({
                success: false,
                message: "service_id is required",
            });
        }

        const serviceResult = await loadComplianceService(req.branch_id, serviceId);
        if (serviceResult.error) {
            return res.status(serviceResult.error.status).json({
                success: false,
                message: serviceResult.error.message,
            });
        }

        const periodOptions = getCompliancePeriodOptions(serviceResult.service.frequency);

        return res.status(200).json({
            success: true,
            message: "Compliance period options retrieved successfully",
            data: {
                service_id: serviceId,
                service_name: serviceResult.service.name,
                ...periodOptions,
            },
        });
    } catch (error) {
        console.error("GET COMPLIANCE PERIOD OPTIONS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch compliance period options",
            error: error.message,
        });
    }
});

router.get("/task-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { pageNum, limitNum, offset } = parseListPagination(req.query);
        const { service_id, firm_id, username, compliance_year, compliance_period, search, ca, agent } = req.query || {};

        const serviceId = parseServiceId(service_id);
        const complianceYearRaw =
            compliance_year != null && String(compliance_year).trim() !== ""
                ? normalizeFinancialYear(compliance_year)
                : null;
        const compliancePeriodRaw =
            compliance_period != null ? String(compliance_period).trim() : "";

        if (compliancePeriodRaw && !complianceYearRaw) {
            return res.status(400).json({
                success: false,
                message: "compliance_year is required when compliance_period is provided",
            });
        }

        let periodOptions = null;
        let serviceFrequency = null;

        if (serviceId) {
            const serviceResult = await loadComplianceService(branch_id, serviceId);
            if (serviceResult.error) {
                return res.status(serviceResult.error.status).json({
                    success: false,
                    message: serviceResult.error.message,
                });
            }

            serviceFrequency = serviceResult.service.frequency;
            periodOptions = getCompliancePeriodOptions(serviceFrequency);

            if (compliancePeriodRaw && !periodOptions.period_select_enabled) {
                return res.status(400).json({
                    success: false,
                    message: "compliance_period is not applicable for yearly services",
                    period_options: periodOptions,
                });
            }

            if (compliancePeriodRaw && periodOptions.period_select_enabled) {
                const matchedPeriod = periodOptions.periods.find(
                    (item) => item.value.toLowerCase() === compliancePeriodRaw.toLowerCase()
                );
                if (!matchedPeriod) {
                    return res.status(400).json({
                        success: false,
                        message: `compliance_period must be one of: ${periodOptions.periods.map((item) => item.value).join(", ")}`,
                        period_options: periodOptions,
                    });
                }
            }
        } else if (compliancePeriodRaw) {
            return res.status(400).json({
                success: false,
                message: "service_id is required when compliance_period is provided",
            });
        }

        const { whereClause, params } = buildComplianceFirmFilters(
            { service_id, firm_id, username, search, ca, agent },
            branch_id
        );

        const [firmRows] = await pool.query(
            `SELECT ${COMPLIANCE_FIRM_SELECT}
             ${COMPLIANCE_FIRM_JOINS}
             WHERE ${whereClause}
             ORDER BY cf.id DESC`,
            params
        );

        const targetYear = complianceYearRaw
            ? normalizeFinancialYear(complianceYearRaw)
            : getFinancialYearForDate(new Date());

        const assignmentRows = expandComplianceFirmPeriods(firmRows, {
            complianceYear: complianceYearRaw,
            compliancePeriod: compliancePeriodRaw || null,
        });

        const existingTaskRows = await fetchExistingComplianceTaskRows(
            branch_id,
            { service_id, firm_id, username, search, ca, agent },
            {
                complianceYear: targetYear,
                compliancePeriod: compliancePeriodRaw || null,
            }
        );

        const expandedRows = sortComplianceTaskListRows(
            mergeComplianceTaskListRows(assignmentRows, existingTaskRows)
        );

        const total = expandedRows.length;
        const pageRows = expandedRows.slice(offset, offset + limitNum);
        const taskMap = await fetchComplianceTasksMap(branch_id, pageRows);

        const data = [];
        for (const row of pageRows) {
            const task = taskMap.get(getComplianceTaskLookupKey(row)) || null;
            data.push(await formatComplianceTaskListRow(row, task));
        }

        const totalPages = Math.ceil(total / limitNum) || 1;

        return res.status(200).json({
            success: true,
            message: "Compliance task list retrieved successfully",
            query_payload: {
                ...req.query,
                page_no: pageNum,
                limit: limitNum,
                service_id: serviceId,
                firm_id: parseFirmId(firm_id),
                username: username != null ? String(username).trim() || null : null,
                compliance_year:
                    complianceYearRaw || getFinancialYearForDate(new Date()),
                compliance_period:
                    serviceFrequency && isYearlyComplianceFrequency(serviceFrequency)
                        ? null
                        : compliancePeriodRaw || null,
                period_options: periodOptions,
            },
            data,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: totalPages,
                is_last_page: offset + pageRows.length >= total,
            },
        });
    } catch (error) {
        console.error("GET COMPLIANCE TASK LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch compliance task list",
            error: error.message,
        });
    }
});

router.get("/firms", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { pageNum, limitNum, offset } = parseListPagination(req.query);
        const { whereClause, params } = buildComplianceFirmFilters(req.query, branch_id);

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total
             ${COMPLIANCE_FIRM_JOINS}
             WHERE ${whereClause}`,
            params
        );

        const [rows] = await pool.query(
            `SELECT ${COMPLIANCE_FIRM_SELECT}
             ${COMPLIANCE_FIRM_JOINS}
             WHERE ${whereClause}
             ORDER BY cf.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const totalPages = Math.ceil(Number(total) / limitNum) || 1;

        return res.status(200).json({
            success: true,
            message: "Compliance firms retrieved successfully",
            data: rows.map(formatComplianceFirmRow),
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total: Number(total),
                total_pages: totalPages,
                has_more: pageNum < totalPages,
            },
        });
    } catch (error) {
        console.error("GET COMPLIANCE FIRMS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch compliance firms",
            error: error.message,
        });
    }
});

router.get("/firm-details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const record = await loadComplianceFirmRecord(branch_id, {
            id: req.query.id,
            serviceId: parseServiceId(req.query.service_id),
            firmId: parseFirmId(req.query.firm_id),
        });

        if (record.error) {
            return res.status(record.error.status).json({
                success: false,
                message: record.error.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Compliance firm details retrieved successfully",
            data: formatComplianceFirmRow(record.row),
        });
    } catch (error) {
        console.error("GET COMPLIANCE FIRM DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch compliance firm details",
            error: error.message,
        });
    }
});

router.put("/edit-firm", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || req.headers["Username"] || "";
        const {
            id,
            service_id,
            firm_id,
            fees,
            tax_rate,
            due_date,
            effective_from,
            staffs,
            ca,
            agent,
        } = req.body || {};

        const serviceId = parseServiceId(service_id);
        const firmId = parseFirmId(firm_id);

        if (!serviceId) {
            return res.status(400).json({ success: false, message: "service_id is required" });
        }
        if (!firmId) {
            return res.status(400).json({ success: false, message: "firm_id is required" });
        }
        if (fees == null || fees === "") {
            return res.status(400).json({ success: false, message: "fees is required" });
        }
        if (tax_rate == null || tax_rate === "") {
            return res.status(400).json({ success: false, message: "tax_rate is required" });
        }

        const dueDateVal = parseDueDate(due_date);
        if (dueDateVal === null) {
            return res.status(400).json({
                success: false,
                message: "due_date is required and must be an integer between 1 and 31",
            });
        }

        const parsedAmounts = parseFeesTax(fees, tax_rate);
        if (parsedAmounts.error) {
            return res.status(400).json({ success: false, message: parsedAmounts.error });
        }
        const { feesNum, taxRateNum, tax_value } = parsedAmounts;

        const recordId = id != null ? Number(id) : null;
        const hasRecordId = recordId != null && !Number.isNaN(recordId) && recordId > 0;

        const record = await loadComplianceFirmRecord(
            branch_id,
            hasRecordId
                ? { id: recordId }
                : { serviceId, firmId }
        );

        if (record.error) {
            return res.status(record.error.status).json({
                success: false,
                message: record.error.message,
            });
        }

        const existing = record.row;

        const serviceResult = await loadComplianceService(branch_id, serviceId);
        if (serviceResult.error) {
            return res.status(serviceResult.error.status).json({
                success: false,
                message: serviceResult.error.message,
            });
        }

        const parsedEffectiveFrom = parseComplianceEffectiveFrom(
            effective_from,
            serviceResult.service.frequency
        );
        if (parsedEffectiveFrom.error) {
            return res.status(400).json({
                success: false,
                message: parsedEffectiveFrom.error,
                hint: formatComplianceEffectiveFromHint(serviceResult.service.frequency),
            });
        }

        const [firmRows] = await pool.query(
            `SELECT firm_id, firm_name, username
             FROM firms
             WHERE firm_id = ?
               AND branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [firmId, branch_id]
        );
        if (!firmRows.length) {
            return res.status(404).json({
                success: false,
                message: "Firm not found or does not belong to this branch",
            });
        }

        const duplicate = await findActiveComplianceFirmMapping(
            branch_id,
            serviceId,
            firmId,
            existing.id
        );
        if (duplicate) {
            return res.status(409).json({
                success: false,
                message: "Firm is already assigned to this compliance service",
            });
        }

        const staffsVal = normalizeCommaSeparated(staffs);
        const caVal = normalizeCommaSeparated(ca);
        const agentVal = normalizeCommaSeparated(agent);
        const clientUsername = firmRows[0].username ? String(firmRows[0].username).trim() : null;

        await pool.query(
            `UPDATE compliance_firms
             SET service_id = ?,
                 firm_id = ?,
                 username = ?,
                 fees = ?,
                 tax_rate = ?,
                 tax_value = ?,
                 due_date = ?,
                 effective_from = ?,
                 staffs = ?,
                 ca = ?,
                 agent = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [
                serviceId,
                firmId,
                clientUsername,
                feesNum,
                taxRateNum,
                tax_value,
                dueDateVal,
                parsedEffectiveFrom.value,
                staffsVal,
                caVal,
                agentVal,
                modifyBy,
                existing.id,
                branch_id,
            ]
        );

        const refreshed = await loadComplianceFirmRecord(branch_id, { id: existing.id });
        if (refreshed.error) {
            return res.status(500).json({
                success: false,
                message: "Compliance firm updated but failed to reload details",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Compliance firm updated successfully",
            data: formatComplianceFirmRow(refreshed.row),
        });
    } catch (error) {
        console.error("PUT COMPLIANCE EDIT FIRM ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update compliance firm",
            error: error.message,
        });
    }
});

router.delete("/delete-firm", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const deletedBy = req.headers["username"] || req.headers["Username"] || "";
        const { id, service_id, firm_id } = req.body || req.query || {};

        const record = await loadComplianceFirmRecord(branch_id, {
            id,
            serviceId: parseServiceId(service_id),
            firmId: parseFirmId(firm_id),
        });

        if (record.error) {
            return res.status(record.error.status).json({
                success: false,
                message: record.error.message,
            });
        }

        const existing = record.row;

        await pool.query(
            `UPDATE compliance_firms
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [deletedBy, deletedBy, existing.id, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Compliance firm deleted successfully",
            data: {
                id: existing.id,
                service_id: existing.service_id,
                firm_id: existing.firm_id,
            },
        });
    } catch (error) {
        console.error("DELETE COMPLIANCE FIRM ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete compliance firm",
            error: error.message,
        });
    }
});

export default router;
