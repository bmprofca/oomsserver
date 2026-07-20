import pool from "../db.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH, TODAY_DATE } from "./function.js";

export async function validateAndNormalizePurchaseItems(branch_id, items, queryConn = pool) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error("items is required and must be a non-empty array");
    }

    const normalizedItems = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index] || {};
        const service_id = item?.service_id != null ? String(item.service_id).trim() : "";
        const feesNum = Number(item?.fees);
        const itemRemark = item?.remark != null ? String(item.remark).trim() : null;

        if (!service_id) {
            throw new Error(`items[${index}].service_id is required`);
        }
        if (!Number.isFinite(feesNum) || feesNum <= 0) {
            throw new Error(`items[${index}].fees must be greater than 0`);
        }

        normalizedItems.push({ service_id, feesNum, itemRemark });
    }

    const serviceIds = normalizedItems.map((el) => el.service_id);
    const placeholders = serviceIds.map(() => "?").join(", ");
    const [serviceRows] = await queryConn.query(
        `SELECT service_id FROM branch_services WHERE branch_id = ? AND is_deleted = '0' AND service_id IN (${placeholders})`,
        [branch_id, ...serviceIds]
    );
    const serviceSet = new Set(serviceRows.map((row) => String(row.service_id)));

    for (let index = 0; index < normalizedItems.length; index++) {
        if (!serviceSet.has(normalizedItems[index].service_id)) {
            throw new Error(`Invalid service_id in items[${index}]: ${normalizedItems[index].service_id}`);
        }
    }

    return normalizedItems;
}

/**
 * Create a purchase invoice + transaction + items.
 * When `connection` is provided, the caller owns begin/commit/rollback/release.
 * When omitted, this helper opens its own connection and commits.
 */
export async function executeCreatePurchase({
    connection: externalConn = null,
    branch_id,
    create_by,
    party_id,
    party_type,
    transaction_date,
    remark,
    items,
}) {
    const party1_id = String(party_id ?? "").trim();
    const party1_type = String(party_type ?? "").trim();
    const txnDate = String(transaction_date ?? "").trim();
    const remarkVal = remark != null ? String(remark).trim() : null;
    const username = String(create_by ?? "").trim();

    if (!branch_id) {
        const err = new Error("branch_id is required");
        err.status = 400;
        throw err;
    }
    if (!party1_id) {
        const err = new Error("party_id is required");
        err.status = 400;
        throw err;
    }
    if (!party1_type) {
        const err = new Error("party_type is required");
        err.status = 400;
        throw err;
    }
    if (!txnDate) {
        const err = new Error("transaction_date is required");
        err.status = 400;
        throw err;
    }

    const ownsConnection = !externalConn;
    const connection = externalConn || (await pool.getConnection());

    try {
        const normalizedItems = await validateAndNormalizePurchaseItems(
            branch_id,
            items,
            connection
        );

        const purchaseItemsToInsert = [];
        let subtotal = 0;
        for (let index = 0; index < normalizedItems.length; index++) {
            const current = normalizedItems[index];
            subtotal += current.feesNum;
            purchaseItemsToInsert.push({
                service_id: current.service_id,
                amount: Number(current.feesNum.toFixed(2)),
                remark: current.itemRemark,
            });
        }
        subtotal = Number(subtotal.toFixed(2));
        const total = subtotal;

        if (ownsConnection) {
            await connection.beginTransaction();
        }

        const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", {
            length: ID_LENGTH,
            conn: connection,
        });
        const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", {
            length: ID_LENGTH,
            conn: connection,
        });

        const [invoicePrefixRows] = await connection.query(
            "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
            [branch_id, "purchase", "0", TODAY_DATE(), TODAY_DATE()]
        );
        if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
            const err = new Error("Invoice prefix not set for purchase.");
            err.status = 400;
            throw err;
        }

        const invoiceData = invoicePrefixRows[0];
        const invoicePrimaryId = invoiceData?.id;
        const serial = Number(invoiceData?.current || 0) + 1;
        const invoice_no = `${invoiceData?.prefix}${serial}`;

        await connection.query(
            `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, discount_type, discount_perc_rate, discount_value, additional_charge, total, round_off, grand_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                invoice_id,
                branch_id,
                invoice_no,
                username,
                username,
                "purchase",
                transaction_id,
                subtotal,
                "not applicable",
                0,
                0,
                0,
                total,
                0,
                total,
            ]
        );

        const purchase_entry_id = await UNIQUE_RANDOM_STRING("purchase_entries", "purchase_id", {
            length: ID_LENGTH,
            conn: connection,
        });
        await connection.query(
            `INSERT INTO purchase_entries (branch_id, purchase_id, invoice_id, party_id, party_type, purchase_date, create_by, modify_by, amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                branch_id,
                purchase_entry_id,
                invoice_id,
                party1_id,
                party1_type,
                txnDate,
                username,
                username,
                total,
            ]
        );

        await connection.query(
            `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
             VALUES (?, ?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?, ?, ?, ?)`,
            [
                branch_id,
                transaction_id,
                username,
                username,
                txnDate,
                total,
                invoice_id,
                invoice_no,
                party1_type,
                party1_id,
                null,
                null,
                remarkVal,
            ]
        );

        for (let index = 0; index < purchaseItemsToInsert.length; index++) {
            const row = purchaseItemsToInsert[index];
            const item_id = await UNIQUE_RANDOM_STRING("purchase_items", "item_id", {
                length: ID_LENGTH,
                conn: connection,
            });
            await connection.query(
                `INSERT INTO purchase_items (branch_id, item_id, purchase_id, invoice_id, service_id, amount, remark)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, item_id, purchase_entry_id, invoice_id, row.service_id, row.amount, row.remark]
            );
        }

        await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [
            serial,
            invoicePrimaryId,
        ]);

        if (ownsConnection) {
            await connection.commit();
        }

        return {
            invoice_id,
            purchase_id: purchase_entry_id,
            transaction_id,
            invoice_no,
            party_id: party1_id,
            party_type: party1_type,
            transaction_date: txnDate,
            subtotal,
            total,
            grand_total: total,
            remark: remarkVal,
            items: purchaseItemsToInsert,
        };
    } catch (err) {
        if (ownsConnection) {
            try {
                await connection.rollback();
            } catch (_) {
                /* ignore */
            }
        }
        throw err;
    } finally {
        if (ownsConnection) {
            connection.release();
        }
    }
}
