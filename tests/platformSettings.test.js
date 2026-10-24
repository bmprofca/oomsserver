import test from "node:test";
import assert from "node:assert/strict";
import {
    createPlatformSettingsStore,
    normalizeSettingValue,
    getPlatformSettingDef,
    PLATFORM_SETTING_DEFS,
} from "../helpers/platformSettings.js";

/** Minimal in-memory stand-in for the mysql2 pool: supports the DDL, SELECT and UPSERT used by the store. */
function fakePool(initialRows = []) {
    const rows = new Map(initialRows.map((r) => [r.setting_key, { ...r }]));
    const calls = [];
    return {
        rows,
        calls,
        async query(sql, params = []) {
            calls.push(sql.trim().split(/\s+/)[0].toUpperCase());
            if (/^\s*CREATE TABLE/i.test(sql)) return [[]];
            if (/^\s*SELECT/i.test(sql)) return [[...rows.values()]];
            if (/^\s*INSERT/i.test(sql)) {
                const [setting_key, setting_value, is_secret, modify_by] = params;
                rows.set(setting_key, { setting_key, setting_value, is_secret, modify_by, modify_date: "2026-10-22 10:00:00" });
                return [{ affectedRows: 1 }];
            }
            throw new Error(`unexpected sql: ${sql}`);
        },
    };
}

const encrypt = (s) => `enc(${s})`;
const decrypt = (s) => (s.startsWith("enc(") ? s.slice(4, -1) : "");

test("resolution order is database → env → default", async () => {
    const pool = fakePool([
        { setting_key: "B2_BUCKET", setting_value: "from-db", is_secret: 0 },
        { setting_key: "B2_ACCESS_KEY", setting_value: encrypt("db-key"), is_secret: 1 },
    ]);
    const env = {
        B2_BUCKET: "from-env",
        ONECHATTING_BASE_URL: "https://env.example.com/",
    };
    const store = createPlatformSettingsStore({ pool, env, encrypt, decrypt, log: { error() {} } });
    await store.load();

    assert.equal(store.get("B2_BUCKET"), "from-db", "db wins over env");
    assert.equal(store.get("B2_ACCESS_KEY"), "db-key", "secrets are decrypted");
    assert.equal(store.get("ONECHATTING_BASE_URL"), "https://env.example.com/", "env used when db row missing");
    assert.equal(store.get("TAX_RATE"), "18", "default used when neither db nor env");
    assert.equal(store.getNumber("TAX_RATE"), 18);
    assert.equal(store.get("WHATSAPPWEB_BASE_URL"), "", "unset with no default is empty");
    assert.equal(getPlatformSettingDef("GOOGLE_CALENDAR_CLIENT_ID"), null, "shared calendar credentials are no longer platform settings");
    assert.equal(getPlatformSettingDef("GOOGLE_CALENDAR_OAUTH_CLIENT_ID")?.group, "google_calendar_oauth");
    await store.update({
        values: {
            GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "oauth-client-id",
            GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "oauth-client-secret",
        },
    });
    assert.equal(store.get("GOOGLE_CALENDAR_OAUTH_CLIENT_ID"), "oauth-client-id");
    assert.equal(pool.rows.get("GOOGLE_CALENDAR_OAUTH_CLIENT_ID").setting_value, "enc(oauth-client-id)");
    assert.equal(pool.rows.get("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET").setting_value, "enc(oauth-client-secret)");
});

test("describe() masks secrets and reports the source of each value", async () => {
    const pool = fakePool([
        { setting_key: "ONECHATTING_SYSTEM_DEVELOPER_TOKEN", setting_value: encrypt("abcd1234"), is_secret: 1, modify_by: "admin1" },
    ]);
    const store = createPlatformSettingsStore({ pool, env: { TAX_RATE: "12" }, encrypt, decrypt, log: { error() {} } });
    const described = await store.describe();
    const all = described.groups.flatMap((g) => g.fields);

    const token = all.find((f) => f.key === "ONECHATTING_SYSTEM_DEVELOPER_TOKEN");
    assert.equal(token.value, "", "secret value never returned");
    assert.equal(token.masked, "••••1234");
    assert.equal(token.has_value, true);
    assert.equal(token.source, "database");
    assert.equal(token.modify_by, "admin1");

    const tax = all.find((f) => f.key === "TAX_RATE");
    assert.equal(tax.value, "12");
    assert.equal(tax.source, "env");

    const bucket = all.find((f) => f.key === "B2_BUCKET");
    assert.equal(bucket.source, "default");
    assert.equal(all.length, PLATFORM_SETTING_DEFS.length, "every definition is described exactly once");
});

