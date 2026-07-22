// report.js
import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { fetchPermissionRoleById } from "../helpers/permissionRole.js";
import { USER_SNIPPED_DATA, TODAY_DATE } from "../helpers/function.js";
import {
    clientBalanceCountParams,
    clientBalanceCountSql,
    clientBalanceListParams,
    clientBalanceListSql,
    clientBalanceTotalParams,
    clientBalanceTotalSql,
} from "../helpers/clientBalanceSql.js";
import {
    filterSchedulesByRecurringRules,
    buildComplianceTaskLookupKey,
    expandComplianceFirmPeriods,
    filterCompliancePeriodsByVisibility,
} from "../helpers/recurringTaskHelper.js";

const router = express.Router();
// ========== GLOBAL HELPER FUNCTIONS (Available to all routes) ==========

// Same normalization as routes/task.js so in_user is returned identically
function normalizeInUser(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

// Helper function to get due date category (OD, DT, D7, FT)
function getDueDateCategory(dueDate) {
    if (!dueDate) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueDateObj = new Date(dueDate);
    dueDateObj.setHours(0, 0, 0, 0);

    const diffDays = Math.ceil((dueDateObj - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
        return 'OD'; // Overdue
    } else if (diffDays === 0) {
        return 'DT'; // Due Today
    } else if (diffDays <= 7) {
        return 'D7'; // 7 Days
    } else {
        return 'FT'; // Future
    }
}

// Helper function to get status category (WIP, PFC, PFD, CPL, CNL)
function getStatusCategory(status) {
    if (status === 'in process') return 'WIP';
    if (status === 'pending from client') return 'PFC';
    if (status === 'pending from department') return 'PFD';
    if (status === 'complete') return 'CPL';
    if (status === 'cancel') return 'CNL';
    return null;
}

// Helper function to check if task is active (not complete or cancel)
function isTaskActive(status) {
    return status !== 'complete' && status !== 'cancel';
}

function isComplianceActive(status) {
    if (!status) return false;
    const s = String(status).trim().toLowerCase();
    return s === 'pending from the department' || s === 'pending from client';
}

function getComplianceStatusCategory(status) {
    if (!status) return null;
    const s = String(status).trim().toLowerCase();
    if (s === 'pending from the department') return 'PFD';
    if (s === 'pending from client') return 'PFC';
    if (s === 'complete') return 'CPL';
    if (s === 'cancel') return 'CNL';
    return null;
}

// Helper function to format time duration
function formatTimeDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '0 minutes';

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    if (seconds > 0 && parts.length === 0) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);

    return parts.join(', ');
}

// Helper function to get status category from task_status table
async function getStatusCategoryFromTaskStatusTable(taskId, branchId) {
    try {
        const [rows] = await pool.query(
            `SELECT status FROM task_status 
             WHERE task_id = ? AND branch_id = ? 
             ORDER BY id DESC LIMIT 1`,
            [taskId, branchId]
        );

        if (rows.length > 0) {
            const status = rows[0].status;
            if (status === 'in process') return 'WIP';
            if (status === 'pending from client') return 'PFC';
            if (status === 'pending from department') return 'PFD';
        }
        return null;
    } catch (error) {
        console.error("Error fetching task status:", error);
        return null;
    }
}

// Helper to check user permissions inside routes
async function checkUserPermission(username, branchId, permissionKey) {
    if (!username || !branchId || !permissionKey) return false;
    try {
        const [mappings] = await pool.query(
            `SELECT type, permission_role_id, custom_permissions 
             FROM branch_mapping 
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'`,
            [username, branchId]
        );
        if (mappings.length === 0) return false;
        const userMap = mappings[0];

        // 1. Branch Administrators always have all permissions
        if (userMap.type === 'admin') return true;

        // 2. Office assistance permission is default for all mapped branch members
        if (permissionKey === 'office_assistance_access') return true;

        // 3. Verify permission is active in the master list
        const [optCheck] = await pool.query(
            "SELECT id FROM permission_option WHERE p_option_id = ? AND status = '1' LIMIT 1",
            [permissionKey]
        );
        if (optCheck.length === 0) return false;

        const parsePermissions = (permissionsAssigned) => {
            if (!permissionsAssigned) return [];
            try {
                const parsed = typeof permissionsAssigned === 'string'
                    ? JSON.parse(permissionsAssigned)
                    : permissionsAssigned;
                if (parsed && parsed.permissions && Array.isArray(parsed.permissions)) {
                    return parsed.permissions;
                } else if (Array.isArray(parsed)) {
                    return parsed;
                }
            } catch (e) {
                // Ignore parsing errors
            }
            return [];
        };

        // 4. Check direct custom permissions
        if (userMap.custom_permissions) {
            const customPerms = parsePermissions(userMap.custom_permissions);
            if (customPerms.includes(permissionKey)) return true;
        }

        // 5. Check permissions from their assigned role (branch or global)
        if (userMap.permission_role_id) {
            const role = await fetchPermissionRoleById(pool, userMap.permission_role_id, branchId);
            if (role) {
                const rolePerms = parsePermissions(role.permissions_assigned);
                if (rolePerms.includes(permissionKey)) return true;
            }
        }

        return false;
    } catch (error) {
        console.error("Error in checkUserPermission helper:", error);
        return false;
    }
}

// ========== END GLOBAL HELPER FUNCTIONS ==========

function getCurrentFinancialYearLabel(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    if (month >= 4) {
        return `${year}-${year + 1}`;
    }
    return `${year - 1}-${year}`;
}

function parseFinancialYearLabel(fyLabel) {
    const match = String(fyLabel || "").trim().match(/^(\d{4})-(\d{4})$/);
    if (!match) return null;
    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear !== startYear + 1) {
        return null;
    }
    return {
        label: `${startYear}-${endYear}`,
        fyStartDate: `${startYear}-04-01`,
        fyEndDate: `${endYear}-03-31`,
    };
}

function resolveFinancialYearRange(fyQuery) {
    const parsed = parseFinancialYearLabel(fyQuery);
    if (parsed) return parsed;

    const current = getCurrentFinancialYearLabel();
    const currentParsed = parseFinancialYearLabel(current);
    return currentParsed;
}

function getPreviousFinancialYearRange(fyLabel) {
    const parsed = parseFinancialYearLabel(fyLabel);
    if (!parsed) return null;
    const startYear = Number(parsed.label.split("-")[0]);
    return parseFinancialYearLabel(`${startYear - 1}-${startYear}`);
}

function computeSaleAmountGrowthPercent(currentAmount, previousAmount) {
    const current = Number(currentAmount) || 0;
    const previous = Number(previousAmount) || 0;
    if (previous === 0) {
        return current === 0 ? 0 : null;
    }
    return Number((((current - previous) / previous) * 100).toFixed(1));
}

function formatFinancialYearShortLabel(fyLabel) {
    const parsed = parseFinancialYearLabel(fyLabel);
    if (!parsed) return fyLabel;
    const [start, end] = parsed.label.split("-");
    return `FY ${start}-${String(end).slice(-2)}`;
}


// Dashboard Summary API - Sales Overview metrics for selected financial year
router.get("/dashboard-summary-core", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || '';
        const hasPerm = await checkUserPermission(username, branch_id, 'sales_overview_view');
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }

        const fyRange = resolveFinancialYearRange(req.query.financial_year);
        if (!fyRange) {
            return res.status(400).json({
                success: false,
                message: "Invalid financial_year. Expected format: YYYY-YYYY (e.g. 2025-2026)",
            });
        }

        const { label: financialYear, fyStartDate, fyEndDate } = fyRange;

        const [salesRows] = await pool.query(
            `SELECT
                COUNT(DISTINCT i.invoice_id) AS invoice_count,
                COALESCE(SUM(i.grand_total), 0) AS sale_amount,
                COALESCE(SUM(
                    GREATEST(
                        0,
                        i.total
                        - GREATEST(0, i.subtotal - COALESCE(i.discount_value, 0))
                        - COALESCE(i.additional_charge, 0)
                    )
                ), 0) AS gst_amount,
                COUNT(DISTINCT CASE
                    WHEN (se.is_task = '1' OR se.is_task = 1)
                         AND LOWER(COALESCE(se.party_type, '')) = 'client'
                    THEN se.sale_id
                    ELSE NULL
                END) AS task_sale_count,
                COUNT(DISTINCT CASE
                    WHEN (se.is_task = '1' OR se.is_task = 1)
                         AND LOWER(COALESCE(se.party_type, '')) = 'client'
                    THEN se.sale_id
                    ELSE NULL
                END) AS breakdown_task_count,
                COALESCE(SUM(CASE
                    WHEN (se.is_task = '1' OR se.is_task = 1)
                         AND LOWER(COALESCE(se.party_type, '')) = 'client'
                    THEN COALESCE(se.total, 0)
                    ELSE 0
                END), 0) AS breakdown_task_amount,
                COUNT(DISTINCT CASE
                    WHEN (se.is_task = '0' OR se.is_task = 0)
                         AND LOWER(COALESCE(se.party_type, '')) = 'client'
                    THEN se.sale_id
                    ELSE NULL
                END) AS breakdown_client_count,
                COALESCE(SUM(CASE
                    WHEN (se.is_task = '0' OR se.is_task = 0)
                         AND LOWER(COALESCE(se.party_type, '')) = 'client'
                    THEN COALESCE(se.total, 0)
                    ELSE 0
                END), 0) AS breakdown_client_amount,
                COUNT(DISTINCT CASE
                    WHEN (se.is_task = '0' OR se.is_task = 0)
                         AND LOWER(COALESCE(se.party_type, '')) = 'bank'
                    THEN se.sale_id
                    ELSE NULL
                END) AS breakdown_bank_count,
                COALESCE(SUM(CASE
                    WHEN (se.is_task = '0' OR se.is_task = 0)
                         AND LOWER(COALESCE(se.party_type, '')) = 'bank'
                    THEN COALESCE(se.total, 0)
                    ELSE 0
                END), 0) AS breakdown_bank_amount,
                COUNT(DISTINCT CASE
                    WHEN (se.is_task = '0' OR se.is_task = 0)
                         AND LOWER(COALESCE(se.party_type, '')) NOT IN ('client', 'bank')
                    THEN se.sale_id
                    ELSE NULL
                END) AS breakdown_other_count,
                COALESCE(SUM(CASE
                    WHEN (se.is_task = '0' OR se.is_task = 0)
                         AND LOWER(COALESCE(se.party_type, '')) NOT IN ('client', 'bank')
                    THEN COALESCE(se.total, 0)
                    ELSE 0
                END), 0) AS breakdown_other_amount
             FROM invoice i
             INNER JOIN sale_entries se
                ON se.invoice_id = i.invoice_id
                AND CAST(se.branch_id AS CHAR) = CAST(i.branch_id AS CHAR)
             WHERE i.branch_id = ?
               AND i.type = 'sale'
               AND DATE(se.sale_date) BETWEEN ? AND ?`,
            [branch_id, fyStartDate, fyEndDate]
        );

        const row = salesRows[0] || {};
        const invoiceCount = parseInt(row.invoice_count || 0, 10);
        const saleAmount = parseFloat(row.sale_amount || 0);
        const gstAmount = parseFloat(row.gst_amount || 0);
        const taskSaleCount = parseInt(row.task_sale_count || 0, 10);

        const saleBreakdown = {
            task: {
                count: parseInt(row.breakdown_task_count || 0, 10),
                amount: parseFloat(row.breakdown_task_amount || 0),
            },
            client: {
                count: parseInt(row.breakdown_client_count || 0, 10),
                amount: parseFloat(row.breakdown_client_amount || 0),
            },
            bank: {
                count: parseInt(row.breakdown_bank_count || 0, 10),
                amount: parseFloat(row.breakdown_bank_amount || 0),
            },
            other: {
                count: parseInt(row.breakdown_other_count || 0, 10),
                amount: parseFloat(row.breakdown_other_amount || 0),
            },
        };

        const previousFyRange = getPreviousFinancialYearRange(financialYear);
        let previousFySaleAmount = 0;
        let previousFinancialYear = null;

        if (previousFyRange) {
            previousFinancialYear = previousFyRange.label;
            const [previousRows] = await pool.query(
                `SELECT COALESCE(SUM(i.grand_total), 0) AS sale_amount
                 FROM invoice i
                 INNER JOIN sale_entries se
                    ON se.invoice_id = i.invoice_id
                    AND CAST(se.branch_id AS CHAR) = CAST(i.branch_id AS CHAR)
                 WHERE i.branch_id = ?
                   AND i.type = 'sale'
                   AND DATE(se.sale_date) BETWEEN ? AND ?`,
                [branch_id, previousFyRange.fyStartDate, previousFyRange.fyEndDate]
            );
            previousFySaleAmount = parseFloat(previousRows[0]?.sale_amount || 0);
        }

        const saleAmountGrowthPercent = computeSaleAmountGrowthPercent(
            saleAmount,
            previousFySaleAmount
        );

        const formatCurrency = (amount) => {
            const absAmount = Math.abs(amount);
            const formatted = new Intl.NumberFormat('en-IN', {
                maximumFractionDigits: 0,
                minimumFractionDigits: 0
            }).format(absAmount);
            return amount < 0 ? `-₹${formatted}` : `₹${formatted}`;
        };

        return res.status(200).json({
            success: true,
            message: "Sales overview retrieved successfully",
            data: {
                financial_year: financialYear,
                fy_start_date: fyStartDate,
                fy_end_date: fyEndDate,
                invoice_count: invoiceCount,
                sale_amount: saleAmount,
                gst_amount: gstAmount,
                task_sale_count: taskSaleCount,
                sale_breakdown: saleBreakdown,
                previous_financial_year: previousFinancialYear,
                previous_fy_sale_amount: previousFySaleAmount,
                sale_amount_growth_percent: saleAmountGrowthPercent,
                formatted: {
                    invoice_count: invoiceCount.toLocaleString('en-IN'),
                    sale_amount: formatCurrency(saleAmount),
                    gst_amount: formatCurrency(gstAmount),
                    task_sale_count: taskSaleCount.toLocaleString('en-IN'),
                    previous_fy_sale_amount: formatCurrency(previousFySaleAmount),
                    previous_fy_label: previousFinancialYear
                        ? formatFinancialYearShortLabel(previousFinancialYear)
                        : null,
                    sale_amount_growth_percent: saleAmountGrowthPercent == null
                        ? null
                        : `${saleAmountGrowthPercent > 0 ? '+' : ''}${saleAmountGrowthPercent}%`,
                    sale_breakdown: Object.fromEntries(
                        Object.entries(saleBreakdown).map(([key, value]) => [
                            key,
                            {
                                count: value.count.toLocaleString('en-IN'),
                                amount: formatCurrency(value.amount),
                            },
                        ]),
                    ),
                },
            }
        });

    } catch (error) {
        console.error("Dashboard summary core error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch sales overview",
            error: error.message
        });
    }
});

