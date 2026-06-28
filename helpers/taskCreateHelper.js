import pool from "../db.js";
import { RANDOM_STRING } from "./function.js";
import { downloadAndSaveNoteFile, downloadAndSaveVoiceFile } from "./NoteFile.js";
import { notifyTaskCreatedEmail } from "./taskStaticEmail.js";
import { notifyTaskCreatedWhatsapp } from "./whatsappNotification.js";

function isISODateString(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function getTableColumns(db, tableName) {
    const [rows] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map((r) => r.Field));
}

async function insertRow(db, tableName, data) {
    const columns = await getTableColumns(db, tableName);
    const entries = Object.entries(data).filter(([k]) => columns.has(k));

    if (entries.length === 0) {
        throw new Error(`No valid columns to insert into ${tableName}`);
    }

    const keys = entries.map(([k]) => `\`${k}\``).join(", ");
    const placeholders = entries.map(() => "?").join(", ");
    const values = entries.map(([, v]) => v);

    const [result] = await db.query(
        `INSERT INTO \`${tableName}\` (${keys}) VALUES (${placeholders})`,
        values
    );

    return result;
}

function normalizeTaskCreatePayload(body = {}) {
    const assignmentPayload =
        body.assignment != null && typeof body.assignment === "object" ? body.assignment : {};
    const notesPayload = body.notes != null && typeof body.notes === "object" ? body.notes : null;
    const subtasksPayload = Array.isArray(body.subtasks) ? body.subtasks : [];
    const meta = body.meta != null && typeof body.meta === "object" ? body.meta : {};

    const due_date = body.due_date != null ? String(body.due_date).trim() : "";
    if (!due_date) {
        return { error: "due_date is required when approving a quotation" };
    }
    if (!isISODateString(due_date)) {
        return { error: "Invalid due_date. Expected YYYY-MM-DD" };
    }

    return {
        due_date,
        service_category_id: body.service_category_id ?? null,
        assignmentPayload,
        notesPayload,
        subtasksPayload,
        meta,
        voice_note_id: body.voice_note_id ?? null,
        legacyAttachments: Array.isArray(body.attachments) ? body.attachments : [],
    };
}

