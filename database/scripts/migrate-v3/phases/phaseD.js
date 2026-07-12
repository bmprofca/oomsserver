import { NEW_BRANCH_ID } from "../config.js";
import {
    batchInsert,
    buildInvoiceRow,
    buildTransactionFromInvoice,
    loadStagingClientUsernameSet,
    loadStagingPartyTypeByUsername,
    mapTransactionType,
    queryBranchRows,
    resolveClientId,
    resolvePurchaseParty,
    resolveSaleEntriesBranchId,
    resolveUsernamePartyType,
    safeDate,
} from "../utils.js";

export async function runPhaseD(ctx) {
    const { staging, target, logger, dryRun } = ctx;
    logger.info("Phase D: finance (invoice-driven)");

    if (!ctx.saleEntriesBranchId) {
        ctx.saleEntriesBranchId = await resolveSaleEntriesBranchId(target);
    }
    const saleBranchId = ctx.saleEntriesBranchId;

    const invoices = await queryBranchRows(staging, "invoice");
    const invoiceItems = await queryBranchRows(staging, "invoice_items");
    const ledgerRows = await queryBranchRows(staging, "ledger");
    const journals = await queryBranchRows(staging, "journals");
    const expenses = await queryBranchRows(staging, "expenses");

    const ledgerByPayment = new Map();
    for (const row of ledgerRows) {
        if (!ledgerByPayment.has(row.payment_id)) ledgerByPayment.set(row.payment_id, []);
        ledgerByPayment.get(row.payment_id).push(row);
    }

    const journalByPayment = new Map();
    for (const j of journals) {
        journalByPayment.set(j.journal_id, j);
    }

    const itemsByInvoice = new Map();
    for (const item of invoiceItems) {
        if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
        itemsByInvoice.get(item.invoice_id).push(item);
    }

    const expensesByInvoice = new Map();
    for (const ex of expenses) {
        if (!expensesByInvoice.has(ex.invoice_id)) expensesByInvoice.set(ex.invoice_id, []);
        expensesByInvoice.get(ex.invoice_id).push(ex);
    }

    const clientUsernameSet = await loadStagingClientUsernameSet(staging);
    const partyTypeByUsername = await loadStagingPartyTypeByUsername(staging);
    const partyOptions = { clientUsernameSet, partyTypeByUsername };

    // Pass 1: invoice + transactions
    const invoiceRows = [];
    const txnRows = [];
    let skipped = 0;

    for (const inv of invoices) {
        const paymentId = inv.payment_id || inv.invoice_id;
        const led = ledgerByPayment.get(paymentId) || [];
        const journal = journalByPayment.get(paymentId) || null;

        invoiceRows.push(buildInvoiceRow(inv));

        try {
            txnRows.push(buildTransactionFromInvoice(inv, led, journal, partyOptions));
        } catch (err) {
            skipped++;
            if (skipped <= 10) {
                logger.warn("Failed to build transaction", { invoice_id: inv.invoice_id, error: err.message });
            }
        }
    }

    const invoiceCount = await batchInsert(
        target,
        "invoice",
        [
            "invoice_id", "branch_id", "invoice_no", "create_date", "create_by", "modify_date", "modify_by",
            "type", "transaction_id", "subtotal", "discount_type", "discount_perc_rate", "discount_value",
            "tax_rate", "tax_value", "additional_charge", "total", "round_off", "grand_total",
        ],
        invoiceRows,
        { dryRun, onProgress: (n, total) => logger.info(`Invoices: ${n}/${total}`) }
    );
    logger.stat("phaseD.invoice", invoiceCount);

    const txnCount = await batchInsert(
        target,
        "transactions",
        [
            "branch_id", "transaction_id", "create_date", "create_by", "modify_date", "modify_by",
            "transaction_date", "transaction_type", "amount", "invoice_id", "invoice_no",
            "party1_type", "party1_id", "party2_type", "party2_id", "remark",
        ],
        txnRows,
        { dryRun, onProgress: (n, total) => logger.info(`Transactions: ${n}/${total}`) }
    );
    logger.stat("phaseD.transactions", txnCount);
    logger.stat("phaseD.transactions_skipped", skipped);

    // Pass 2: entry tables per transaction type
    const saleEntryRows = [];
    const saleItemRows = [];

    for (const inv of invoices) {
        if (mapTransactionType(inv.type) !== "sale" || !saleBranchId) continue;

        const grand_total = Number(inv.grand_total) || Number(inv.total) || 0;
        const sale_id = inv.payment_id || inv.invoice_id;
        const paymentId = inv.payment_id || inv.invoice_id;
        const led = ledgerByPayment.get(paymentId) || [];
        const clientId = resolveClientId(inv, led);

        saleEntryRows.push({
            branch_id: saleBranchId,
            sale_id,
            invoice_id: inv.invoice_id,
            party_id: clientId,
            party_type: clientId ? resolveUsernamePartyType(clientId, partyOptions) : "client",
            firm_id: inv.firm_id || null,
            sale_date: safeDate(inv.date) || inv.create_date,
            create_by: inv.create_by,
            modify_by: inv.modify_by || inv.create_by,
            create_date: inv.create_date,
            modify_date: inv.modify_date || inv.create_date,
            total: grand_total,
            is_task: "0",
        });

        const { tax_rate } = buildInvoiceRow(inv);
        for (const item of itemsByInvoice.get(inv.invoice_id) || []) {
            if (String(item.status) === "0") continue;
            const fees = Number(item.price) || 0;
            const tax_value = Number(((fees * tax_rate) / 100).toFixed(2));
            saleItemRows.push({
                branch_id: NEW_BRANCH_ID,
                item_id: item.item_id,
                sale_id,
                invoice_id: inv.invoice_id,
                service_id: item.service_id,
                fees,
                tax_perc: tax_rate,
                tax_value,
                total: fees + tax_value,
                remark: item.description || "",
            });
        }
    }

    const saleEntryCount = await batchInsert(
        target,
        "sale_entries",
        [
            "branch_id", "sale_id", "invoice_id", "party_id", "party_type", "firm_id", "sale_date",
            "create_by", "modify_by", "create_date", "modify_date", "total", "is_task",
        ],
        saleEntryRows,
        { dryRun }
    );
    const saleItemCount = await batchInsert(
        target,
        "sale_items",
        ["branch_id", "item_id", "sale_id", "invoice_id", "service_id", "fees", "tax_perc", "tax_value", "total", "remark"],
        saleItemRows,
        { dryRun }
    );
    logger.stat("phaseD.sale_entries", saleEntryCount);
    logger.stat("phaseD.sale_items", saleItemCount);

    const purchaseEntryRows = [];
    const purchaseItemRows = [];

    for (const inv of invoices) {
        if (mapTransactionType(inv.type) !== "purchase") continue;

        const grand_total = Number(inv.grand_total) || Number(inv.total) || 0;
        const purchase_id = inv.payment_id || inv.invoice_id;
        const paymentId = inv.payment_id || inv.invoice_id;
        const led = ledgerByPayment.get(paymentId) || [];
        const party = resolvePurchaseParty(inv, led, partyOptions);

        purchaseEntryRows.push({
            branch_id: NEW_BRANCH_ID,
            purchase_id,
            invoice_id: inv.invoice_id,
            party_id: party.id,
            party_type: party.type,
            purchase_date: safeDate(inv.date) || inv.create_date,
            create_by: inv.create_by,
            modify_by: inv.modify_by || inv.create_by,
            amount: grand_total,
        });

        for (const item of itemsByInvoice.get(inv.invoice_id) || []) {
            if (String(item.status) === "0") continue;
            purchaseItemRows.push({
                branch_id: NEW_BRANCH_ID,
                item_id: item.item_id,
                purchase_id,
                invoice_id: inv.invoice_id,
                service_id: item.service_id,
                amount: Number(item.price) || 0,
                remark: item.description || "",
            });
        }
    }

    const purchaseEntryCount = await batchInsert(
        target,
        "purchase_entries",
        [
            "branch_id", "purchase_id", "invoice_id", "party_id", "party_type", "purchase_date",
            "create_by", "modify_by", "amount",
        ],
        purchaseEntryRows,
        { dryRun }
    );
    const purchaseItemCount = await batchInsert(
        target,
        "purchase_items",
        ["branch_id", "item_id", "purchase_id", "invoice_id", "service_id", "amount", "remark"],
        purchaseItemRows,
        { dryRun }
    );
    logger.stat("phaseD.purchase_entries", purchaseEntryCount);
    logger.stat("phaseD.purchase_items", purchaseItemCount);

    const journalRows = journals.map((j) => ({
        branch_id: NEW_BRANCH_ID,
        journal_id: j.journal_id,
        create_by: j.create_by,
        invoice_id: j.invoice_id,
        invoice_no: j.invoice_no,
        transaction_id: j.journal_id,
        transaction_date: safeDate(j.date) || j.create_date,
        party1_type: j.from_username ? resolveUsernamePartyType(j.from_username, partyOptions) : "client",
        party1_id: j.from_username || null,
        party2_type: j.to_username ? resolveUsernamePartyType(j.to_username, partyOptions) : "client",
        party2_id: j.to_username || null,
        amount: Number(j.amount) || 0,
        modify_by: j.modify_by || j.create_by,
        is_deleted: "0",
        remark: j.remark || "",
        create_date: j.create_date,
    }));
    const journalCount = await batchInsert(
        target,
        "journal_entries",
        [
            "branch_id", "journal_id", "create_by", "invoice_id", "invoice_no", "transaction_id",
            "transaction_date", "party1_type", "party1_id", "party2_type", "party2_id",
            "amount", "modify_by", "is_deleted", "remark", "create_date",
        ],
        journalRows,
        { dryRun }
    );
    logger.stat("phaseD.journal_entries", journalCount);

    const expenseEntryRows = [];
    const expenseEntryItemRows = [];
    const seenExpenseIds = new Set();

    for (const inv of invoices) {
        if (mapTransactionType(inv.type) !== "expense") continue;
        const invExpenses = expensesByInvoice.get(inv.invoice_id) || [];
        if (!invExpenses.length) {
            const partyId = inv.create_by;
            expenseEntryRows.push({
                branch_id: NEW_BRANCH_ID,
                expense_id: inv.payment_id || inv.invoice_id,
                create_by: inv.create_by,
                modify_by: inv.modify_by || inv.create_by,
                create_date: inv.create_date,
                modify_date: inv.modify_date || inv.create_date,
                expense_date: safeDate(inv.date) || safeDate(inv.create_date),
                party_type: partyId ? resolveUsernamePartyType(partyId, partyOptions) : "staff",
                party_id: partyId,
                amount: Number(inv.grand_total) || 0,
                remark: "",
                invoice_id: inv.invoice_id,
                transaction_id: inv.payment_id || inv.invoice_id,
            });
            continue;
        }

        for (const ex of invExpenses) {
            if (seenExpenseIds.has(ex.expense_id)) continue;
            seenExpenseIds.add(ex.expense_id);
            const partyId = ex.username || ex.create_by;
            expenseEntryRows.push({
                branch_id: NEW_BRANCH_ID,
                expense_id: ex.expense_id,
                create_by: ex.create_by,
                modify_by: ex.modify_by || ex.create_by,
                create_date: ex.create_date,
                modify_date: ex.modify_date || ex.create_date,
                expense_date: safeDate(ex.approved_date) || safeDate(ex.create_date),
                party_type: partyId ? resolveUsernamePartyType(partyId, partyOptions) : "staff",
                party_id: partyId,
                amount: Number(ex.amount) || Number(inv.grand_total) || 0,
                remark: ex.remark || "",
                invoice_id: ex.invoice_id || inv.invoice_id,
                transaction_id: inv.payment_id || ex.expense_id,
            });
            expenseEntryItemRows.push({
                branch_id: NEW_BRANCH_ID,
                item_id: ex.item_id,
                expense_id: ex.expense_id,
                invoice_id: ex.invoice_id || inv.invoice_id,
                amount: Number(ex.amount) || 0,
                remark: ex.remark || "",
            });
        }
    }

    const expenseCount = await batchInsert(
        target,
        "expense_entries",
        [
            "branch_id", "expense_id", "create_by", "modify_by", "create_date", "modify_date",
            "expense_date", "party_type", "party_id", "amount", "remark", "invoice_id", "transaction_id",
        ],
        expenseEntryRows,
        { dryRun }
    );
    const expenseItemLinkCount = await batchInsert(
        target,
        "expense_entries_items",
        ["branch_id", "item_id", "expense_id", "invoice_id", "amount", "remark"],
        expenseEntryItemRows,
        { dryRun }
    );
    logger.stat("phaseD.expense_entries", expenseCount);
    logger.stat("phaseD.expense_entries_items", expenseItemLinkCount);

    const expenseItems = await queryBranchRows(staging, "expense_item");
    const expenseItemRows = expenseItems.map((ei) => {
        const typeRaw = String(ei.type || "direct").toLowerCase();
        const itemType = typeRaw.includes("reimburs") ? "reimbursement" : typeRaw.includes("indirect") ? "indirect" : "direct";
        return {
            branch_id: NEW_BRANCH_ID,
            item_id: ei.item_id,
            name: ei.name,
            type: itemType,
            create_by: ei.create_by,
            modify_by: ei.modify_by || ei.create_by,
            create_date: ei.create_date,
            modify_date: ei.modify_date || ei.create_date,
            is_deleted: "0",
        };
    });
    const expenseItemCount = await batchInsert(
        target,
        "expense_items",
        ["branch_id", "item_id", "name", "type", "create_by", "modify_by", "create_date", "modify_date", "is_deleted"],
        expenseItemRows,
        { dryRun }
    );
    logger.stat("phaseD.expense_items", expenseItemCount);
}