router.get("/task-summary", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || '';
        const hasPerm = await checkUserPermission(username, branch_id, 'card_task_summary');
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }
        const { service_ids, search, type } = req.query;
        const serviceType = type != null ? String(type).trim().toLowerCase() : "";

        if (serviceType && !["general", "compliance"].includes(serviceType)) {
            return res.status(400).json({
                success: false,
                message: "type must be empty, 'general', or 'compliance'",
            });
        }

        // Parse service_ids - can be single or multiple (comma separated)
        let serviceIdArray = [];
        if (service_ids) {
            if (Array.isArray(service_ids)) {
                serviceIdArray = service_ids.map(id => String(id).trim()).filter(Boolean);
            } else if (typeof service_ids === "string") {
                serviceIdArray = service_ids.split(",").map(id => id.trim()).filter(Boolean);
            }
        }

        // Build base query for services
        let serviceQuery = `
            SELECT 
                s.service_id,
                s.name as service_name,
                s.type as service_type,
                bs.is_deleted
            FROM branch_services bs
            INNER JOIN services s ON bs.service_id = s.service_id
            WHERE bs.branch_id = ? AND bs.is_deleted = '0'
        `;

        const serviceParams = [branch_id];

        // Filter by service_ids if provided
        if (serviceIdArray.length > 0) {
            const placeholders = serviceIdArray.map(() => "?").join(",");
            serviceQuery += ` AND s.service_id IN (${placeholders})`;
            serviceParams.push(...serviceIdArray);
        }

        // Always filter by service type when requested (even with service_ids)
        if (serviceType) {
            serviceQuery += ` AND s.type = ?`;
            serviceParams.push(serviceType);
        }

        // Add search filter
        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            serviceQuery += ` AND s.name LIKE ?`;
            serviceParams.push(searchPattern);
        }

        serviceQuery += ` ORDER BY s.name ASC`;

        const [services] = await pool.query(serviceQuery, serviceParams);

        if (services.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No services found",
                data: [],
                summary: {
                    total_services: 0,
                    total_active_tasks: 0,
                    total_all_tasks: 0,
                    category_totals: {
                        OD: 0, DT: 0, D7: 0, FT: 0,
                        WIP: 0, PFC: 0, PFD: 0,
                        yet_no_started: 0
                    }
                }
            });
        }

        // Get active (non-complete/cancel) tasks for these services
        const serviceIdList = services.map(s => s.service_id);
        const taskPlaceholders = serviceIdList.map(() => "?").join(",");

        const tasksQuery = `
            SELECT 
                t.task_id,
                t.service_id,
                t.due_date,
                t.status
            FROM tasks t
            WHERE t.branch_id = ? 
            AND t.service_id IN (${taskPlaceholders})
            AND t.status NOT IN ('complete', 'cancel')
        `;

        const [tasks] = await pool.query(tasksQuery, [branch_id, ...serviceIdList]);

        const complianceQuery = `
            SELECT 
                cs.schedule_id AS task_id,
                ca.service_id,
                ca.firm_id,
                cs.financial_year,
                cs.period_name,
                cs.due_date AS schedule_due_date,
                cs.status,
                s.frequency,
                ca.create_date,
                ca.modify_date,
                ca.pay_from_month,
                cf.due_date,
                cf.visibility_offset
            FROM compliance_schedules cs
            INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
            INNER JOIN firms f ON ca.firm_id = f.firm_id
            INNER JOIN services s ON ca.service_id = s.service_id
            LEFT JOIN compliance_firms cf
                ON cf.branch_id = f.branch_id
               AND cf.service_id = ca.service_id
               AND cf.firm_id = ca.firm_id
               AND cf.is_deleted = '0'
            WHERE f.branch_id = ? AND f.is_deleted = '0'
            AND ca.service_id IN (${taskPlaceholders})
            AND (cs.status IS NULL OR LOWER(TRIM(cs.status)) NOT IN ('complete', 'cancel'))
        `;
        const [complianceTasks] = await pool.query(complianceQuery, [branch_id, ...serviceIdList]);

        const complianceTasksForVisibility = complianceTasks.map((row) => ({
            ...row,
            visibility_offset: row.visibility_offset != null ? Number(row.visibility_offset) : 0,
        }));

        const visibleComplianceSchedules = filterCompliancePeriodsByVisibility(
            filterSchedulesByRecurringRules(complianceTasksForVisibility),
            new Date()
        );

        const [startedComplianceTasks] = await pool.query(
            `SELECT t.service_id, t.firm_id, t.compliance_year, t.compliance_period, s.frequency
             FROM tasks t
             INNER JOIN services s ON t.service_id = s.service_id
             WHERE t.branch_id = ?
               AND t.task_type = 'compliance'
               AND t.service_id IN (${taskPlaceholders})`,
            [branch_id, ...serviceIdList]
        );

        const startedComplianceTaskKeys = new Set(
            startedComplianceTasks.map((task) => buildComplianceTaskLookupKey(task))
        );

        const complianceServiceIds = services
            .filter((service) => String(service.service_type || "").toLowerCase() === "compliance")
            .map((service) => service.service_id);

        let expandedComplianceFirmPeriods = [];
        if (complianceServiceIds.length > 0) {
            const complianceFirmPlaceholders = complianceServiceIds.map(() => "?").join(",");
            const [complianceFirmRows] = await pool.query(
                `SELECT cf.service_id,
                        cf.firm_id,
                        cf.effective_from,
                        cf.create_date,
                        cf.modify_date,
                        cf.due_date,
                        cf.visibility_offset,
                        s.frequency
                 FROM compliance_firms cf
                 INNER JOIN services s ON s.service_id = cf.service_id
                 INNER JOIN firms f
                    ON f.firm_id = cf.firm_id
                   AND f.branch_id = cf.branch_id
                   AND f.is_deleted = '0'
                 WHERE cf.branch_id = ?
                   AND cf.is_deleted = '0'
                   AND cf.service_id IN (${complianceFirmPlaceholders})`,
                [branch_id, ...complianceServiceIds]
            );
            expandedComplianceFirmPeriods = expandComplianceFirmPeriods(complianceFirmRows, {});
        }

        // Helper function to get due date category (OD, DT, D7, FT)
        function getDueDateCategory(dueDate) {
            if (!dueDate) return null;

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const dueDateObj = new Date(dueDate);
            dueDateObj.setHours(0, 0, 0, 0);

            const diffDays = Math.ceil((dueDateObj - today) / (1000 * 60 * 60 * 24));

            if (diffDays < 0) {
                return 'OD'; // Overdue
            } else if (diffDays === 0) {
                return 'DT'; // Due Today
            } else if (diffDays <= 7) {
                return 'D7'; // 7 Days
            } else {
                return 'FT'; // Future
            }
        }

        // Helper function to get status category (WIP, PFC, PFD)
        function getStatusCategory(status) {
            if (status === 'in process') return 'WIP';
            if (status === 'pending from client') return 'PFC';
            if (status === 'pending from department') return 'PFD';
            return null;
        }

        // Helper function to check if task is active (not complete or cancel)
        function isTaskActive(status) {
            return status !== 'complete' && status !== 'cancel';
        }

        // Build response data - ONLY include services with at least ONE active task
        const reportData = [];
        let globalTotals = {
            OD: 0, DT: 0, D7: 0, FT: 0,
            WIP: 0, PFC: 0, PFD: 0,
            yet_no_started: 0,
            total_active_tasks: 0,
            total_all_tasks: 0
        };

        for (const service of services) {
            // Filter tasks for this service
            const serviceTasks = tasks.filter(t => t.service_id === service.service_id);
            const serviceSchedules = visibleComplianceSchedules.filter(
                (cs) => cs.service_id === service.service_id
            );
            const visibleServiceSchedules = serviceSchedules;

            // Initialize counters for this service
            const counts = {
                OD: 0, DT: 0, D7: 0, FT: 0,
                WIP: 0, PFC: 0, PFD: 0
            };

            let activeTaskCount = 0;
            const isComplianceService =
                String(service.service_type || "").toLowerCase() === "compliance";
            let yetNoStarted = isComplianceService ? 0 : false;

            if (isComplianceService) {
                const notStartedKeys = new Set();

                for (const periodRow of expandedComplianceFirmPeriods) {
                    if (periodRow.service_id !== service.service_id) continue;
                    const lookupKey = buildComplianceTaskLookupKey(periodRow);
                    if (!startedComplianceTaskKeys.has(lookupKey)) {
                        notStartedKeys.add(lookupKey);
                    }
                }

                for (const cs of visibleServiceSchedules) {
                    const lookupKey = buildComplianceTaskLookupKey({
                        service_id: cs.service_id,
                        firm_id: cs.firm_id,
                        compliance_year: cs.financial_year,
                        compliance_period: cs.period_name,
                        frequency: cs.frequency,
                    });
                    if (!startedComplianceTaskKeys.has(lookupKey)) {
                        notStartedKeys.add(lookupKey);
                    }
                }

                yetNoStarted = notStartedKeys.size;
            }

            // Categorize each task - tasks can be in multiple categories
            for (const task of serviceTasks) {
                // Get due date category (OD, DT, D7, FT) - only for active tasks
                // OD is counted only for "in process" tasks
                if (isTaskActive(task.status)) {
                    const dueCategory = getDueDateCategory(task.due_date);
                    if (dueCategory === 'OD') {
                        if (task.status === 'in process') {
                            counts.OD++;
                        }
                    } else if (dueCategory) {
                        counts[dueCategory]++;
                    }
                    activeTaskCount++;
                }

                // Get status category (WIP, PFC, PFD)
                const statusCategory = getStatusCategory(task.status);
                if (statusCategory) {
                    counts[statusCategory]++;
                }
            }

            // Categorize each compliance schedule
            for (const cs of serviceSchedules) {
                const csStatus = String(cs.status || '').trim().toLowerCase();
                const dueCategory = getDueDateCategory(cs.schedule_due_date ?? cs.due_date);

                // OD is counted only for "in process" schedules (even if not in the active PFC/PFD set)
                if (dueCategory === 'OD' && csStatus === 'in process') {
                    counts.OD++;
                }

                // Get due date category (DT, D7, FT) - only for active schedules
                if (isComplianceActive(cs.status)) {
                    if (dueCategory && dueCategory !== 'OD') {
                        counts[dueCategory]++;
                    }
                    activeTaskCount++;
                }

                // Get status category (WIP, PFC, PFD only — complete/cancel excluded in SQL)
                const statusCategory = getComplianceStatusCategory(cs.status);
                if (statusCategory === 'PFC' || statusCategory === 'PFD') {
                    counts[statusCategory]++;
                }
            }

            const totalTasks = serviceTasks.length + serviceSchedules.length;

            const hasYetNoStarted = typeof yetNoStarted === 'number' && yetNoStarted > 0;

            if (serviceType && String(service.service_type || '').toLowerCase() !== serviceType) {
                continue;
            }

            // Include service if it has active tasks or not-started compliance schedules
            if (activeTaskCount > 0 || hasYetNoStarted) {
                // Update global totals
                for (const key of Object.keys(counts)) {
                    globalTotals[key] += counts[key];
                }
                if (hasYetNoStarted) {
                    globalTotals.yet_no_started += yetNoStarted;
                }
                globalTotals.total_active_tasks += activeTaskCount;
                globalTotals.total_all_tasks += totalTasks;

                reportData.push({
                    service_id: service.service_id,
                    service_name: service.service_name,
                    service_type: service.service_type,
                    task_counts: {
                        yet_no_started: yetNoStarted,
                        OD: counts.OD,
                        DT: counts.DT,
                        D7: counts.D7,
                        FT: counts.FT,
                        WIP: counts.WIP,
                        PFC: counts.PFC,
                        PFD: counts.PFD
                    },
                    total_tasks: totalTasks,
                    active_tasks: activeTaskCount
                });
            }
        }

        // Calculate category totals for summary
        const categoryTotals = {
            yet_no_started: globalTotals.yet_no_started,
            OD: globalTotals.OD,
            DT: globalTotals.DT,
            D7: globalTotals.D7,
            FT: globalTotals.FT,
            WIP: globalTotals.WIP,
            PFC: globalTotals.PFC,
            PFD: globalTotals.PFD
        };

        return res.status(200).json({
            success: true,
            message: "Task summary report retrieved successfully",
            data: reportData,
            summary: {
                total_services: reportData.length,
                total_active_tasks: globalTotals.total_active_tasks,
                total_all_tasks: globalTotals.total_all_tasks,
                category_totals: categoryTotals
            },
            filters_applied: {
                service_ids: serviceIdArray.length > 0 ? serviceIdArray : "all",
                type: serviceType || "all",
                search: search || null
            },
            category_legend: {
                "YNS": "Yet Not Started - Compliance schedules without a started task",
                "yet_no_started": "Yet Not Started - Compliance schedules without a started task (false for general services)",
                "OD": "Overdue (Due date passed) - Counted for 'in process' tasks with past due date",
                "DT": "Due Today - Counted for active tasks due today",
                "D7": "Due within 7 Days - Counted for active tasks due in next 7 days",
                "FT": "Future (More than 7 days) - Counted for active tasks with due date beyond 7 days",
                "WIP": "In Progress - Tasks with status 'in process'",
                "PFC": "Pending From Client - Tasks with status 'pending from client'",
                "PFD": "Pending From Department - Tasks with status 'pending from department'"
            },
            note: "Services with at least one active task or not-started compliance schedule are shown. yet_no_started is a count for compliance services only (false for general services). A task can be counted in multiple categories. For example, an 'in process' task with overdue due date will be counted in both WIP and OD. OD is counted only for tasks with status 'in process'."
        });

    } catch (error) {
        console.error("Task summary report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task summary report",
            error: error.message
        });
    }
});

