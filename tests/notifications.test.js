import test from "node:test";
import assert from "node:assert/strict";
import {
    buildNotificationId,
    normalizeNotificationInput,
    normalizeNotificationRecipients,
    sanitizeNotificationData,
} from "../helpers/notifications.js";

test("notification IDs are deterministic for idempotent retries", () => {
    assert.equal(
        buildNotificationId("b1", "staff", "u1", "task:created:1"),
        buildNotificationId("b1", "staff", "u1", "task:created:1")
    );
    assert.notEqual(
        buildNotificationId("b1", "staff", "u1", "task:created:1"),
        buildNotificationId("b2", "staff", "u1", "task:created:1")
    );
});

test("notification recipients are normalized and deduplicated", () => {
    assert.deepEqual(
        normalizeNotificationRecipients([
            { recipient_type: "Staff", recipient_id: "u1" },
            { recipient_type: "staff", recipient_id: "u1" },
            { recipient_type: "client", recipient_id: "c1" },
            { recipient_type: "", recipient_id: "bad" },
        ]),
        [
            { recipient_type: "staff", recipient_id: "u1" },
            { recipient_type: "client", recipient_id: "c1" },
        ]
    );
});

test("notification payload redacts secrets and validates required fields", () => {
    const result = normalizeNotificationInput({
        event_key: "billing:invoice:1",
        title: "Invoice ready",
        body: "A new invoice is ready",
        data: { invoice_id: "inv_1", pan: "ABCDE1234F", nested: { token: "secret" } },
    });
    assert.equal(result.data.pan, undefined);
    assert.equal(result.data.nested.token, undefined);
    assert.throws(() => normalizeNotificationInput({ title: "missing event" }), /event_key is required/);
    assert.equal(sanitizeNotificationData(null).constructor, Object);
});
