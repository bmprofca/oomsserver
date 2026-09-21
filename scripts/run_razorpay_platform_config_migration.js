/**
 * Create razorpay_platform_config and seed live keys.
 * Usage: node scripts/run_razorpay_platform_config_migration.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { upsertRazorpayConfig } from "../helpers/razorpayConfig.js";
import { testRazorpayCredentials, invalidateRazorpayServiceCache } from "../services/razorpayService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.join(
    __dirname,
    "../database/migrations/20260921_razorpay_platform_config.sql"
);

function splitStatements(sql) {
    const withoutLineComments = String(sql || "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
    return withoutLineComments
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
}

async function main() {
    const raw = fs.readFileSync(sqlPath, "utf8");
    for (const statement of splitStatements(raw)) {
        console.log("Running:", statement.slice(0, 80).replace(/\s+/g, " "), "…");
        await pool.query(statement);
    }

    // Prefer important.txt for seed (ops live keys), then env overrides
    let keyId = "";
    let keySecret = "";
    let webhookSecret = String(
        process.env.RAZORPAY_SEED_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || ""
    ).trim();

    try {
        const importantPath = path.join(__dirname, "../../important.txt");
        if (fs.existsSync(importantPath)) {
            const text = fs.readFileSync(importantPath, "utf8");
            const keyMatch = text.match(/API_KEY:\s*(\S+)/i);
            const secretMatch = text.match(/KEY_SECRET:\s*(\S+)/i);
            if (keyMatch?.[1]) keyId = keyMatch[1].trim();
            if (secretMatch?.[1]) keySecret = secretMatch[1].trim();
        }
    } catch (_) {
        /* optional local file */
    }

    if (!keyId) keyId = String(process.env.RAZORPAY_SEED_KEY_ID || process.env.RAZORPAY_KEY_ID || "").trim();
    if (!keySecret) {
        keySecret = String(process.env.RAZORPAY_SEED_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || "").trim();
    }
    if (!webhookSecret) webhookSecret = "onedevelopers";

    if (!keyId || !keySecret) {
        console.warn("No Razorpay keys found to seed. Configure via Admin → Settings → Razorpay.");
        await pool.end();
        return;
    }

    const saved = await upsertRazorpayConfig(
        {
            key_id: keyId,
            key_secret: keySecret,
            webhook_secret: webhookSecret,
            status: "active",
        },
        "migration"
    );
    invalidateRazorpayServiceCache();

    console.log("Razorpay config saved:", {
        environment: saved.environment,
        key_id: saved.key_id,
        configured: saved.configured,
        webhook_url: saved.webhook_url,
    });

    const test = await testRazorpayCredentials();
    console.log("Razorpay credential test:", test);

    await pool.end();
    if (!test.ok) process.exitCode = 1;
}

main().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