// Task Detailed Report - Get tasks by category with full details
router.get("/task-detailed", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            category,
            service_id,
            page_no = 1,
            limit = 20,
            search,
            status_filter,
            staff_username
        } = req.query;

        const categoryDescriptions = {
            "OD": "Overdue - Active tasks with due date passed",
            "DT": "Due Today - Active tasks due today",
            "D7": "Due within 7 Days - Active tasks due in next 7 days",
            "FT": "Future - Active tasks with due date beyond 7 days",
            "WIP": "In Progress - Tasks with status 'in process'",
            "PFC": "Pending From Client",
            "PFD": "Pending From Department",
            "CPL": "Complete",
            "CNL": "Cancel",
            "ALL": "All Tasks"
        };


        // Helper function to get due date category
        function getDueDateCategory(dueDate) {
            if (!dueDate) return null;

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const dueDateObj = new Date(dueDate);
            dueDateObj.setHours(0, 0, 0, 0);

            const diffDays = Math.ceil((dueDateObj - today) / (1000 * 60 * 60 * 24));

            if (diffDays < 0) return 'OD';
            else if (diffDays === 0) return 'DT';
            else if (diffDays <= 7) return 'D7';
            else return 'FT';
        }

        // Helper function to get status category
        function getStatusCategory(status) {
            if (status === 'in process') return 'WIP';
            if (status === 'pending from client') return 'PFC';
            if (status === 'pending from department') return 'PFD';
            if (status === 'complete') return 'CPL';
            if (status === 'cancel') return 'CNL';
            return null;
        }

        // Helper function to check if task is active
        function isTaskActive(status) {
            return status !== 'complete' && status !== 'cancel';
        }

        // Helper function to format time duration
        function formatTimeDuration(totalSeconds) {
            if (!totalSeconds || totalSeconds <= 0) return '0 minutes';

            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            const parts = [];
            if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
            if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
            if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
            if (seconds > 0 && parts.length === 0) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);

            return parts.join(', ');
        }

        // VALIDATION: category is required
        const validCategories = ['OD', 'DT', 'D7', 'FT', 'WIP', 'PFC', 'PFD', 'CPL', 'CNL', 'ALL'];

        if (!category) {
            return res.status(400).json({
                success: false,
                message: "Category is required",
                valid_categories: validCategories
            });
        }

        if (!validCategories.includes(category)) {
            return res.status(400).json({
                success: false,
                message: `Invalid category. Valid categories are: ${validCategories.join(', ')}`
            });
        }

        // Pagination setup
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        // Build WHERE conditions
        let whereConditions = "t.branch_id = ?";
        const queryParams = [branch_id];

        // Apply service_id filter if provided
        if (service_id && String(service_id).trim() !== "") {
            whereConditions += ` AND t.service_id = ?`;
            queryParams.push(String(service_id).trim());
        }

        // Apply search filter if provided
        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            whereConditions += ` AND (s.name LIKE ? OR f.firm_name LIKE ? OR p.name LIKE ? OR t.task_id LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        // Apply status filter if provided
        if (status_filter && String(status_filter).trim() !== "") {
            const validStatuses = ['in process', 'pending from client', 'pending from department', 'complete', 'cancel'];
            if (validStatuses.includes(status_filter)) {
                whereConditions += ` AND t.status = ?`;
                queryParams.push(status_filter);
            }
        }

        // Apply staff filter if provided (tasks assigned to this staff)
        const staffUsernameFilter = staff_username && String(staff_username).trim() !== "" && String(staff_username).trim() !== "all"
            ? String(staff_username).trim()
            : null;

        if (staffUsernameFilter) {
            whereConditions += ` AND EXISTS (
                SELECT 1 FROM task_staffs ts
                WHERE ts.task_id = t.task_id
                  AND ts.branch_id = t.branch_id
                  AND ts.username = ?
                  AND (ts.is_deleted = '0' OR ts.is_deleted = 0)
            )`;
            queryParams.push(staffUsernameFilter);
        }

        // Apply category-specific filters in SQL
        if (category !== 'ALL') {
            if (['WIP', 'PFC', 'PFD', 'CPL', 'CNL'].includes(category)) {
                // For status categories - filter by task status directly
                let statusValue = '';
                if (category === 'WIP') statusValue = 'in process';
                else if (category === 'PFC') statusValue = 'pending from client';
                else if (category === 'PFD') statusValue = 'pending from department';
                else if (category === 'CPL') statusValue = 'complete';
                else if (category === 'CNL') statusValue = 'cancel';

                whereConditions += ` AND t.status = ?`;
                queryParams.push(statusValue);
            }
        }

        // Get tasks with their details
        const tasksQuery = `
            SELECT DISTINCT
                t.task_id,
                t.service_id,
                t.username,
                t.firm_id,
                t.task_type,
                t.due_date,
                t.status,
                t.fees,
                t.total,
                t.create_date,
                t.create_by,
                t.complete_date,
                t.complete_by,
                t.billing_status,
                t.has_ca,
                t.ca_id,
                t.has_agent,
                t.agent_id,
                t.target_date,
                t.in_user,
                s.name as service_name,
                f.firm_name,
                f.username as firm_username,
                f.pan_no as firm_pan_no,
                f.file_no as firm_file_no,
                p.name as client_name,
                p.email as client_email,
                p.mobile as client_phone,
                p.address_line_1 as client_address,
                'normal' AS task_kind
            FROM tasks t
            LEFT JOIN services s ON t.service_id = s.service_id
            LEFT JOIN firms f ON t.firm_id = f.firm_id AND f.branch_id = t.branch_id
            LEFT JOIN profile p ON t.username = p.username
            WHERE ${whereConditions}
            ORDER BY t.create_date DESC
        `;

        let allTasks = await pool.query(tasksQuery, queryParams);
        allTasks = allTasks[0];

        // 2. Query compliance schedules (Recurring Tasks)
        let complianceConditions = "f.branch_id = ? AND f.is_deleted = '0'";
        const complianceParams = [branch_id];

        if (service_id && String(service_id).trim() !== "") {
            complianceConditions += ` AND ca.service_id = ?`;
            complianceParams.push(String(service_id).trim());
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            complianceConditions += ` AND (s.name LIKE ? OR f.firm_name LIKE ? OR p.name LIKE ? OR cs.schedule_id LIKE ?)`;
            complianceParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        if (status_filter && String(status_filter).trim() !== "") {
            let mappedStatus = null;
            if (status_filter === 'complete') mappedStatus = 'Complete';
            else if (status_filter === 'cancel') mappedStatus = 'N/A';
            else if (status_filter === 'in process') mappedStatus = 'Outsource';
            else if (status_filter === 'pending from client') mappedStatus = 'Pending From Client';
            else if (status_filter === 'pending from department') mappedStatus = 'Pending From The Department';

            if (mappedStatus) {
                complianceConditions += ` AND cs.status = ?`;
                complianceParams.push(mappedStatus);
            } else {
                complianceConditions += ` AND 1 = 0`; // Force empty result
            }
        }

        if (staffUsernameFilter) {
            complianceConditions += ` AND FIND_IN_SET(?, REPLACE(IFNULL(ca.employee_username, ''), ' ', '')) > 0`;
            complianceParams.push(staffUsernameFilter);
        }

        if (category !== 'ALL' && ['WIP', 'PFC', 'PFD', 'CPL', 'CNL'].includes(category)) {
            let statusValue = '';
            if (category === 'WIP') statusValue = 'Outsource';
            else if (category === 'PFC') statusValue = 'Pending From Client';
            else if (category === 'PFD') statusValue = 'Pending From The Department';
            else if (category === 'CPL') statusValue = 'Complete';
            else if (category === 'CNL') statusValue = 'N/A';

            complianceConditions += ` AND cs.status = ?`;
            complianceParams.push(statusValue);
        }

        const complianceQuery = `
            SELECT DISTINCT
                cs.schedule_id AS task_id,
                ca.service_id,
                f.username AS username,
                ca.firm_id,
                cs.due_date,
                cs.status,
                cs.amount AS fees,
                0.00 AS tax_rate,
                0.00 AS tax_value,
                cs.amount AS total,
                ca.create_date AS create_date,
                NULL AS create_by,
                cs.completed_at AS complete_date,
                cs.completed_by AS complete_by,
                CASE WHEN cs.invoice_id IS NOT NULL THEN '1' ELSE '0' END AS billing_status,
                CASE WHEN ca.ca_id IS NOT NULL THEN '1' ELSE '0' END AS has_ca,
                ca.ca_id,
                '0' AS has_agent,
                NULL AS agent_id,
                NULL AS target_date,
                NULL AS in_user,
                s.name AS service_name,
                f.firm_name,
                f.username AS firm_username,
                f.pan_no AS firm_pan_no,
                f.file_no AS firm_file_no,
                p.name AS client_name,
                p.email AS client_email,
                p.mobile AS client_phone,
                p.address_line_1 AS client_address,
                'recurring' AS task_kind,
                'compliance' AS task_type,
                ca.employee_username
            FROM compliance_schedules cs
            INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
            INNER JOIN services s ON ca.service_id = s.service_id
            INNER JOIN firms f ON ca.firm_id = f.firm_id
            LEFT JOIN profile p ON f.username = p.username
            WHERE ${complianceConditions}
            ORDER BY ca.create_date DESC
        `;

        let [complianceTasks] = await pool.query(complianceQuery, complianceParams);

        // Normalize compliance tasks status to match normal tasks
        const normalizedComplianceTasks = complianceTasks.map(t => {
            let normalizedStatus = 'pending';
            if (t.status === 'Complete') normalizedStatus = 'complete';
            else if (t.status === 'N/A' || t.status === 'Cancel') normalizedStatus = 'cancel';
            else if (t.status === 'Pending From Client') normalizedStatus = 'pending from client';
            else if (t.status === 'Pending From The Department') normalizedStatus = 'pending from department';

            return {
                ...t,
                status: normalizedStatus
            };
        });

        // 3. Combine and Filter
        let combinedTasks = [];

        if (['OD', 'DT', 'D7', 'FT'].includes(category)) {
            // Filter normal tasks
            for (const task of allTasks) {
                if (isTaskActive(task.status)) {
                    if (getDueDateCategory(task.due_date) === category) {
                        combinedTasks.push(task);
                    }
                }
            }
            // Filter compliance tasks
            for (const task of normalizedComplianceTasks) {
                if (isTaskActive(task.status)) {
                    if (getDueDateCategory(task.due_date) === category) {
                        combinedTasks.push(task);
                    }
                }
            }
        } else {
            combinedTasks = [...allTasks, ...normalizedComplianceTasks];
        }

        // Deduplicate by task_id
        const uniqueTasks = [];
        const taskIds = new Set();

        for (const task of combinedTasks) {
            if (!taskIds.has(task.task_id)) {
                taskIds.add(task.task_id);
                uniqueTasks.push(task);
            }
        }

        // Sort combined list by create_date DESC
        uniqueTasks.sort((a, b) => {
            const dateA = new Date(a.create_date || 0);
            const dateB = new Date(b.create_date || 0);
            return dateB - dateA;
        });

        const total = uniqueTasks.length;

        // PAGINATION SLICE (Optimize queries to run only on paginated subset)
        const paginatedSlice = uniqueTasks.slice(offset, offset + limitNum);

        // Prepare final data with all details for current page only
        const finalData = [];

        for (const task of paginatedSlice) {
            // Get staff assigned to this task
            let staffList = [];
            if (task.task_kind === 'recurring') {
                const usernames = (task.employee_username || "")
                    .split(",")
                    .map(u => u.trim())
                    .filter(Boolean);

                for (const uname of usernames) {
                    const staffProfile = await USER_SNIPPED_DATA(uname);
                    let staffStatus = '1';
                    let designation = 'Staff';
                    try {
                        const [bmRows] = await pool.query(
                            "SELECT designation, status FROM branch_mapping WHERE username = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1",
                            [uname, branch_id]
                        );
                        if (bmRows.length > 0) {
                            designation = bmRows[0].designation || 'Staff';
                            staffStatus = bmRows[0].status || '1';
                        }
                    } catch (e) { }

                    staffList.push({
                        username: uname,
                        name: staffProfile?.name || uname,
                        designation: designation,
                        status: staffStatus,
                        profile: staffProfile
                    });
                }
            } else {
                try {
                    const [staffRows] = await pool.query(
                        `SELECT DISTINCT ts.username, bm.designation, bm.status as staff_status
                         FROM task_staffs ts
                         LEFT JOIN branch_mapping bm ON ts.username = bm.username AND bm.branch_id = ? AND bm.is_deleted = '0'
                         WHERE ts.task_id = ? AND (ts.is_deleted = '0' OR ts.is_deleted = 0)`,
                        [branch_id, task.task_id]
                    );

                    for (const staff of staffRows) {
                        const staffProfile = await USER_SNIPPED_DATA(staff.username);
                        staffList.push({
                            username: staff.username,
                            name: staffProfile?.name || staff.username,
                            designation: staff.designation,
                            status: staff.staff_status,
                            profile: staffProfile
                        });
                    }
                } catch (err) {
                    console.log("Error fetching staff for task", task.task_id, err.message);
                }
            }

            // Get CA and Agent details
            let caDetails = null;
            let agentDetails = null;

            if (task.has_ca === '1' && task.ca_id) {
                caDetails = await USER_SNIPPED_DATA(task.ca_id);
            }

            if (task.has_agent === '1' && task.agent_id) {
                agentDetails = await USER_SNIPPED_DATA(task.agent_id);
            }

            // Get subtasks for this task
            let subtasksList = [];
            try {
                const [subtaskRows] = await pool.query(
                    `SELECT s.subtask_id, s.type, s.text, s.service_id, s.status, s.create_date,
                            sv.name as service_name
                     FROM subtask s
                     LEFT JOIN services sv ON s.service_id = sv.service_id
                     WHERE s.task_id = ? AND (s.is_deleted = '0' OR s.is_deleted = 0)
                     ORDER BY s.id ASC`,
                    [task.task_id]
                );

                subtasksList = subtaskRows.map(st => ({
                    subtask_id: st.subtask_id,
                    type: st.type === 'task' ? 'service' : 'text',
                    content: st.type === 'text' ? st.text : null,
                    service: st.type === 'task' ? {
                        service_id: st.service_id,
                        name: st.service_name
                    } : null,
                    status: st.status,
                    create_date: st.create_date
                }));
            } catch (err) {
                console.log("Error fetching subtasks for task", task.task_id, err.message);
            }

            // Get notes for this task (limited to recent)
            let notesList = [];
            try {
                const [noteRows] = await pool.query(
                    `SELECT note_id, type, subject, note, create_date, create_by
                     FROM notes 
                     WHERE task_id = ? AND note_type = 'task' AND (is_deleted = '0' OR is_deleted = 0)
                     ORDER BY id DESC LIMIT 10`,
                    [task.task_id]
                );

                for (const note of noteRows) {
                    const noteCreator = await USER_SNIPPED_DATA(note.create_by);
                    notesList.push({
                        note_id: note.note_id,
                        type: note.type,
                        subject: note.subject,
                        content: note.type === 'text' ? note.note : null,
                        file: note.type !== 'text' ? note.note : null,
                        create_date: note.create_date,
                        created_by: noteCreator
                    });
                }
            } catch (err) {
                console.log("Error fetching notes for task", task.task_id, err.message);
            }

            // Get timelogs for this task
            let timelogList = [];
            let totalTimeSpent = 0;
            try {
                const [timelogRows] = await pool.query(
                    `SELECT timelog_id, staff_username, work_name, start_datetime, end_datetime, total_seconds, create_date
                     FROM timelogs 
                     WHERE task_id = ? AND branch_id = ? AND is_deleted = '0'
                     ORDER BY start_datetime DESC`,
                    [task.task_id, branch_id]
                );

                totalTimeSpent = timelogRows.reduce((sum, tl) => sum + (tl.total_seconds || 0), 0);

                for (const tl of timelogRows) {
                    const staffProfile = await USER_SNIPPED_DATA(tl.staff_username);
                    timelogList.push({
                        timelog_id: tl.timelog_id,
                        staff: {
                            username: tl.staff_username,
                            profile: staffProfile
                        },
                        work_name: tl.work_name,
                        start_datetime: tl.start_datetime,
                        end_datetime: tl.end_datetime,
                        total_seconds: tl.total_seconds,
                        formatted_time: formatTimeDuration(tl.total_seconds),
                        create_date: tl.create_date
                    });
                }
            } catch (err) {
                console.log("Error fetching timelogs for task", task.task_id, err.message);
            }

            // Get documents for this task
            let documentsList = [];
            try {
                const [docRows] = await pool.query(
                    `SELECT document_id, name, remark, file, size, mime_type, create_date
                     FROM documents 
                     WHERE task_id = ? AND branch_id = ? AND is_deleted = '0'
                     ORDER BY id DESC LIMIT 5`,
                    [task.task_id, branch_id]
                );

                documentsList = docRows.map(doc => ({
                    document_id: doc.document_id,
                    name: doc.name,
                    remark: doc.remark,
                    file: doc.file,
                    size: doc.size,
                    mime_type: doc.mime_type,
                    create_date: doc.create_date
                }));
            } catch (err) {
                console.log("Error fetching documents for task", task.task_id, err.message);
            }

            // Get created by user details
            const createdByUser = await USER_SNIPPED_DATA(task.create_by);
            const completedByUser = task.complete_by ? await USER_SNIPPED_DATA(task.complete_by) : null;

            // Same shape as routes/task.js list endpoint: snipped profile or null
            const inUser = normalizeInUser(task.in_user);
            const inUserData = inUser ? await USER_SNIPPED_DATA(inUser) : null;

            finalData.push({
                task_id: task.task_id,
                task_type: task.task_type || null,
                service: {
                    service_id: task.service_id,
                    service_name: task.service_name
                },
                client: {
                    username: task.username,
                    name: task.client_name,
                    email: task.client_email,
                    phone: task.client_phone,
                    address: task.client_address
                },
                firm: {
                    firm_id: task.firm_id,
                    firm_name: task.firm_name,
                    username: task.firm_username,
                    pan_no: task.firm_pan_no || null,
                    file_no: task.firm_file_no || null,
                },
                task_details: {
                    status: task.status,
                    status_category: getStatusCategory(task.status),
                    due_date: task.due_date,
                    due_category: getDueDateCategory(task.due_date),
                    target_date: task.target_date,
                    is_active: isTaskActive(task.status),
                    create_date: task.create_date,
                    complete_date: task.complete_date,
                    created_by: createdByUser,
                    completed_by: completedByUser,
                    task_kind: task.task_kind,
                    task_type: task.task_type || null,
                },
                in_user: inUserData,
                financials: {
                    fees: parseFloat(task.fees || 0),
                    tax_rate: 0,
                    tax_value: 0,
                    total: parseFloat(task.total || 0),
                    billing_status: task.billing_status == '0' ? 'pending' :
                        task.billing_status == '1' ? 'complete' : 'non_billable'
                },
                assignment: {
                    ca: caDetails,
                    agent: agentDetails,
                    staff_count: staffList.length,
                    staff: staffList
                },
                subtasks: {
                    total: subtasksList.length,
                    pending: subtasksList.filter(s => s.status === 'pending').length,
                    in_process: subtasksList.filter(s => s.status === 'in process').length,
                    completed: subtasksList.filter(s => s.status === 'complete').length,
                    list: subtasksList
                },
                notes: {
                    total: notesList.length,
                    recent: notesList
                },
                timelogs: {
                    total_entries: timelogList.length,
                    total_seconds: totalTimeSpent,
                    total_time_formatted: formatTimeDuration(totalTimeSpent),
                    list: timelogList.slice(0, 5)
                },
                documents: {
                    total: documentsList.length,
                    recent: documentsList
                }
            });
        }

        // Summary calculations based on full uniqueTasks list (not paginated subset)
        const summaryObj = {
            category: category,
            category_description: categoryDescriptions[category],
            total_tasks: total,
            total_services_affected: new Set(uniqueTasks.map(t => t.service_id)).size,
            total_clients_affected: new Set(uniqueTasks.map(t => t.username)).size,
            total_firms_affected: new Set(uniqueTasks.map(t => t.firm_id)).size,
            total_revenue: uniqueTasks.reduce((sum, t) => sum + parseFloat(t.total || 0), 0)
        };

        return res.status(200).json({
            success: true,
            message: `Task detailed report for category: ${category}`,
            data: finalData,
            summary: summaryObj,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total: total,
                total_pages: Math.ceil(total / limitNum) || 0,
                has_more: offset + finalData.length < total
            },
            filters_applied: {
                category: category,
                service_id: service_id || "all",
                staff_username: staffUsernameFilter || "all",
                search: search || null,
                status_filter: status_filter || null
            },
            category_legend: {
                "OD": "Overdue - Active tasks with due date passed",
                "DT": "Due Today - Active tasks due today",
                "D7": "Due within 7 Days - Active tasks due in next 7 days",
                "FT": "Future - Active tasks with due date beyond 7 days",
                "WIP": "In Progress - Tasks with status 'in process'",
                "PFC": "Pending From Client",
                "PFD": "Pending From Department",
                "CPL": "Complete",
                "CNL": "Cancel"
            }
        });

    } catch (error) {
        console.error("Task detailed report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task detailed report",
            error: error.message
        });
    }
});
// dashboard-summary endpoint 

router.get("/dashboard-summary", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || '';
        const hasPerm = await checkUserPermission(username, branch_id, 'card_dashboard_statistics');
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }

        // Get today's date for comparison
        const today = new Date();
        const todayDateStr = today.toISOString().split('T')[0];

        // 1. Total Client Count (active clients from profile table)
        const [totalClientsResult] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM profile p
             INNER JOIN clients c ON p.username = c.username 
             WHERE c.branch_id = ? 
             AND c.is_deleted = '0' 
             AND c.status = '1'
             AND p.status = '1'`,
            [branch_id]
        );
        const totalClient = totalClientsResult[0]?.total || 0;

        // 2. New Client Count (clients created today)
        const [newClientsResult] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM clients 
             WHERE branch_id = ? 
             AND is_deleted = '0' 
             AND status = '1'
             AND DATE(create_date) = CURDATE()`,
            [branch_id]
        );
        const newClient = newClientsResult[0]?.total || 0;

        // 3. Active Client Count
        // Based on tasks table, clients are linked through username or firm_id
        let activeClient = 0;
        try {
            const [activeClientsResult] = await pool.query(
                `SELECT COUNT(DISTINCT c.id) as total 
                 FROM clients c
                 INNER JOIN tasks t ON (t.username = c.username OR t.firm_id = c.id)
                 WHERE c.branch_id = ? 
                 AND c.is_deleted = '0' 
                 AND c.status = '1'
                 AND t.branch_id = ?
                 AND t.status != 'cancel'`,
                [branch_id, branch_id]
            );
            activeClient = activeClientsResult[0]?.total || 0;
        } catch (err) {
            // Fallback: count all active clients
            console.log("Could not link clients to tasks, using fallback");
            const [fallbackResult] = await pool.query(
                `SELECT COUNT(*) as total 
                 FROM clients 
                 WHERE branch_id = ? 
                 AND is_deleted = '0' 
                 AND status = '1'`,
                [branch_id]
            );
            activeClient = fallbackResult[0]?.total || 0;
        }

        // 4. Net Profit (from transactions table - note the plural 'transactions')
        const [netProfitResult] = await pool.query(
            `SELECT 
                COALESCE(SUM(CASE WHEN LOWER(transaction_type) IN ('credit', 'receive', 'received', 'sale') THEN amount ELSE 0 END), 0) as total_income,
                COALESCE(SUM(CASE WHEN LOWER(transaction_type) IN ('debit', 'payment', 'purchase', 'pay') THEN amount ELSE 0 END), 0) as total_expense,
                COALESCE(SUM(CASE 
                    WHEN LOWER(transaction_type) IN ('credit', 'receive', 'received', 'sale') THEN amount 
                    WHEN LOWER(transaction_type) IN ('debit', 'payment', 'purchase', 'pay') THEN -amount 
                    ELSE 0 
                END), 0) as net_profit
             FROM transactions 
             WHERE branch_id = ? 
             AND DATE(transaction_date) = CURDATE()`,
            [branch_id]
        );

        const netProfit = parseFloat(netProfitResult[0]?.net_profit || 0);
        const totalIncome = parseFloat(netProfitResult[0]?.total_income || 0);
        const totalExpense = parseFloat(netProfitResult[0]?.total_expense || 0);

        // 5. Total Staff Count (active staff from branch_mapping)
        const [totalStaffResult] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM branch_mapping 
             WHERE branch_id = ? 
             AND is_deleted = '0' 
             AND status = '1'`,
            [branch_id]
        );
        const totalStaff = totalStaffResult[0]?.total || 0;

        // 6. Present Today (staff who punched in today)
        const [presentTodayResult] = await pool.query(
            `SELECT COUNT(DISTINCT map_id) as total 
     FROM attendance 
     WHERE branch_id = ? 
     AND is_deleted = '0'
     AND DATE(punch_in_time) = CURDATE()`,  // Remove status filter
            [branch_id]
        );
        const presentToday = presentTodayResult[0]?.total || 0;
        // 7. Task Created Today
        const [tasksCreatedResult] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM tasks 
             WHERE branch_id = ? 
             AND DATE(create_date) = CURDATE()`,
            [branch_id]
        );
        const taskCreatedToday = tasksCreatedResult[0]?.total || 0;

        // 8. Task Completed Today (using complete_date)
        const [tasksCompletedResult] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM tasks 
             WHERE branch_id = ? 
             AND status = 'complete'
             AND DATE(complete_date) = CURDATE()`,
            [branch_id]
        );
        const taskCompletedToday = tasksCompletedResult[0]?.total || 0;

        // Additional helpful metrics
        // Pending tasks (not complete or cancel)
        const [pendingTasksResult] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM tasks 
             WHERE branch_id = ? 
             AND status NOT IN ('complete', 'cancel')`,
            [branch_id]
        );
        const pendingTasks = pendingTasksResult[0]?.total || 0;

        // Overdue tasks (due_date passed and not complete/cancel)
        const [overdueTasksResult] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM tasks 
             WHERE branch_id = ? 
             AND status NOT IN ('complete', 'cancel')
             AND due_date < CURDATE()`,
            [branch_id]
        );
        const overdueTasks = overdueTasksResult[0]?.total || 0;

        // Tasks by status breakdown
        const [tasksByStatus] = await pool.query(
            `SELECT 
                status,
                COUNT(*) as count
             FROM tasks 
             WHERE branch_id = ? 
             GROUP BY status`,
            [branch_id]
        );

        const statusBreakdown = {};
        tasksByStatus.forEach(item => {
            statusBreakdown[item.status] = item.count;
        });

        // Billing status breakdown
        const [tasksByBillingStatus] = await pool.query(
            `SELECT 
                billing_status,
                COUNT(*) as count,
                SUM(total) as total_amount
             FROM tasks 
             WHERE branch_id = ? 
             GROUP BY billing_status`,
            [branch_id]
        );

        const billingBreakdown = {
            pending: { count: 0, amount: 0 },
            complete: { count: 0, amount: 0 },
            non_billable: { count: 0, amount: 0 }
        };

        tasksByBillingStatus.forEach(item => {
            if (item.billing_status == 0) {
                billingBreakdown.pending.count = item.count;
                billingBreakdown.pending.amount = parseFloat(item.total_amount || 0);
            } else if (item.billing_status == 1) {
                billingBreakdown.complete.count = item.count;
                billingBreakdown.complete.amount = parseFloat(item.total_amount || 0);
            } else if (item.billing_status == 2) {
                billingBreakdown.non_billable.count = item.count;
                billingBreakdown.non_billable.amount = parseFloat(item.total_amount || 0);
            }
        });

        // Get today's transaction breakdown
        const [todayTransactions] = await pool.query(
            `SELECT 
                transaction_type,
                COUNT(*) as count,
                SUM(amount) as total_amount
             FROM transactions 
             WHERE branch_id = ? 
             AND DATE(transaction_date) = CURDATE()
             GROUP BY transaction_type`,
            [branch_id]
        );

        const transactionBreakdown = {
            credit: { count: 0, amount: 0 },
            debit: { count: 0, amount: 0 }
        };

        if (todayTransactions && todayTransactions.length > 0) {
            todayTransactions.forEach(trans => {
                const type = (trans.transaction_type || '').toLowerCase();
                if (['credit', 'receive', 'received', 'sale'].includes(type)) {
                    transactionBreakdown.credit.count += trans.count;
                    transactionBreakdown.credit.amount += parseFloat(trans.total_amount || 0);
                } else if (['debit', 'payment', 'purchase', 'pay'].includes(type)) {
                    transactionBreakdown.debit.count += trans.count;
                    transactionBreakdown.debit.amount += parseFloat(trans.total_amount || 0);
                }
            });
        }

        // 9. Recurring Tasks Summary
        const [recurringSchedules] = await pool.query(
            `SELECT 
                cs.status,
                cs.due_date
             FROM compliance_schedules cs
             INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
             INNER JOIN firms f ON ca.firm_id = f.firm_id
             WHERE f.branch_id = ? AND f.is_deleted = '0'`,
            [branch_id]
        );

        let totalRecurringTasks = recurringSchedules.length;
        let overdueRecurringTasks = 0;
        const recurringStatusBreakdown = {
            'Pending From The Department': 0,
            'Pending From Client': 0,
            'Complete': 0,
            'Cancel': 0,
            'N/A': 0
        };
        const recurringDueDateBreakdown = {
            'OD': 0, // Overdue
            'DT': 0, // Due Today
            'D7': 0, // Due in 7 Days
            'FT': 0  // Future
        };

        for (const cs of recurringSchedules) {
            const status = cs.status || 'Pending From The Department';
            recurringStatusBreakdown[status] = (recurringStatusBreakdown[status] || 0) + 1;

            if (status === 'Pending From The Department' || status === 'Pending From Client') {
                const dueDateCategory = getDueDateCategory(cs.due_date);
                if (dueDateCategory) {
                    recurringDueDateBreakdown[dueDateCategory]++;
                    if (dueDateCategory === 'OD') {
                        overdueRecurringTasks++;
                    }
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "Dashboard summary retrieved successfully",
            data: {
                total_client: totalClient,
                new_client: newClient,
                active_client: activeClient,
                net_profit: netProfit,
                total_staff: totalStaff,
                present_today: presentToday,
                task_created_today: taskCreatedToday,
                task_completed_today: taskCompletedToday,
                recurring_task_summary: {
                    total_tasks: totalRecurringTasks,
                    overdue_tasks: overdueRecurringTasks,
                    status_breakdown: recurringStatusBreakdown,
                    due_date_breakdown: recurringDueDateBreakdown
                },
                additional_metrics: {
                    pending_tasks: pendingTasks,
                    overdue_tasks: overdueTasks,
                    total_income_today: totalIncome,
                    total_expense_today: totalExpense,
                    transaction_breakdown: transactionBreakdown,
                    task_status_breakdown: statusBreakdown,
                    billing_status_breakdown: billingBreakdown
                }
            },
            report_date: todayDateStr,
            calculation_note: "Net Profit = Total Credit (Income) - Total Debit (Expense) from transactions table for today"
        });

    } catch (error) {
        console.error("Dashboard summary report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard summary",
            error: error.message
        });
    }
});

