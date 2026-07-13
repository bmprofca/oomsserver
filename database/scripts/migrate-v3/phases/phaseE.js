import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NEW_BRANCH_ID, OLD_APP_ID } from "../config.js";
import { stagingTable } from "../db.js";
import { batchInsert, combineDateTime, queryBranchRows, safeDate } from "../utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function mapAttendanceStatus(status) {
    const attendanceStatus = String(status || "present").toLowerCase().replace(/\s+/g, "_");
    const statusMap = {
        present: "present",
        absent: "absent",
        idle: "absent",
        paid_leave: "paid_leave",
        "paid leave": "paid_leave",
        half_day: "half_day",
        fine: "fine",
        bonus: "bonus",
    };
    return statusMap[attendanceStatus] || "present";
}

export async function runPhaseE(ctx) {
    const { staging, target, logger, dryRun } = ctx;
    logger.info("Phase E: extras");

    const [mappingRows] = await target.query(
        `SELECT username, map_id FROM branch_mapping WHERE branch_id = ?`,
        [NEW_BRANCH_ID]
    );
    const mapByUsername = new Map(mappingRows.map((m) => [m.username, m.map_id]));

    const attendanceOld = await queryBranchRows(staging, "attendence");
    const attendanceRows = attendanceOld.map((row) => ({
        attendance_id: row.attendence_id,
        map_id: mapByUsername.get(row.username) || `${NEW_BRANCH_ID}_${row.username}`.slice(0, 50),
        username: row.username,
        branch_id: NEW_BRANCH_ID,
        punch_in_time: combineDateTime(row.date, row.in_time),
        punch_out_time: combineDateTime(row.date, row.out_time),
        attendance_status: mapAttendanceStatus(row.status),
        create_by: row.create_by || row.username,
        modify_by: row.modify_by || row.username,
        create_date: row.create_date,
        modify_date: row.modify_date || row.create_date,
        is_deleted: "0",
    }));
    const attendanceCount = await batchInsert(
        target,
        "attendance",
        [
            "attendance_id", "map_id", "username", "branch_id", "punch_in_time", "punch_out_time",
            "attendance_status", "create_by", "modify_by", "create_date", "modify_date", "is_deleted",
        ],
        attendanceRows,
        { dryRun }
    );
    logger.stat("phaseE.attendance", attendanceCount);

    const documents = await queryBranchRows(staging, "documents");
    const docRows = documents.map((d) => {
        const monthIdx = Math.max(0, Math.min(11, Number(d.month) - 1));
        return {
            document_id: d.document_id,
            branch_id: NEW_BRANCH_ID,
            firm_id: d.firm_id || "",
            username: d.username,
            category_id: d.category_id || "",
            name: d.name,
            a_year: d.year || null,
            type: d.document_type || d.type || null,
            remark: d.remark || "",
            month: monthNames[monthIdx] || "january",
            task_id: d.task_id || null,
            file: d.path,
            size: 0,
            created_by: d.create_by,
            modify_by: d.modify_by || d.create_by,
            create_date: d.create_date,
            modify_date: safeDate(d.modify_date) || d.create_date,
            is_deleted: String(d.is_deleted) === "1" ? 1 : 0,
            deleted_by: d.deleted_by || null,
        };
    });
    const docsInserted = await batchInsert(
        target,
        "documents",
        [
            "document_id", "branch_id", "firm_id", "username", "category_id", "name", "a_year", "type", "remark",
            "month", "task_id", "file", "size", "created_by", "modify_by", "create_date", "modify_date", "is_deleted", "deleted_by",
        ],
        docRows,
        { dryRun }
    );
    logger.stat("phaseE.documents", docsInserted);

    const passwordGroups = await queryBranchRows(staging, "password_group");
    const pgRows = passwordGroups.map((pg) => ({
        group_id: pg.password_group_id,
        group_name: pg.group_name,
        branch_id: NEW_BRANCH_ID,
        status: pg.status ?? "1",
        create_by: pg.create_by,
        create_date: pg.create_date,
        modify_by: pg.modify_by,
        modify_date: pg.modify_date,
        is_deleted: "0",
    }));
    const pgCount = await batchInsert(
        target,
        "password_groups",
        ["group_id", "group_name", "branch_id", "status", "create_by", "create_date", "modify_by", "modify_date", "is_deleted"],
        pgRows,
        { dryRun }
    );
    logger.stat("phaseE.password_groups", pgCount);

    const clientPasswords = await queryBranchRows(staging, "client_passwords");
    const cpRows = clientPasswords.map((cp) => ({
        credential_id: cp.password_id,
        group_id: cp.password_group_id,
        firm_id: cp.firm_id,
        username: cp.username,
        password: cp.passwords || cp.usernames || "",
        description: cp.description || `${cp.usernames || ""}`.trim(),
        status: "1",
        create_by: cp.create_by,
        modify_by: cp.modify_by,
        create_date: cp.create_date,
        modify_date: cp.modify_date,
        is_deleted: "0",
    }));
    const cpCount = await batchInsert(
        target,
        "password_group_firms",
        [
            "credential_id", "group_id", "firm_id", "username", "password", "description",
            "status", "create_by", "modify_by", "create_date", "modify_date", "is_deleted",
        ],
        cpRows,
        { dryRun }
    );
    logger.stat("phaseE.password_group_firms", cpCount);

    const [subscriptions] = await staging.query(
        `SELECT * FROM \`${stagingTable("subscriptions")}\` WHERE app_id = ? ORDER BY end_date DESC`,
        [OLD_APP_ID]
    );
    const [activePlans] = await staging.query(
        `SELECT * FROM \`${stagingTable("active_plans")}\` WHERE app_id = ? ORDER BY id DESC LIMIT 1`,
        [OLD_APP_ID]
    );
    const plan = activePlans[0];
    if (plan) {
        logger.warn("Subscription plan requires manual mapping to v5 plan enum (Business/BusinessPlus/BusinessPro)", {
            old_plan: plan.plan_name,
            expire_date: plan.expire_date,
            subscription_history: subscriptions.length,
        });
    }
    logger.stat("phaseE.user_subscriptions", 0);

    const mediaNotePath = path.join(__dirname, "..", "..", "reports", "media-copy-checklist.txt");
    const mediaLines = [
        "# Copy these media files from old server to SERVER/media/",
        "# Logo/sign from app_settings:",
    ];
    const [appSettings] = await staging.query(`SELECT logo, sign FROM \`${stagingTable("app_settings")}\` WHERE app_id = ? LIMIT 1`, [OLD_APP_ID]);
    if (appSettings[0]?.logo) mediaLines.push(`logo: ${appSettings[0].logo}`);
    if (appSettings[0]?.sign) mediaLines.push(`sign: ${appSettings[0].sign}`);
    mediaLines.push("", "# Sample document paths (first 20):");
    documents.slice(0, 20).forEach((d) => mediaLines.push(d.path));
    if (!dryRun) {
        fs.mkdirSync(path.dirname(mediaNotePath), { recursive: true });
        fs.writeFileSync(mediaNotePath, mediaLines.join("\n"), "utf8");
    }
    logger.info(`Media checklist written: ${mediaNotePath}`);
}
