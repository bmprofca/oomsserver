import { NEW_BRANCH_ID } from "../config.js";
import { batchInsert, queryBranchRows, safeDate } from "../utils.js";

function mapTaskStatus(status) {
    const s = String(status || "").trim().toLowerCase();
    const map = {
        "in process": "in process",
        "pending from client": "pending from client",
        "pending from department": "pending from department",
        complete: "complete",
        cancelled: "cancel",
        cancel: "cancel",
    };
    return map[s] || "in process";
}

function mapSubtaskStatus(status) {
    const s = String(status || "").trim().toLowerCase();
    if (s === "complete" || s === "completed") return "complete";
    if (s === "cancel" || s === "cancelled") return "cancel";
    return "pending";
}

function mapBillingStatus(isBilled, isNonBillable) {
    if (String(isNonBillable) === "1") return "2";
    if (String(isBilled) === "1") return "1";
    return "0";
}

export async function runPhaseC(ctx) {
    const { staging, target, logger, dryRun } = ctx;
    logger.info("Phase C: tasks & operations");

    const tasks = await queryBranchRows(staging, "tasks", { reversed: true });
    const taskRows = tasks.map((t) => {
        const taxRate = Number(t.tax) || 0;
        const fees = Number(t.fees) || 0;
        const taxValue = Number(((fees * taxRate) / 100).toFixed(2));
        return {
            branch_id: NEW_BRANCH_ID,
            task_id: t.task_id,
            task_type: "general",
            username: t.username,
            firm_id: t.firm_id,
            service_id: t.service_id,
            has_ca: t.ca ? "1" : "0",
            ca_id: t.ca || null,
            has_agent: t.agent ? "1" : "0",
            agent_id: t.agent || null,
            fees,
            tax_rate: taxRate,
            tax_value: taxValue,
            total: Number(t.total) || fees + taxValue,
            create_date: t.create_date,
            create_by: t.create_by,
            is_recurring: t.is_recurring ?? "0",
            due_date: safeDate(t.due_date),
            target_date: safeDate(t.target_date),
            complete_date: safeDate(t.complete_date),
            complete_by: t.complete_by || null,
            billing_status: mapBillingStatus(t.is_billed, t.is_non_billable),
            invoice_id: t.invoice_id || null,
            status: mapTaskStatus(t.status),
        };
    });
    const tasksInserted = await batchInsert(
        target,
        "tasks",
        [
            "branch_id", "task_id", "task_type", "username", "firm_id", "service_id", "has_ca", "ca_id",
            "has_agent", "agent_id", "fees", "tax_rate", "tax_value", "total", "create_date", "create_by",
            "is_recurring", "due_date", "target_date", "complete_date", "complete_by", "billing_status",
            "invoice_id", "status",
        ],
        taskRows,
        { dryRun }
    );
    logger.stat("phaseC.tasks", tasksInserted);

    const subtasks = await queryBranchRows(staging, "sub_tasks");
    const subtaskRows = subtasks.map((s, idx) => ({
        branch_id: NEW_BRANCH_ID,
        subtask_id: s.subtask_id || `${s.task_id}_ST_${idx + 1}`.slice(0, 100),
        task_id: s.task_id,
        create_date: s.create_date,
        create_by: s.create_by,
        modify_date: s.modify_date || s.create_date,
        modify_by: s.modify_by || s.create_by,
        type: "text",
        text: (s.name || s.text || "Subtask").slice(0, 100),
        service_id: s.service_id || null,
        status: mapSubtaskStatus(s.status),
        is_deleted: "0",
    }));
    const subtasksInserted = await batchInsert(
        target,
        "subtask",
        [
            "branch_id", "subtask_id", "task_id", "create_date", "create_by", "modify_date",
            "modify_by", "type", "text", "service_id", "status", "is_deleted",
        ],
        subtaskRows,
        { dryRun }
    );
    logger.stat("phaseC.subtask", subtasksInserted);

    const taskEmployees = await queryBranchRows(staging, "task_employees");
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const staffRows = taskEmployees.map((te) => ({
        branch_id: NEW_BRANCH_ID,
        assign_id: `${te.task_id}_${te.username}_${te.id || 0}`.slice(0, 100),
        task_id: te.task_id,
        username: te.username,
        create_date: te.create_date || now,
        create_by: te.create_by || te.username,
        modify_date: te.modify_date || te.create_date || now,
        modify_by: te.modify_by || te.create_by || te.username,
        is_deleted: "0",
    }));
    const staffInserted = await batchInsert(
        target,
        "task_staffs",
        ["branch_id", "assign_id", "task_id", "username", "create_date", "create_by", "modify_date", "modify_by", "is_deleted"],
        staffRows,
        { dryRun }
    );
    logger.stat("phaseC.task_staffs", staffInserted);

    const statusHistory = await queryBranchRows(staging, "task_status_history");
    const statusRows = statusHistory.map((sh) => ({
        branch_id: NEW_BRANCH_ID,
        task_id: sh.task_id,
        create_date: sh.create_date,
        create_by: sh.create_by,
        status: mapTaskStatus(sh.status),
    }));
    const statusInserted = await batchInsert(
        target,
        "task_status",
        ["branch_id", "task_id", "create_date", "create_by", "status"],
        statusRows,
        { dryRun }
    );
    logger.stat("phaseC.task_status", statusInserted);

    const taskNotes = await queryBranchRows(staging, "task_notes");
    const noteRows = taskNotes
        .filter((tn) => tn.notes)
        .map((tn) => ({
            branch_id: NEW_BRANCH_ID,
            note_id: `${tn.task_id}_N${tn.id}`.slice(0, 100),
            task_id: tn.task_id,
            note_type: "task",
            subject: "Task note",
            note: tn.notes,
            type: "text",
            create_by: tn.create_by,
            modify_by: tn.create_by,
            create_date: tn.create_date,
            modify_date: tn.create_date,
            is_deleted: "0",
        }));
    const notesInserted = await batchInsert(
        target,
        "notes",
        [
            "branch_id", "note_id", "task_id", "note_type", "subject", "note", "type",
            "create_by", "modify_by", "create_date", "modify_date", "is_deleted",
        ],
        noteRows,
        { dryRun }
    );
    logger.stat("phaseC.notes", notesInserted);
}