router.get("/dashboard-summary-detail/:metric", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || '';
        const hasPerm = await checkUserPermission(username, branch_id, 'card_dashboard_statistics');
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }
        const { metric } = req.params;
        const { page_no = 1, limit = 20, search = '' } = req.query;

        const offset = (parseInt(page_no) - 1) * parseInt(limit);

        let query = "";
        let countQuery = "";
        let params = [];
        let countParams = [];

        switch (metric) {
            case 'total_client':
                query = `
                    SELECT 
                        c.id as client_id,
                        p.name as client_name,
                        p.email,
                        p.mobile,
                        p.country_code,
                        CONCAT_WS(', ', p.address_line_1, p.address_line_2, p.village_town, p.city, p.district, p.state) as address,
                        c.status,
                        c.create_date,
                        (
                            SELECT COUNT(*) FROM tasks 
                            WHERE (username = c.username OR firm_id = c.id) 
                            AND branch_id = ?
                        ) as total_tasks,
                        (
                            SELECT COALESCE(SUM(total), 0) FROM tasks 
                            WHERE (username = c.username OR firm_id = c.id) 
                            AND branch_id = ?
                        ) as total_revenue
                    FROM clients c
                    INNER JOIN profile p ON c.username = p.username
                    WHERE c.branch_id = ? 
                    AND c.is_deleted = '0'
                    AND p.user_type = 'client'
                    ${search ? `AND (p.name LIKE ? OR p.email LIKE ? OR p.mobile LIKE ?)` : ''}
                    GROUP BY c.id
                    ORDER BY c.create_date DESC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(*) as total
                    FROM clients c
                    INNER JOIN profile p ON c.username = p.username
                    WHERE c.branch_id = ? AND c.is_deleted = '0' AND p.user_type = 'client'
                    ${search ? `AND (p.name LIKE ? OR p.email LIKE ? OR p.mobile LIKE ?)` : ''}
                `;

                params = [branch_id, branch_id, branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern, searchPattern);
                }
                break;

            case 'new_client':
                query = `
                    SELECT 
                        c.id as client_id,
                        p.name as client_name,
                        p.email,
                        p.mobile,
                        p.country_code,
                        c.create_date,
                        c.status,
                        (
                            SELECT COUNT(*) FROM tasks 
                            WHERE (username = c.username OR firm_id = c.id) 
                            AND branch_id = ?
                        ) as total_tasks
                    FROM clients c
                    INNER JOIN profile p ON c.username = p.username
                    WHERE c.branch_id = ? 
                    AND c.is_deleted = '0'
                    AND DATE(c.create_date) = CURDATE()
                    AND p.user_type = 'client'
                    ${search ? `AND (p.name LIKE ? OR p.email LIKE ? OR p.mobile LIKE ?)` : ''}
                    GROUP BY c.id
                    ORDER BY c.create_date DESC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(*) as total
                    FROM clients c
                    INNER JOIN profile p ON c.username = p.username
                    WHERE c.branch_id = ? 
                    AND c.is_deleted = '0'
                    AND DATE(c.create_date) = CURDATE()
                    AND p.user_type = 'client'
                    ${search ? `AND (p.name LIKE ? OR p.email LIKE ? OR p.mobile LIKE ?)` : ''}
                `;

                params = [branch_id, branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern, searchPattern);
                }
                break;

            case 'active_client':
                // FIXED: Use EXISTS instead of INNER JOIN to avoid duplicates
                query = `
                    SELECT 
                        c.id as client_id,
                        p.name as client_name,
                        p.email,
                        p.mobile,
                        p.country_code,
                        c.status,
                        (
                            SELECT COUNT(*) FROM tasks 
                            WHERE (username = c.username OR firm_id = c.id) 
                            AND branch_id = ? AND status NOT IN ('complete', 'cancel')
                        ) as active_tasks,
                        (
                            SELECT MAX(due_date) FROM tasks 
                            WHERE (username = c.username OR firm_id = c.id) 
                            AND branch_id = ? AND status NOT IN ('complete', 'cancel')
                        ) as latest_due_date
                    FROM clients c
                    INNER JOIN profile p ON c.username = p.username
                    WHERE c.branch_id = ? 
                    AND c.is_deleted = '0'
                    AND c.status = '1'
                    AND p.user_type = 'client'
                    AND EXISTS (
                        SELECT 1 FROM tasks t 
                        WHERE (t.username = c.username OR t.firm_id = c.id) 
                        AND t.branch_id = ? 
                        AND t.status NOT IN ('complete', 'cancel')
                    )
                    ${search ? `AND (p.name LIKE ? OR p.email LIKE ? OR p.mobile LIKE ?)` : ''}
                    GROUP BY c.id
                    ORDER BY active_tasks DESC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(DISTINCT c.id) as total
                    FROM clients c
                    INNER JOIN profile p ON c.username = p.username
                    WHERE c.branch_id = ? 
                    AND c.is_deleted = '0'
                    AND c.status = '1'
                    AND p.user_type = 'client'
                    AND EXISTS (
                        SELECT 1 FROM tasks t 
                        WHERE (t.username = c.username OR t.firm_id = c.id) 
                        AND t.branch_id = ? 
                        AND t.status NOT IN ('complete', 'cancel')
                    )
                    ${search ? `AND (p.name LIKE ? OR p.email LIKE ? OR p.mobile LIKE ?)` : ''}
                `;

                params = [branch_id, branch_id, branch_id, branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id, branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern, searchPattern);
                }
                break;

            case 'net_profit':
                query = `
                    SELECT 
                        transaction_id,
                        transaction_type,
                        amount,
                        transaction_date,
                        description,
                        payment_mode,
                        reference_no,
                        created_by
                    FROM transactions
                    WHERE branch_id = ? 
                    AND DATE(transaction_date) = CURDATE()
                    ${search ? `AND (description LIKE ? OR reference_no LIKE ?)` : ''}
                    ORDER BY transaction_date DESC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(*) as total
                    FROM transactions
                    WHERE branch_id = ? 
                    AND DATE(transaction_date) = CURDATE()
                    ${search ? `AND (description LIKE ? OR reference_no LIKE ?)` : ''}
                `;

                params = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern);
                }
                break;

            case 'total_staff':
                query = `
                    SELECT 
                        bm.id as staff_id,
                        bm.name as staff_name,
                        bm.email,
                        bm.mobile,
                        bm.role,
                        bm.status,
                        bm.join_date,
                        (
                            SELECT COUNT(*) FROM task_assignments ta
                            WHERE ta.assign_id = bm.id AND ta.branch_id = ?
                        ) as assigned_tasks,
                        (
                            SELECT COUNT(DISTINCT DATE(punch_in_time)) FROM attendance a
                            WHERE a.map_id = bm.id AND a.branch_id = ? AND a.is_deleted = '0'
                        ) as total_present_days
                    FROM branch_mapping bm
                    WHERE bm.branch_id = ? 
                    AND bm.is_deleted = '0'
                    ${search ? `AND (bm.name LIKE ? OR bm.email LIKE ? OR bm.mobile LIKE ?)` : ''}
                    GROUP BY bm.id
                    ORDER BY bm.name ASC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(*) as total
                    FROM branch_mapping bm
                    WHERE bm.branch_id = ? AND bm.is_deleted = '0'
                    ${search ? `AND (bm.name LIKE ? OR bm.email LIKE ? OR bm.mobile LIKE ?)` : ''}
                `;

                params = [branch_id, branch_id, branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern, searchPattern);
                }
                break;

            case 'present_today':
                query = `
                    SELECT 
                        bm.id as staff_id,
                        bm.name as staff_name,
                        bm.email,
                        bm.mobile,
                        bm.role,
                        a.punch_in_time,
                        a.punch_out_time,
                        a.attendance_status,
                        TIMESTAMPDIFF(MINUTE, a.punch_in_time, COALESCE(a.punch_out_time, NOW())) as working_minutes
                    FROM attendance a
                    INNER JOIN branch_mapping bm ON a.map_id = bm.id
                    WHERE a.branch_id = ? 
                    AND a.is_deleted = '0'
                    AND DATE(a.punch_in_time) = CURDATE()
                    AND a.attendance_status IN ('present', 'late', 'half_day')
                    ${search ? `AND (bm.name LIKE ? OR bm.email LIKE ? OR bm.mobile LIKE ?)` : ''}
                    GROUP BY a.id
                    ORDER BY a.punch_in_time ASC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(DISTINCT a.map_id) as total
                    FROM attendance a
                    INNER JOIN branch_mapping bm ON a.map_id = bm.id
                    WHERE a.branch_id = ? 
                    AND a.is_deleted = '0'
                    AND DATE(a.punch_in_time) = CURDATE()
                    AND a.attendance_status IN ('present', 'late', 'half_day')
                    ${search ? `AND (bm.name LIKE ? OR bm.email LIKE ? OR bm.mobile LIKE ?)` : ''}
                `;

                params = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern, searchPattern);
                }
                break;

            case 'task_created_today':
                query = `
                    SELECT DISTINCT
                        t.task_id,
                        t.status,
                        t.create_date,
                        s.name as service_name,
                        p.name as client_name,
                        t.total as amount,
                        t.due_date
                    FROM tasks t
                    LEFT JOIN services s ON t.service_id = s.service_id
                    LEFT JOIN clients c ON (t.username = c.username OR t.firm_id = c.id)
                    LEFT JOIN profile p ON c.username = p.username
                    WHERE t.branch_id = ? 
                    AND DATE(t.create_date) = CURDATE()
                    ${search ? `AND (t.task_id LIKE ? OR s.name LIKE ? OR p.name LIKE ?)` : ''}
                    GROUP BY t.task_id
                    ORDER BY t.create_date DESC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(DISTINCT t.task_id) as total
                    FROM tasks t
                    WHERE t.branch_id = ? 
                    AND DATE(t.create_date) = CURDATE()
                    ${search ? `AND (t.task_id LIKE ? OR t.service_id IN (SELECT service_id FROM services WHERE name LIKE ?) OR t.username IN (SELECT username FROM profile WHERE name LIKE ?))` : ''}
                `;

                params = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern, searchPattern);
                }
                break;

            case 'task_completed_today':
                query = `
                    SELECT DISTINCT
                        t.task_id,
                        t.status,
                        t.complete_date,
                        s.name as service_name,
                        p.name as client_name,
                        t.total as amount,
                        t.due_date,
                        DATEDIFF(t.complete_date, t.due_date) as days_diff
                    FROM tasks t
                    LEFT JOIN services s ON t.service_id = s.service_id
                    LEFT JOIN clients c ON (t.username = c.username OR t.firm_id = c.id)
                    LEFT JOIN profile p ON c.username = p.username
                    WHERE t.branch_id = ? 
                    AND t.status = 'complete'
                    AND DATE(t.complete_date) = CURDATE()
                    ${search ? `AND (t.task_id LIKE ? OR s.name LIKE ? OR p.name LIKE ?)` : ''}
                    GROUP BY t.task_id
                    ORDER BY t.complete_date DESC
                    LIMIT ? OFFSET ?
                `;

                countQuery = `
                    SELECT COUNT(DISTINCT t.task_id) as total
                    FROM tasks t
                    WHERE t.branch_id = ? 
                    AND t.status = 'complete'
                    AND DATE(t.complete_date) = CURDATE()
                    ${search ? `AND (t.task_id LIKE ? OR t.service_id IN (SELECT service_id FROM services WHERE name LIKE ?) OR t.username IN (SELECT username FROM profile WHERE name LIKE ?))` : ''}
                `;

                params = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern, searchPattern);
                }
                params.push(parseInt(limit), offset);

                countParams = [branch_id];
                if (search) {
                    const searchPattern = `%${search}%`;
                    countParams.push(searchPattern, searchPattern, searchPattern);
                }
                break;

            default:
                return res.status(400).json({
                    success: false,
                    message: "Invalid metric parameter"
                });
        }

        // Execute queries
        const [data] = await pool.query(query, params);
        const [countResult] = await pool.query(countQuery, countParams);

        // Get summary for the metric
        let summary = {};

        if (metric === 'total_client' || metric === 'new_client' || metric === 'active_client' ||
            metric === 'task_created_today' || metric === 'task_completed_today') {

            switch (metric) {
                case 'total_client':
                    const [totalResult] = await pool.query(`
                        SELECT 
                            COUNT(*) as total,
                            SUM(CASE WHEN c.status = '1' THEN 1 ELSE 0 END) as active,
                            SUM(CASE WHEN c.status = '0' THEN 1 ELSE 0 END) as inactive
                        FROM clients c
                        INNER JOIN profile p ON c.username = p.username
                        WHERE c.branch_id = ? AND c.is_deleted = '0' AND p.user_type = 'client'
                    `, [branch_id]);
                    summary = totalResult[0] || {};
                    break;
                case 'new_client':
                    const [newResult] = await pool.query(`
                        SELECT 
                            COUNT(*) as total
                        FROM clients c
                        INNER JOIN profile p ON c.username = p.username
                        WHERE c.branch_id = ? 
                        AND c.is_deleted = '0'
                        AND DATE(c.create_date) = CURDATE()
                        AND p.user_type = 'client'
                    `, [branch_id]);
                    summary = newResult[0] || {};
                    break;
                case 'active_client':
                    const [activeResult] = await pool.query(`
                        SELECT COUNT(DISTINCT c.id) as total
                        FROM clients c
                        INNER JOIN profile p ON c.username = p.username
                        WHERE c.branch_id = ? 
                        AND c.is_deleted = '0'
                        AND c.status = '1'
                        AND p.user_type = 'client'
                        AND EXISTS (
                            SELECT 1 FROM tasks t 
                            WHERE (t.username = c.username OR t.firm_id = c.id) 
                            AND t.branch_id = ? 
                            AND t.status NOT IN ('complete', 'cancel')
                        )
                    `, [branch_id, branch_id]);
                    summary = activeResult[0] || {};
                    break;
                case 'task_created_today':
                    const [taskCreatedResult] = await pool.query(`
                        SELECT 
                            COUNT(*) as total,
                            SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as completed,
                            SUM(CASE WHEN status NOT IN ('complete', 'cancel') THEN 1 ELSE 0 END) as pending,
                            COALESCE(SUM(total), 0) as total_amount
                        FROM tasks 
                        WHERE branch_id = ? AND DATE(create_date) = CURDATE()
                    `, [branch_id]);
                    summary = taskCreatedResult[0] || {};
                    break;
                case 'task_completed_today':
                    const [taskCompletedResult] = await pool.query(`
                        SELECT 
                            COUNT(*) as total,
                            COALESCE(SUM(total), 0) as total_amount,
                            ROUND(AVG(DATEDIFF(complete_date, due_date)), 2) as avg_completion_days
                        FROM tasks 
                        WHERE branch_id = ? AND status = 'complete' AND DATE(complete_date) = CURDATE()
                    `, [branch_id]);
                    summary = taskCompletedResult[0] || {};
                    break;
            }
        }

        const total = countResult[0]?.total || 0;
        const totalPages = Math.ceil(total / parseInt(limit));

        return res.status(200).json({
            success: true,
            message: `${metric.replace(/_/g, ' ')} details retrieved successfully`,
            data: {
                items: data,
                summary: summary,
                pagination: {
                    page_no: parseInt(page_no),
                    limit: parseInt(limit),
                    total: total,
                    total_pages: totalPages,
                    has_next: parseInt(page_no) < totalPages,
                    has_prev: parseInt(page_no) > 1
                },
                metric: metric,
                generated_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error("Dashboard detail error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard details",
            error: error.message
        });
    }
});

router.get("/dashboard/quick-stats", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || '';
        const hasPerm = await checkUserPermission(username, branch_id, 'card_quick_stats');
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }

        // Pending Billing Count (from tasks table)
        // Pending Billing Count (from tasks table)
        const [pendingBilling] = await pool.query(
            `SELECT COUNT(*) AS total FROM tasks 
     WHERE branch_id = ? 
     AND status = 'complete' 
     AND billing_status IN (0, '0')`,
            [branch_id]
        );
        // Creditors: clients with negative net balance (GET_BALANCE rules)
        const [creditors] = await pool.query(
            clientBalanceCountSql("creditor"),
            clientBalanceCountParams(branch_id)
        );

        // Debtors: clients with positive net balance (GET_BALANCE rules)
        const [debtors] = await pool.query(
            clientBalanceCountSql("debtor"),
            clientBalanceCountParams(branch_id)
        );

        // Today Received: transaction_type = 'receive' or 'sale' or 'received'
        const [todayReceived] = await pool.query(
            `SELECT 
                COUNT(*) AS total_count,
                COALESCE(SUM(amount), 0) AS total_amount
             FROM transactions 
             WHERE branch_id = ? 
             AND DATE(transaction_date) = CURDATE()
             AND LOWER(transaction_type) IN ('receive', 'received', 'sale')`,
            [branch_id]
        );

        // Today Payment: transaction_type = 'payment' or 'purchase' or 'pay'
        const [todayPayment] = await pool.query(
            `SELECT 
                COUNT(*) AS total_count,
                COALESCE(SUM(ABS(amount)), 0) AS total_amount
             FROM transactions 
             WHERE branch_id = ? 
             AND DATE(transaction_date) = CURDATE()
             AND LOWER(transaction_type) IN ('payment', 'purchase', 'pay')`,
            [branch_id]
        );

        // Today Birthday - Join with clients table to filter by branch
        const [todayBirthday] = await pool.query(
            `SELECT 
                COUNT(*) AS total,
                p.username,
                p.name,
                p.mobile,
                p.email,
                p.date_of_birth
             FROM profile p
             INNER JOIN clients c ON c.username = p.username 
                AND c.branch_id = ?
                AND (c.is_deleted = '0' OR c.is_deleted = 0)
             WHERE p.status = '1'
             AND DATE_FORMAT(p.date_of_birth, '%m-%d') = DATE_FORMAT(CURDATE(), '%m-%d')
             GROUP BY p.username, p.name, p.mobile, p.email, p.date_of_birth`,
            [branch_id]
        );

        // Format birthdays array
        const birthdays = todayBirthday.map(row => ({
            username: row.username,
            name: row.name,
            mobile: row.mobile,
            email: row.email,
            date_of_birth: row.date_of_birth
        }));

        // Recurring Tasks Summary
        const [recurringSchedules] = await pool.query(
            `SELECT 
                cs.status,
                cs.due_date
             FROM compliance_schedules cs
             INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
             INNER JOIN firms f ON ca.firm_id = f.firm_id
             WHERE f.branch_id = ? AND f.is_deleted = '0'`,
            [branch_id]
        );

        let totalRecurringTasks = recurringSchedules.length;
        let overdueRecurringTasks = 0;
        const recurringStatusBreakdown = {
            'Pending From The Department': 0,
            'Pending From Client': 0,
            'Complete': 0,
            'Cancel': 0,
            'N/A': 0
        };
        const recurringDueDateBreakdown = {
            'OD': 0, // Overdue
            'DT': 0, // Due Today
            'D7': 0, // Due in 7 Days
            'FT': 0  // Future
        };

        for (const cs of recurringSchedules) {
            const status = cs.status || 'Pending From The Department';
            recurringStatusBreakdown[status] = (recurringStatusBreakdown[status] || 0) + 1;

            if (status === 'Pending From The Department' || status === 'Pending From Client') {
                const dueDateCategory = getDueDateCategory(cs.due_date);
                if (dueDateCategory) {
                    recurringDueDateBreakdown[dueDateCategory]++;
                    if (dueDateCategory === 'OD') {
                        overdueRecurringTasks++;
                    }
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "Dashboard quick stats retrieved successfully",
            data: {
                pending_billing: {
                    count: Number(pendingBilling[0]?.total) || 0
                },
                creditors: {
                    count: Number(creditors[0]?.total_count) || 0,
                    total_amount: Number(creditors[0]?.total_amount) || 0
                },
                debtors: {
                    count: Number(debtors[0]?.total_count) || 0,
                    total_amount: Number(debtors[0]?.total_amount) || 0  // POSITIVE balance
                },
                today_received: {
                    count: Number(todayReceived[0]?.total_count) || 0,
                    total_amount: Number(todayReceived[0]?.total_amount) || 0
                },
                today_payment: {
                    count: Number(todayPayment[0]?.total_count) || 0,
                    total_amount: Number(todayPayment[0]?.total_amount) || 0
                },
                today_birthday: {
                    count: todayBirthday.length,
                    list: birthdays
                },
                recurring_task_summary: {
                    total_tasks: totalRecurringTasks,
                    overdue_tasks: overdueRecurringTasks,
                    status_breakdown: recurringStatusBreakdown,
                    due_date_breakdown: recurringDueDateBreakdown
                }
            }
        });

    } catch (error) {
        console.error("Dashboard quick stats error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard quick stats",
            error: error.message
        });
    }
});