async function createSingleTask(conn, options) {
    const {
        branch_id,
        createdBy,
        firm_id,
        firm_username,
        service_id,
        fees,
        tax_rate,
        tax_value,
        total,
        due_date,
        service_category_id = null,
        assignmentPayload = {},
        notesPayload = null,
        subtasksPayload = [],
        meta = {},
        voice_note_id = null,
        legacyAttachments = [],
    } = options;

    const ca_id = assignmentPayload.ca_id ?? assignmentPayload.ca ?? null;
    const agent_id = assignmentPayload.agent_id ?? assignmentPayload.agent ?? null;
    const has_ca = ca_id ? "1" : "0";
    const has_agent = agent_id ? "1" : "0";
    const staffIds = Array.isArray(assignmentPayload.staff) ? assignmentPayload.staff : [];
    const taskStatus = staffIds.length > 0 ? "in process" : "pending from department";

    const notesText = notesPayload?.text ?? null;
    const attachmentsForDb = Array.isArray(notesPayload?.attachments)
        ? notesPayload.attachments
        : legacyAttachments;
    const voiceForDb = Array.isArray(notesPayload?.voice)
        ? notesPayload.voice
        : voice_note_id
          ? [voice_note_id]
          : [];

    const urlToSavedFile = new Map();
    for (const att of attachmentsForDb) {
        const url = (att?.url ?? "").trim();
        if (url && !urlToSavedFile.has(url)) {
            const saved = await downloadAndSaveNoteFile(url);
            urlToSavedFile.set(url, saved);
        }
    }
    for (const voiceUrl of voiceForDb) {
        if (voiceUrl && !urlToSavedFile.has(voiceUrl)) {
            const saved = await downloadAndSaveVoiceFile(voiceUrl);
            urlToSavedFile.set(voiceUrl, saved);
        }
    }

    const task_id = RANDOM_STRING(30);

    await insertRow(conn, "tasks", {
        branch_id,
        task_id,
        username: firm_username || createdBy,
        firm_id,
        service_id,
        has_ca,
        ca_id,
        has_agent,
        agent_id,
        fees,
        tax_rate,
        tax_value,
        total,
        create_by: createdBy,
        is_recurring: "0",
        due_date,
        target_date: due_date,
        billing_status: "0",
        status: taskStatus,
    });

    await conn.query(
        "INSERT INTO task_status (branch_id, task_id, create_by, status) VALUES (?, ?, ?, ?)",
        [branch_id, task_id, createdBy, taskStatus]
    );

    const textItems = Array.isArray(notesText) ? notesText : notesText ? [notesText] : [];
    for (const content of textItems) {
        if (content == null || content === "") continue;
        await insertRow(conn, "notes", {
            branch_id,
            note_id: RANDOM_STRING(30),
            username: firm_username || createdBy,
            firm_id,
            task_id,
            note_type: "task",
            subject: String(content).slice(0, 255) || null,
            note: String(content),
            type: "text",
            priority: "low",
            status: "pending",
            create_by: createdBy,
            modify_by: createdBy,
        });
    }

    for (const att of attachmentsForDb) {
        const name = att?.name ?? att?.remark ?? "";
        const remark = att?.remark ?? att?.name ?? "";
        const url = (att?.url ?? "").trim();
        const savedFile = url ? urlToSavedFile.get(url) : null;
        if (!savedFile && url) continue;
        await insertRow(conn, "notes", {
            branch_id,
            note_id: RANDOM_STRING(30),
            username: firm_username || createdBy,
            firm_id,
            task_id,
            note_type: "task",
            subject: String(name),
            note: String(remark),
            type: "file",
            file: savedFile || null,
            priority: "low",
            status: "pending",
            create_by: createdBy,
            modify_by: createdBy,
        });
    }

    for (const voiceUrl of voiceForDb) {
        if (!voiceUrl) continue;
        const savedVoice = urlToSavedFile.get(voiceUrl);
        if (!savedVoice) continue;
        await insertRow(conn, "notes", {
            branch_id,
            note_id: RANDOM_STRING(30),
            username: firm_username || createdBy,
            firm_id,
            task_id,
            note_type: "task",
            type: "voice",
            file: savedVoice,
            priority: "low",
            status: "pending",
            create_by: createdBy,
            modify_by: createdBy,
        });
    }

    for (const st of subtasksPayload) {
        const subtaskType = st?.type === "service" ? "task" : "text";
        const textVal = st?.content != null ? String(st.content).slice(0, 100) : null;
        const serviceIdVal = st?.service_id ?? null;
        await insertRow(conn, "subtask", {
            subtask_id: RANDOM_STRING(30),
            branch_id,
            task_id,
            type: subtaskType,
            text: subtaskType === "text" ? textVal : null,
            service_id: subtaskType === "task" ? serviceIdVal : null,
            status: "pending",
            create_by: createdBy,
        });
    }

    for (const staffId of staffIds) {
        if (!staffId) continue;
        await insertRow(conn, "task_staffs", {
            branch_id,
            assign_id: RANDOM_STRING(30),
            task_id,
            username: String(staffId),
            create_by: createdBy,
        });
    }

    const financialYears = Array.isArray(meta?.financial_years) ? meta.financial_years : [];
    const assismentYears = Array.isArray(meta?.assisment_years) ? meta.assisment_years : [];
    for (const year of financialYears) {
        if (!year) continue;
        await insertRow(conn, "task_years", {
            branch_id,
            task_id,
            type: "financial year",
            year: String(year),
        });
    }
    for (const year of assismentYears) {
        if (!year) continue;
        await insertRow(conn, "task_years", {
            branch_id,
            task_id,
            type: "assisment year",
            year: String(year),
        });
    }

    return {
        task_id,
        firm_id,
        service_id,
        service_category_id,
        fees,
        tax_rate,
        tax_value,
        total,
        due_date,
        assignment: {
            staff: staffIds,
            ca_id,
            agent_id,
        },
        subtasks: subtasksPayload,
        notes: notesPayload ?? { text: [], attachments: [], voice: [] },
        meta,
        status: taskStatus,
    };
}

