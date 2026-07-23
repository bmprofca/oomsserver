import pool from "../db.js";
import { RANDOM_STRING } from "./function.js";

// Helper to normalize financial year strings (e.g. "26-27 FY", "26-27", "2026-27" -> "2026-2027")
export function normalizeFinancialYear(fy) {
    if (!fy) return fy;
    let clean = String(fy).replace(/(?:\b(fy|financial\s*year)\b)/gi, '').replace(/\s+/g, '').trim();
    const match = clean.match(/^(\d{2,4})[-/](\d{2,4})$/);
    if (match) {
        let start = match[1];
        let end = match[2];
        if (start.length === 2) {
            start = "20" + start;
        }
        if (end.length === 2) {
            end = "20" + end;
        }
        return `${start}-${end}`;
    }
    return fy;
}

// Helper to get allowed periods for financial year generation based on frequency
export function getPeriodsForFrequency(frequency, options = {}) {
    const freq = String(frequency).trim().toLowerCase();
    const { pay_from_month, quarters } = options;

    if (freq === 'monthly') {
        const allMonths = [
            'April', 'May', 'June', 'July', 'August', 'September',
            'October', 'November', 'December', 'January', 'February', 'March'
        ];
        if (pay_from_month) {
            const startMonthNormalized = String(pay_from_month).trim().toLowerCase();
            const startIndex = allMonths.findIndex(m => m.toLowerCase() === startMonthNormalized);
            if (startIndex !== -1) {
                return allMonths.slice(startIndex);
            }
        }
        return allMonths;
    } else if (freq === 'quarterly') {
        const allQuarters = ['Q1 (Apr-Jun)', 'Q2 (Jul-Sep)', 'Q3 (Oct-Dec)', 'Q4 (Jan-Mar)'];
        if (quarters) {
            const qArr = Array.isArray(quarters) ? quarters.map(Number) : [Number(quarters)];
            const filteredQuarters = [];
            qArr.forEach(q => {
                if (q >= 1 && q <= 4) {
                    filteredQuarters.push(allQuarters[q - 1]);
                }
            });
            if (filteredQuarters.length > 0) {
                return filteredQuarters;
            }
        }
        return allQuarters;
    } else if (freq === 'half-yearly' || freq === 'halfyearly' || freq === 'hypearly') {
        return ['H1 (Apr-Sep)', 'H2 (Oct-Mar)'];
    } else if (freq === 'yearly' || freq === 'annual') {
        return ['Annual'];
    }
    return ['Annual'];
}

// Helper to determine the end date of a period in a financial year
export function getPeriodEndDate(period, fy) {
    const normalizedFy = normalizeFinancialYear(fy);
    const parts = String(normalizedFy).split('-');
    let startYear = parseInt(parts[0]);
    let endYear = parts[1] ? parseInt(parts[1]) : startYear + 1;
    if (startYear < 100) startYear += 2000;
    if (endYear < 100) endYear += 2000;

    const p = String(period).trim().toLowerCase();

    if (p === 'april') return new Date(startYear, 3, 30, 23, 59, 59);
    if (p === 'may') return new Date(startYear, 4, 31, 23, 59, 59);
    if (p === 'june') return new Date(startYear, 5, 30, 23, 59, 59);
    if (p === 'july') return new Date(startYear, 6, 31, 23, 59, 59);
    if (p === 'august') return new Date(startYear, 7, 31, 23, 59, 59);
    if (p === 'september') return new Date(startYear, 8, 30, 23, 59, 59);
    if (p === 'october') return new Date(startYear, 9, 31, 23, 59, 59);
    if (p === 'november') return new Date(startYear, 10, 30, 23, 59, 59);
    if (p === 'december') return new Date(startYear, 11, 31, 23, 59, 59);
    if (p === 'january') return new Date(endYear, 0, 31, 23, 59, 59);
    if (p === 'february') return new Date(endYear, 1, 28, 23, 59, 59);
    if (p === 'march') return new Date(endYear, 2, 31, 23, 59, 59);

    if (p.startsWith('q1')) return new Date(startYear, 5, 30, 23, 59, 59);
    if (p.startsWith('q2')) return new Date(startYear, 8, 30, 23, 59, 59);
    if (p.startsWith('q3')) return new Date(startYear, 11, 31, 23, 59, 59);
    if (p.startsWith('q4')) return new Date(endYear, 2, 31, 23, 59, 59);

    if (p.startsWith('h1')) return new Date(startYear, 8, 30, 23, 59, 59);
    if (p.startsWith('h2')) return new Date(endYear, 2, 31, 23, 59, 59);

    if (p === 'annual') return new Date(endYear, 2, 31, 23, 59, 59);

    return new Date(endYear, 2, 31, 23, 59, 59);
}