async function getFirmsMapForUsernames(branchId, usernames) {
    const firmsByUsername = {};
    if (!usernames.length) return firmsByUsername;

    const firmPlaceholders = usernames.map(() => "?").join(", ");
    const [firmRows] = await pool.query(
        `SELECT firm_id, username, firm_name, firm_type, pan_no, gst_no, tan_no, vat_no, cin_no, file_no,
                status, create_date, modify_date, address_line_1, address_line_2, city, state, pincode, country
         FROM firms
         WHERE branch_id = ?
           AND username IN (${firmPlaceholders})
           AND (is_deleted = '0' OR is_deleted = 0)
         ORDER BY COALESCE(modify_date, create_date) DESC`,
        [branchId, ...usernames]
    );

    for (const row of firmRows) {
        if (!firmsByUsername[row.username]) {
            firmsByUsername[row.username] = [];
        }
        firmsByUsername[row.username].push({
            firm_id: row.firm_id || "",
            firm_name: row.firm_name || "",
            firm_type: row.firm_type || "",
            gst_no: row.gst_no || "",
            pan_no: row.pan_no || "",
            tan_no: row.tan_no || "",
            vat_no: row.vat_no || "",
            cin_no: row.cin_no || "",
            file_no: row.file_no || "",
            status: row.status === "1",
            create_date: row.create_date,
            modify_date: row.modify_date,
            address: {
                address_line_1: row.address_line_1 || "",
                address_line_2: row.address_line_2 || "",
                city: row.city || "",
                state: row.state || "",
                pincode: row.pincode || "",
                country: row.country || "",
            },
        });
    }

    return firmsByUsername;
}

router.get("/dashboard/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || '';
        const hasPerm = await checkUserPermission(username, branch_id, 'card_quick_stats');
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }
        const {
            page_no = 1,
            limit = 10,
            type = "all",
            search = "",
            balance_after = 0
        } = req.query || {};

        const searchTerm = String(search || "").trim();
        const balanceAfter = Math.max(0, Number(balance_after) || 0);

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
        const offset = (pageNum - 1) * limitNum;

        let data = [];
        let total = 0;
        let debtorMeta = null;
        let creditorMeta = null;

        switch (type) {
            case "pending_billing":
                const [pendingTasks] = await pool.query(
                    `SELECT 
                        t.task_id,
                        t.username,
                        t.firm_id,
                        t.service_id,
                        t.fees,
                        t.total,
                        t.due_date,
                        t.target_date,
                        t.create_date,
                        p.name AS client_name,
                        p.mobile AS client_mobile,
                        f.firm_name,
                        s.name AS service_name
                     FROM tasks t
                     LEFT JOIN profile p ON p.username = t.username AND p.status = '1'
                     LEFT JOIN firms f ON f.firm_id = t.firm_id
                     LEFT JOIN services s ON s.service_id = t.service_id
                     WHERE t.branch_id = ? 
                     AND t.status = 'complete' 
                     AND t.billing_status = '0'
                     ORDER BY t.due_date ASC, t.create_date DESC
                     LIMIT ? OFFSET ?`,
                    [branch_id, limitNum, offset]
                );

                const [totalPending] = await pool.query(
                    `SELECT COUNT(*) AS total FROM tasks 
                     WHERE branch_id = ? AND status = 'complete' AND billing_status = '0'`,
                    [branch_id]
                );

                data = pendingTasks;
                total = totalPending[0]?.total || 0;
                break;

            case "creditors": {
                const [creditorDetails] = await pool.query(
                    clientBalanceListSql("creditor", searchTerm),
                    clientBalanceListParams(branch_id, limitNum, offset, searchTerm, "creditor", 0)
                );

                const creditorUsernames = creditorDetails.map((c) => c.username).filter(Boolean);
                const creditorFirmsMap = await getFirmsMapForUsernames(branch_id, creditorUsernames);

                const formattedCreditors = creditorDetails.map(creditor => {
                    const firms = creditorFirmsMap[creditor.username] || [];
                    const primaryFirm = firms[0] || null;
                    return {
                        username: creditor.username,
                        name: creditor.name || creditor.username,
                        guardian_name: creditor.guardian_name || '',
                        care_of: creditor.care_of || '',
                        pan_number: creditor.pan_number || '',
                        mobile: creditor.mobile || '',
                        email: creditor.email || '',
                        country_code: creditor.country_code || '',
                        firms,
                        firm: primaryFirm ? {
                            firm_id: primaryFirm.firm_id || '',
                            firm_name: primaryFirm.firm_name || '',
                            gst_no: primaryFirm.gst_no || '',
                            pan_no: primaryFirm.pan_no || ''
                        } : {
                            firm_id: creditor.firm_id || '',
                            firm_name: creditor.firm_name || '',
                            gst_no: creditor.gst_no || '',
                            pan_no: creditor.pan_no || ''
                        },
                        balance: -Number(Math.abs(creditor.total_balance)),
                        balance_type: "creditor"
                    };
                });

                const [totalCreditors] = await pool.query(
                    clientBalanceTotalSql("creditor", searchTerm),
                    clientBalanceTotalParams(branch_id, searchTerm, "creditor", 0)
                );

                data = formattedCreditors;
                total = totalCreditors[0]?.total || 0;
                creditorMeta = {
                    creditor_count: Number(totalCreditors[0]?.total) || 0,
                    creditor_balance: Math.abs(Number(totalCreditors[0]?.balance_sum) || 0)
                };
                break;
            }

            case "debtors": {
                const [debtorDetails] = await pool.query(
                    clientBalanceListSql("debtor", searchTerm, balanceAfter),
                    clientBalanceListParams(branch_id, limitNum, offset, searchTerm, "debtor", balanceAfter)
                );

                const debtorUsernames = debtorDetails.map((d) => d.username).filter(Boolean);
                const firmsByUsername = await getFirmsMapForUsernames(branch_id, debtorUsernames);

                const formattedDebtors = debtorDetails.map(debtor => {
                    const firms = firmsByUsername[debtor.username] || [];
                    const primaryFirm = firms[0] || null;
                    return {
                        username: debtor.username,
                        name: debtor.name || debtor.username,
                        guardian_name: debtor.guardian_name || '',
                        care_of: debtor.care_of || '',
                        pan_number: debtor.pan_number || '',
                        mobile: debtor.mobile || '',
                        email: debtor.email || '',
                        country_code: debtor.country_code || '',
                        firms,
                        firm: primaryFirm ? {
                            firm_id: primaryFirm.firm_id || '',
                            firm_name: primaryFirm.firm_name || '',
                            gst_no: primaryFirm.gst_no || '',
                            pan_no: primaryFirm.pan_no || ''
                        } : {
                            firm_id: debtor.firm_id || '',
                            firm_name: debtor.firm_name || '',
                            gst_no: debtor.gst_no || '',
                            pan_no: debtor.pan_no || ''
                        },
                        balance: Number(debtor.total_balance),
                        balance_type: "debtor",
                        last_transaction: {
                            date: debtor.last_transaction_date,
                            days_ago: debtor.days_since_last_payment,
                            period: debtor.last_received_in
                        }
                    };
                });

                const [totalDebtors] = await pool.query(
                    clientBalanceTotalSql("debtor", searchTerm, balanceAfter),
                    clientBalanceTotalParams(branch_id, searchTerm, "debtor", balanceAfter)
                );

                data = formattedDebtors;
                total = totalDebtors[0]?.total || 0;
                debtorMeta = {
                    debtor_count: Number(totalDebtors[0]?.total) || 0,
                    debtor_balance: Number(totalDebtors[0]?.balance_sum) || 0
                };
                break;
            }

            case "today_received":
                // Today Received: DISTINCT transactions by transaction_id to avoid duplicates
                const [receivedDetails] = await pool.query(
                    `SELECT DISTINCT
                        t.transaction_date AS date,
                        CASE 
                            WHEN t.party1_type = 'client' THEN CONCAT(COALESCE(p.name, t.party1_id), ' (', COALESCE(p.mobile, 'No Mobile'), ')')
                            WHEN t.party1_type = 'bank' THEN 'Bank Transfer'
                            ELSE t.party1_id
                        END AS particulars,
                        t.invoice_no AS voucher_no,
                        t.amount,
                        t.create_date AS received_at,
                        COALESCE(t.create_by, 'System') AS received_by
                     FROM transactions t
                     LEFT JOIN profile p ON p.username = t.party1_id
                     WHERE t.branch_id = ? 
                     AND DATE(t.transaction_date) = CURDATE()
                     AND LOWER(t.transaction_type) IN ('receive', 'received', 'sale')
                     GROUP BY t.transaction_id, t.create_date, t.party1_type, t.party1_id, t.invoice_no, t.amount, t.create_by
                     ORDER BY t.create_date DESC
                     LIMIT ? OFFSET ?`,
                    [branch_id, limitNum, offset]
                );

                const [totalReceived] = await pool.query(
                    `SELECT COUNT(DISTINCT transaction_id) AS total, COALESCE(SUM(amount), 0) AS total_amount
                     FROM transactions 
                     WHERE branch_id = ? 
                     AND DATE(t.transaction_date) = CURDATE()
                     AND LOWER(transaction_type) IN ('receive', 'received', 'sale')`,
                    [branch_id]
                );

                data = {
                    transactions: receivedDetails,
                    summary: {
                        total_count: totalReceived[0]?.total || 0,
                        total_amount: Number(totalReceived[0]?.total_amount) || 0
                    }
                };
                total = totalReceived[0]?.total || 0;
                break;

            case "today_payment":
                // Today Payment: DISTINCT transactions by transaction_id to avoid duplicates
                const [paymentDetails] = await pool.query(
                    `SELECT DISTINCT
                        t.transaction_date AS date,
                        CASE 
                            WHEN t.party2_type = 'client' THEN CONCAT(COALESCE(p.name, t.party2_id), ' (', COALESCE(p.mobile, 'No Mobile'), ')')
                            WHEN t.party2_type = 'bank' THEN 'Bank Transfer'
                            ELSE t.party2_id
                        END AS particulars,
                        t.invoice_no AS voucher_no,
                        ABS(t.amount) AS amount,
                        t.create_date AS paid_at,
                        COALESCE(t.create_by, 'System') AS paid_by
                     FROM transactions t
                     LEFT JOIN profile p ON p.username = t.party2_id
                     WHERE t.branch_id = ? 
                     AND DATE(t.transaction_date) = CURDATE()
                     AND LOWER(t.transaction_type) IN ('payment', 'purchase', 'pay')
                     GROUP BY t.transaction_id, t.create_date, t.party2_type, t.party2_id, t.invoice_no, t.amount, t.create_by
                     ORDER BY t.create_date DESC
                     LIMIT ? OFFSET ?`,
                    [branch_id, limitNum, offset]
                );

                const [totalPayment] = await pool.query(
                    `SELECT COUNT(DISTINCT transaction_id) AS total, COALESCE(SUM(ABS(amount)), 0) AS total_amount
                     FROM transactions 
                     WHERE branch_id = ? 
                     AND DATE(t.transaction_date) = CURDATE()
                     AND LOWER(transaction_type) IN ('payment', 'purchase', 'pay')`,
                    [branch_id]
                );

                data = {
                    transactions: paymentDetails,
                    summary: {
                        total_count: totalPayment[0]?.total || 0,
                        total_amount: Number(totalPayment[0]?.total_amount) || 0
                    }
                };
                total = totalPayment[0]?.total || 0;
                break;

            case "today_birthday":
                const [birthdayDetails] = await pool.query(
                    `SELECT 
                        p.username,
                        p.name,
                        p.care_of,
                        p.guardian_name,
                        p.date_of_birth,
                        p.mobile,
                        p.email,
                        p.country_code,
                        p.user_type,
                        p.gender,
                        p.country,
                        p.state,
                        p.city,
                        p.district,
                        p.village_town,
                        p.address_line_1,
                        p.address_line_2,
                        p.pincode,
                        p.image,
                        p.status,
                        p.create_date,
                        CONCAT(TIMESTAMPDIFF(YEAR, p.date_of_birth, CURDATE()), ' years') AS age
                     FROM profile p
                     INNER JOIN clients c ON c.username = p.username 
                        AND c.branch_id = ?
                        AND (c.is_deleted = '0' OR c.is_deleted = 0)
                     WHERE p.status = '1'
                     AND DATE_FORMAT(p.date_of_birth, '%m-%d') = DATE_FORMAT(CURDATE(), '%m-%d')
                     ORDER BY p.name ASC
                     LIMIT ? OFFSET ?`,
                    [branch_id, limitNum, offset]
                );

                const [totalBirthdays] = await pool.query(
                    `SELECT COUNT(*) AS total
                     FROM profile p
                     INNER JOIN clients c ON c.username = p.username 
                        AND c.branch_id = ?
                        AND (c.is_deleted = '0' OR c.is_deleted = 0)
                     WHERE p.status = '1'
                     AND DATE_FORMAT(p.date_of_birth, '%m-%d') = DATE_FORMAT(CURDATE(), '%m-%d')`,
                    [branch_id]
                );

                data = birthdayDetails.map(birthday => ({
                    name: birthday.name,
                    contact: {
                        mobile: birthday.mobile,
                        email: birthday.email,
                        country_code: birthday.country_code
                    },
                    date_of_birth: birthday.date_of_birth,
                    age: birthday.age,
                    address: {
                        line1: birthday.address_line_1,
                        line2: birthday.address_line_2,
                        city: birthday.city,
                        district: birthday.district,
                        state: birthday.state,
                        country: birthday.country,
                        pincode: birthday.pincode,
                        village_town: birthday.village_town
                    },
                    personal_details: {
                        username: birthday.username,
                        care_of: birthday.care_of,
                        guardian_name: birthday.guardian_name,
                        gender: birthday.gender,
                        user_type: birthday.user_type
                    },
                    image: birthday.image,
                    status: birthday.status
                }));
                total = totalBirthdays[0]?.total || 0;
                break;

            default:
                const [allDetails] = await pool.query(
                    `(SELECT 
                        'pending_billing' as type,
                        task_id as id,
                        create_date,
                        CONCAT('Pending Bill: ₹', fees) as description,
                        username as reference
                     FROM tasks 
                     WHERE branch_id = ? AND status = 'complete' AND billing_status = '0')
                     
                     UNION ALL
                     
                     (SELECT 
                        'transaction' as type,
                        transaction_id as id,
                        create_date,
                        CONCAT(IF(amount > 0, 'Received: ₹', 'Paid: ₹'), ABS(amount)) as description,
                        party1_id as reference
                     FROM transactions 
                     WHERE branch_id = ? AND DATE(transaction_date) = CURDATE())
                     
                     UNION ALL
                     
                     (SELECT 
                        'birthday' as type,
                        p.username as id,
                        p.create_date,
                        CONCAT('Birthday: ', p.name, ' (', TIMESTAMPDIFF(YEAR, p.date_of_birth, CURDATE()), ' years)') as description,
                        p.mobile as reference
                     FROM profile p
                     INNER JOIN clients c ON c.username = p.username 
                        AND c.branch_id = ?
                        AND (c.is_deleted = '0' OR c.is_deleted = 0)
                     WHERE p.status = '1' 
                     AND DATE_FORMAT(p.date_of_birth, '%m-%d') = DATE_FORMAT(CURDATE(), '%m-%d'))
                     
                     ORDER BY create_date DESC
                     LIMIT ? OFFSET ?`,
                    [branch_id, branch_id, branch_id, limitNum, offset]
                );

                const [totalAll] = await pool.query(
                    `SELECT 
                        (SELECT COUNT(*) FROM tasks WHERE branch_id = ? AND status = 'complete' AND billing_status = '0') +
                        (SELECT COUNT(*) FROM transactions WHERE branch_id = ? AND DATE(transaction_date) = CURDATE()) +
                        (SELECT COUNT(*) FROM profile p
                         INNER JOIN clients c ON c.username = p.username 
                            AND c.branch_id = ?
                            AND (c.is_deleted = '0' OR c.is_deleted = 0)
                         WHERE p.status = '1' 
                         AND DATE_FORMAT(p.date_of_birth, '%m-%d') = DATE_FORMAT(CURDATE(), '%m-%d')) AS total`,
                    [branch_id, branch_id, branch_id]
                );

                data = allDetails;
                total = totalAll[0]?.total || 0;
                break;
        }

        return res.status(200).json({
            success: true,
            message: "Dashboard details retrieved successfully",
            data: {
                type: type,
                list: data,
                pagination: {
                    page_no: pageNum,
                    limit: limitNum,
                    total: total,
                    total_pages: Math.ceil(total / limitNum),
                    is_last_page: offset + (Array.isArray(data) ? data.length : 0) >= total
                },
                ...(debtorMeta ? { meta: debtorMeta } : {}),
                ...(creditorMeta ? { meta: creditorMeta } : {})
            }
        });

    } catch (error) {
        console.error("Dashboard details error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard details",
            error: error.message
        });
    }
});

//sales stats 

// Top Sales Summary - Staff or Service Wise (Type based)
router.get("/sales-top-summary", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { from_date, to_date, type = "both" } = req.query;
        const username = req.headers["username"] || req.headers["Username"] || '';
        let requiredPermission = 'card_sales_overview';
        if (type === 'service') {
            requiredPermission = 'card_service_wise_sales';
        } else if (type === 'staff') {
            requiredPermission = 'card_staff_wise_sales';
        }
        const hasPerm = await checkUserPermission(username, branch_id, requiredPermission);
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }

        // Validate date range
        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "Both from_date and to_date are required"
            });
        }

        // Validate type parameter
        const validTypes = ["staff", "service", "both"];
        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                message: "Invalid type parameter. Valid values: staff, service, both"
            });
        }

        const response = {
            success: true,
            message: "Top sales summary retrieved successfully",
            data: {
                period: {
                    from_date,
                    to_date
                }
            }
        };

        // 1. SERVICE WISE DATA (using invoice table for date filtering)
        if (type === "service" || type === "both") {
            // Get top service with total sales
            const [topService] = await pool.query(
                `SELECT 
                    si.service_id,
                    COALESCE(s.name, 'Unknown Service') as service_name,
                    COALESCE(SUM(si.total), 0) as total_sales
                FROM sale_items si
                INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                LEFT JOIN services s ON si.service_id = s.service_id
                WHERE si.branch_id = ? 
                AND DATE(i.create_date) BETWEEN ? AND ?
                AND si.total > 0
                GROUP BY si.service_id
                ORDER BY total_sales DESC
                LIMIT 1`,
                [branch_id, from_date, to_date]
            );

            // Get total sales across all services
            const [totalServiceResult] = await pool.query(
                `SELECT COALESCE(SUM(si.total), 0) as total_sales
                FROM sale_items si
                INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                WHERE si.branch_id = ? 
                AND DATE(i.create_date) BETWEEN ? AND ?`,
                [branch_id, from_date, to_date]
            );

            response.data.service_wise = {
                top_service: topService.length > 0 ? {
                    service_id: topService[0].service_id,
                    service_name: topService[0].service_name,
                    total_sales: parseFloat(topService[0].total_sales)
                } : null,
                total_sales: parseFloat(totalServiceResult[0]?.total_sales || 0)
            };
        }

        // 2. STAFF WISE DATA (from tasks table using complete_date)
        if (type === "staff" || type === "both") {
            // Get top staff
            const [topStaff] = await pool.query(
                `SELECT 
                    t.complete_by as staff_username,
                    COALESCE(p.name, t.complete_by) as staff_name,
                    COALESCE(SUM(t.total), 0) as total_sales
                FROM tasks t
                LEFT JOIN profile p ON t.complete_by = p.username
                WHERE t.branch_id = ? 
                AND t.status = 'complete'
                AND t.billing_status = '1'
                AND t.complete_date IS NOT NULL
                AND DATE(t.complete_date) BETWEEN ? AND ?
                AND t.complete_by IS NOT NULL
                GROUP BY t.complete_by
                ORDER BY total_sales DESC
                LIMIT 1`,
                [branch_id, from_date, to_date]
            );

            // Get total sales across all staff
            const [totalStaffResult] = await pool.query(
                `SELECT COALESCE(SUM(t.total), 0) as total_sales
                FROM tasks t
                WHERE t.branch_id = ? 
                AND t.status = 'complete'
                AND t.billing_status = '1'
                AND t.complete_date IS NOT NULL
                AND DATE(t.complete_date) BETWEEN ? AND ?
                AND t.complete_by IS NOT NULL`,
                [branch_id, from_date, to_date]
            );

            response.data.staff_wise = {
                top_staff: topStaff.length > 0 ? {
                    username: topStaff[0].staff_username,
                    name: topStaff[0].staff_name,
                    total_sales: parseFloat(topStaff[0].total_sales)
                } : null,
                total_sales: parseFloat(totalStaffResult[0]?.total_sales || 0)
            };
        }

        return res.status(200).json(response);

    } catch (error) {
        console.error("Top sales summary error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch top sales summary",
            error: error.message
        });
    }
});

