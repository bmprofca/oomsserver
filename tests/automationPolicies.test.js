import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_AUTOMATION_POLICIES,
    normalizeAutomationPolicies,
    normalizeAutomationScope,
} from "../helpers/automationPolicies.js";

test("automation scope is branch-safe", () => {
    assert.deepEqual(
        normalizeAutomationScope({ scopeType: "branch", scopeId: "BR1", branchId: "BR1" }),
        { value: { scopeType: "branch", scopeId: "BR1" } }
    );
    assert.match(
        normalizeAutomationScope({ scopeType: "branch", scopeId: "BR2", branchId: "BR1" }).error,
        /current branch/
    );
});

test("automation policies accept only known boolean settings", () => {
    const result = normalizeAutomationPolicies({ recurringTasks: false, emailNotifications: 1 });
    assert.deepEqual(result.value, { recurringTasks: false, emailNotifications: true });
    assert.match(normalizeAutomationPolicies({ unknown: true }).error, /Unknown/);
    assert.equal(Object.keys(DEFAULT_AUTOMATION_POLICIES).length, 12);
});