test("update() validates, encrypts secrets, keeps blank secrets and honours clear[]", async () => {
    const pool = fakePool([
        { setting_key: "B2_SECRET_KEY", setting_value: encrypt("old-secret"), is_secret: 1 },
    ]);
    const store = createPlatformSettingsStore({ pool, env: {}, encrypt, decrypt, log: { error() {} } });

    await store.update(
        { values: { B2_SECRET_KEY: "", B2_BUCKET: " my-bucket ", ONECHATTING_BASE_URL: "https://oc.example.com/", TAX_RATE: "5" } },
        "admin1"
    );
    assert.equal(store.get("B2_SECRET_KEY"), "old-secret", "blank secret keeps the stored value");
    assert.equal(store.get("B2_BUCKET"), "my-bucket", "text is trimmed");
    assert.equal(store.get("ONECHATTING_BASE_URL"), "https://oc.example.com", "trailing slash removed");
    assert.equal(store.get("TAX_RATE"), "5");
    assert.equal(pool.rows.get("B2_BUCKET").modify_by, "admin1");

    await store.update({ values: { B2_ACCESS_KEY: "new-key" } }, "admin2");
    assert.equal(pool.rows.get("B2_ACCESS_KEY").setting_value, "enc(new-key)", "secrets stored encrypted");
    assert.equal(pool.rows.get("B2_ACCESS_KEY").is_secret, 1);

    await store.update({ clear: ["B2_SECRET_KEY"] }, "admin2");
    assert.equal(store.get("B2_SECRET_KEY"), "", "clear[] blanks a secret");

    await assert.rejects(() => store.update({ values: { TAX_RATE: "abc" } }), /must be a number/);
    await assert.rejects(() => store.update({ values: { TAX_RATE: "150" } }), /at most 100/);
    await assert.rejects(() => store.update({ values: { ONECHATTING_BASE_URL: "not a url" } }), /valid URL/);
    await assert.rejects(() => store.update({ values: { ONECHATTING_BASE_URL: "ftp://x.y" } }), /http/);
    await assert.rejects(() => store.update({ values: { NOT_A_KEY: "x" } }), /Unknown setting/);
});

test("stale cache triggers a background reload; DB failures keep the last good values", async () => {
    let now = 1_000_000;
    const pool = fakePool([{ setting_key: "B2_BUCKET", setting_value: "v1", is_secret: 0 }]);
    const store = createPlatformSettingsStore({ pool, env: {}, encrypt, decrypt, now: () => now, ttlMs: 1000, log: { error() {} } });
    await store.load();
    assert.equal(store.get("B2_BUCKET"), "v1");

    pool.rows.set("B2_BUCKET", { setting_key: "B2_BUCKET", setting_value: "v2", is_secret: 0 });
    assert.equal(store.get("B2_BUCKET"), "v1", "within ttl: cached");

    now += 2000;
    store.get("B2_BUCKET"); // kicks off the reload
    await new Promise((r) => setImmediate(r));
    assert.equal(store.get("B2_BUCKET"), "v2", "after ttl: refreshed in the background");

    pool.query = async () => { throw new Error("db down"); };
    now += 2000;
    store.get("B2_BUCKET");
    await new Promise((r) => setImmediate(r));
    assert.equal(store.get("B2_BUCKET"), "v2", "load failure keeps last good value");
});

test("normalizeSettingValue and getPlatformSettingDef", () => {
    const url = getPlatformSettingDef("ONESAAS_UPLOAD_URL");
    assert.equal(normalizeSettingValue(url, " https://u.example.com/api/ "), "https://u.example.com/api");
    const num = getPlatformSettingDef("B2_DOWNLOAD_AUTH_TTL_SECONDS");
    assert.equal(normalizeSettingValue(num, "3600"), "3600");
    assert.throws(() => normalizeSettingValue(num, "10"), /at least 60/);
    assert.equal(getPlatformSettingDef("nope"), null);
    assert.equal(normalizeSettingValue(url, ""), "", "empty means clear");
});

import { createRazorpayConfig, serializeRazorpayConfig } from "../helpers/razorpayConfig.js";
import { createCompanySmsConfig, serializeCompanySmsConfig } from "../helpers/smsCompanyConfig.js";

test("select / uppercase / validate() / envAliases", async () => {
    const pool = fakePool();
    const env = { FAST2SMS_DEFAULT_ROUTE: "dlt_manual", SMS_OTP_MESSAGE_ID: "tpl-1" };
    const store = createPlatformSettingsStore({ pool, env, encrypt, decrypt, log: { error() {} } });
    await store.load();
    assert.equal(store.get("SMS_OTP_ROUTE"), "dlt_manual", "alias env name is honoured");
    assert.equal(store.get("SMS_OTP_DLT_TEMPLATE_ID"), "tpl-1");

    await store.update({ values: { SMS_OTP_ROUTE: "Q", FAST2SMS_SENDER_ID: "oomsin", RAZORPAY_KEY_ID: "rzp_test_abc" } });
    assert.equal(store.get("SMS_OTP_ROUTE"), "q", "select values are canonicalised");
    assert.equal(store.get("FAST2SMS_SENDER_ID"), "OOMSIN", "uppercase flag");
    await assert.rejects(() => store.update({ values: { SMS_OTP_ROUTE: "sms" } }), /must be one of/);
    await assert.rejects(() => store.update({ values: { RAZORPAY_KEY_ID: "abc" } }), /rzp_test_ or rzp_live_/);
    await assert.rejects(() => store.update({ values: { RAZORPAY_STATUS: "paused" } }), /must be one of/);

    const described = await store.describe();
    const route = described.groups.flatMap((g) => g.fields).find((f) => f.key === "SMS_OTP_ROUTE");
    assert.equal(route.type, "select");
    assert.deepEqual(route.options.map((o) => o.value), ["dlt", "dlt_manual", "otp", "q"]);
    const groupKeys = described.groups.map((g) => g.key);
    assert.ok(groupKeys.includes("razorpay") && groupKeys.includes("otp_sms"));
});