// Helper to determine the start date of a period in a financial year
export function getPeriodStartDate(period, fy) {
    if (!fy) return new Date();
    const normalizedFy = normalizeFinancialYear(fy);
    const parts = String(normalizedFy).split('-');
    let startYear = parseInt(parts[0]);
    let endYear = parts[1] ? parseInt(parts[1]) : startYear + 1;
    if (startYear < 100) startYear += 2000;
    if (endYear < 100) endYear += 2000;

    const p = String(period).trim().toLowerCase();

    if (p === 'april') return new Date(startYear, 3, 1, 0, 0, 0);
    if (p === 'may') return new Date(startYear, 4, 1, 0, 0, 0);
    if (p === 'june') return new Date(startYear, 5, 1, 0, 0, 0);
    if (p === 'july') return new Date(startYear, 6, 1, 0, 0, 0);
    if (p === 'august') return new Date(startYear, 7, 1, 0, 0, 0);
    if (p === 'september') return new Date(startYear, 8, 1, 0, 0, 0);
    if (p === 'october') return new Date(startYear, 9, 1, 0, 0, 0);
    if (p === 'november') return new Date(startYear, 10, 1, 0, 0, 0);
    if (p === 'december') return new Date(startYear, 11, 1, 0, 0, 0);
    if (p === 'january') return new Date(endYear, 0, 1, 0, 0, 0);
    if (p === 'february') return new Date(endYear, 1, 1, 0, 0, 0);
    if (p === 'march') return new Date(endYear, 2, 1, 0, 0, 0);

    if (p.startsWith('q1')) return new Date(startYear, 3, 1, 0, 0, 0);
    if (p.startsWith('q2')) return new Date(startYear, 6, 1, 0, 0, 0);
    if (p.startsWith('q3')) return new Date(startYear, 9, 1, 0, 0, 0);
    if (p.startsWith('q4')) return new Date(endYear, 0, 1, 0, 0, 0);

    if (p.startsWith('h1')) return new Date(startYear, 3, 1, 0, 0, 0);
    if (p.startsWith('h2')) return new Date(startYear, 9, 1, 0, 0, 0);

    if (p === 'annual') return new Date(startYear, 3, 1, 0, 0, 0);

    return new Date(startYear, 3, 1, 0, 0, 0);
}

// Helper to determine the due date of a period in a financial year
export function getPeriodDueDate(period, fy, dueDay) {
    if (dueDay == null) {
        return getPeriodEndDate(period, fy);
    }
    const day = parseInt(dueDay);
    if (isNaN(day) || day < 1 || day > 31) {
        return getPeriodEndDate(period, fy);
    }

    const normalizedFy = normalizeFinancialYear(fy);
    const parts = String(normalizedFy).split('-');
    let startYear = parseInt(parts[0]);
    let endYear = parts[1] ? parseInt(parts[1]) : startYear + 1;
    if (startYear < 100) startYear += 2000;
    if (endYear < 100) endYear += 2000;

    const p = String(period).trim().toLowerCase();

    function makeSafeDate(year, month, dayVal) {
        const maxDays = new Date(year, month + 1, 0).getDate();
        const safeDay = Math.min(dayVal, maxDays);
        return new Date(year, month, safeDay, 23, 59, 59);
    }

    if (p === 'april') return makeSafeDate(startYear, 4, day);
    if (p === 'may') return makeSafeDate(startYear, 5, day);
    if (p === 'june') return makeSafeDate(startYear, 6, day);
    if (p === 'july') return makeSafeDate(startYear, 7, day);
    if (p === 'august') return makeSafeDate(startYear, 8, day);
    if (p === 'september') return makeSafeDate(startYear, 9, day);
    if (p === 'october') return makeSafeDate(startYear, 10, day);
    if (p === 'november') return makeSafeDate(startYear, 11, day);
    if (p === 'december') return makeSafeDate(endYear, 0, day);
    if (p === 'january') return makeSafeDate(endYear, 1, day);
    if (p === 'february') return makeSafeDate(endYear, 2, day);
    if (p === 'march') return makeSafeDate(endYear, 3, day);

    // Quarters
    if (p.startsWith('q1')) return makeSafeDate(startYear, 6, day);
    if (p.startsWith('q2')) return makeSafeDate(startYear, 9, day);
    if (p.startsWith('q3')) return makeSafeDate(endYear, 0, day);
    if (p.startsWith('q4')) return makeSafeDate(endYear, 3, day);

    // Half-yearly
    if (p.startsWith('h1')) return makeSafeDate(startYear, 9, day);
    if (p.startsWith('h2')) return makeSafeDate(endYear, 3, day);

    // Yearly
    if (p === 'annual') return makeSafeDate(endYear, 3, day);

    return getPeriodEndDate(period, fy);
}

