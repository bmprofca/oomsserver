import test from "node:test";
import assert from "node:assert/strict";
import { buildBroadcastReportSql, normalizeBroadcastReportQuery } from "../helpers/broadcastReport.js";

test("broadcast report query validates channel and dates", () => {
    assert.deepEqual(normalizeBroadcastReportQuery({ channel: "sms", page: "2", limit: "200" }), {
        channel: "sms", page: 2, limit: 100, status: null, from: null, to: null,
    });
    assert.throws(() => normalizeBroadcastReportQuery({ channel: "whatsapp" }), /channel must be/);
    assert.throws(() => normalizeBroadcastReportQuery({ channel: "email", from: "yesterday" }), /YYYY-MM-DD/);
});

test("broadcast report SQL is branch-scoped and uses persisted counts", () => {
    const email = buildBroadcastReportSql({ channel: "email", status: "failed", from: null, to: null });
    assert.match(email.sql, /branch_id = \?/);
    assert.match(email.sql, /total_failed AS failed_count/);
    assert.deepEqual(email.params, ["__BRANCH__", "failed"]);
    const sms = buildBroadcastReportSql({ channel: "sms", status: null, from: null, to: null });
    assert.match(sms.sql, /sms_fast2sms_campaigns/);
    assert.match(sms.sql, /GREATEST/);
});
