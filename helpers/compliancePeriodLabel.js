/**
 * Format compliance period/year the same way as CLIENT/src/utils/taskCompliancePeriod.js
 * (task table: "{period} · {year}").
 */
export function isComplianceTaskLike(task) {
    if (!task) return false;
    if (String(task.task_type || "").toLowerCase() === "compliance") return true;
    if (
        task.is_recurring === true ||
        task.is_recurring === 1 ||
        task.is_recurring === "1"
    ) {
        return true;
    }
    return false;
}

export function formatCompliancePeriodLabel(task) {
    if (!isComplianceTaskLike(task)) return null;

    const year =
        task?.compliance_year ??
        task?.financial_year ??
        null;
    const yearLabel =
        year != null && String(year).trim() !== "" ? String(year).trim() : "";

    const candidates = [
        task?.compliance_period,
        task?.period,
        task?.period_name,
        task?.compliance_period_label,
    ];

    let raw = null;
    for (const value of candidates) {
        if (value != null && String(value).trim() !== "") {
            raw = String(value).trim();
            break;
        }
    }

    if (raw) {
        if (yearLabel && !raw.includes(yearLabel)) {
            return `${raw} · ${yearLabel}`;
        }
        return raw;
    }

    const frequency = String(task?.frequency || task?.service_frequency || "").toLowerCase();
    if (frequency === "yearly") {
        return yearLabel ? `Yearly · ${yearLabel}` : "Yearly";
    }

    return yearLabel || null;
}