export function getServiceDueDayForPeriod(service, period) {
    if (!service) return null;
    return service.default_due_date ?? service.due_day ?? null;
}

export function formatMySqlDate(d) {
    if (!d) return null;
    const dateObj = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dateObj.getTime())) return String(d);
    return dateObj.getFullYear() + '-' +
        String(dateObj.getMonth() + 1).padStart(2, '0') + '-' +
        String(dateObj.getDate()).padStart(2, '0');
}

export function getNextFinancialYear(fy) {
    const parts = String(fy).split('-');
    const startYear = parseInt(parts[0]);
    if (!isNaN(startYear)) {
        return `${startYear + 1}-${startYear + 2}`;
    }
    return null;
}

export function getFinancialYearForDate(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth(); // 0-indexed (0 = Jan, 11 = Dec)
    if (month >= 3) {
        return `${year}-${year + 1}`;
    } else {
        return `${year - 1}-${year}`;
    }
}

/** Inclusive FY list from startFy through endFy (e.g. 2024-2025 … 2026-2027). */
export function listFinancialYearsInclusive(startFy, endFy) {
    const end = normalizeFinancialYear(endFy);
    const start = normalizeFinancialYear(startFy);
    const startInt = parseInt(String(start).split("-")[0], 10);
    const endInt = parseInt(String(end).split("-")[0], 10);
    if (!Number.isFinite(startInt) || !Number.isFinite(endInt)) {
        return [end];
    }
    if (startInt > endInt) {
        return [];
    }
    const years = [];
    for (let year = startInt; year <= endInt; year += 1) {
        years.push(`${year}-${year + 1}`);
    }
    return years;
}

/** Start FY for an assignment from effective_from; falls back to current FY when missing/invalid. */
export function getEffectiveStartFinancialYear(effectiveFrom, frequency, now = new Date()) {
    const currentFy = getFinancialYearForDate(now);
    if (effectiveFrom == null || String(effectiveFrom).trim() === "") {
        return currentFy;
    }
    const parsed = parseComplianceEffectiveFrom(effectiveFrom, frequency);
    if (parsed.error || !parsed.periodStart) {
        return currentFy;
    }
    return getFinancialYearForDate(parsed.periodStart);
}

const COMPLIANCE_MONTH_LABELS = [
    "April", "May", "June", "July", "August", "September",
    "October", "November", "December", "January", "February", "March",
];

const MONTH_NAME_TO_CALENDAR_INDEX = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
};

export function normalizeComplianceFrequency(frequency) {
    const freq = String(frequency || "monthly").trim().toLowerCase();
    if (freq === "halfyearly" || freq === "hypearly") return "half-yearly";
    if (freq === "annual") return "yearly";
    return freq;
}

export function isYearlyComplianceFrequency(frequency) {
    return normalizeComplianceFrequency(frequency) === "yearly";
}

