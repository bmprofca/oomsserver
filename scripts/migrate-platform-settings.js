/**
 * One-time migration: consolidate every platform configuration value into `platform_settings`.
 *
 *   node scripts/migrate-platform-settings.js --dry-run      # report only, write nothing, drop nothing
 *   node scripts/migrate-platform-settings.js                # copy + verify + drop legacy tables
 *   node scripts/migrate-platform-settings.js --force        # overwrite values already in platform_settings
 *   node scripts/migrate-platform-settings.js --keep-tables  # copy + verify, but leave the legacy tables
 *
 * Sources, in priority order for every key:
 *   1. legacy one-row tables  razorpay_platform_config  → RAZORPAY_*
 *                             sms_company_fast2sms_config → FAST2SMS_* / SMS_OTP_*
 *   2. SERVER/.env            every PLATFORM_SETTING_DEFS key (and its legacy aliases)
 *
 * After every copied value has been read back from platform_settings and matches, the two
 * legacy tables are dropped (unless --keep-tables / --dry-run). Secrets are never printed.
 */
import "dotenv/config";
import pool from "../db.js";
import store, { PLATFORM_SETTING_DEFS, envNamesFor, normalizeSettingValue } from "../helpers/platformSettings.js";
import { decrypt as legacyDecrypt } from "../utils/smtpEncryption.js";
import { maskSecret } from "../helpers/secretBox.js";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE = args.has("--force");
const KEEP_TABLES = args.has("--keep-tables");
const ACTOR = "migration";

const LEGACY_TABLES = ["razorpay_platform_config", "sms_company_fast2sms_config"];
const DEF_BY_KEY = new Map(PLATFORM_SETTING_DEFS.map((d) => [d.key, d]));

const trim = (v) => (v == null ? "" : String(v).trim());
const show = (def, value) => (def.type === "secret" ? maskSecret(value) : value);

async function tableExists(name) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
        [name]
    );
    return Number(rows[0]?.n) > 0;
}

async function latestRow(table) {
    if (!(await tableExists(table))) return null;
    const [rows] = await pool.query(`SELECT * FROM \`${table}\` ORDER BY id DESC LIMIT 1`);
    return rows[0] || null;
}

/** Legacy table values keyed by setting key. */
async function readLegacy() {
    const out = new Map();
    const present = [];

    const rz = await latestRow("razorpay_platform_config");
    if (rz) {
        present.push("razorpay_platform_config");
        const pairs = {
            RAZORPAY_KEY_ID: rz.key_id,
            RAZORPAY_KEY_SECRET: rz.key_secret,
            RAZORPAY_WEBHOOK_SECRET: rz.webhook_secret,
            RAZORPAY_WEBHOOK_URL: rz.webhook_url,
            RAZORPAY_STATUS: rz.status,
            RAZORPAY_GATEWAY_FEE_PERCENT: rz.gateway_fee_percent,
            RAZORPAY_GATEWAY_FEE_FLAT: rz.gateway_fee_flat,
        };
        for (const [k, v] of Object.entries(pairs)) if (trim(v)) out.set(k, { value: trim(v), from: "razorpay_platform_config" });
    }

    const sms = await latestRow("sms_company_fast2sms_config");
    if (sms) {
        present.push("sms_company_fast2sms_config");
        let token = "";
        try {
            token = sms.auth_token_encrypted ? legacyDecrypt(sms.auth_token_encrypted) : "";
        } catch {
            console.warn("  ! sms_company_fast2sms_config.auth_token_encrypted could not be decrypted (encryption key changed?)");
        }
        const pairs = {
            FAST2SMS_AUTH_TOKEN: token,
            FAST2SMS_SENDER_ID: sms.sender_id,
            FAST2SMS_ENTITY_ID: sms.entity_id,
            SMS_OTP_ROUTE: sms.route,
            SMS_OTP_DLT_TEMPLATE_ID: sms.otp_dlt_message_id,
            SMS_OTP_STATUS: sms.status,
        };
        for (const [k, v] of Object.entries(pairs)) if (trim(v)) out.set(k, { value: trim(v), from: "sms_company_fast2sms_config" });
    }

    return { values: out, present };
}

