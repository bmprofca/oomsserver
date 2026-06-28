import pool from '../db.js';
import crypto from 'crypto';

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

async function getOrCreateWallet(branchId) {
    const [rows] = await pool.query(
        "SELECT * FROM branch_wallets WHERE branch_id = ? LIMIT 1",
        [branchId]
    );
    if (rows.length) {
        return {
            ...rows[0],
            balance: Number(rows[0].balance)
        };
    }

    // Insert wallet if it does not exist
    await pool.query(
        "INSERT IGNORE INTO branch_wallets (branch_id, balance) VALUES (?, 0.00)",
        [branchId]
    );

    const [newRows] = await pool.query(
        "SELECT * FROM branch_wallets WHERE branch_id = ? LIMIT 1",
        [branchId]
    );
    
    return newRows[0] ? {
        ...newRows[0],
        balance: Number(newRows[0].balance)
    } : { branch_id: branchId, balance: 0.00 };
}

async function creditWallet({ branch_id, amount, purpose, details = null }) {
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new Error("Invalid credit amount");
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Lock wallet record
        const [wallets] = await conn.query(
            "SELECT balance FROM branch_wallets WHERE branch_id = ? FOR UPDATE",
            [branch_id]
        );

        if (!wallets.length) {
            await conn.query(
                "INSERT INTO branch_wallets (branch_id, balance) VALUES (?, ?)",
                [branch_id, numericAmount]
            );
        } else {
            await conn.query(
                "UPDATE branch_wallets SET balance = balance + ? WHERE branch_id = ?",
                [numericAmount, branch_id]
            );
        }

        const transactionId = newId("wtx");
        await conn.query(
            `INSERT INTO wallet_transactions (transaction_id, branch_id, amount, type, purpose, details)
             VALUES (?, ?, ?, 'credit', ?, ?)`,
            [transactionId, branch_id, numericAmount, purpose || "Add Money", details]
        );

        await conn.commit();
        
        const [updated] = await conn.query(
            "SELECT * FROM branch_wallets WHERE branch_id = ? LIMIT 1",
            [branch_id]
        );
        return {
            ...updated[0],
            balance: Number(updated[0].balance)
        };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function debitWallet({ branch_id, amount, purpose, details = null, connection = null }) {
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new Error("Invalid debit amount");
    }

    const runner = connection || pool;

    const [wallets] = await runner.query(
        "SELECT balance FROM branch_wallets WHERE branch_id = ? FOR UPDATE",
        [branch_id]
    );

    const balance = wallets.length ? Number(wallets[0].balance) : 0;
    if (balance < numericAmount) {
        throw new Error("Insufficient wallet balance");
    }

    await runner.query(
        "UPDATE branch_wallets SET balance = balance - ? WHERE branch_id = ?",
        [numericAmount, branch_id]
    );

    const transactionId = newId("wtx");
    await runner.query(
        `INSERT INTO wallet_transactions (transaction_id, branch_id, amount, type, purpose, details)
         VALUES (?, ?, ?, 'debit', ?, ?)`,
        [transactionId, branch_id, numericAmount, purpose || "SMS Sent", details]
    );

    return {
        branch_id,
        balance: balance - numericAmount
    };
}

async function getTransactions({ branch_id, page_no = 1, limit = 10 }) {
    const page = Math.max(Number(page_no) || 1, 1);
    const size = Math.max(Number(limit) || 10, 1);
    const offset = (page - 1) * size;

    const [rows] = await pool.query(
        `SELECT * FROM wallet_transactions
         WHERE branch_id = ?
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [branch_id, size, offset]
    );

    const [countRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM wallet_transactions WHERE branch_id = ?",
        [branch_id]
    );
    const total = Number(countRows[0]?.total || 0);

    return {
        data: rows,
        pagination: {
            page_no: page,
            limit: size,
            total,
            total_pages: Math.ceil(total / size) || 1,
            has_more: page * size < total
        }
    };
}

export {
    getOrCreateWallet,
    creditWallet,
    debitWallet,
    getTransactions
};