export function getCompliancePeriodOptions(frequency) {
    const freq = normalizeComplianceFrequency(frequency);

    if (freq === "yearly") {
        return {
            frequency: freq,
            period_select_enabled: false,
            periods: [],
        };
    }

    const allPeriods = getPeriodsForFrequency(freq);
    return {
        frequency: freq,
        period_select_enabled: true,
        periods: allPeriods.map((period) => ({
            value: period,
            label: period,
        })),
    };
}

export function resolveCompliancePeriodInput(compliancePeriodRaw, frequency) {
    const freq = normalizeComplianceFrequency(frequency);

    if (freq === "yearly") {
        if (compliancePeriodRaw != null && String(compliancePeriodRaw).trim() !== "") {
            return {
                error: "compliance_period is not applicable for yearly services",
            };
        }
        return { period: "Annual" };
    }

    const period = compliancePeriodRaw != null ? String(compliancePeriodRaw).trim() : "";
    if (!period) {
        return { error: "compliance_period is required" };
    }

    const allowedPeriods = getPeriodsForFrequency(freq);
    const matchedPeriod = allowedPeriods.find(
        (item) => item.toLowerCase() === period.toLowerCase()
    );
    if (!matchedPeriod) {
        return {
            error: `compliance_period must be one of: ${allowedPeriods.join(", ")}`,
        };
    }

    return { period: matchedPeriod };
}

function resolveComplianceMonthName(input) {
    const lower = String(input || "").trim().toLowerCase();
    return COMPLIANCE_MONTH_LABELS.find((month) => month.toLowerCase() === lower) || null;
}

export function parseComplianceEffectiveFrom(value, frequency) {
    const freq = normalizeComplianceFrequency(frequency);
    const raw = value != null ? String(value).trim() : "";
    if (!raw) {
        return { error: "effective_from is required" };
    }

    if (freq === "yearly") {
        const fy = normalizeFinancialYear(raw);
        if (!/^\d{4}-\d{4}$/.test(String(fy))) {
            return {
                error: "effective_from for yearly services must be a financial year like 2026-2027",
            };
        }
        return {
            value: fy,
            periodStart: getPeriodStartDate("Annual", fy),
        };
    }

    if (freq === "monthly") {
        const match = raw.match(/^([A-Za-z]+)-(\d{4})$/);
        if (!match) {
            return {
                error: "effective_from for monthly services must be like May-2026",
            };
        }
        const monthName = resolveComplianceMonthName(match[1]);
        if (!monthName) {
            return { error: "effective_from contains an invalid month name" };
        }
        const calendarYear = parseInt(match[2], 10);
        if (Number.isNaN(calendarYear)) {
            return { error: "effective_from year must be a 4-digit year" };
        }
        const monthIndex = MONTH_NAME_TO_CALENDAR_INDEX[monthName.toLowerCase()];
        const fy = getFinancialYearForDate(new Date(calendarYear, monthIndex, 1));
        return {
            value: `${monthName}-${calendarYear}`,
            periodStart: getPeriodStartDate(monthName, fy),
        };
    }

    const dashIdx = raw.lastIndexOf("-");
    if (dashIdx <= 0) {
        return {
            error: `effective_from for ${freq} services must be like Q1 (Apr-Jun)-2026`,
        };
    }

    const periodPart = raw.slice(0, dashIdx).trim();
    const yearPart = raw.slice(dashIdx + 1).trim();
    if (!/^\d{4}$/.test(yearPart)) {
        return {
            error: "effective_from must end with a 4-digit financial year start (e.g. -2026)",
        };
    }
    const startYear = parseInt(yearPart, 10);
    const fy = `${startYear}-${startYear + 1}`;
    const allowedPeriods = getPeriodsForFrequency(freq);
    const matchedPeriod = allowedPeriods.find(
        (period) => period.toLowerCase() === periodPart.toLowerCase()
    );
    if (!matchedPeriod) {
        return {
            error: `effective_from period must be one of: ${allowedPeriods.join(", ")}`,
        };
    }

    return {
        value: `${matchedPeriod}-${startYear}`,
        periodStart: getPeriodStartDate(matchedPeriod, fy),
    };
}