function readEnv() {
    const out = new Map();
    for (const def of PLATFORM_SETTING_DEFS) {
        for (const name of envNamesFor(def)) {
            const v = trim(process.env[name]);
            if (v) {
                out.set(def.key, { value: v, from: `.env ${name}` });
                break;
            }
        }
    }
    return out;
}

async function main() {
    console.log(
        `Migrating platform settings${DRY_RUN ? " (dry run)" : ""}${FORCE ? " (force)" : ""}${KEEP_TABLES ? " (keep tables)" : ""}`
    );
    await store.ensureTable();
    await store.load();

    const legacy = await readLegacy();
    const env = readEnv();

    const plan = new Map(); // key -> { value, from }
    for (const def of PLATFORM_SETTING_DEFS) {
        const candidate = legacy.values.get(def.key) || env.get(def.key);
        if (!candidate) continue;
        plan.set(def.key, candidate);
    }

    const writes = {};
    const report = [];
    for (const def of PLATFORM_SETTING_DEFS) {
        const current = store.resolve(def.key);
        const inDb = current.source === "database";
        const candidate = plan.get(def.key);
        if (!candidate) {
            report.push([def.key, inDb ? "kept (db)" : "no source value, skipped"]);
            continue;
        }
        let normalized;
        try {
            normalized = normalizeSettingValue(def, candidate.value);
        } catch (error) {
            report.push([def.key, `INVALID from ${candidate.from}: ${error.message}`]);
            continue;
        }
        if (inDb && !FORCE) {
            report.push([def.key, `kept (db already set, ${candidate.from} ignored)`]);
            continue;
        }
        writes[def.key] = normalized;
        report.push([def.key, `${inDb ? "overwritten" : "copied"} from ${candidate.from} = ${show(def, normalized)}`]);
    }

    for (const [key, outcome] of report) console.log(`  ${key.padEnd(36)} ${outcome}`);

    if (!DRY_RUN && Object.keys(writes).length) {
        await store.update({ values: writes }, ACTOR);
    }

    // Verify every legacy value is now served from platform_settings before dropping anything.
    let verified = true;
    if (legacy.present.length) {
        await store.load();
        for (const [key, candidate] of legacy.values) {
            const def = DEF_BY_KEY.get(key);
            let expected;
            try {
                expected = normalizeSettingValue(def, candidate.value);
            } catch {
                continue; // reported above as INVALID; nothing to verify
            }
            const actual = store.resolve(key);
            const ok = DRY_RUN
                ? actual.source === "database" || Object.prototype.hasOwnProperty.call(writes, key)
                : actual.source === "database" && actual.value === expected;
            if (!ok) {
                verified = false;
                console.error(`  ✗ ${key}: platform_settings does not hold the ${candidate.from} value (source=${actual.source})`);
            }
        }
    }

    if (!legacy.present.length) {
        console.log("Legacy tables: none present, nothing to drop.");
    } else if (DRY_RUN) {
        console.log(`Legacy tables present: ${legacy.present.join(", ")} — would ${verified ? "drop" : "NOT drop (verification failed)"}.`);
    } else if (!verified) {
        console.error("Verification failed; legacy tables were NOT dropped. Fix the reported keys (or use --force) and re-run.");
        process.exitCode = 1;
    } else if (KEEP_TABLES) {
        console.log(`Legacy tables kept (--keep-tables): ${legacy.present.join(", ")}`);
    } else {
        for (const table of LEGACY_TABLES) {
            await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
            console.log(`Dropped ${table}`);
        }
    }
    console.log("Done.");
}

try {
    await main();
} catch (error) {
    console.error("MIGRATION FAILED:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end().catch(() => {});
}
