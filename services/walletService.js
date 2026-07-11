import pool from '../db.js';
import crypto from 'crypto';

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const walletLockKey = (branchId) => `wallet:${branchId}`;

async function acquireWalletLock(conn, branchId) {
    const [rows] = await conn.query(
        'SELECT GET_LOCK(?, 10) AS acquired',
        [walletLockKey(branchId)]
    );
    if (!rows[0]?.acquired) {
        throw new Error('Could not acquire wallet lock');
    }
}

async function releaseWalletLock(conn, branchId) {
    await conn.query('SELECT RELEASE_LOCK(?)', [walletLockKey(branchId)]);
}

async function getWalletBalance(branchId, connection = null) {
    const runner = connection || pool;
    const [rows] = await runner.query(
        `SELECT
            COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) -
            COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS balance
         FROM wallet_transactions
         WHERE branch_id = ?`,
        [branchId]
    );

    return Number(rows[0]?.balance || 0);
}

async function getOrCreateWallet(branchId) {
    const balance = await getWalletBalance(branchId);
    return {
        branch_id: branchId,
        balance,
    };
}

async function creditWallet({ branch_id, amount, purpose, details = null }) {
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new Error('Invalid credit amount');
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await acquireWalletLock(conn, branch_id);

        const transactionId = newId('wtx');
        await conn.query(
            `INSERT INTO wallet_transactions (transaction_id, branch_id, amount, type, purpose, details)
             VALUES (?, ?, ?, 'credit', ?, ?)`,
            [transactionId, branch_id, numericAmount, purpose || 'Add Money', details]
        );

        const balance = await getWalletBalance(branch_id, conn);

        await releaseWalletLock(conn, branch_id);
        await conn.commit();

        return {
            branch_id,
            balance,
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
        throw new Error('Invalid debit amount');
    }

    const ownsConnection = !connection;
    const conn = connection || await pool.getConnection();
    let lockAcquired = false;

    try {
        if (ownsConnection) {
            await conn.beginTransaction();
        }

        await acquireWalletLock(conn, branch_id);
        lockAcquired = true;

        const balance = await getWalletBalance(branch_id, conn);
        if (balance < numericAmount) {
            throw new Error('Insufficient wallet balance');
        }

        const transactionId = newId('wtx');
        await conn.query(
            `INSERT INTO wallet_transactions (transaction_id, branch_id, amount, type, purpose, details)
             VALUES (?, ?, ?, 'debit', ?, ?)`,
            [transactionId, branch_id, numericAmount, purpose || 'SMS Sent', details]
        );

        const updatedBalance = balance - numericAmount;

        if (ownsConnection) {
            await releaseWalletLock(conn, branch_id);
            lockAcquired = false;
            await conn.commit();
        }

        return {
            branch_id,
            balance: updatedBalance,
        };
    } catch (error) {
        if (ownsConnection) {
            await conn.rollback();
        }
        throw error;
    } finally {
        if (lockAcquired) {
            try {
                await releaseWalletLock(conn, branch_id);
            } catch (releaseError) {
                console.error('Failed to release wallet lock:', releaseError);
            }
        }
        if (ownsConnection) {
            conn.release();
        }
    }
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
        'SELECT COUNT(*) AS total FROM wallet_transactions WHERE branch_id = ?',
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
            has_more: page * size < total,
        },
    };
}

export {
    getWalletBalance,
    getOrCreateWallet,
    creditWallet,
    debitWallet,
    getTransactions,
};