export function getComplianceTaskPeriodStart(complianceYear, compliancePeriod) {
    return getPeriodStartDate(compliancePeriod, normalizeFinancialYear(complianceYear));
}

export function isCompliancePeriodOnOrAfterEffective(
    complianceYear,
    compliancePeriod,
    effectiveFrom,
    frequency
) {
    if (effectiveFrom == null || String(effectiveFrom).trim() === "") {
        return true;
    }
    const parsed = parseComplianceEffectiveFrom(effectiveFrom, frequency);
    if (parsed.error) {
        return true;
    }
    const taskStart = getComplianceTaskPeriodStart(complianceYear, compliancePeriod);
    return taskStart >= parsed.periodStart;
}

export function formatComplianceEffectiveFromHint(frequency) {
    const freq = normalizeComplianceFrequency(frequency);
    if (freq === "yearly") return "2026-2027";
    if (freq === "monthly") return "May-2026";
    if (freq === "quarterly") return "Q1 (Apr-Jun)-2026";
    if (freq === "half-yearly") return "H1 (Apr-Sep)-2026";
    return "2026-2027";
}

// Logic to auto-generate missing compliance schedules for a single active assignment and a specific target financial year
export async function generateSchedulesForAssignment(connectionOrPool, assignment, targetFy) {
    const [schedules] = await connectionOrPool.query(
        "SELECT id FROM compliance_schedules WHERE assignment_id = ? AND financial_year = ? LIMIT 1",
        [assignment.assignment_id, targetFy]
    );

    if (schedules.length === 0) {
        // Find min existing financial year of schedules, to determine if this is the start financial year
        const [minFyRow] = await connectionOrPool.query(
            "SELECT MIN(financial_year) AS min_fy FROM compliance_schedules WHERE assignment_id = ?",
            [assignment.assignment_id]
        );

        const startFy = minFyRow[0]?.min_fy || getFinancialYearForDate(assignment.create_date);

        const normTarget = normalizeFinancialYear(targetFy);
        const normStart = normalizeFinancialYear(startFy);
        const targetYearInt = parseInt(normTarget.split('-')[0]) || 0;
        const startYearInt = parseInt(normStart.split('-')[0]) || 0;

        if (targetYearInt < startYearInt) {
            // Do not generate schedules for financial years before the assignment's start financial year
            return;
        }

        let freq = assignment.frequency;
        const monthlyGstServiceIds = new Set([
            'gstr-1',
            'gstr-3b',
            'gstr-1-regular-monthly',
            'gstr-3b-monthly',
        ]);
        if (assignment.service_id && monthlyGstServiceIds.has(String(assignment.service_id).toLowerCase())) {
            freq = 'monthly';
        }

        let periods;
        if (targetFy === startFy) {
            const savedQuarters = assignment.quarters
                ? assignment.quarters.split(',').map(Number)
                : null;
            periods = getPeriodsForFrequency(freq, {
                pay_from_month: assignment.pay_from_month,
                quarters: savedQuarters
            });
        } else {
            periods = getPeriodsForFrequency(freq);
        }

        for (const period of periods) {
            const [exists] = await connectionOrPool.query(
                "SELECT id FROM compliance_schedules WHERE assignment_id = ? AND financial_year = ? AND period_name = ? LIMIT 1",
                [assignment.assignment_id, targetFy, period]
            );
            if (exists.length === 0) {
                const schedule_id = RANDOM_STRING(30);
                const resolvedDueDay = getServiceDueDayForPeriod(assignment, period);
                const calculatedDueDate = getPeriodDueDate(period, targetFy, resolvedDueDay);
                const formattedDueDate = formatMySqlDate(calculatedDueDate);

                await connectionOrPool.query(
                    `INSERT INTO compliance_schedules (schedule_id, assignment_id, financial_year, period_name, status, amount, due_date)
                     VALUES (?, ?, ?, ?, 'N/A', ?, ?)`,
                    [schedule_id, assignment.assignment_id, targetFy, period, assignment.custom_amount, formattedDueDate]
                );
            }
        }
    }
}

