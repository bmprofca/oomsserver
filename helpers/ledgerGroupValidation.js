export const LEDGER_GROUP_TYPES = new Set([
    "asset",
    "liability",
    "equity",
    "income",
    "expense",
]);

export const LEDGER_BALANCES = new Set(["debit", "credit"]);

export function normalizeLedgerGroupInput(body = {}) {
    const name = String(body.name || "").trim();
    const groupType = String(body.group_type || "").trim().toLowerCase();
    const normalBalance = String(body.normal_balance || "").trim().toLowerCase();
    const parentGroupId = body.parent_group_id == null
        ? null
        : String(body.parent_group_id).trim() || null;

    if (!name) {
        return { error: "name is required" };
    }
    if (name.length > 150) {
        return { error: "name must be 150 characters or fewer" };
    }
    if (!LEDGER_GROUP_TYPES.has(groupType)) {
        return { error: "group_type must be asset, liability, equity, income, or expense" };
    }
    if (!LEDGER_BALANCES.has(normalBalance)) {
        return { error: "normal_balance must be debit or credit" };
    }

    return {
        value: {
            name,
            group_type: groupType,
            normal_balance: normalBalance,
            parent_group_id: parentGroupId,
        },
    };
}

/**
 * Detects whether assigning parentId to groupId would create a hierarchy cycle.
 * The map values only need a parent_group_id property, which keeps this helper
 * database-independent and easy to test.
 */
export function createsLedgerGroupCycle(groups, groupId, parentId) {
    if (!parentId) return false;
    const seen = new Set([String(groupId)]);
    let current = String(parentId);

    while (current) {
        if (seen.has(current)) return true;
        seen.add(current);
        current = groups.get(current)?.parent_group_id || null;
    }

    return false;
}