async function createTaskFromQuotation({
    branch_id,
    quotation_id,
    createdBy,
    taskPayload = {},
}) {
    const parsed = normalizeTaskCreatePayload(taskPayload);
    if (parsed.error) {
        return { error: { status: 400, message: parsed.error } };
    }

    const normalizedQuotationId = String(quotation_id).trim();
    const conn = await pool.getConnection();

    try {
        const [quotationRows] = await conn.query(
            `SELECT quotation_id, username, firm_id, status, task_id
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, normalizedQuotationId]
        );

        if (!quotationRows.length) {
            return { error: { status: 404, message: "Quotation not found" } };
        }

        const quotation = quotationRows[0];
        const currentStatus = quotation.status != null ? String(quotation.status).trim().toLowerCase() : "";

        if (currentStatus === "approved" && quotation.task_id) {
            return {
                error: {
                    status: 400,
                    message: "Quotation is already approved and linked to a task",
                },
            };
        }

        if (currentStatus !== "pending") {
            return {
                error: {
                    status: 400,
                    message: "Only pending quotations can be approved",
                },
            };
        }

        const firm_id =
            quotation.firm_id != null && String(quotation.firm_id).trim() !== ""
                ? String(quotation.firm_id).trim()
                : null;
        if (!firm_id) {
            return {
                error: {
                    status: 400,
                    message: "Quotation firm_id is required to create a task",
                },
            };
        }

        const [itemRows] = await conn.query(
            `SELECT service_id, fees, tax_rate, tax_value, total
             FROM quotation_items
             WHERE branch_id = ? AND quotation_id = ?
             ORDER BY id ASC
             LIMIT 1`,
            [branch_id, normalizedQuotationId]
        );

        if (!itemRows.length || !itemRows[0].service_id) {
            return {
                error: {
                    status: 400,
                    message: "Quotation has no service item to create a task from",
                },
            };
        }

        const item = itemRows[0];
        const service_id = String(item.service_id).trim();

        const [firmRows] = await conn.query(
            `SELECT firm_id, username
             FROM firms
             WHERE firm_id = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [firm_id, branch_id]
        );

        if (!firmRows.length) {
            return { error: { status: 404, message: "Quotation firm not found in this branch" } };
        }

        const [serviceRows] = await conn.query(
            `SELECT service_id
             FROM branch_services
             WHERE service_id = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [service_id, branch_id]
        );

        if (!serviceRows.length) {
            return { error: { status: 400, message: "Quotation service is invalid for this branch" } };
        }

        await conn.beginTransaction();

        const taskData = await createSingleTask(conn, {
            branch_id,
            createdBy,
            firm_id,
            firm_username: firmRows[0].username,
            service_id,
            fees: Number(item.fees || 0),
            tax_rate: Number(item.tax_rate || 0),
            tax_value: Number(item.tax_value || 0),
            total: Number(item.total || 0),
            due_date: parsed.due_date,
            service_category_id: parsed.service_category_id,
            assignmentPayload: parsed.assignmentPayload,
            notesPayload: parsed.notesPayload,
            subtasksPayload: parsed.subtasksPayload,
            meta: parsed.meta,
            voice_note_id: parsed.voice_note_id,
            legacyAttachments: parsed.legacyAttachments,
        });

        await conn.query(
            `UPDATE quotations
             SET status = ?, task_id = ?, modify_by = ?
             WHERE branch_id = ? AND quotation_id = ?`,
            ["approved", taskData.task_id, createdBy, branch_id, normalizedQuotationId]
        );

        await conn.commit();

        notifyTaskCreatedEmail({ branch_id, task_id: taskData.task_id });
        notifyTaskCreatedWhatsapp({ branch_id, task_id: taskData.task_id, created_by: createdBy });

        const [updatedRows] = await conn.query(
            `SELECT status, task_id, modify_date
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, normalizedQuotationId]
        );
        const updated = updatedRows[0] || {};

        return {
            data: {
                quotation_id: normalizedQuotationId,
                status: updated.status || "approved",
                task_id: updated.task_id || taskData.task_id,
                modify_date: updated.modify_date || null,
                task: taskData,
            },
        };
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

async function createTaskFromServiceRequest({
    branch_id,
    request_id,
    createdBy,
    taskPayload = {},
}) {
    const parsed = normalizeTaskCreatePayload(taskPayload);
    if (parsed.error) {
        return { error: { status: 400, message: parsed.error } };
    }

    const normalizedRequestId = String(request_id).trim();
    const conn = await pool.getConnection();

    try {
        const [requestRows] = await conn.query(
            `SELECT request_id, username, firm_id, service_id, fees, tax_rate, tax_value, amount,
                    client_remark, status, task_id
             FROM service_requests
             WHERE branch_id = ? AND request_id = ?
             LIMIT 1`,
            [branch_id, normalizedRequestId]
        );

        if (!requestRows.length) {
            return { error: { status: 404, message: "Service request not found" } };
        }

        const serviceRequest = requestRows[0];
        const currentStatus =
            serviceRequest.status != null ? String(serviceRequest.status).trim().toLowerCase() : "";

        if (currentStatus === "approved" && serviceRequest.task_id) {
            return {
                error: {
                    status: 400,
                    message: "Service request is already approved and linked to a task",
                },
            };
        }

        if (currentStatus !== "pending") {
            return {
                error: {
                    status: 400,
                    message: "Only pending service requests can be approved",
                },
            };
        }

        const firm_id =
            serviceRequest.firm_id != null && String(serviceRequest.firm_id).trim() !== ""
                ? String(serviceRequest.firm_id).trim()
                : null;
        if (!firm_id) {
            return {
                error: {
                    status: 400,
                    message: "Service request firm_id is required to create a task",
                },
            };
        }

        const firm_username =
            serviceRequest.username != null && String(serviceRequest.username).trim() !== ""
                ? String(serviceRequest.username).trim()
                : null;

        const service_id = String(serviceRequest.service_id || "").trim();
        if (!service_id) {
            return {
                error: {
                    status: 400,
                    message: "Service request service_id is required to create a task",
                },
            };
        }

        const [firmRows] = await conn.query(
            `SELECT firm_id, username
             FROM firms
             WHERE firm_id = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [firm_id, branch_id]
        );

        if (!firmRows.length) {
            return { error: { status: 404, message: "Service request firm not found in this branch" } };
        }

        const [serviceRows] = await conn.query(
            `SELECT service_id
             FROM branch_services
             WHERE service_id = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [service_id, branch_id]
        );

        if (!serviceRows.length) {
            return { error: { status: 400, message: "Service request service is invalid for this branch" } };
        }

        const fees = Number(serviceRequest.fees || 0);
        const tax_rate = Number(serviceRequest.tax_rate || 0);
        const tax_value = Number(serviceRequest.tax_value || 0);
        const total = Number(serviceRequest.amount || fees + tax_value);

        let notesPayload = parsed.notesPayload;
        const clientRemark =
            serviceRequest.client_remark != null && String(serviceRequest.client_remark).trim() !== ""
                ? String(serviceRequest.client_remark).trim()
                : null;

        if (clientRemark) {
            if (!notesPayload) {
                notesPayload = { text: [clientRemark], attachments: [], voice: [] };
            } else {
                const existingText = notesPayload.text;
                const textItems = Array.isArray(existingText)
                    ? existingText
                    : existingText
                      ? [existingText]
                      : [];
                if (!textItems.some((item) => String(item).trim() === clientRemark)) {
                    notesPayload = {
                        ...notesPayload,
                        text: [clientRemark, ...textItems],
                    };
                }
            }
        }

        await conn.beginTransaction();

        const taskData = await createSingleTask(conn, {
            branch_id,
            createdBy,
            firm_id,
            firm_username: firm_username || firmRows[0].username,
            service_id,
            fees,
            tax_rate,
            tax_value,
            total,
            due_date: parsed.due_date,
            service_category_id: parsed.service_category_id,
            assignmentPayload: parsed.assignmentPayload,
            notesPayload,
            subtasksPayload: parsed.subtasksPayload,
            meta: parsed.meta,
            voice_note_id: parsed.voice_note_id,
            legacyAttachments: parsed.legacyAttachments,
        });

        await conn.query(
            `UPDATE service_requests
             SET status = ?, task_id = ?, modify_by = ?, modify_date = NOW()
             WHERE branch_id = ? AND request_id = ?`,
            ["approved", taskData.task_id, createdBy, branch_id, normalizedRequestId]
        );

        await conn.commit();

        notifyTaskCreatedEmail({ branch_id, task_id: taskData.task_id });
        notifyTaskCreatedWhatsapp({ branch_id, task_id: taskData.task_id, created_by: createdBy });

        const [updatedRows] = await conn.query(
            `SELECT status, task_id, modify_date
             FROM service_requests
             WHERE branch_id = ? AND request_id = ?
             LIMIT 1`,
            [branch_id, normalizedRequestId]
        );
        const updated = updatedRows[0] || {};

        return {
            data: {
                request_id: normalizedRequestId,
                status: updated.status || "approved",
                task_id: updated.task_id || taskData.task_id,
                modify_date: updated.modify_date || null,
                task: taskData,
            },
        };
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

export {
    createSingleTask,
    createTaskFromQuotation,
    createTaskFromServiceRequest,
    isISODateString,
    normalizeTaskCreatePayload,
};
