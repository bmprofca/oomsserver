import pool from '../db.js';
import { TODAY_DATE } from '../helpers/function.js';

const DEFAULT_INVOICE_PREFIXES = [
    { type: 'opening balance', prefix: 'OB/' },
    { type: 'sale', prefix: 'SAL/' },
    { type: 'purchase', prefix: 'PUR/' },
    { type: 'payment', prefix: 'PAY/' },
    { type: 'receive', prefix: 'REC/' },
    { type: 'journal', prefix: 'JRN/' },
    { type: 'contra', prefix: 'CON/' },
    { type: 'expense', prefix: 'EXP/' },
    { type: 'discount', prefix: 'DIS/' },
];

function getDefaultExpireDate() {
    const expire = new Date();
    expire.setFullYear(expire.getFullYear() + 10);
    return expire.toISOString().slice(0, 10);
}

export async function setupInvoicePrefixes(branchId, createdBy, connection = null) {
    const runner = connection || pool;
    const issueDate = TODAY_DATE();
    const expireDate = getDefaultExpireDate();
    const created = [];

    for (const entry of DEFAULT_INVOICE_PREFIXES) {
        const [existing] = await runner.query(
            `SELECT id
             FROM invoice_prefix
             WHERE branch_id = ?
               AND type = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [branchId, entry.type]
        );

        if (existing.length > 0) {
            continue;
        }

        await runner.query(
            `INSERT INTO invoice_prefix (
                branch_id, type, prefix, current, issue_date, expire_date,
                create_by, modify_by, create_date, modify_date, is_deleted
             ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, '0')`,
            [
                branchId,
                entry.type,
                entry.prefix,
                issueDate,
                expireDate,
                createdBy,
                createdBy,
                issueDate,
                issueDate,
            ]
        );

        created.push({ type: entry.type, prefix: entry.prefix });
    }

    return created;
}

export async function setupDefaultBranchService(branchId, createdBy, connection = null) {
    const runner = connection || pool;

    const [services] = await runner.query(
        `SELECT service_id, name, type, default_amount, default_due_date
         FROM services
         WHERE type = 'general'
         ORDER BY id ASC
         LIMIT 1`
    );

    const service = services[0];
    if (!service?.service_id) {
        return null;
    }

    const [existing] = await runner.query(
        `SELECT id
         FROM branch_services
         WHERE branch_id = ?
           AND service_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branchId, service.service_id]
    );

    if (existing.length > 0) {
        return {
            service_id: service.service_id,
            name: service.name,
            skipped: true,
            reason: 'already_added',
        };
    }

    const [softDeleted] = await runner.query(
        `SELECT id
         FROM branch_services
         WHERE branch_id = ?
           AND service_id = ?
           AND is_deleted = '1'
         LIMIT 1`,
        [branchId, service.service_id]
    );

    const fees = Number(service.default_amount || 0);
    const dueDateRaw = Number(service.default_due_date);
    const dueDate = Number.isInteger(dueDateRaw) && dueDateRaw >= 1 && dueDateRaw <= 31
        ? dueDateRaw
        : 10;
    const remark = 'Default service added during branch setup';
    const now = TODAY_DATE();

    if (softDeleted.length > 0) {
        await runner.query(
            `UPDATE branch_services
             SET is_deleted = '0',
                 deleted_by = NULL,
                 fees = ?,
                 due_date = ?,
                 remark = ?,
                 modify_by = ?,
                 modify_date = ?
             WHERE branch_id = ?
               AND service_id = ?`,
            [
                fees,
                dueDate,
                remark,
                createdBy,
                now,
                branchId,
                service.service_id,
            ]
        );
    } else {
        await runner.query(
            `INSERT INTO branch_services (
                branch_id, service_id, fees, due_date, remark,
                create_by, modify_by, is_deleted, create_date, modify_date
             ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`,
            [
                branchId,
                service.service_id,
                fees,
                dueDate,
                remark,
                createdBy,
                createdBy,
                now,
                now,
            ]
        );
    }

    return {
        service_id: service.service_id,
        name: service.name,
        fees,
        due_date: dueDate,
        skipped: false,
    };
}

/**
 * Seeds utility rows required for a newly created branch workspace.
 * Safe to call inside the branch-create transaction.
 */
export async function initializeBranchDefaults({
    branchId,
    createdBy,
    connection = null,
}) {
    if (!branchId) {
        throw new Error('branchId is required for branch setup');
    }

    const invoice_prefixes = await setupInvoicePrefixes(branchId, createdBy, connection);
    const branch_service = await setupDefaultBranchService(branchId, createdBy, connection);

    return {
        branch_id: branchId,
        invoice_prefixes,
        branch_service,
    };
}