// Detailed Sales Report - Service Wise and Staff Wise with Pagination
router.get("/sales-detailed", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { from_date, to_date, type = "both", page_no = 1, limit = 20 } = req.query;
        const username = req.headers["username"] || req.headers["Username"] || '';
        let requiredPermission = 'card_sales_overview';
        if (type === 'service') {
            requiredPermission = 'card_service_wise_sales';
        } else if (type === 'staff') {
            requiredPermission = 'card_staff_wise_sales';
        }
        const hasPerm = await checkUserPermission(username, branch_id, requiredPermission);
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }

        // Validate date range
        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "Both from_date and to_date are required"
            });
        }

        // Validate type parameter
        const validTypes = ["staff", "service", "both"];
        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                message: "Invalid type parameter. Valid values: staff, service, both"
            });
        }

        // Pagination setup
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const response = {
            success: true,
            message: "Detailed sales report retrieved successfully",
            data: {
                period: {
                    from_date,
                    to_date
                }
            }
        };

        // 1. SERVICE WISE DETAILED DATA
        if (type === "service" || type === "both") {
            // Get all services with their sales details (without pagination for summary)
            const [allServiceDetails] = await pool.query(
                `SELECT 
                    si.service_id,
                    COALESCE(s.name, 'Unknown Service') as service_name,
                    COALESCE(s.sac_code, '') as sac_code,
                    COALESCE(0) as gst_rate,
                    COUNT(DISTINCT si.invoice_id) as total_invoices,
                    COUNT(si.id) as total_items_sold,
                    COALESCE(SUM(si.fees), 0) as total_fees,
                    0 as total_tax,
                    COALESCE(SUM(si.total), 0) as total_sales,
                    COALESCE(AVG(si.fees), 0) as avg_fee_per_item,
                    COALESCE(AVG(si.total), 0) as avg_sales_per_item,
                    MIN(i.create_date) as first_sale_date,
                    MAX(i.create_date) as last_sale_date
                FROM sale_items si
                INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                LEFT JOIN services s ON si.service_id = s.service_id
                LEFT JOIN branch_services bs ON si.service_id = bs.service_id AND bs.branch_id = si.branch_id AND bs.is_deleted = '0'
                WHERE si.branch_id = ? 
                AND DATE(i.create_date) BETWEEN ? AND ?
                AND si.total > 0
                GROUP BY si.service_id
                ORDER BY total_sales DESC`,
                [branch_id, from_date, to_date]
            );

            // Get paginated services
            const [serviceDetails] = await pool.query(
                `SELECT 
                    si.service_id,
                    COALESCE(s.name, 'Unknown Service') as service_name,
                    COALESCE(s.sac_code, '') as sac_code,
                    COALESCE(0) as gst_rate,
                    COUNT(DISTINCT si.invoice_id) as total_invoices,
                    COUNT(si.id) as total_items_sold,
                    COALESCE(SUM(si.fees), 0) as total_fees,
                    0 as total_tax,
                    COALESCE(SUM(si.total), 0) as total_sales,
                    COALESCE(AVG(si.fees), 0) as avg_fee_per_item,
                    COALESCE(AVG(si.total), 0) as avg_sales_per_item,
                    MIN(i.create_date) as first_sale_date,
                    MAX(i.create_date) as last_sale_date
                FROM sale_items si
                INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                LEFT JOIN services s ON si.service_id = s.service_id
                LEFT JOIN branch_services bs ON si.service_id = bs.service_id AND bs.branch_id = si.branch_id AND bs.is_deleted = '0'
                WHERE si.branch_id = ? 
                AND DATE(i.create_date) BETWEEN ? AND ?
                AND si.total > 0
                GROUP BY si.service_id
                ORDER BY total_sales DESC
                LIMIT ? OFFSET ?`,
                [branch_id, from_date, to_date, limitNum, offset]
            );

            // Calculate totals
            const totalServiceSales = allServiceDetails.reduce((sum, item) => sum + parseFloat(item.total_sales), 0);
            const totalServiceFees = allServiceDetails.reduce((sum, item) => sum + parseFloat(item.total_fees), 0);
            const totalServiceTax = allServiceDetails.reduce((sum, item) => sum + parseFloat(item.total_tax), 0);

            // Get top 5 services (from all data, not paginated)
            const topServices = allServiceDetails.slice(0, 5).map((item, index) => ({
                rank: index + 1,
                service_id: item.service_id,
                service_name: item.service_name,
                total_sales: parseFloat(item.total_sales),
                percentage: totalServiceSales > 0 ? ((parseFloat(item.total_sales) / totalServiceSales) * 100).toFixed(2) : 0,
                total_invoices: item.total_invoices,
                total_items_sold: item.total_items_sold
            }));

            // Get recent sales by service (last 10 invoices) - no pagination needed
            const [recentServiceSales] = await pool.query(
                `SELECT 
                    si.service_id,
                    COALESCE(s.name, 'Unknown Service') as service_name,
                    si.invoice_id,
                    i.invoice_no,
                    i.create_date as sale_date,
                    si.fees,
                    si.total as sale_amount,
                    i.grand_total as invoice_total
                FROM sale_items si
                INNER JOIN invoice i ON si.invoice_id = i.invoice_id AND si.branch_id = i.branch_id
                LEFT JOIN services s ON si.service_id = s.service_id
                WHERE si.branch_id = ? 
                AND DATE(i.create_date) BETWEEN ? AND ?
                AND si.total > 0
                ORDER BY i.create_date DESC
                LIMIT 10`,
                [branch_id, from_date, to_date]
            );

            // Pagination for services
            const totalServices = allServiceDetails.length;
            const totalServicePages = Math.ceil(totalServices / limitNum);

            response.data.service_wise = {
                summary: {
                    total_services: totalServices,
                    total_sales: totalServiceSales,
                    total_fees: totalServiceFees,
                    total_tax: totalServiceTax,
                    total_invoices: allServiceDetails.reduce((sum, item) => sum + item.total_invoices, 0),
                    total_items_sold: allServiceDetails.reduce((sum, item) => sum + item.total_items_sold, 0),
                    avg_sales_per_service: totalServices > 0 ? totalServiceSales / totalServices : 0
                },
                top_services: topServices,
                recent_sales: recentServiceSales.map(sale => ({
                    service_id: sale.service_id,
                    service_name: sale.service_name,
                    invoice_id: sale.invoice_id,
                    invoice_no: sale.invoice_no,
                    sale_date: sale.sale_date,
                    fees: parseFloat(sale.fees),
                    tax: 0,
                    amount: parseFloat(sale.sale_amount),
                    invoice_total: parseFloat(sale.invoice_total)
                })),
                all_services: serviceDetails.map(item => ({
                    service_id: item.service_id,
                    service_name: item.service_name,
                    sac_code: item.sac_code,
                    gst_rate: 0,
                    total_sales: parseFloat(item.total_sales),
                    total_fees: parseFloat(item.total_fees),
                    total_tax: parseFloat(item.total_tax),
                    total_invoices: item.total_invoices,
                    total_items_sold: item.total_items_sold,
                    avg_fee_per_item: parseFloat(item.avg_fee_per_item),
                    avg_sales_per_item: parseFloat(item.avg_sales_per_item),
                    first_sale_date: item.first_sale_date,
                    last_sale_date: item.last_sale_date,
                    percentage: totalServiceSales > 0 ? ((parseFloat(item.total_sales) / totalServiceSales) * 100).toFixed(2) : 0
                })),
                pagination: {
                    page_no: pageNum,
                    limit: limitNum,
                    total: totalServices,
                    total_pages: totalServicePages,
                    is_last_page: pageNum >= totalServicePages
                }
            };
        }

        // 2. STAFF WISE DETAILED DATA
        if (type === "staff" || type === "both") {
            // Get all staff with their sales details (without pagination for summary)
            const [allStaffDetails] = await pool.query(
                `SELECT 
                    t.complete_by as staff_username,
                    COALESCE(p.name, t.complete_by) as staff_name,
                    COALESCE(p.email, '') as email,
                    COALESCE(p.mobile, '') as mobile,
                    COUNT(DISTINCT t.task_id) as total_tasks_completed,
                    COUNT(DISTINCT t.invoice_id) as total_invoices_generated,
                    COALESCE(SUM(t.fees), 0) as total_fees,
                    0 as total_tax,
                    COALESCE(SUM(t.total), 0) as total_sales,
                    COALESCE(AVG(t.total), 0) as avg_sales_per_task,
                    MIN(t.complete_date) as first_completion_date,
                    MAX(t.complete_date) as last_completion_date
                FROM tasks t
                LEFT JOIN profile p ON t.complete_by = p.username
                WHERE t.branch_id = ? 
                AND t.status = 'complete'
                AND t.billing_status = '1'
                AND t.complete_date IS NOT NULL
                AND DATE(t.complete_date) BETWEEN ? AND ?
                AND t.complete_by IS NOT NULL
                GROUP BY t.complete_by
                ORDER BY total_sales DESC`,
                [branch_id, from_date, to_date]
            );

            // Get paginated staff
            const [staffDetails] = await pool.query(
                `SELECT 
                    t.complete_by as staff_username,
                    COALESCE(p.name, t.complete_by) as staff_name,
                    COALESCE(p.email, '') as email,
                    COALESCE(p.mobile, '') as mobile,
                    COUNT(DISTINCT t.task_id) as total_tasks_completed,
                    COUNT(DISTINCT t.invoice_id) as total_invoices_generated,
                    COALESCE(SUM(t.fees), 0) as total_fees,
                    0 as total_tax,
                    COALESCE(SUM(t.total), 0) as total_sales,
                    COALESCE(AVG(t.total), 0) as avg_sales_per_task,
                    MIN(t.complete_date) as first_completion_date,
                    MAX(t.complete_date) as last_completion_date
                FROM tasks t
                LEFT JOIN profile p ON t.complete_by = p.username
                WHERE t.branch_id = ? 
                AND t.status = 'complete'
                AND t.billing_status = '1'
                AND t.complete_date IS NOT NULL
                AND DATE(t.complete_date) BETWEEN ? AND ?
                AND t.complete_by IS NOT NULL
                GROUP BY t.complete_by
                ORDER BY total_sales DESC
                LIMIT ? OFFSET ?`,
                [branch_id, from_date, to_date, limitNum, offset]
            );

            // Calculate totals
            const totalStaffSales = allStaffDetails.reduce((sum, item) => sum + parseFloat(item.total_sales), 0);
            const totalStaffFees = allStaffDetails.reduce((sum, item) => sum + parseFloat(item.total_fees), 0);
            const totalStaffTax = allStaffDetails.reduce((sum, item) => sum + parseFloat(item.total_tax), 0);

            // Get top 5 staff performers (from all data, not paginated)
            const topStaffPerformers = allStaffDetails.slice(0, 5).map((item, index) => ({
                rank: index + 1,
                username: item.staff_username,
                name: item.staff_name,
                total_sales: parseFloat(item.total_sales),
                percentage: totalStaffSales > 0 ? ((parseFloat(item.total_sales) / totalStaffSales) * 100).toFixed(2) : 0,
                total_tasks: item.total_tasks_completed,
                total_invoices: item.total_invoices_generated
            }));

            // Get service breakdown for top staff
            const topStaffUsername = allStaffDetails.length > 0 ? allStaffDetails[0].staff_username : null;
            let topStaffServiceBreakdown = [];

            if (topStaffUsername) {
                const [serviceBreakdown] = await pool.query(
                    `SELECT 
                        si.service_id,
                        COALESCE(s.name, 'Unknown Service') as service_name,
                        COUNT(si.id) as quantity,
                        COALESCE(SUM(si.total), 0) as total_sales
                    FROM tasks t
                    INNER JOIN sale_items si ON t.invoice_id = si.invoice_id AND t.branch_id = si.branch_id
                    LEFT JOIN services s ON si.service_id = s.service_id
                    WHERE t.branch_id = ? 
                    AND t.complete_by = ?
                    AND t.status = 'complete'
                    AND t.billing_status = '1'
                    AND DATE(t.complete_date) BETWEEN ? AND ?
                    GROUP BY si.service_id
                    ORDER BY total_sales DESC
                    LIMIT 5`,
                    [branch_id, topStaffUsername, from_date, to_date]
                );

                topStaffServiceBreakdown = serviceBreakdown.map(item => ({
                    service_id: item.service_id,
                    service_name: item.service_name,
                    quantity: item.quantity,
                    total_sales: parseFloat(item.total_sales)
                }));
            }

            // Get recent tasks completed by staff (last 10) - no pagination needed
            const [recentTasks] = await pool.query(
                `SELECT 
                    t.task_id,
                    t.complete_by,
                    COALESCE(p.name, t.complete_by) as staff_name,
                    t.invoice_id,
                    t.service_id,
                    COALESCE(s.name, 'Unknown Service') as service_name,
                    t.total as sale_amount,
                    t.complete_date,
                    t.billing_status
                FROM tasks t
                LEFT JOIN profile p ON t.complete_by = p.username
                LEFT JOIN services s ON t.service_id = s.service_id
                WHERE t.branch_id = ? 
                AND t.status = 'complete'
                AND t.billing_status = '1'
                AND t.complete_date IS NOT NULL
                AND DATE(t.complete_date) BETWEEN ? AND ?
                AND t.complete_by IS NOT NULL
                ORDER BY t.complete_date DESC
                LIMIT 10`,
                [branch_id, from_date, to_date]
            );

            // Get daily sales trend for top 3 staff
            const top3StaffUsernames = allStaffDetails.slice(0, 3).map(s => s.staff_username);
            let dailyTrend = [];

            if (top3StaffUsernames.length > 0) {
                const placeholders = top3StaffUsernames.map(() => '?').join(',');
                const [trendData] = await pool.query(
                    `SELECT 
                        t.complete_by,
                        COALESCE(p.name, t.complete_by) as staff_name,
                        DATE(t.complete_date) as sale_date,
                        COALESCE(SUM(t.total), 0) as daily_sales,
                        COUNT(t.task_id) as tasks_count
                    FROM tasks t
                    LEFT JOIN profile p ON t.complete_by = p.username
                    WHERE t.branch_id = ? 
                    AND t.status = 'complete'
                    AND t.billing_status = '1'
                    AND t.complete_date IS NOT NULL
                    AND DATE(t.complete_date) BETWEEN ? AND ?
                    AND t.complete_by IN (${placeholders})
                    GROUP BY t.complete_by, DATE(t.complete_date)
                    ORDER BY sale_date ASC`,
                    [branch_id, from_date, to_date, ...top3StaffUsernames]
                );

                dailyTrend = trendData.map(item => ({
                    staff_name: item.staff_name,
                    date: item.sale_date,
                    sales: parseFloat(item.daily_sales),
                    tasks: item.tasks_count
                }));
            }

            // Pagination for staff
            const totalStaff = allStaffDetails.length;
            const totalStaffPages = Math.ceil(totalStaff / limitNum);

            response.data.staff_wise = {
                summary: {
                    total_staff_members: totalStaff,
                    total_sales: totalStaffSales,
                    total_fees: totalStaffFees,
                    total_tax: totalStaffTax,
                    total_tasks_completed: allStaffDetails.reduce((sum, item) => sum + item.total_tasks_completed, 0),
                    total_invoices_generated: allStaffDetails.reduce((sum, item) => sum + item.total_invoices_generated, 0),
                    avg_sales_per_staff: totalStaff > 0 ? totalStaffSales / totalStaff : 0,
                    avg_tasks_per_staff: totalStaff > 0 ? allStaffDetails.reduce((sum, item) => sum + item.total_tasks_completed, 0) / totalStaff : 0
                },
                top_performers: topStaffPerformers,
                top_performer_service_breakdown: topStaffServiceBreakdown,
                recent_tasks: recentTasks.map(task => ({
                    task_id: task.task_id,
                    staff_name: task.staff_name,
                    invoice_id: task.invoice_id,
                    service_name: task.service_name,
                    sale_amount: parseFloat(task.sale_amount),
                    complete_date: task.complete_date
                })),
                daily_sales_trend: dailyTrend,
                all_staff: staffDetails.map(item => ({
                    username: item.staff_username,
                    name: item.staff_name,
                    email: item.email,
                    mobile: item.mobile,
                    total_sales: parseFloat(item.total_sales),
                    total_fees: parseFloat(item.total_fees),
                    total_tax: parseFloat(item.total_tax),
                    total_tasks: item.total_tasks_completed,
                    total_invoices: item.total_invoices_generated,
                    avg_sales_per_task: parseFloat(item.avg_sales_per_task),
                    first_completion_date: item.first_completion_date,
                    last_completion_date: item.last_completion_date,
                    percentage: totalStaffSales > 0 ? ((parseFloat(item.total_sales) / totalStaffSales) * 100).toFixed(2) : 0
                })),
                pagination: {
                    page_no: pageNum,
                    limit: limitNum,
                    total: totalStaff,
                    total_pages: totalStaffPages,
                    is_last_page: pageNum >= totalStaffPages
                }
            };
        }

        return res.status(200).json(response);

    } catch (error) {
        console.error("Detailed sales report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch detailed sales report",
            error: error.message
        });
    }
});


//top sales by clients 