test("Razorpay adapter reads/writes RAZORPAY_* rows and keeps blank secrets", async () => {
    const pool = fakePool();
    const store = createPlatformSettingsStore({ pool, env: {}, encrypt, decrypt, log: { error() {} } });
    const rz = createRazorpayConfig(store);

    assert.equal(await rz.getRazorpayConfigRow(), null, "nothing configured yet");
    assert.equal(serializeRazorpayConfig(null).configured, false);
    const empty = await rz.resolveRazorpayRuntimeConfig();
    assert.equal(empty.status, "inactive");

    await assert.rejects(() => rz.upsertRazorpayConfig({ key_id: "rzp_live_x" }, "admin"), /key_secret is required/);
    await assert.rejects(() => rz.upsertRazorpayConfig({ key_id: "nope", key_secret: "s" }, "admin"), /rzp_test_ or rzp_live_/);

    const saved = await rz.upsertRazorpayConfig(
        { key_id: "rzp_live_abc123", key_secret: "secret-1", webhook_secret: "wh-1", status: "active" },
        "admin"
    );
    assert.equal(saved.environment, "live");
    assert.equal(saved.configured, true);
    assert.equal(saved.key_secret_masked, "••••et-1");
    assert.equal(saved.has_webhook_secret, true);
    assert.equal(pool.rows.get("RAZORPAY_KEY_SECRET").setting_value, "enc(secret-1)", "secret encrypted at rest");
    assert.ok(saved.webhook_url.endsWith("/api/v1/webhook/razorpay"), "default webhook url filled in");

    // blank secrets keep the stored value; status can be toggled
    const again = await rz.upsertRazorpayConfig({ key_id: "rzp_live_abc123", key_secret: "", status: "inactive" }, "admin");
    assert.equal(again.has_key_secret, true);
    assert.equal(again.status, "inactive");
    const runtime = await rz.resolveRazorpayRuntimeConfig();
    assert.equal(runtime.keySecret, "secret-1");
    assert.equal(runtime.webhookSecret, "wh-1");
    assert.equal(runtime.isLive, true);
    assert.equal(runtime.status, "inactive");
    assert.equal(runtime.source, "database");

    await store.update({ values: { RAZORPAY_GATEWAY_FEE_PERCENT: "2", RAZORPAY_GATEWAY_FEE_FLAT: "5" } });
    const row = await rz.getRazorpayConfigRow();
    assert.equal(row.gateway_fee_percent, 2);
    assert.equal(row.gateway_fee_flat, 5);
});

test("OTP SMS adapter validates DLT requirements and reports configured state", async () => {
    const pool = fakePool();
    const store = createPlatformSettingsStore({ pool, env: {}, encrypt, decrypt, log: { error() {} } });
    const sms = createCompanySmsConfig(store);

    assert.equal(await sms.getCompanySmsConfigRow(), null);
    assert.equal(serializeCompanySmsConfig(null).configured, false);

    await assert.rejects(() => sms.upsertCompanySmsConfig({ sender_id: "OOMSIN", route: "dlt" }), /auth_token is required/);
    await assert.rejects(
        () => sms.upsertCompanySmsConfig({ auth_token: "tok", sender_id: "OOMSIN", route: "dlt" }),
        /otp_dlt_message_id is required/
    );
    await assert.rejects(
        () => sms.upsertCompanySmsConfig({ auth_token: "tok", route: "dlt", otp_dlt_message_id: "123" }),
        /sender_id is required/
    );

    const quick = await sms.upsertCompanySmsConfig({ auth_token: "tok-abcdef", route: "q" }, "admin");
    assert.equal(quick.route, "q");
    assert.equal(quick.configured, true, "quick route needs only a token");
    assert.equal(quick.has_auth_token, true);
    assert.equal(pool.rows.get("FAST2SMS_AUTH_TOKEN").setting_value, "enc(tok-abcdef)");

    const dlt = await sms.upsertCompanySmsConfig(
        { sender_id: "oomsin", entity_id: "ent1", route: "dlt", otp_dlt_message_id: "999", status: "active" },
        "admin"
    );
    assert.equal(dlt.sender_id, "OOMSIN");
    assert.equal(dlt.has_auth_token, true, "blank token keeps the stored one");
    assert.equal(dlt.configured, true);

    const off = await sms.upsertCompanySmsConfig({ status: "inactive" }, "admin");
    assert.equal(off.status, "inactive");
    assert.equal(off.configured, false, "inactive is never 'configured'");
    await assert.rejects(() => sms.upsertCompanySmsConfig({ status: "paused" }), /active or inactive/);
});
