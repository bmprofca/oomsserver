/**
 * Gateway fee columns + payment request banks/requests tables.
 * Usage: node scripts/run_wallet_gateway_fee_migration.js
 */
import { ensureWalletPaymentTables } from "../helpers/walletPaymentConfig.js";
import pool from "../db.js";

async function main() {
    await ensureWalletPaymentTables();
    console.log("Wallet gateway fee + payment request tables ready");
    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