// Corrected Top Clients by Sales API - Shows firms even when not directly linked in sale_entries
router.get("/top-clients-by-sales", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { from_date, to_date, limit = 10, page_no = 1 } = req.query;
        const username = req.headers["username"] || req.headers["Username"] || '';
        const hasPerm = await checkUserPermission(username, branch_id, 'card_top_10_clients_by_sales');
        if (!hasPerm) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You do not have permission to view this card"
            });
        }

        // Validate date range
        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "Both from_date and to_date are required"
            });
        }

        // Pagination setup
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
        const offset = (pageNum - 1) * limitNum;

        // Aggregate top clients first (no per-row firms subquery — avoids max_statement_time timeout)
        const [clientsData] = await pool.query(
            `SELECT 
                se.party_id as username,
                MAX(p.name) as name,
                MAX(p.guardian_name) as guardian_name,
                MAX(p.care_of) as care_of,
                MAX(p.mobile) as mobile,
                MAX(p.email) as email,
                MAX(p.country_code) as country_code,
                COUNT(DISTINCT se.sale_id) as total_transactions,
                COUNT(se.id) as total_items,
                COALESCE(SUM(se.total), 0) as total_amount,
                MIN(DATE(se.sale_date)) as first_sale_date,
                MAX(DATE(se.sale_date)) as last_sale_date
            FROM sale_entries se
            LEFT JOIN profile p ON se.party_id = p.username
            WHERE se.branch_id = ?
            AND se.sale_date >= ? AND se.sale_date <= ?
            AND se.party_type = 'client'
            AND (se.is_task = '0' OR se.is_task = 0 OR se.is_task IS NULL)
            GROUP BY se.party_id
            HAVING total_amount > 0
            ORDER BY total_amount DESC
            LIMIT ? OFFSET ?`,
            [branch_id, from_date, to_date, limitNum, offset]
        );

        const clientUsernames = clientsData.map((c) => c.username).filter(Boolean);
        const firmsByUsername = await getFirmsMapForUsernames(branch_id, clientUsernames);

        // Get total count for pagination
        const [countResult] = await pool.query(
            `SELECT COUNT(*) as total
            FROM (
                SELECT se.party_id
                FROM sale_entries se
                WHERE se.branch_id = ?
                AND se.sale_date >= ? AND se.sale_date <= ?
                AND se.party_type = 'client'
                AND (se.is_task = '0' OR se.is_task = 0 OR se.is_task IS NULL)
                GROUP BY se.party_id
                HAVING COALESCE(SUM(se.total), 0) > 0
            ) counted`,
            [branch_id, from_date, to_date]
        );

        const total = countResult[0]?.total || 0;
        const totalPages = Math.ceil(total / limitNum);

        // Format the response data with proper firm parsing
        const formattedClients = clientsData.map((client, index) => {
            const firmsRaw = firmsByUsername[client.username] || [];
            const firms = firmsRaw.map((f) => ({
                firm_id: f.firm_id,
                firm_name: f.firm_name,
                firm_type: f.firm_type,
                gst_no: f.gst_no,
                pan_no: f.pan_no,
                tan_no: f.tan_no,
                address: f.address?.address_line_1 || '',
                city: f.address?.city || '',
                state: f.address?.state || '',
                status: f.status,
            }));

            return {
                rank: index + 1,
                client_info: {
                    username: client.username,
                    name: client.name || 'N/A',
                    guardian_name: client.guardian_name || null,
                    care_of: client.care_of || null,
                    contact: {
                        mobile: client.mobile ? `${client.country_code || '+91'} ${client.mobile}` : 'N/A',
                        email: client.email || 'N/A'
                    }
                },
                firms: firms.length > 0 ? firms : null,
                sales_summary: {
                    total_amount: parseFloat(client.total_amount),
                    total_transactions: client.total_transactions,
                    total_items: client.total_items,
                    first_sale_date: client.first_sale_date,
                    last_sale_date: client.last_sale_date
                }
            };
        });

        // Remove duplicate clients (by username)
        const uniqueClients = [];
        const seenUsernames = new Set();

        for (const client of formattedClients) {
            if (!seenUsernames.has(client.client_info.username)) {
                seenUsernames.add(client.client_info.username);
                uniqueClients.push(client);
            }
        }

        // Get summary statistics for the period
        const [summaryResult] = await pool.query(
            `SELECT 
                COUNT(DISTINCT party_id) as total_clients,
                COALESCE(SUM(total), 0) as grand_total,
                COUNT(DISTINCT sale_id) as total_transactions,
                COUNT(id) as total_items
            FROM sale_entries
            WHERE branch_id = ?
            AND sale_date >= ? AND sale_date <= ?
            AND party_type = 'client'
            AND (is_task = '0' OR is_task = 0 OR is_task IS NULL)
            `,
            [branch_id, from_date, to_date]
        );

        // Get the top client
        const topClient = uniqueClients.length > 0 ? uniqueClients[0] : null;

        return res.status(200).json({
            success: true,
            message: "Top clients by sales retrieved successfully",
            data: {
                period: {
                    from_date,
                    to_date
                },
                summary: {
                    total_clients: summaryResult[0]?.total_clients || 0,
                    grand_total_sales: parseFloat(summaryResult[0]?.grand_total || 0),
                    total_transactions: summaryResult[0]?.total_transactions || 0,
                    total_items_sold: summaryResult[0]?.total_items || 0,
                    average_per_client: summaryResult[0]?.total_clients > 0
                        ? parseFloat(summaryResult[0]?.grand_total || 0) / summaryResult[0]?.total_clients
                        : 0
                },
                top_client: topClient,
                clients: uniqueClients,
                pagination: {
                    page_no: pageNum,
                    limit: limitNum,
                    total: total,
                    total_pages: totalPages,
                    has_next: pageNum < totalPages,
                    has_prev: pageNum > 1
                }
            }
        });

    } catch (error) {
        console.error("Top clients by sales error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch top clients by sales",
            error: error.message
        });
    }
});

// Team Report API's

router.get("/team-report", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { staff_username, search, service_id } = req.query;

        // Get all active and accepted staff from branch_mapping
        let staffQuery = `
            SELECT DISTINCT 
                bm.map_id,
                bm.username,
                bm.designation,
                bm.status,
                bm.type,
                bm.is_accepted
            FROM branch_mapping bm
            WHERE bm.branch_id = ? 
            AND bm.is_deleted = '0'
            AND bm.status = '1'
            AND bm.is_accepted = '1'
        `;

        const staffParams = [branch_id];

        if (staff_username) {
            staffQuery += ` AND bm.username = ?`;
            staffParams.push(staff_username);
        }

        if (search) {
            staffQuery += ` AND bm.username LIKE ?`;
            staffParams.push(`%${search}%`);
        }

        const [staffMembers] = await pool.query(staffQuery, staffParams);

        if (staffMembers.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No active and accepted staff members found",
                data: [],
                summary: {
                    total_staff: 0,
                    total_tasks: 0,
                    total_active_tasks: 0
                }
            });
        }

        // Get all tasks assigned to these staff members
        const staffUsernames = staffMembers.map(s => s.username);
        const placeholders = staffUsernames.map(() => "?").join(",");

        let tasksQuery = `
            SELECT DISTINCT
                t.task_id,
                t.due_date,
                t.status as task_status,
                t.create_date,
                t.complete_date,
                ts.username as assigned_staff
            FROM task_staffs ts
            INNER JOIN tasks t ON ts.task_id = t.task_id AND t.branch_id = ts.branch_id
            WHERE ts.branch_id = ?
            AND ts.username IN (${placeholders})
            AND (ts.is_deleted = '0' OR ts.is_deleted = 0)
            GROUP BY t.task_id, ts.username
        `;

        const tasksParams = [branch_id, ...staffUsernames];

        // Add service filter if provided
        if (service_id && service_id !== 'all') {
            tasksQuery += ` AND t.service_id = ?`;
            tasksParams.push(service_id);
        }

        const [tasks] = await pool.query(tasksQuery, tasksParams);

        // Build staff-wise report
        const reportData = [];
        let globalTotalTasks = 0;
        let globalTotalActiveTasks = 0;

        for (const staff of staffMembers) {
            // Get staff profile details
            const staffProfile = await USER_SNIPPED_DATA(staff.username);

            // Filter tasks for this staff
            const staffTasks = tasks.filter(t => t.assigned_staff === staff.username);

            // Initialize counters
            let statusCounts = {
                'in process': 0,
                'pending from client': 0,
                'pending from department': 0,
                'complete': 0,
                'cancel': 0
            };

            let dueDateCounts = {
                'OD': 0,  // Overdue
                'DT': 0,  // Due Today
                'D7': 0,  // Due within 7 days
                'FT': 0   // Future (beyond 7 days)
            };

            let activeTaskCount = 0;
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            for (const task of staffTasks) {
                // Count by status
                if (statusCounts.hasOwnProperty(task.task_status)) {
                    statusCounts[task.task_status]++;
                }

                // Check if task is active (not complete or cancel)
                const isActive = task.task_status !== 'complete' && task.task_status !== 'cancel';

                if (isActive && task.due_date) {
                    activeTaskCount++;

                    // Calculate due date category
                    const dueDateObj = new Date(task.due_date);
                    dueDateObj.setHours(0, 0, 0, 0);
                    const diffDays = Math.ceil((dueDateObj - today) / (1000 * 60 * 60 * 24));

                    if (diffDays < 0) {
                        dueDateCounts['OD']++;
                    } else if (diffDays === 0) {
                        dueDateCounts['DT']++;
                    } else if (diffDays <= 7) {
                        dueDateCounts['D7']++;
                    } else {
                        dueDateCounts['FT']++;
                    }
                }
            }

            const totalTasks = staffTasks.length;

            // Check if staff has ANY tasks (total_tasks > 0)
            // Also check if all breakdown values are zero (no active tasks)
            const hasAnyTask = totalTasks > 0;
            const hasAnyActiveTask = activeTaskCount > 0;
            const hasAnyStatusTask = (statusCounts['in process'] > 0 ||
                statusCounts['pending from client'] > 0 ||
                statusCounts['pending from department'] > 0);
            const hasAnyDueDateTask = (dueDateCounts['OD'] > 0 ||
                dueDateCounts['DT'] > 0 ||
                dueDateCounts['D7'] > 0 ||
                dueDateCounts['FT'] > 0);

            // Only include staff if they have at least one task AND at least one active task OR any status task
            if (hasAnyTask && (hasAnyActiveTask || hasAnyStatusTask || hasAnyDueDateTask)) {
                globalTotalTasks += totalTasks;
                globalTotalActiveTasks += activeTaskCount;

                reportData.push({
                    staff: {
                        username: staff.username,
                        name: staffProfile?.name || staff.username,
                        designation: staff.designation,
                        email: staffProfile?.email,
                        mobile: staffProfile?.mobile,
                        image: staffProfile?.image,
                        is_accepted: staff.is_accepted === '1',
                        status: staff.status === '1' ? 'active' : 'inactive'
                    },
                    summary: {
                        total_tasks: totalTasks,
                        active_tasks: activeTaskCount,
                        completed_tasks: statusCounts['complete'],
                        cancelled_tasks: statusCounts['cancel']
                    },
                    status_breakdown: {
                        in_process: statusCounts['in process'],
                        pending_from_client: statusCounts['pending from client'],
                        pending_from_department: statusCounts['pending from department'],
                        complete: statusCounts['complete'],
                        cancel: statusCounts['cancel']
                    },
                    due_date_breakdown: {
                        overdue: dueDateCounts['OD'],
                        due_today: dueDateCounts['DT'],
                        due_within_7_days: dueDateCounts['D7'],
                        future: dueDateCounts['FT']
                    }
                });
            }
        }

        // Sort by total active tasks (descending)
        reportData.sort((a, b) => b.summary.active_tasks - a.summary.active_tasks);

        // Calculate global totals
        const globalStatusTotals = {
            in_process: 0,
            pending_from_client: 0,
            pending_from_department: 0,
            complete: 0,
            cancel: 0
        };

        const globalDueDateTotals = {
            overdue: 0,
            due_today: 0,
            due_within_7_days: 0,
            future: 0
        };

        for (const staff of reportData) {
            globalStatusTotals.in_process += staff.status_breakdown.in_process;
            globalStatusTotals.pending_from_client += staff.status_breakdown.pending_from_client;
            globalStatusTotals.pending_from_department += staff.status_breakdown.pending_from_department;
            globalStatusTotals.complete += staff.status_breakdown.complete;
            globalStatusTotals.cancel += staff.status_breakdown.cancel;

            globalDueDateTotals.overdue += staff.due_date_breakdown.overdue;
            globalDueDateTotals.due_today += staff.due_date_breakdown.due_today;
            globalDueDateTotals.due_within_7_days += staff.due_date_breakdown.due_within_7_days;
            globalDueDateTotals.future += staff.due_date_breakdown.future;
        }

        return res.status(200).json({
            success: true,
            message: "Team report retrieved successfully for active and accepted staff",
            data: reportData,
            summary: {
                total_staff: reportData.length,
                total_tasks: globalTotalTasks,
                total_active_tasks: globalTotalActiveTasks,
                global_status_breakdown: globalStatusTotals,
                global_due_date_breakdown: globalDueDateTotals
            },
            filters_applied: {
                staff_username: staff_username || "all",
                search: search || null,
                service_id: service_id || "all",
                staff_status: "active and accepted only"
            },
            legend: {
                status: {
                    "in_process": "Task is currently in progress (WIP)",
                    "pending_from_client": "Waiting for client response (PFC)",
                    "pending_from_department": "Waiting for department action (PFD)",
                    "complete": "Task completed (CPL)",
                    "cancel": "Task cancelled (CNL)"
                },
                due_date: {
                    "overdue": "Due date has passed (OD)",
                    "due_today": "Due today (DT)",
                    "due_within_7_days": "Due within 7 days (D7)",
                    "future": "Due beyond 7 days (FT)"
                }
            }
        });

    } catch (error) {
        console.error("Team report error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch team report",
            error: error.message
        });
    }
});
// Team Report Details - Get detailed tasks for a specific staff member
router.get("/team-report-details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            staff_username,
            category,
            page_no = 1,
            limit = 20,
            search,
            status_filter
        } = req.query;

        // Validate required parameters
        if (!staff_username) {
            return res.status(400).json({
                success: false,
                message: "staff_username is required"
            });
        }

        // Define valid categories
        const dateCategories = ['OD', 'DT', 'D7', 'FT'];
        const statusCategories = ['WIP', 'PFC', 'PFD'];
        const allValidCategories = [...dateCategories, ...statusCategories];

        // If category is provided, validate it
        if (category && !allValidCategories.includes(category)) {
            return res.status(400).json({
                success: false,
                message: `Invalid category. Valid categories are: ${allValidCategories.join(', ')}`
            });
        }

        // Pagination setup
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        // First, verify the staff exists and belongs to this branch (only active and accepted)
        const [staffCheck] = await pool.query(
            `SELECT bm.username, bm.designation, bm.status, bm.type, bm.is_accepted,
                    p.name, p.email, p.mobile, p.image
             FROM branch_mapping bm
             LEFT JOIN profile p ON bm.username = p.username
             WHERE bm.branch_id = ? 
             AND bm.username = ?
             AND bm.is_deleted = '0'
             AND bm.status = '1'
             AND bm.is_accepted = '1'`,
            [branch_id, staff_username]
        );

        if (staffCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Staff member not found, not active, or not accepted"
            });
        }

        const staffInfo = {
            username: staffCheck[0].username,
            name: staffCheck[0].name || staffCheck[0].username,
            designation: staffCheck[0].designation,
            email: staffCheck[0].email,
            mobile: staffCheck[0].mobile,
            image: staffCheck[0].image
        };

        // Get all tasks assigned to this staff - WITH DISTINCT to remove duplicates
        let tasksQuery = `
            SELECT DISTINCT
                t.task_id,
                t.username as client_username,
                t.firm_id,
                t.service_id,
                t.due_date,
                t.target_date,
                t.status as task_status,
                t.create_date,
                t.complete_date,
                t.billing_status,
                t.fees,
                t.total,
                s.name as service_name,
                p.name as client_name,
                p.mobile as client_mobile,
                p.email as client_email,
                f.firm_name
            FROM task_staffs ts
            INNER JOIN tasks t ON ts.task_id = t.task_id AND t.branch_id = ts.branch_id
            LEFT JOIN services s ON t.service_id = s.service_id
            LEFT JOIN profile p ON t.username = p.username
            LEFT JOIN firms f ON t.firm_id = f.firm_id AND f.branch_id = t.branch_id
            WHERE ts.branch_id = ?
            AND ts.username = ?
            AND (ts.is_deleted = '0' OR ts.is_deleted = 0)
            GROUP BY t.task_id
        `;

        const tasksParams = [branch_id, staff_username];

        // Add search filter if provided
        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            tasksQuery += ` HAVING (t.task_id LIKE ? OR s.name LIKE ? OR p.name LIKE ? OR f.firm_name LIKE ?)`;
            tasksParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        // Add status filter if provided
        if (status_filter && String(status_filter).trim() !== "") {
            const validStatuses = ['in process', 'pending from client', 'pending from department', 'complete', 'cancel'];
            if (validStatuses.includes(status_filter)) {
                tasksQuery += ` AND t.status = ?`;
                tasksParams.push(status_filter);
            }
        }

        const [tasks] = await pool.query(tasksQuery, tasksParams);

        // Calculate due date categories for each task
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let filteredTasks = tasks;

        // Apply category filter based on type
        if (category) {
            if (dateCategories.includes(category)) {
                // FILTER BY DATE CATEGORY (OD, DT, D7, FT)
                filteredTasks = tasks.filter(task => {
                    // Only active tasks (not complete or cancel)
                    const isActive = task.task_status !== 'complete' && task.task_status !== 'cancel';
                    if (!isActive || !task.due_date) return false;

                    const dueDateObj = new Date(task.due_date);
                    dueDateObj.setHours(0, 0, 0, 0);
                    const diffDays = Math.ceil((dueDateObj - today) / (1000 * 60 * 60 * 24));

                    switch (category) {
                        case 'OD': return diffDays < 0;
                        case 'DT': return diffDays === 0;
                        case 'D7': return diffDays > 0 && diffDays <= 7;
                        case 'FT': return diffDays > 7;
                        default: return false;
                    }
                });
            }
            else if (statusCategories.includes(category)) {
                // FILTER BY STATUS CATEGORY (WIP, PFC, PFD)
                filteredTasks = tasks.filter(task => {
                    switch (category) {
                        case 'WIP': return task.task_status === 'in process';
                        case 'PFC': return task.task_status === 'pending from client';
                        case 'PFD': return task.task_status === 'pending from department';
                        default: return false;
                    }
                });
            }
        }

        // Prepare task details only (NO SUMMARY)
        const taskDetails = [];

        for (const task of filteredTasks.slice(offset, offset + limitNum)) {
            // Calculate due category
            let dueCategory = null;
            const isActive = task.task_status !== 'complete' && task.task_status !== 'cancel';

            if (isActive && task.due_date) {
                const dueDateObj = new Date(task.due_date);
                dueDateObj.setHours(0, 0, 0, 0);
                const diffDays = Math.ceil((dueDateObj - today) / (1000 * 60 * 60 * 24));

                if (diffDays < 0) dueCategory = 'OD';
                else if (diffDays === 0) dueCategory = 'DT';
                else if (diffDays <= 7) dueCategory = 'D7';
                else dueCategory = 'FT';
            }

            // Calculate status category
            let statusCategory = null;
            if (task.task_status === 'in process') statusCategory = 'WIP';
            else if (task.task_status === 'pending from client') statusCategory = 'PFC';
            else if (task.task_status === 'pending from department') statusCategory = 'PFD';

            taskDetails.push({
                task_id: task.task_id,
                service: {
                    service_id: task.service_id,
                    service_name: task.service_name
                },
                client: {
                    username: task.client_username,
                    name: task.client_name,
                    email: task.client_email,
                    mobile: task.client_mobile
                },
                firm: {
                    firm_id: task.firm_id,
                    firm_name: task.firm_name
                },
                task_details: {
                    status: task.task_status,
                    status_category: statusCategory,
                    due_date: task.due_date,
                    due_category: dueCategory,
                    target_date: task.target_date,
                    is_active: isActive,
                    create_date: task.create_date,
                    complete_date: task.complete_date
                },
                financials: {
                    fees: parseFloat(task.fees || 0),
                    tax_rate: 0,
                    tax_value: 0,
                    total: parseFloat(task.total || 0),
                    billing_status: task.billing_status == '0' ? 'pending' :
                        task.billing_status == '1' ? 'complete' : 'non_billable'
                }
            });
        }

        const total = filteredTasks.length;
        const totalPages = Math.ceil(total / limitNum);

        // Get category description
        const categoryDescriptions = {
            'OD': 'Overdue Tasks - Active tasks with due date passed',
            'DT': 'Due Today - Active tasks due today',
            'D7': 'Due within 7 Days - Active tasks due in next 7 days',
            'FT': 'Future Tasks - Active tasks with due date beyond 7 days',
            'WIP': 'In Progress - Tasks with status "in process"',
            'PFC': 'Pending From Client - Tasks with status "pending from client"',
            'PFD': 'Pending From Department - Tasks with status "pending from department"'
        };

        return res.status(200).json({
            success: true,
            message: category ?
                `Tasks for ${staffInfo.name} - Category: ${category}` :
                `All tasks for ${staffInfo.name}`,
            data: {
                staff_info: staffInfo,
                tasks: taskDetails,
                pagination: {
                    page_no: pageNum,
                    limit: limitNum,
                    total: total,
                    total_pages: totalPages,
                    has_next: pageNum < totalPages,
                    has_prev: pageNum > 1
                }
            },
            filters_applied: {
                staff_username: staff_username,
                category: category || "all",
                search: search || null,
                status_filter: status_filter || null
            }
        });

    } catch (error) {
        console.error("Team report details error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch team report details",
            error: error.message
        });
    }
});


// Performance Staff 

