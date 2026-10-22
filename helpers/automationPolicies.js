export const AUTOMATION_POLICY_KEYS = [
    "recurringTasks",
    "autoBilling",
    "paymentReminders",
    "documentReminders",
    "complianceAlerts",
    "taxDeadlineAlerts",
    "reportGeneration",
    "clientOnboarding",
    "emailNotifications",
    "dataBackup",
    "auditTrail",
    "performanceReports",
];

export const DEFAULT_AUTOMATION_POLICIES = {
    recurringTasks: true,
    autoBilling: false,
    paymentReminders: true,
    documentReminders: true,
    complianceAlerts: false,
    taxDeadlineAlerts: true,
    reportGeneration: false,
    clientOnboarding: true,
    emailNotifications: true,
    dataBackup: true,
    auditTrail: false,
    performanceReports: true,
};

export function normalizeAutomationScope({ scopeType, scopeId, branchId }) {
    const normalizedType = String(scopeType || "branch").trim().toLowerCase();
    const normalizedId = String(scopeId || branchId || "").trim();

    if (!new Set(["branch", "client"]).has(normalizedType)) {
        return { error: "scope_type must be branch or client" };
    }
    if (!normalizedId) {
        return { error: "scope_id is required" };
    }
    if (normalizedType === "branch" && normalizedId !== String(branchId)) {
        return { error: "branch scope must use the current branch" };
    }

    return { value: { scopeType: normalizedType, scopeId: normalizedId } };
}

export function normalizeAutomationPolicies(input = {}) {
    const unknown = Object.keys(input).filter((key) => !AUTOMATION_POLICY_KEYS.includes(key));
    if (unknown.length) {
        return { error: `Unknown automation policy: ${unknown[0]}` };
    }

    const policies = {};
    for (const key of AUTOMATION_POLICY_KEYS) {
        if (input[key] !== undefined) policies[key] = Boolean(input[key]);
    }
    if (!Object.keys(policies).length) {
        return { error: "policies must contain at least one recognized setting" };
    }
    return { value: policies };
}
