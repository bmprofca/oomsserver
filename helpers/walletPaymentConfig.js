import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";

function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

export async function ensureWalletPaymentTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS wallet_payment_banks (
          id INT NOT NULL AUTO_INCREMENT,
          bank_id VARCHAR(50) NOT NULL,
          account_name VARCHAR(150) NOT NULL DEFAULT '',
          bank_name VARCHAR(150) NOT NULL DEFAULT '',
          account_number VARCHAR(64) NOT NULL DEFAULT '',
          ifsc VARCHAR(20) NOT NULL DEFAULT '',
          branch_name VARCHAR(150) NULL DEFAULT NULL,
          upi_id VARCHAR(100) NULL DEFAULT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          sort_order INT NOT NULL DEFAULT 0,
          create_by VARCHAR(50) NULL DEFAULT NULL,
          create_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
          modify_by VARCHAR(50) NULL DEFAULT NULL,
          modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_wallet_payment_bank_id (bank_id),
          KEY idx_wallet_payment_banks_status (status, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS wallet_payment_requests (
          id INT NOT NULL AUTO_INCREMENT,
          request_id VARCHAR(50) NOT NULL,
          branch_id VARCHAR(50) NOT NULL,
          username VARCHAR(100) NOT NULL,
          bank_id VARCHAR(50) NULL DEFAULT NULL,
          amount DECIMAL(12,2) NOT NULL,
          remark VARCHAR(255) NULL DEFAULT NULL,
          transfer_ref VARCHAR(100) NULL DEFAULT NULL,
          transfer_date DATE NULL DEFAULT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          admin_remark VARCHAR(500) NULL DEFAULT NULL,
          reviewed_by VARCHAR(100) NULL DEFAULT NULL,
          reviewed_at DATETIME NULL DEFAULT NULL,
          create_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
          modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_wallet_payment_request_id (request_id),
          KEY idx_wallet_payment_req_branch (branch_id, status),
          KEY idx_wallet_payment_req_status (status, create_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Fee columns on razorpay config (ignore if already present)
    try {
        await pool.query(`
            ALTER TABLE razorpay_platform_config
              ADD COLUMN gateway_fee_percent DECIMAL(8,4) NOT NULL DEFAULT 0 AFTER status
        `);
    } catch (_) {}
    try {
        await pool.query(`
            ALTER TABLE razorpay_platform_config
              ADD COLUMN gateway_fee_flat DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER gateway_fee_percent
        `);
    } catch (_) {}
    try {
        await pool.query(`
            ALTER TABLE razorpay_orders
              ADD COLUMN credit_amount BIGINT NULL AFTER amount
        `);
    } catch (_) {}
    try {
        await pool.query(`
            ALTER TABLE razorpay_orders
              ADD COLUMN gateway_fee BIGINT NULL AFTER credit_amount
        `);
    } catch (_) {}
}

export async function getGatewayFeeSettings() {
    await ensureWalletPaymentTables();
    try {
        const [rows] = await pool.query(
            `SELECT gateway_fee_percent, gateway_fee_flat
             FROM razorpay_platform_config
             ORDER BY id DESC
             LIMIT 1`
        );
        const row = rows[0] || {};
        return {
            gateway_fee_percent: toNumber(row.gateway_fee_percent, 0),
            gateway_fee_flat: toNumber(row.gateway_fee_flat, 0),
        };
    } catch (error) {
        if (error?.code === "ER_BAD_FIELD_ERROR" || error?.code === "ER_NO_SUCH_TABLE") {
            return { gateway_fee_percent: 0, gateway_fee_flat: 0 };
        }
        throw error;
    }
}

export async function updateGatewayFeeSettings(body = {}, actor = null) {
    await ensureWalletPaymentTables();
    const percent = Math.max(0, toNumber(body.gateway_fee_percent, 0));
    const flat = Math.max(0, toNumber(body.gateway_fee_flat, 0));
    if (percent > 100) {
        const err = new Error("gateway_fee_percent cannot exceed 100");
        err.status = 400;
        throw err;
    }

    const [rows] = await pool.query(
        `SELECT config_id FROM razorpay_platform_config ORDER BY id DESC LIMIT 1`
    );
    if (!rows[0]) {
        const err = new Error("Save Razorpay API keys first, then set gateway fees.");
        err.status = 400;
        throw err;
    }

    await pool.query(
        `UPDATE razorpay_platform_config
         SET gateway_fee_percent = ?, gateway_fee_flat = ?, modify_by = ?, modify_date = NOW()
         WHERE config_id = ?`,
        [percent, flat, actor, rows[0].config_id]
    );

    return {
        gateway_fee_percent: percent,
        gateway_fee_flat: flat,
    };
}

/** Compute fee for a requested net wallet credit (INR). */
export function computeGatewayFee(netAmountRupees, settings) {
    const net = roundMoney(netAmountRupees);
    const percent = Math.max(0, toNumber(settings?.gateway_fee_percent, 0));
    const flat = Math.max(0, toNumber(settings?.gateway_fee_flat, 0));
    const fee = roundMoney((net * percent) / 100 + flat);
    const total = roundMoney(net + fee);
    return {
        net_amount: net,
        gateway_fee: fee,
        total_amount: total,
        gateway_fee_percent: percent,
        gateway_fee_flat: flat,
    };
}

export function serializeBank(row) {
    if (!row) return null;
    return {
        bank_id: row.bank_id,
        account_name: row.account_name || "",
        bank_name: row.bank_name || "",
        account_number: row.account_number || "",
        ifsc: row.ifsc || "",
        branch_name: row.branch_name || "",
        upi_id: row.upi_id || "",
        status: row.status || "active",
        sort_order: Number(row.sort_order) || 0,
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

export async function listPaymentBanks({ activeOnly = false } = {}) {
    await ensureWalletPaymentTables();
    const where = activeOnly ? `WHERE status = 'active'` : "";
    const [rows] = await pool.query(
        `SELECT *
         FROM wallet_payment_banks
         ${where}
         ORDER BY sort_order ASC, id ASC`
    );
    return (rows || []).map(serializeBank);
}

export async function getPaymentBankById(bankId) {
    await ensureWalletPaymentTables();
    const [rows] = await pool.query(
        `SELECT * FROM wallet_payment_banks WHERE bank_id = ? LIMIT 1`,
        [bankId]
    );
    return rows[0] ? serializeBank(rows[0]) : null;
}

export async function upsertPaymentBank(body = {}, actor = null) {
    await ensureWalletPaymentTables();
    const bank_id = trimStr(body.bank_id);
    const account_name = trimStr(body.account_name);
    const bank_name = trimStr(body.bank_name);
    const account_number = trimStr(body.account_number);
    const ifsc = trimStr(body.ifsc).toUpperCase();
    const branch_name = trimStr(body.branch_name) || null;
    const upi_id = trimStr(body.upi_id) || null;
    const status =
        String(body.status || "active").toLowerCase() === "inactive" ? "inactive" : "active";
    const sort_order = Math.max(0, Math.floor(toNumber(body.sort_order, 0)));

    if (!account_name || !bank_name || !account_number || !ifsc) {
        const err = new Error("account_name, bank_name, account_number and ifsc are required");
        err.status = 400;
        throw err;
    }

    if (bank_id) {
        const [existing] = await pool.query(
            `SELECT bank_id FROM wallet_payment_banks WHERE bank_id = ? LIMIT 1`,
            [bank_id]
        );
        if (!existing.length) {
            const err = new Error("Bank not found");
            err.status = 404;
            throw err;
        }
        await pool.query(
            `UPDATE wallet_payment_banks
             SET account_name = ?, bank_name = ?, account_number = ?, ifsc = ?,
                 branch_name = ?, upi_id = ?, status = ?, sort_order = ?,
                 modify_by = ?, modify_date = NOW()
             WHERE bank_id = ?`,
            [
                account_name,
                bank_name,
                account_number,
                ifsc,
                branch_name,
                upi_id,
                status,
                sort_order,
                actor,
                bank_id,
            ]
        );
        return getPaymentBankById(bank_id);
    }

    const newId = await UNIQUE_RANDOM_STRING("wallet_payment_banks", "bank_id", { length: 12 });
    await pool.query(
        `INSERT INTO wallet_payment_banks
            (bank_id, account_name, bank_name, account_number, ifsc, branch_name, upi_id, status, sort_order, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            newId,
            account_name,
            bank_name,
            account_number,
            ifsc,
            branch_name,
            upi_id,
            status,
            sort_order,
            actor,
            actor,
        ]
    );
    return getPaymentBankById(newId);
}

export async function deletePaymentBank(bankId) {
    await ensureWalletPaymentTables();
    const [result] = await pool.query(
        `DELETE FROM wallet_payment_banks WHERE bank_id = ?`,
        [bankId]
    );
    if (!result?.affectedRows) {
        const err = new Error("Bank not found");
        err.status = 404;
        throw err;
    }
    return { deleted: true, bank_id: bankId };
}

export function serializePaymentRequest(row, bank = null) {
    if (!row) return null;
    return {
        request_id: row.request_id,
        branch_id: row.branch_id,
        username: row.username,
        bank_id: row.bank_id || null,
        bank: bank || null,
        amount: toNumber(row.amount, 0),
        remark: row.remark || "",
        transfer_ref: row.transfer_ref || "",
        transfer_date: row.transfer_date || null,
        status: row.status || "pending",
        admin_remark: row.admin_remark || "",
        reviewed_by: row.reviewed_by || null,
        reviewed_at: row.reviewed_at || null,
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

export async function createPaymentRequest({
    branchId,
    username,
    amount,
    remark,
    bankId,
    transferRef,
    transferDate,
}) {
    await ensureWalletPaymentTables();
    const amountRupees = roundMoney(amount);
    if (!amountRupees || amountRupees < 1) {
        const err = new Error("Amount must be at least ₹1");
        err.status = 400;
        throw err;
    }

    const bank = bankId ? await getPaymentBankById(bankId) : null;
    if (bankId && (!bank || bank.status !== "active")) {
        const err = new Error("Selected bank account is invalid or inactive");
        err.status = 400;
        throw err;
    }

    const request_id = await UNIQUE_RANDOM_STRING("wallet_payment_requests", "request_id", {
        length: 14,
    });

    await pool.query(
        `INSERT INTO wallet_payment_requests
            (request_id, branch_id, username, bank_id, amount, remark, transfer_ref, transfer_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
            request_id,
            branchId,
            username,
            bank?.bank_id || null,
            amountRupees,
            trimStr(remark) || null,
            trimStr(transferRef) || null,
            transferDate || null,
        ]
    );

    const [rows] = await pool.query(
        `SELECT * FROM wallet_payment_requests WHERE request_id = ? LIMIT 1`,
        [request_id]
    );
    return serializePaymentRequest(rows[0], bank);
}

export async function listPaymentRequests({
    branchId = null,
    status = null,
    page_no = 1,
    limit = 20,
} = {}) {
    await ensureWalletPaymentTables();
    const page = Math.max(1, Number(page_no) || 1);
    const size = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (page - 1) * size;

    const conditions = [];
    const params = [];
    if (branchId) {
        conditions.push("r.branch_id = ?");
        params.push(branchId);
    }
    if (status && status !== "all") {
        conditions.push("r.status = ?");
        params.push(String(status).toLowerCase());
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM wallet_payment_requests r ${where}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT r.*,
                b.account_name, b.bank_name, b.account_number, b.ifsc, b.branch_name, b.upi_id, b.status AS bank_status
         FROM wallet_payment_requests r
         LEFT JOIN wallet_payment_banks b ON b.bank_id = r.bank_id
         ${where}
         ORDER BY r.id DESC
         LIMIT ? OFFSET ?`,
        [...params, size, offset]
    );

    const data = (rows || []).map((row) =>
        serializePaymentRequest(row, row.bank_id
            ? {
                bank_id: row.bank_id,
                account_name: row.account_name || "",
                bank_name: row.bank_name || "",
                account_number: row.account_number || "",
                ifsc: row.ifsc || "",
                branch_name: row.branch_name || "",
                upi_id: row.upi_id || "",
                status: row.bank_status || null,
            }
            : null)
    );

    return {
        data,
        pagination: {
            page_no: page,
            limit: size,
            total: Number(total) || 0,
            total_pages: Math.ceil((Number(total) || 0) / size) || 1,
        },
    };
}

export async function reviewPaymentRequest({
    requestId,
    action,
    adminRemark,
    actor,
}) {
    await ensureWalletPaymentTables();
    const next = String(action || "").toLowerCase();
    if (!["approved", "rejected"].includes(next)) {
        const err = new Error("action must be approved or rejected");
        err.status = 400;
        throw err;
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT * FROM wallet_payment_requests WHERE request_id = ? LIMIT 1 FOR UPDATE`,
            [requestId]
        );
        const row = rows[0];
        if (!row) {
            const err = new Error("Payment request not found");
            err.status = 404;
            throw err;
        }
        if (row.status !== "pending") {
            const err = new Error(`Request is already ${row.status}`);
            err.status = 400;
            throw err;
        }

        await conn.query(
            `UPDATE wallet_payment_requests
             SET status = ?, admin_remark = ?, reviewed_by = ?, reviewed_at = NOW()
             WHERE request_id = ?`,
            [next, trimStr(adminRemark) || null, actor, requestId]
        );

        await conn.commit();
        return {
            request: serializePaymentRequest({ ...row, status: next, admin_remark: adminRemark, reviewed_by: actor }),
            shouldCredit: next === "approved",
            amount: toNumber(row.amount, 0),
            branch_id: row.branch_id,
            remark: row.remark || "Payment request approved",
            request_id: row.request_id,
        };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}