// Simple Staff Performance Stats API
router.get("/staff-performance-stats", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            staff_username,
            from_date,
            to_date,
            range = "1m"
        } = req.query;

        // Calculate date range
        let startDate, endDate;
        const today = new Date();
        today.setHours(23, 59, 59, 999);

        if (from_date && to_date) {
            startDate = new Date(from_date);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(to_date);
            endDate.setHours(23, 59, 59, 999);
        } else {
            endDate = new Date(today);

            switch (range) {
                case "1d": startDate = new Date(today); startDate.setDate(today.getDate() - 1); break;
                case "1w": startDate = new Date(today); startDate.setDate(today.getDate() - 7); break;
                case "1m": startDate = new Date(today); startDate.setDate(today.getDate() - 30); break;
                case "3m": startDate = new Date(today); startDate.setDate(today.getDate() - 90); break;
                case "6m": startDate = new Date(today); startDate.setDate(today.getDate() - 180); break;
                case "1y": startDate = new Date(today); startDate.setDate(today.getDate() - 365); break;
                default: startDate = new Date(today); startDate.setDate(today.getDate() - 30);
            }
            startDate.setHours(0, 0, 0, 0);
        }

        // Get staff info
        let staffCondition = "";
        const queryParams = [branch_id];

        if (staff_username) {
            staffCondition = " AND bm.username = ?";
            queryParams.push(staff_username);
        }

        const staffQuery = `
            SELECT DISTINCT 
                bm.username,
                bm.designation,
                p.name,
                p.email,
                p.mobile
            FROM branch_mapping bm
            LEFT JOIN profile p ON bm.username = p.username
            WHERE bm.branch_id = ? 
            AND bm.is_deleted = '0'
            AND bm.status = '1'
            AND bm.is_accepted = '1'
            ${staffCondition}
            ORDER BY p.name ASC
        `;

        const [staffMembers] = await pool.query(staffQuery, queryParams);

        if (staffMembers.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No staff members found",
                data: []
            });
        }

        // Get staff usernames
        const staffUsernames = staffMembers.map(s => s.username);
        const placeholders = staffUsernames.map(() => "?").join(",");

        // Get tasks for these staff members
        const tasksQuery = `
            SELECT 
                t.task_id,
                t.due_date,
                t.status,
                t.create_date,
                t.complete_date,
                t.total,
                ts.username as staff_username,
                t.billing_status,
                t.complete_date as task_completed_date
            FROM task_staffs ts
            INNER JOIN tasks t ON ts.task_id = t.task_id AND t.branch_id = ts.branch_id
            WHERE ts.branch_id = ?
            AND ts.username IN (${placeholders})
            AND (ts.is_deleted = '0' OR ts.is_deleted = 0)
            AND DATE(t.create_date) BETWEEN ? AND ?
        `;

        const [tasks] = await pool.query(tasksQuery, [
            branch_id,
            ...staffUsernames,
            startDate.toISOString().split('T')[0],
            endDate.toISOString().split('T')[0]
        ]);

        // Calculate stats for each staff
        const staffStats = [];

        for (const staff of staffMembers) {
            const staffTasks = tasks.filter(t => t.staff_username === staff.username);

            // Basic counts
            const total_assigned = staffTasks.length;
            const total_completed = staffTasks.filter(t => t.status === 'complete').length;
            const total_in_progress = staffTasks.filter(t => t.status === 'in process').length;
            const total_pending = staffTasks.filter(t => t.status === 'pending from client' || t.status === 'pending from department').length;
            const total_cancelled = staffTasks.filter(t => t.status === 'cancel').length;

            // Completion rate
            const completion_rate = total_assigned > 0 ? (total_completed / total_assigned) * 100 : 0;

            // On-time vs Late calculation
            let on_time_count = 0;
            let late_count = 0;
            let total_revenue = 0;
            let billed_revenue = 0;
            let unbilled_revenue = 0;

            for (const task of staffTasks) {
                // Calculate revenue
                const revenue = parseFloat(task.total || 0);
                total_revenue += revenue;

                // Billed vs Unbilled
                if (task.billing_status == '1') {
                    billed_revenue += revenue;
                } else if (task.billing_status == '0') {
                    unbilled_revenue += revenue;
                }

                // Check on-time completion
                if (task.status === 'complete' && task.due_date && task.complete_date) {
                    const dueDate = new Date(task.due_date);
                    const completeDate = new Date(task.complete_date);

                    if (completeDate <= dueDate) {
                        on_time_count++;
                    } else {
                        late_count++;
                    }
                } else if (task.status === 'complete' && !task.due_date) {
                    // No due date - consider as on time
                    on_time_count++;
                }
            }

            // On-time rate
            const on_time_rate = total_completed > 0 ? (on_time_count / total_completed) * 100 : 0;

            // Performance score (simple average of completion rate and on-time rate)
            const performance_score = (completion_rate + on_time_rate) / 2;

            // Performance rating
            let performance_rating = 'Poor';
            if (performance_score >= 90) performance_rating = 'Excellent';
            else if (performance_score >= 75) performance_rating = 'Good';
            else if (performance_score >= 60) performance_rating = 'Average';
            else if (performance_score >= 40) performance_rating = 'Below Average';

            staffStats.push({
                staff_info: {
                    username: staff.username,
                    name: staff.name || staff.username,
                    designation: staff.designation || 'Staff',
                    email: staff.email,
                    mobile: staff.mobile
                },
                task_summary: {
                    total_assigned: total_assigned,
                    total_completed: total_completed,
                    total_in_progress: total_in_progress,
                    total_pending: total_pending,
                    total_cancelled: total_cancelled,
                    completion_rate: parseFloat(completion_rate.toFixed(1))
                },
                quality_metrics: {
                    on_time_completed: on_time_count,
                    late_completed: late_count,
                    on_time_rate: parseFloat(on_time_rate.toFixed(1))
                },
                revenue_summary: {
                    total_revenue: parseFloat(total_revenue.toFixed(2)),
                    billed_revenue: parseFloat(billed_revenue.toFixed(2)),
                    unbilled_revenue: parseFloat(unbilled_revenue.toFixed(2)),
                    formatted_total_revenue: `₹${total_revenue.toLocaleString('en-IN')}`,
                    formatted_billed_revenue: `₹${billed_revenue.toLocaleString('en-IN')}`,
                    formatted_unbilled_revenue: `₹${unbilled_revenue.toLocaleString('en-IN')}`
                },
                performance_score: parseFloat(performance_score.toFixed(1)),
                performance_rating: performance_rating
            });
        }

        // Calculate team totals
        const teamStats = {
            total_staff: staffStats.length,
            total_assigned: staffStats.reduce((sum, s) => sum + s.task_summary.total_assigned, 0),
            total_completed: staffStats.reduce((sum, s) => sum + s.task_summary.total_completed, 0),
            total_revenue: staffStats.reduce((sum, s) => sum + s.revenue_summary.total_revenue, 0),
            avg_completion_rate: staffStats.reduce((sum, s) => sum + s.task_summary.completion_rate, 0) / (staffStats.length || 1),
            avg_on_time_rate: staffStats.reduce((sum, s) => sum + s.quality_metrics.on_time_rate, 0) / (staffStats.length || 1)
        };

        return res.status(200).json({
            success: true,
            message: "Staff performance stats retrieved successfully",
            data: {
                period: {
                    from_date: startDate.toISOString().split('T')[0],
                    to_date: endDate.toISOString().split('T')[0],
                    range: range
                },
                team_summary: {
                    total_staff: teamStats.total_staff,
                    total_tasks_assigned: teamStats.total_assigned,
                    total_tasks_completed: teamStats.total_completed,
                    total_revenue_generated: parseFloat(teamStats.total_revenue.toFixed(2)),
                    formatted_total_revenue: `₹${teamStats.total_revenue.toLocaleString('en-IN')}`,
                    average_completion_rate: parseFloat(teamStats.avg_completion_rate.toFixed(1)),
                    average_on_time_rate: parseFloat(teamStats.avg_on_time_rate.toFixed(1))
                },
                staff_performance: staffStats
            }
        });

    } catch (error) {
        console.error("Staff performance stats error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch staff performance stats",
            error: error.message
        });
    }
});

// Get Staff Tasks by Status - Simple API
router.get("/staff-tasks", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            staff_username,
            status  // 'all', 'complete', 'cancel', 'in process', 'pending from client', 'pending from department'
        } = req.query;

        // Validate required parameter
        if (!staff_username) {
            return res.status(400).json({
                success: false,
                message: "staff_username is required"
            });
        }

        // Verify staff exists and is active
        const [staffCheck] = await pool.query(
            `SELECT bm.username, bm.designation, p.name, p.email, p.mobile
             FROM branch_mapping bm
             LEFT JOIN profile p ON bm.username = p.username
             WHERE bm.branch_id = ? 
             AND bm.username = ?
             AND bm.is_deleted = '0'
             AND bm.status = '1'
             AND bm.is_accepted = '1'`,
            [branch_id, staff_username]
        );

        if (staffCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Staff member not found or not active"
            });
        }

        const staffInfo = {
            username: staffCheck[0].username,
            name: staffCheck[0].name || staffCheck[0].username,
            designation: staffCheck[0].designation,
            email: staffCheck[0].email,
            mobile: staffCheck[0].mobile
        };

        // Build query to get tasks
        let tasksQuery = `
            SELECT DISTINCT
                t.task_id,
                t.due_date,
                t.target_date,
                t.status as task_status,
                t.create_date,
                t.complete_date,
                t.billing_status,
                t.fees,
                t.total,
                s.name as service_name,
                p.name as client_name,
                p.mobile as client_mobile,
                f.firm_name
            FROM task_staffs ts
            INNER JOIN tasks t ON ts.task_id = t.task_id AND t.branch_id = ts.branch_id
            LEFT JOIN services s ON t.service_id = s.service_id
            LEFT JOIN profile p ON t.username = p.username
            LEFT JOIN firms f ON t.firm_id = f.firm_id AND f.branch_id = t.branch_id
            WHERE ts.branch_id = ?
            AND ts.username = ?
            AND (ts.is_deleted = '0' OR ts.is_deleted = 0)
        `;

        const queryParams = [branch_id, staff_username];

        // Add status filter
        if (status && status !== 'all') {
            tasksQuery += ` AND t.status = ?`;
            queryParams.push(status);
        }

        // Add order by
        tasksQuery += ` ORDER BY t.due_date ASC`;

        const [tasks] = await pool.query(tasksQuery, queryParams);

        // Format response
        const taskList = tasks.map(task => ({
            task_id: task.task_id,
            service_name: task.service_name,
            client_name: task.client_name,
            client_mobile: task.client_mobile,
            firm_name: task.firm_name,
            status: task.task_status,
            due_date: task.due_date,
            target_date: task.target_date,
            create_date: task.create_date,
            complete_date: task.complete_date,
            financials: {
                fees: parseFloat(task.fees || 0),
                total: parseFloat(task.total || 0),
                billing_status: task.billing_status == '0' ? 'pending' :
                    task.billing_status == '1' ? 'billed' : 'non_billable'
            }
        }));

        // Summary by status
        const summary = {
            total: taskList.length,
            complete: taskList.filter(t => t.status === 'complete').length,
            cancel: taskList.filter(t => t.status === 'cancel').length,
            in_process: taskList.filter(t => t.status === 'in process').length,
            pending_from_client: taskList.filter(t => t.status === 'pending from client').length,
            pending_from_department: taskList.filter(t => t.status === 'pending from department').length
        };

        return res.status(200).json({
            success: true,
            message: "Staff tasks retrieved successfully",
            data: {
                staff_info: staffInfo,
                filter_applied: status || 'all',
                summary: summary,
                tasks: taskList
            }
        });

    } catch (error) {
        console.error("Staff tasks simple error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch staff tasks",
            error: error.message
        });
    }
});

// GET /recurring-task-summary - Get summary report of recurring tasks (compliance schedules)
router.get("/recurring-task-summary", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { service_ids, search } = req.query;

        let serviceIdArray = [];
        if (service_ids) {
            if (Array.isArray(service_ids)) {
                serviceIdArray = service_ids.map(id => String(id).trim()).filter(Boolean);
            } else if (typeof service_ids === "string") {
                serviceIdArray = service_ids.split(",").map(id => id.trim()).filter(Boolean);
            }
        }

        // 1. Fetch compliance services enabled/owned by branch
        let serviceQuery = `
            SELECT DISTINCT
                s.service_id,
                s.name as service_name,
                s.type as service_type
            FROM services s
            LEFT JOIN branch_services bs ON s.service_id = bs.service_id AND bs.branch_id = ? AND bs.is_deleted = '0'
            WHERE s.type = 'compliance'
        `;
        const serviceParams = [branch_id];

        if (serviceIdArray.length > 0) {
            const placeholders = serviceIdArray.map(() => "?").join(",");
            serviceQuery += ` AND s.service_id IN (${placeholders})`;
            serviceParams.push(...serviceIdArray);
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            serviceQuery += ` AND s.name LIKE ?`;
            serviceParams.push(searchPattern);
        }

        serviceQuery += ` ORDER BY s.name ASC`;
        const [services] = await pool.query(serviceQuery, serviceParams);

        if (services.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No recurring tasks found",
                data: [],
                summary: {
                    total_services: 0,
                    total_active_tasks: 0,
                    total_all_tasks: 0,
                    category_totals: {
                        OD: 0, DT: 0, D7: 0, FT: 0,
                        PFD: 0, PFC: 0, CPL: 0, OUT: 0, NA: 0
                    }
                }
            });
        }

        // 2. Fetch compliance schedules for these services
        const serviceIdList = services.map(s => s.service_id);
        const placeholders = serviceIdList.map(() => "?").join(",");
        const schedulesQuery = `
            SELECT 
                cs.schedule_id,
                ca.service_id,
                cs.status,
                cs.due_date
            FROM compliance_schedules cs
            INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
            INNER JOIN firms f ON ca.firm_id = f.firm_id
            WHERE f.branch_id = ? AND f.is_deleted = '0'
              AND ca.service_id IN (${placeholders})
        `;
        const [schedules] = await pool.query(schedulesQuery, [branch_id, ...serviceIdList]);

        // Helper to check active status (pending action)
        function isRecurringActive(status) {
            return status === 'Pending From The Department' || status === 'Pending From Client';
        }

        function getRecurringStatusCategory(status) {
            if (status === 'Pending From The Department') return 'PFD';
            if (status === 'Pending From Client') return 'PFC';
            if (status === 'Complete') return 'CPL';
            if (status === 'Cancel') return 'CNL';
            if (status === 'N/A') return 'NA';
            return null;
        }

        const reportData = [];
        let globalTotals = {
            OD: 0, DT: 0, D7: 0, FT: 0,
            PFD: 0, PFC: 0, CPL: 0, CNL: 0, NA: 0,
            total_active_tasks: 0,
            total_all_tasks: 0
        };

        for (const service of services) {
            const serviceSchedules = schedules.filter(s => s.service_id === service.service_id);

            const counts = {
                OD: 0, DT: 0, D7: 0, FT: 0,
                PFD: 0, PFC: 0, CPL: 0, CNL: 0, NA: 0
            };

            let activeCount = 0;

            for (const sched of serviceSchedules) {
                const statusCat = getRecurringStatusCategory(sched.status);
                if (statusCat) {
                    counts[statusCat]++;
                }

                if (isRecurringActive(sched.status)) {
                    const dueCategory = getDueDateCategory(sched.due_date);
                    if (dueCategory) {
                        counts[dueCategory]++;
                    }
                    activeCount++;
                }
            }

            const totalCount = serviceSchedules.length;

            // Update global totals
            for (const key of Object.keys(counts)) {
                globalTotals[key] += counts[key];
            }
            globalTotals.total_active_tasks += activeCount;
            globalTotals.total_all_tasks += totalCount;

            reportData.push({
                service_id: service.service_id,
                service_name: service.service_name,
                service_type: service.service_type,
                task_counts: counts,
                total_tasks: totalCount,
                active_tasks: activeCount,
                completed_tasks: counts.CPL
            });
        }

        return res.status(200).json({
            success: true,
            message: "Recurring task summary report retrieved successfully",
            data: reportData,
            summary: {
                total_services: reportData.length,
                total_active_tasks: globalTotals.total_active_tasks,
                total_all_tasks: globalTotals.total_all_tasks,
                category_totals: {
                    OD: globalTotals.OD,
                    DT: globalTotals.DT,
                    D7: globalTotals.D7,
                    FT: globalTotals.FT,
                    PFD: globalTotals.PFD,
                    PFC: globalTotals.PFC,
                    CPL: globalTotals.CPL,
                    OUT: globalTotals.OUT,
                    NA: globalTotals.NA
                }
            }
        });
    } catch (error) {
        console.error("Recurring task summary report error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch recurring task summary report", error: error.message });
    }
});

// GET /recurring-task-detailed - Get detailed list of recurring tasks by category
router.get("/recurring-task-detailed", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { category, service_id, page_no = 1, limit = 20, search, status_filter } = req.query;

        const validCategories = ['OD', 'DT', 'D7', 'FT', 'PFD', 'PFC', 'CPL', 'OUT', 'NA', 'ALL'];
        if (!category || !validCategories.includes(category)) {
            return res.status(400).json({ success: false, message: `Invalid or missing category. Valid categories: ${validCategories.join(', ')}` });
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let whereConditions = "f.branch_id = ? AND f.is_deleted = '0'";
        const queryParams = [branch_id];

        if (service_id && String(service_id).trim() !== "") {
            whereConditions += " AND ca.service_id = ?";
            queryParams.push(String(service_id).trim());
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            whereConditions += " AND (s.name LIKE ? OR f.firm_name LIKE ? OR cs.period_name LIKE ?)";
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        if (status_filter && String(status_filter).trim() !== "") {
            whereConditions += " AND cs.status = ?";
            queryParams.push(String(status_filter).trim());
        }

        // If category is a direct status category, filter in SQL
        if (['PFD', 'PFC', 'CPL', 'CNL', 'NA'].includes(category)) {
            let statusVal = '';
            if (category === 'PFD') statusVal = 'Pending From The Department';
            else if (category === 'PFC') statusVal = 'Pending From Client';
            else if (category === 'CPL') statusVal = 'Complete';
            else if (category === 'CNL') statusVal = 'Cancel';
            else if (category === 'NA') statusVal = 'N/A';

            whereConditions += " AND cs.status = ?";
            queryParams.push(statusVal);
        }

        const schedulesQuery = `
            SELECT 
                cs.schedule_id,
                cs.financial_year,
                cs.period_name,
                cs.status,
                cs.amount,
                cs.due_date,
                cs.completed_by,
                cs.completed_at,
                ca.service_id,
                s.name as service_name,
                s.frequency,
                ca.firm_id,
                f.firm_name,
                ca.employee_username,
                ca.ca_id,
                ca.create_date
            FROM compliance_schedules cs
            INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id
            INNER JOIN firms f ON ca.firm_id = f.firm_id
            INNER JOIN services s ON ca.service_id = s.service_id
            WHERE ${whereConditions}
            ORDER BY cs.due_date ASC, cs.id DESC
        `;

        const [allSchedules] = await pool.query(schedulesQuery, queryParams);

        // Restrict schedules based on frequency display limits
        const allSchedulesFiltered = filterSchedulesByRecurringRules(allSchedules, new Date());

        // Filter due date categories in Javascript
        let filteredSchedules = [];
        if (['OD', 'DT', 'D7', 'FT'].includes(category)) {
            for (const sched of allSchedulesFiltered) {
                if (sched.status === 'Pending From The Department' || sched.status === 'Pending From Client') {
                    const dueCategory = getDueDateCategory(sched.due_date);
                    if (dueCategory === category) {
                        filteredSchedules.push(sched);
                    }
                }
            }
        } else {
            filteredSchedules = allSchedulesFiltered;
        }

        // Pagination
        const total = filteredSchedules.length;
        const paginatedSchedules = filteredSchedules.slice(offset, offset + limitNum);

        const result = [];
        for (const sched of paginatedSchedules) {
            const usernames = (sched.employee_username || "")
                .split(",")
                .map(u => u.trim())
                .filter(Boolean);

            const employees = [];
            for (const uname of usernames) {
                const profile = await USER_SNIPPED_DATA(uname);
                if (profile && profile.username) {
                    employees.push(profile);
                }
            }

            const caProfile = sched.ca_id ? await USER_SNIPPED_DATA(sched.ca_id) : null;
            const completedByProfile = sched.completed_by ? await USER_SNIPPED_DATA(sched.completed_by) : null;

            result.push({
                schedule_id: sched.schedule_id,
                financial_year: sched.financial_year,
                period_name: sched.period_name,
                status: sched.status,
                amount: sched.amount,
                due_date: sched.due_date,
                completed_at: sched.completed_at,
                completed_by: completedByProfile,
                service_id: sched.service_id,
                service_name: sched.service_name,
                firm_id: sched.firm_id,
                firm_name: sched.firm_name,
                employees,
                ca: caProfile
            });
        }

        const totalPages = Math.ceil(total / limitNum);
        return res.status(200).json({
            success: true,
            message: "Recurring task detailed report retrieved successfully",
            data: result,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: totalPages,
                is_last_page: pageNum >= totalPages
            }
        });
    } catch (error) {
        console.error("Recurring task detailed report error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch recurring task detailed report", error: error.message });
    }
});

export default router;