import test from "node:test";
import assert from "node:assert/strict";
import {
    createsLedgerGroupCycle,
    normalizeLedgerGroupInput,
} from "../helpers/ledgerGroupValidation.js";

test("ledger group input is normalized and validated", () => {
    assert.deepEqual(normalizeLedgerGroupInput({
        name: "  Sundry Debtors  ",
        group_type: "ASSET",
        normal_balance: "DEBIT",
        parent_group_id: "LG_PARENT",
    }), {
        value: {
            name: "Sundry Debtors",
            group_type: "asset",
            normal_balance: "debit",
            parent_group_id: "LG_PARENT",
        },
    });
});

test("ledger group input rejects invalid type and empty name", () => {
    assert.equal(normalizeLedgerGroupInput({ group_type: "asset", normal_balance: "debit" }).error, "name is required");
    assert.match(
        normalizeLedgerGroupInput({ name: "Sales", group_type: "other", normal_balance: "credit" }).error,
        /group_type/
    );
});

test("ledger group hierarchy detects self and indirect cycles", () => {
    const groups = new Map([
        ["A", { parent_group_id: null }],
        ["B", { parent_group_id: "A" }],
        ["C", { parent_group_id: "B" }],
    ]);

    assert.equal(createsLedgerGroupCycle(groups, "C", "A"), false);
    assert.equal(createsLedgerGroupCycle(groups, "A", "C"), true);
    assert.equal(createsLedgerGroupCycle(groups, "B", "B"), true);
});
