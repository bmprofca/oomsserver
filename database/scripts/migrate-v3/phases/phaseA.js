import { NEW_BRANCH_ID } from "../config.js";
import { stagingTable } from "../db.js";
import { queryBranchRows, permissionsFromOptions, resolveSaleEntriesBranchId } from "../utils.js";

export async function runPhaseA(ctx) {
    const { staging, target, logger, dryRun } = ctx;
    logger.info("Phase A: foundation");

    const [appSettings] = await staging.query(
        `SELECT * FROM \`${stagingTable("app_settings")}\` WHERE app_id = ? LIMIT 1`,
        [ctx.oldAppId]
    );
    const [branchSettings] = await staging.query(
        `SELECT * FROM \`${stagingTable("branch_settings")}\` WHERE app_id = ? AND branch_id = ? LIMIT 1`,
        [ctx.oldAppId, ctx.oldBranchId]
    );

    const app = appSettings[0] || {};
    const branch = branchSettings[0] || {};

    if (!dryRun && (app.app_id || branch.branch_id)) {
        await target.query(
            `UPDATE branch_list SET
                name = COALESCE(NULLIF(?, ''), name),
                legal_name = COALESCE(NULLIF(?, ''), legal_name),
                logo = COALESCE(NULLIF(?, ''), logo),
                sign = COALESCE(NULLIF(?, ''), sign),
                mobile_1 = COALESCE(NULLIF(?, ''), mobile_1),
                email_1 = COALESCE(NULLIF(?, ''), email_1),
                address_line_1 = COALESCE(NULLIF(?, ''), address_line_1),
                city = COALESCE(NULLIF(?, ''), city),
                state = COALESCE(NULLIF(?, ''), state),
                pincode = COALESCE(NULLIF(?, ''), pincode),
                gst = COALESCE(NULLIF(?, ''), gst),
                whatsapp_channel = CASE WHEN ? != '' THEN 'ooms system' ELSE whatsapp_channel END,
                whatsappweb_session = COALESCE(NULLIF(?, ''), whatsappweb_session),
                modify_date = NOW()
             WHERE branch_id = ?`,
            [
                app.app_name || branch.name,
                app.entity_name || branch.name,
                app.logo,
                app.sign,
                app.mobile || branch.mobile,
                app.email || branch.email,
                app.address,
                app.town || branch.remark,
                app.state,
                app.pincode,
                app.gst_number || branch.gst_no,
                branch.wp_ooms_session || "",
                branch.wp_ooms_session,
                NEW_BRANCH_ID,
            ]
        );
    }
    logger.stat("phaseA.branch_list_updated", 1);

    const prefixes = await queryBranchRows(staging, "invoice_prefix");
    let prefixCount = 0;
    for (const row of prefixes) {
        const [existing] = await target.query(
            `SELECT id FROM invoice_prefix WHERE branch_id = ? AND type = ? AND is_deleted = '0' LIMIT 1`,
            [NEW_BRANCH_ID, row.type]
        );
        if (existing.length) continue;
        if (!dryRun) {
            await target.query(
                `INSERT INTO invoice_prefix (
                    branch_id, type, prefix, current, issue_date, expire_date,
                    create_by, modify_by, create_date, modify_date, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), '0')`,
                [
                    NEW_BRANCH_ID,
                    row.type,
                    row.prefix,
                    row.current ?? 0,
                    row.validity_from || row.issue_date,
                    row.validity_to || row.expire_date,
                    row.create_by || "MIGRATION",
                    row.modify_by || "MIGRATION",
                ]
            );
        }
        prefixCount++;
    }
    logger.stat("phaseA.invoice_prefix", prefixCount);

    const oldServices = await queryBranchRows(staging, "services");
    let serviceCount = 0;
    for (const svc of oldServices) {
        const [globalSvc] = await target.query(
            `SELECT service_id FROM services WHERE service_id = ? LIMIT 1`,
            [svc.service_id]
        );
        if (!globalSvc.length && !dryRun) {
            await target.query(
                `INSERT IGNORE INTO services (
                    service_id, name, sac_code, type, frequency, default_amount, default_due_date, remark
                ) VALUES (?, ?, ?, 'general', ?, ?, ?, ?)`,
                [
                    svc.service_id,
                    svc.name,
                    svc.sac_code,
                    svc.period || "monthly",
                    Number(svc.fees) || 0,
                    Number(svc.due_days) || 10,
                    svc.name,
                ]
            );
        }

        const [existingBs] = await target.query(
            `SELECT id FROM branch_services WHERE branch_id = ? AND service_id = ? LIMIT 1`,
            [NEW_BRANCH_ID, svc.service_id]
        );
        if (existingBs.length) continue;

        if (!dryRun) {
            await target.query(
                `INSERT INTO branch_services (
                    branch_id, service_id, fees, gst_rate, gst_value, remark,
                    create_by, modify_by, is_deleted, create_date, modify_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`,
                [
                    NEW_BRANCH_ID,
                    svc.service_id,
                    Number(svc.fees) || 0,
                    Number(svc.gst_rate) || 0,
                    Number(svc.gst) || 0,
                    svc.name,
                    svc.create_by,
                    svc.modify_by,
                    svc.create_date,
                    svc.modify_date,
                ]
            );
        }
        serviceCount++;
    }
    logger.stat("phaseA.branch_services", serviceCount);

    const banks = await queryBranchRows(staging, "banks");
    let bankCount = 0;
    for (const row of banks) {
        if (String(row.type).toLowerCase() === "capital") continue;
        const [exists] = await target.query(
            `SELECT id FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1`,
            [NEW_BRANCH_ID, row.bank_id]
        );
        if (exists.length) continue;
        const bankType = ["savings", "loan", "current", "cash"].includes(String(row.type).toLowerCase())
            ? String(row.type).toLowerCase()
            : "current";
        if (!dryRun) {
            await target.query(
                `INSERT INTO banks (
                    branch_id, bank_id, account_no, holder, ifsc, bank, branch, type, remark,
                    create_by, modify_by, create_date, modify_date, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
                [
                    NEW_BRANCH_ID,
                    row.bank_id,
                    row.account,
                    row.holder,
                    row.ifsc,
                    row.bank,
                    row.branch,
                    bankType,
                    row.remark || "",
                    row.create_by,
                    row.modify_by,
                    row.create_date,
                    row.modify_date,
                ]
            );
        }
        bankCount++;
    }
    logger.stat("phaseA.banks", bankCount);

    const capitals = await queryBranchRows(staging, "capital_accounts");
    let capitalCount = 0;
    for (const row of capitals) {
        const [exists] = await target.query(
            `SELECT id FROM capitals WHERE branch_id = ? AND capital_id = ? LIMIT 1`,
            [NEW_BRANCH_ID, row.account_id]
        );
        if (exists.length) continue;
        if (!dryRun) {
            await target.query(
                `INSERT INTO capitals (
                    branch_id, capital_id, name, create_by, modify_by, create_date, modify_date, remark, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0')`,
                [
                    NEW_BRANCH_ID,
                    row.account_id,
                    row.name,
                    row.create_by,
                    row.modify_by,
                    row.create_date,
                    row.modify_date,
                    row.remark,
                ]
            );
        }
        capitalCount++;
    }
    logger.stat("phaseA.capitals", capitalCount);

    const permissionLists = await queryBranchRows(staging, "permission_list");
    let roleCount = 0;
    for (const role of permissionLists) {
        const options = await queryBranchRows(staging, "permission_options", {
            extraWhere: "permission_id = ?",
            extraParams: [role.permission_id],
        });
        const permissions_assigned = permissionsFromOptions(options);
        const [exists] = await target.query(
            `SELECT id FROM permission_role WHERE branch_id = ? AND permission_role_id = ? LIMIT 1`,
            [NEW_BRANCH_ID, role.permission_id]
        );
        if (exists.length) continue;
        if (!dryRun) {
            await target.query(
                `INSERT INTO permission_role (
                    branch_id, permission_role_id, name, permissions_assigned, remark,
                    create_by, modify_by, create_date, modify_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    NEW_BRANCH_ID,
                    role.permission_id,
                    role.name,
                    permissions_assigned,
                    role.remark,
                    role.create_by,
                    role.modify_by,
                    role.create_date,
                    role.modify_date,
                ]
            );
        }
        roleCount++;
    }
    logger.stat("phaseA.permission_role", roleCount);

    ctx.saleEntriesBranchId = await resolveSaleEntriesBranchId(target);
    logger.stat("phaseA.sale_entries_branch_id", ctx.saleEntriesBranchId);
}