// Logic to auto-transfer active assignments for a branch to a specific financial year
export async function autoTransferActiveAssignmentsForBranch(connectionOrPool, branchId, targetFy) {
    const [activeAssignments] = await connectionOrPool.query(
        `SELECT ca.*, s.frequency, s.default_due_date
         FROM compliance_assignments ca
         INNER JOIN services s ON ca.service_id = s.service_id
         INNER JOIN firms f ON ca.firm_id = f.firm_id
         WHERE f.branch_id = ? AND ca.status = 'active' AND f.is_deleted = '0'`,
        [branchId]
    );

    for (const assignment of activeAssignments) {
        await generateSchedulesForAssignment(connectionOrPool, assignment, targetFy);
    }
}

// Logic to auto-transfer active assignments for a specific client to a specific financial year
export async function autoTransferActiveAssignmentsForClient(connectionOrPool, username, branchId, targetFy) {
    const [activeAssignments] = await connectionOrPool.query(
        `SELECT ca.*, s.frequency, s.default_due_date
         FROM compliance_assignments ca
         INNER JOIN services s ON ca.service_id = s.service_id
         INNER JOIN firms f ON ca.firm_id = f.firm_id
         WHERE f.username = ? AND f.branch_id = ? AND ca.status = 'active' AND f.is_deleted = '0'`,
        [username, branchId]
    );

    for (const assignment of activeAssignments) {
        await generateSchedulesForAssignment(connectionOrPool, assignment, targetFy);
    }
}

// Restrict compliance schedules based on frequency display limits
export function filterSchedulesByRecurringRules(rows, now = new Date()) {
    if (!Array.isArray(rows)) return [];

    const currentFy = getFinancialYearForDate(now);
    const currentStartYear = parseInt(currentFy.split('-')[0]);

    const currentMonthIndex = now.getFullYear() * 12 + now.getMonth();

    const getFinancialYearStartYear = (d) => {
        const month = d.getMonth();
        const year = d.getFullYear();
        return month >= 3 ? year : year - 1;
    };

    const getFinancialQuarterIndex = (d) => {
        const fyStart = getFinancialYearStartYear(d);
        const month = d.getMonth();
        let q;
        if (month >= 3 && month <= 5) q = 0;      // Apr-Jun
        else if (month >= 6 && month <= 8) q = 1; // Jul-Sep
        else if (month >= 9 && month <= 11) q = 2;// Oct-Dec
        else q = 3;                               // Jan-Mar
        return fyStart * 4 + q;
    };
    const currentQuarterIndex = getFinancialQuarterIndex(now);

    const getFinancialHalfYearIndex = (d) => {
        const fyStart = getFinancialYearStartYear(d);
        const month = d.getMonth();
        const isH2 = (month >= 9 || month < 3); // Oct-Mar
        return fyStart * 2 + (isH2 ? 1 : 0);
    };
    const currentHalfYearIndex = getFinancialHalfYearIndex(now);

    return rows.filter(row => {
        const freq = String(row.frequency || '').trim().toLowerCase();
        const periodStart = getPeriodStartDate(row.period_name, row.financial_year);
        const periodEnd = getPeriodEndDate(row.period_name, row.financial_year);

        // Find assignment initial FY creation date
        const startFy = getFinancialYearForDate(row.create_date || row.modify_date || now);

        // Prevent showing schedules that are earlier than the start financial year of the assignment
        const normRowFy = normalizeFinancialYear(row.financial_year);
        const normStartFy = normalizeFinancialYear(startFy);
        const rowStartYear = parseInt(normRowFy.split('-')[0]) || 0;
        const startStartYear = parseInt(normStartFy.split('-')[0]) || 0;

        if (rowStartYear < startStartYear) {
            return false;
        }

        // 1. In the initial FY, exclude periods before pay_from_month
        if (row.financial_year === startFy && row.pay_from_month) {
            const payFromStart = getPeriodStartDate(row.pay_from_month, startFy);
            if (periodEnd < payFromStart) {
                return false;
            }
        }

        // Check if past or future financial year
        if (row.financial_year !== currentFy) {
            return true;
        }

        // Apply frequency-specific rules
        if (freq === 'monthly') {
            const rowMonthIndex = periodStart.getFullYear() * 12 + periodStart.getMonth();
            // Show last 6 months till active (current) month
            return (currentMonthIndex - 5 <= rowMonthIndex && rowMonthIndex <= currentMonthIndex);
        } else if (freq === 'quarterly') {
            const rowQuarterIndex = getFinancialQuarterIndex(periodStart);
            // Show last 4 quarters till now current
            return (currentQuarterIndex - 3 <= rowQuarterIndex && rowQuarterIndex <= currentQuarterIndex);
        } else if (freq === 'half-yearly' || freq === 'halfyearly' || freq === 'hypearly') {
            const rowHalfYearIndex = getFinancialHalfYearIndex(periodStart);
            // Show last 2 half-years till now current
            return (currentHalfYearIndex - 1 <= rowHalfYearIndex && rowHalfYearIndex <= currentHalfYearIndex);
        } else if (freq === 'yearly' || freq === 'annual') {
            const rowStartYear = parseInt(row.financial_year.split('-')[0]);
            // Show last 3 years till this year
            return (currentStartYear - 2 <= rowStartYear && rowStartYear <= currentStartYear);
        }

        // Fallback for any other frequency: default to keeping it
        return true;
    });
}

function startOfCalendarDay(date) {
    const d = date instanceof Date ? date : new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function getCompliancePeriodVisibilityStart(row, now = new Date()) {
    const period = row.period_name ?? row.compliance_period;
    const fy = row.financial_year ?? row.compliance_year;
    const frequency = row.frequency;
    const dueDay = row.due_date;
    const visibilityOffset = row.visibility_offset != null ? Number(row.visibility_offset) : 0;

    if (!period || !fy) {
        return startOfCalendarDay(now);
    }

    if (visibilityOffset < 0) {
        return startOfCalendarDay(getPeriodStartDate(period, fy));
    }

    const dueDate = getPeriodDueDate(period, fy, dueDay);
    return new Date(dueDate.getFullYear(), dueDate.getMonth(), 1, 0, 0, 0, 0);
}

export function isCompliancePeriodVisible(row, now = new Date()) {
    const visibilityStart = getCompliancePeriodVisibilityStart(row, now);
    return startOfCalendarDay(now) >= visibilityStart;
}

export function filterCompliancePeriodsByVisibility(rows, now = new Date()) {
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => isCompliancePeriodVisible(row, now));
}

export function buildComplianceTaskLookupKey(row) {
    const serviceId = row.service_id;
    const firmId = row.firm_id;
    const complianceYear = row.compliance_year ?? row.financial_year;
    const rawPeriod = row.compliance_period ?? row.period_name;
    const frequency = row.frequency;
    const period = isYearlyComplianceFrequency(frequency) || rawPeriod == null || rawPeriod === ""
        ? "Annual"
        : rawPeriod;
    return `${serviceId}|${firmId}|${complianceYear}|${period}`;
}

export function expandComplianceFirmPeriods(firmRows, { complianceYear, compliancePeriod } = {}) {
    const now = new Date();
    const currentFy = getFinancialYearForDate(now);
    const singleYear =
        complianceYear != null && String(complianceYear).trim() !== ""
            ? normalizeFinancialYear(complianceYear)
            : null;
    const explicitPeriod = compliancePeriod != null ? String(compliancePeriod).trim() : "";
    const expanded = [];

    for (const firm of firmRows) {
        const isYearly = isYearlyComplianceFrequency(firm.frequency);
        const years = singleYear
            ? [singleYear]
            : listFinancialYearsInclusive(
                getEffectiveStartFinancialYear(firm.effective_from, firm.frequency, now),
                currentFy
            );

        for (const targetYear of years) {
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
    }

    const pastRows = expanded.filter((row) => row.compliance_year !== currentFy);
    const currentRows = expanded.filter((row) => row.compliance_year === currentFy);

    const filteredPast = filterCompliancePeriodsByVisibility(pastRows, now);
    const filteredCurrent = !explicitPeriod
        ? filterCompliancePeriodsByVisibility(
            filterSchedulesByRecurringRules(currentRows, now),
            now
        )
        : filterCompliancePeriodsByVisibility(currentRows, now);

    return [...filteredPast, ...filteredCurrent];
}

