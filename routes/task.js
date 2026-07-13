import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH, SINGLE_FIRM_DATA, SINGLE_SERVICE_DATA, SINGLE_TASK_STAFF_LIST, TIMESTAMP, USER_SNIPPED_DATA } from "../helpers/function.js";
import { downloadAndSaveNoteFile, downloadAndSaveVoiceFile } from "../helpers/NoteFile.js";
import { notifyTaskCreatedEmail, notifyTaskCompletedEmail, notifyTaskCanceledEmail } from "../helpers/taskStaticEmail.js";
import { notifyTaskCreatedWhatsapp, notifyTaskCompletedWhatsapp } from "../helpers/whatsappNotification.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import {
    deleteProfileDocument,
    downloadAndUploadProfileDocument,
    getProfileDocumentAccessUrl,
} from "../helpers/b2Storage.js";
import { resolveSaleEntriesBranchId } from "../helpers/saleEntriesBranch.js";

const router = express.Router();

const TRANSIENT_DB_ERRORS = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "PROTOCOL_CONNECTION_LOST",
    "ER_CLIENT_INTERACTION_TIMEOUT",
]);

async function safeTaskLookup(label, loader, fallback = null) {
    try {
        return await loader();
    } catch (error) {
        console.warn(`Task lookup skipped (${label}):`, error?.code || error?.message || error);
        return fallback;
    }
}

function isTransientDbError(error) {
    return TRANSIENT_DB_ERRORS.has(error?.code);
}

async function isBranchAdmin(username, branchId) {
    const [rows] = await pool.query(
        "SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type = 'admin' AND is_deleted = '0' LIMIT 1",
        [username, branchId]
    );
    return rows.length > 0;
}

function parseUserPermissions(permissionsAssigned) {
    if (!permissionsAssigned) return [];
    try {
        const parsed = typeof permissionsAssigned === "string"
            ? JSON.parse(permissionsAssigned)
            : permissionsAssigned;
        if (parsed?.permissions && Array.isArray(parsed.permissions)) {
            return parsed.permissions;
        }
        if (Array.isArray(parsed)) {
            return parsed;
        }
    } catch (_) { }
    return [];
}

async function checkUserPermission(username, branchId, permissionKey) {
    if (!username || !branchId || !permissionKey) return false;

    try {
        const [mappings] = await pool.query(
            `SELECT type, permission_role_id, custom_permissions
             FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [username, branchId]
        );
        if (!mappings.length) return false;

        const userMap = mappings[0];
        if (userMap.type === "admin") return true;

        const [optCheck] = await pool.query(
            "SELECT id FROM permission_option WHERE p_option_id = ? AND status = '1' LIMIT 1",
            [permissionKey]
        );
        if (!optCheck.length) return false;

        if (userMap.custom_permissions) {
            const customPerms = parseUserPermissions(userMap.custom_permissions);
            if (customPerms.includes(permissionKey)) return true;
        }

        if (userMap.permission_role_id) {
            const [roleRows] = await pool.query(
                "SELECT permissions_assigned FROM permission_role WHERE permission_role_id = ? AND branch_id = ? LIMIT 1",
                [userMap.permission_role_id, branchId]
            );
            if (roleRows.length) {
                const rolePerms = parseUserPermissions(roleRows[0].permissions_assigned);
                if (rolePerms.includes(permissionKey)) return true;
            }
        }

        return false;
    } catch (error) {
        console.error("Error checking user permission:", error);
        return false;
    }
}

function normalizeInUser(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

const TASK_DOCUMENT_CATEGORY = "task";

/** tasks.status — align with DB enum (unassign removed from schema) */
const TASK_STATUS_ENUM = [
    "in process",
    "pending from client",
    "pending from department",
    "complete",
    "cancel"
];

function calculateTotalSeconds(startDateTime, endDateTime) {
    const start = new Date(startDateTime);
    const end = new Date(endDateTime);
    return Math.floor((end - start) / 1000);
}


async function getTableColumns(db, tableName) {
    const [rows] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map(r => r.Field));
}

async function tableExists(db, tableName) {
    const [rows] = await db.query("SHOW TABLES LIKE ?", [tableName]);
    return rows.length > 0;
}

/**
 * Insert row but only with columns that exist in DB (prevents breaking when schemas differ)
 */
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

function isISODateString(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}



// Create Task
router.post("/create", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || "";
        const branch_id = req.branch_id;

        const body = req.body || {};
        const {
            firm_id: legacyFirmId,
            service_id: legacyServiceId,
            service_category_id = null,
            fees: legacyFees = null,
            due_date: legacyDueDate,
            subtasks: legacySubtasks = [],
            assignment: legacyAssignment = {},
            notes: legacyNotes = null,
            attachments: legacyAttachments = [],
            voice_note_id = null,
            meta: legacyMeta = {}
        } = body;

        const firmsPayload = body.firms != null ? (Array.isArray(body.firms) ? body.firms : [body.firms]) : [];
        const groupsPayload = body.groups != null ? (Array.isArray(body.groups) ? body.groups : [body.groups]) : [];
        const serviceObj = body.service != null && typeof body.service === "object" ? body.service : null;
        const subtasksPayload = body.subtasks != null ? (Array.isArray(body.subtasks) ? body.subtasks : []) : legacySubtasks;
        const assignmentPayload = body.assignment != null && typeof body.assignment === "object" ? body.assignment : legacyAssignment;
        const notesPayload = body.notes != null && typeof body.notes === "object" ? body.notes : null;

        let allFirmIds = [];
        let service_id, due_date, fees, service_category_id_final, meta_final;

        // New flow: payload like test.json — firms/groups + service required
        if (serviceObj) {
            if (firmsPayload.length === 0 && groupsPayload.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "When using service object, provide at least one firm_id in firms array or one group_id in groups array"
                });
            }
            if (!serviceObj.service_id || !serviceObj.due_date) {
                return res.status(400).json({
                    success: false,
                    message: "service.service_id and service.due_date are required"
                });
            }
            if (!isISODateString(serviceObj.due_date)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service.due_date. Expected YYYY-MM-DD"
                });
            }
            service_id = serviceObj.service_id;
            due_date = serviceObj.due_date;
            fees = serviceObj.fees != null ? serviceObj.fees : null;
            service_category_id_final = serviceObj.service_category_id ?? service_category_id ?? null;
            meta_final = {
                ...legacyMeta,
                has_financial_year: serviceObj.has_financial_year,
                financial_years: serviceObj.financial_years,
                has_assisment_year: serviceObj.has_assisment_year,
                assisment_years: serviceObj.assisment_years
            };

            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();

                const firmIdsFromGroups = [];
                if (groupsPayload.length > 0) {
                    const placeholders = groupsPayload.map(() => "?").join(",");
                    const [groupFirmRows] = await conn.query(
                        `SELECT gf.firm_id FROM group_firms gf
                         INNER JOIN groups g ON g.group_id = gf.group_id AND g.branch_id = ? AND (g.is_deleted = '0' OR g.is_deleted = 0)
                         WHERE gf.group_id IN (${placeholders}) AND (gf.is_deleted = '0' OR gf.is_deleted = 0)`,
                        [branch_id, ...groupsPayload]
                    ).catch(async () => {
                        const [rows] = await conn.query(
                            `SELECT gf.firm_id FROM group_firms gf
                             INNER JOIN groups g ON g.group_id = gf.group_id AND g.branch_id = ?
                             WHERE gf.group_id IN (${placeholders})`,
                            [branch_id, ...groupsPayload]
                        );
                        return [rows];
                    });
                    firmIdsFromGroups.push(...(groupFirmRows || []).map(r => r.firm_id));
                }

                allFirmIds = [...new Set([...firmsPayload.map(String), ...firmIdsFromGroups.map(String)])];
                if (allFirmIds.length === 0) {
                    await conn.rollback();
                    conn.release();
                    return res.status(400).json({
                        success: false,
                        message: "At least one firm_id (from firms or groups) is required"
                    });
                }

                const [validFirmRows] = await conn.query(
                    `SELECT firm_id, username FROM firms WHERE firm_id IN (${allFirmIds.map(() => "?").join(",")}) AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)`,
                    [...allFirmIds, branch_id]
                ).catch(async () => {
                    const [rows] = await conn.query(
                        `SELECT firm_id, username FROM firms WHERE firm_id IN (${allFirmIds.map(() => "?").join(",")}) AND branch_id = ?`,
                        [...allFirmIds, branch_id]
                    );
                    return [rows];
                });
                const validFirmIds = new Set((validFirmRows || []).map(r => String(r.firm_id)));
                const invalid = allFirmIds.filter(id => !validFirmIds.has(id));
                if (invalid.length > 0) {
                    await conn.rollback();
                    conn.release();
                    return res.status(404).json({
                        success: false,
                        message: "One or more firms not found or do not belong to this branch",
                        invalid_firm_ids: invalid
                    });
                }

                const firmMap = new Map((validFirmRows || []).map(r => [String(r.firm_id), r]));

                const [serviceRows] = await conn.query(
                    "SELECT fees AS default_fees, gst_rate FROM branch_services WHERE service_id = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1",
                    [service_id, branch_id]
                );
                const gst_rate = Number(serviceRows?.[0]?.gst_rate ?? 0) || 0;
                const finalFees = Number(fees ?? serviceRows?.[0]?.default_fees ?? 0) || 0;
                const tax_value = Number(((finalFees * gst_rate) / 100).toFixed(2));
                const total = Number((finalFees + tax_value).toFixed(2));

                const ca_id = assignmentPayload.ca_id ?? assignmentPayload.ca ?? null;
                const agent_id = assignmentPayload.agent_id ?? assignmentPayload.agent ?? null;
                const has_ca = ca_id ? "1" : "0";
                const has_agent = agent_id ? "1" : "0";
                const assignmentForDb = {
                    staff: assignmentPayload.staff ?? [],
                    ca_id: ca_id,
                    agent_id: agent_id
                };

                const notesText = notesPayload?.text ?? null;
                const attachmentsForDb = Array.isArray(notesPayload?.attachments) ? notesPayload.attachments : (Array.isArray(legacyAttachments) ? legacyAttachments : []);
                const voiceForDb = Array.isArray(notesPayload?.voice) ? notesPayload.voice : (voice_note_id ? [voice_note_id] : []);

                const staffIds = Array.isArray(assignmentPayload.staff) ? assignmentPayload.staff : [];
                const taskStatus = staffIds.length > 0 ? "in process" : "pending from department";

                // Download file/voice note URLs once (same as client notes create), save to media
                const urlToSavedFile = new Map();
                try {
                    for (const att of attachmentsForDb) {
                        const url = att?.url ?? "";
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
                } catch (downloadErr) {
                    try { await conn.rollback(); } catch { }
                    conn.release();
                    return res.status(400).json({
                        success: false,
                        message: downloadErr.message || "Failed to download note file or voice file"
                    });
                }

                const created = [];
                for (const fid of allFirmIds) {
                    const firmRow = firmMap.get(String(fid));
                    const firm_username = firmRow?.username ?? null;
                    const task_id = await UNIQUE_RANDOM_STRING("tasks", "task_id", { length: ID_LENGTH, conn });

                    await insertRow(conn, "tasks", {
                        branch_id,
                        task_id,
                        username: firm_username || username,
                        firm_id: fid,
                        service_id,
                        has_ca,
                        ca_id,
                        has_agent,
                        agent_id,
                        fees: finalFees,
                        tax_rate: gst_rate,
                        tax_value,
                        total,
                        create_by: username,
                        is_recurring: "0",
                        due_date,
                        target_date: due_date,
                        billing_status: "0",
                        status: taskStatus
                    });

                    // Record initial task status history
                    await conn.query(
                        "INSERT INTO task_status (branch_id, task_id, create_by, status) VALUES (?, ?, ?, ?)",
                        [branch_id, task_id, username, taskStatus]
                    );

                    // notes: note_type = "task", same as client notes create (text / file / voice), priority & status
                    const textItems = Array.isArray(notesText) ? notesText : (notesText ? [notesText] : []);
                    for (const content of textItems) {
                        if (content == null || content === "") continue;
                        const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });
                        await insertRow(conn, "notes", {
                            branch_id,
                            note_id,
                            username: firm_username || username,
                            firm_id: fid,
                            task_id,
                            note_type: "task",
                            subject: String(content).slice(0, 255) || null,
                            note: String(content),
                            type: "text",
                            priority: "low",
                            status: "pending",
                            create_by: username,
                            modify_by: username
                        });
                    }
                    for (const att of attachmentsForDb) {
                        const name = att?.name ?? att?.remark ?? "";
                        const remark = att?.remark ?? att?.name ?? "";
                        const url = (att?.url ?? "").trim();
                        const savedFile = url ? urlToSavedFile.get(url) : null;
                        if (!savedFile && url) continue;
                        const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });
                        await insertRow(conn, "notes", {
                            branch_id,
                            note_id,
                            username: firm_username || username,
                            firm_id: fid,
                            task_id,
                            note_type: "task",
                            subject: String(name),
                            note: String(remark),
                            type: "file",
                            file: savedFile || null,
                            priority: "low",
                            status: "pending",
                            create_by: username,
                            modify_by: username
                        });
                    }
                    for (const voiceUrl of voiceForDb) {
                        if (!voiceUrl) continue;
                        const savedVoice = urlToSavedFile.get(voiceUrl);
                        if (!savedVoice) continue;
                        const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });
                        await insertRow(conn, "notes", {
                            branch_id,
                            note_id,
                            username: firm_username || username,
                            firm_id: fid,
                            task_id,
                            note_type: "task",
                            type: "voice",
                            file: savedVoice,
                            priority: "low",
                            status: "pending",
                            create_by: username,
                            modify_by: username
                        });
                    }

                    // subtask: type 'text' (content) or 'task' (service_id)
                    for (const st of subtasksPayload) {
                        const subtaskType = st?.type === "service" ? "task" : "text";
                        const textVal = st?.content != null ? String(st.content).slice(0, 100) : null;
                        const serviceIdVal = st?.service_id ?? null;
                        const subtask_id = await UNIQUE_RANDOM_STRING("subtask", "subtask_id", { length: ID_LENGTH, conn });
                        await insertRow(conn, "subtask", {
                            subtask_id,
                            branch_id,
                            task_id,
                            type: subtaskType,
                            text: subtaskType === "text" ? textVal : null,
                            service_id: subtaskType === "task" ? serviceIdVal : null,
                            status: "pending",
                            create_by: username
                        });
                    }

                    // task_staffs: one row per staff in assignment.staff
                    for (const staffId of staffIds) {
                        if (!staffId) continue;
                        const assign_id = await UNIQUE_RANDOM_STRING("task_staffs", "assign_id", { length: ID_LENGTH, conn });
                        await insertRow(conn, "task_staffs", {
                            branch_id,
                            assign_id,
                            task_id,
                            username: String(staffId),
                            create_by: username
                        });
                    }

                    // task_years: financial year and assisment year
                    const financialYears = Array.isArray(meta_final?.financial_years) ? meta_final.financial_years : [];
                    const assismentYears = Array.isArray(meta_final?.assisment_years) ? meta_final.assisment_years : [];
                    for (const year of financialYears) {
                        if (!year) continue;
                        await insertRow(conn, "task_years", {
                            branch_id,
                            task_id,
                            type: "financial year",
                            year: String(year)
                        });
                    }
                    for (const year of assismentYears) {
                        if (!year) continue;
                        await insertRow(conn, "task_years", {
                            branch_id,
                            task_id,
                            type: "assisment year",
                            year: String(year)
                        });
                    }

                    created.push({
                        task_id,
                        firm_id: fid,
                        service_id,
                        service_category_id: service_category_id_final,
                        fees: finalFees,
                        tax_rate: gst_rate,
                        tax_value,
                        total,
                        due_date,
                        assignment: assignmentForDb,
                        subtasks: subtasksPayload,
                        notes: notesPayload ?? { text: [], attachments: [], voice: [] },
                        meta: meta_final
                    });
                }

                await conn.commit();
                conn.release();

                for (const item of created) {
                    notifyTaskCreatedEmail({ branch_id, task_id: item.task_id });
                    notifyTaskCreatedWhatsapp({ branch_id, task_id: item.task_id, created_by: username });
                }

                return res.status(200).json({
                    success: true,
                    message: "Tasks created successfully",
                    data: created,
                    count: created.length
                });
            } catch (e) {
                try { await conn.rollback(); } catch { }
                conn.release();
                console.error("Create task error:", e);
                return res.status(500).json({ success: false, message: "Failed to create tasks", error: e.message });
            }
        }

        // Legacy flow: single firm_id, service_id, due_date at top level
        const firm_id = legacyFirmId;
        const service_id_legacy = legacyServiceId ?? service_id;
        const due_date_legacy = legacyDueDate ?? due_date;
        if (!firm_id || !service_id_legacy || !due_date_legacy) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields (firm_id, service_id, due_date) or use (firms/groups + service)"
            });
        }
        if (!isISODateString(due_date_legacy)) {
            return res.status(400).json({
                success: false,
                message: "Invalid due_date. Expected YYYY-MM-DD"
            });
        }
        if (legacySubtasks && !Array.isArray(legacySubtasks)) {
            return res.status(400).json({ success: false, message: "subtasks must be an array" });
        }
        if (legacyAttachments && !Array.isArray(legacyAttachments)) {
            return res.status(400).json({ success: false, message: "attachments must be an array" });
        }
        for (const st of legacySubtasks || []) {
            if (!st?.subtask_type || !st?.description || !st?.due_date) {
                return res.status(400).json({
                    success: false,
                    message: "Each subtask requires subtask_type, description, due_date"
                });
            }
            if (!isISODateString(st.due_date)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid subtask due_date. Expected YYYY-MM-DD"
                });
            }
            if (st.assigned_staff_ids && !Array.isArray(st.assigned_staff_ids)) {
                return res.status(400).json({
                    success: false,
                    message: "subtask.assigned_staff_ids must be an array"
                });
            }
        }

        const conn = await pool.getConnection();
        const legacyUrlToSaved = new Map();
        try {
            for (const att of legacyAttachments || []) {
                const url = (att?.url ?? "").trim();
                if (url && !legacyUrlToSaved.has(url)) {
                    const saved = await downloadAndSaveNoteFile(url);
                    legacyUrlToSaved.set(url, saved);
                }
            }
            if (voice_note_id && !legacyUrlToSaved.has(voice_note_id)) {
                const saved = await downloadAndSaveVoiceFile(voice_note_id);
                legacyUrlToSaved.set(voice_note_id, saved);
            }
        } catch (downloadErr) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: downloadErr.message || "Failed to download note file or voice file"
            });
        }

        try {
            await conn.beginTransaction();

            const [firmRows] = await conn.query(
                "SELECT branch_id, username FROM firms WHERE firm_id = ? AND branch_id = ? AND (is_deleted = '0' OR is_deleted = 0) LIMIT 1",
                [firm_id, branch_id]
            ).catch(async () => {
                const [rows] = await conn.query(
                    "SELECT branch_id, username FROM firms WHERE firm_id = ? AND branch_id = ? LIMIT 1",
                    [firm_id, branch_id]
                );
                return [rows];
            });

            if (!firmRows?.length) {
                await conn.rollback();
                conn.release();
                return res.status(404).json({ success: false, message: "firm_id not found or does not belong to this branch" });
            }

            const firm_username = firmRows[0]?.username ?? null;

            const [serviceRows] = await conn.query(
                "SELECT fees AS default_fees, gst_rate FROM branch_services WHERE service_id = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1",
                [service_id_legacy, branch_id]
            );
            const gst_rate = Number(serviceRows?.[0]?.gst_rate ?? 0) || 0;
            const finalFees = Number(legacyFees ?? serviceRows?.[0]?.default_fees ?? 0) || 0;
            const tax_value = Number(((finalFees * gst_rate) / 100).toFixed(2));
            const total = Number((finalFees + tax_value).toFixed(2));

            const task_id = await UNIQUE_RANDOM_STRING("tasks", "task_id", { length: ID_LENGTH, conn });
            const ca_id = legacyAssignment?.ca_id ?? legacyAssignment?.ca ?? null;
            const agent_id = legacyAssignment?.agent_id ?? legacyAssignment?.agent ?? null;
            const has_ca = ca_id ? "1" : "0";
            const has_agent = agent_id ? "1" : "0";
            const legacyStaffIds = Array.isArray(legacyAssignment?.staff) ? legacyAssignment.staff : [];
            const taskStatusLegacy = "in process";

            await insertRow(conn, "tasks", {
                branch_id,
                task_id,
                username: firm_username || username,
                firm_id,
                service_id: service_id_legacy,
                has_ca,
                ca_id,
                has_agent,
                agent_id,
                fees: finalFees,
                tax_rate: gst_rate,
                tax_value,
                total,
                create_by: username,
                is_recurring: "0",
                due_date: due_date_legacy,
                target_date: due_date_legacy,
                billing_status: "0",
                status: taskStatusLegacy
            });

            // Record initial task status history
            await conn.query(
                "INSERT INTO task_status (branch_id, task_id, create_by, status) VALUES (?, ?, ?, ?)",
                [branch_id, task_id, username, taskStatusLegacy]
            );

            // notes: note_type = "task", same as client (text / file / voice), priority & status
            const legacyNotesText = Array.isArray(legacyNotes) ? legacyNotes : (legacyNotes != null ? [legacyNotes] : []);
            for (const content of legacyNotesText) {
                if (content == null || content === "") continue;
                const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });
                await insertRow(conn, "notes", {
                    branch_id,
                    note_id,
                    username: firm_username || username,
                    firm_id,
                    task_id,
                    note_type: "task",
                    subject: String(content).slice(0, 255) || null,
                    note: String(content),
                    type: "text",
                    priority: "low",
                    status: "pending",
                    create_by: username,
                    modify_by: username
                });
            }
            for (const att of legacyAttachments || []) {
                const name = att?.name ?? att?.remark ?? "";
                const remark = att?.remark ?? att?.name ?? "";
                const url = (att?.url ?? "").trim();
                const savedFile = url ? legacyUrlToSaved.get(url) : null;
                if (!savedFile && url) continue;
                const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });
                await insertRow(conn, "notes", {
                    branch_id,
                    note_id,
                    username: firm_username || username,
                    firm_id,
                    task_id,
                    note_type: "task",
                    subject: String(name),
                    note: String(remark),
                    type: "file",
                    file: savedFile || null,
                    priority: "low",
                    status: "pending",
                    create_by: username,
                    modify_by: username
                });
            }
            if (voice_note_id) {
                const savedVoice = legacyUrlToSaved.get(voice_note_id);
                if (savedVoice) {
                    const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });
                    await insertRow(conn, "notes", {
                        branch_id,
                        note_id,
                        username: firm_username || username,
                        firm_id,
                        task_id,
                        note_type: "task",
                        type: "voice",
                        file: savedVoice,
                        priority: "low",
                        status: "pending",
                        create_by: username,
                        modify_by: username
                    });
                }
            }

            // subtask
            for (const st of legacySubtasks || []) {
                const subtaskType = st?.subtask_type === "service" || st?.type === "service" ? "task" : "text";
                const textVal = (st?.description ?? st?.content) != null ? String(st.description ?? st.content).slice(0, 100) : null;
                const serviceIdVal = st?.service_id ?? null;
                const subtask_id = await UNIQUE_RANDOM_STRING("subtask", "subtask_id", { length: ID_LENGTH, conn });
                await insertRow(conn, "subtask", {
                    subtask_id,
                    branch_id,
                    task_id,
                    type: subtaskType,
                    text: subtaskType === "text" ? textVal : null,
                    service_id: subtaskType === "task" ? serviceIdVal : null,
                    status: "pending",
                    create_by: username
                });
            }

            // task_staffs
            for (const staffId of legacyStaffIds) {
                if (!staffId) continue;
                const assign_id = await UNIQUE_RANDOM_STRING("task_staffs", "assign_id", { length: ID_LENGTH, conn });
                await insertRow(conn, "task_staffs", {
                    branch_id,
                    assign_id,
                    task_id,
                    username: String(staffId),
                    create_by: username
                });
            }

            // task_years from legacyMeta
            const legacyFinYears = Array.isArray(legacyMeta?.financial_years) ? legacyMeta.financial_years : [];
            const legacyAssYears = Array.isArray(legacyMeta?.assisment_years) ? legacyMeta.assisment_years : [];
            for (const year of legacyFinYears) {
                if (!year) continue;
                await insertRow(conn, "task_years", { branch_id, task_id, type: "financial year", year: String(year) });
            }
            for (const year of legacyAssYears) {
                if (!year) continue;
                await insertRow(conn, "task_years", { branch_id, task_id, type: "assisment year", year: String(year) });
            }

            await conn.commit();
            conn.release();

            notifyTaskCreatedEmail({ branch_id, task_id });
            notifyTaskCreatedWhatsapp({ branch_id, task_id, created_by: username });

            return res.status(200).json({
                success: true,
                message: "Task created successfully",
                data: {
                    task_id,
                    firm_id,
                    service_id: service_id_legacy,
                    service_category_id,
                    fees: finalFees,
                    tax_rate: gst_rate,
                    tax_value,
                    total,
                    due_date: due_date_legacy,
                    assignment: legacyAssignment,
                    subtasks: legacySubtasks,
                    attachments: legacyAttachments,
                    notes: legacyNotes,
                    voice_note_id,
                    meta: legacyMeta
                }
            });
        } catch (e) {
            try { await conn.rollback(); } catch { }
            conn.release();
            console.error("Create task error:", e);
            return res.status(500).json({ success: false, message: "Failed to create task", error: e.message });
        }
    } catch (error) {
        console.error("Create task fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create task", error: error.message });
    }
});

// View task list
router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const parseQueryArray = (value) => {
            if (value === undefined || value === null) return [];

            const toCleanStringArray = (arr) =>
                arr
                    .map((item) => String(item).trim())
                    .filter((item) => item !== "");

            if (Array.isArray(value)) {
                return toCleanStringArray(value);
            }

            const raw = String(value).trim();
            if (raw === "") return [];

            // Supports JSON-encoded arrays from query params.
            if (raw.startsWith("[") && raw.endsWith("]")) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        return toCleanStringArray(parsed);
                    }
                } catch (_) { }
            }

            return toCleanStringArray(raw.split(","));
        };

        const {
            page_no = 1,
            limit = 20,
            search,
            username,
            firm_id,
            service_id,
            status,
            service_ids,
            ca,
            agent,
        } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;
        const statusList = parseQueryArray(status);
        const serviceIdList = parseQueryArray(service_ids);

        let baseQuery = `
            FROM tasks t
            LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN services s
                ON s.service_id = t.service_id
            WHERE t.branch_id = ?
        `;

        const params = [branch_id];

        if (username && String(username).trim() !== "") {
            baseQuery += " AND t.username = ?";
            params.push(String(username).trim());
        }
        if (firm_id && String(firm_id).trim() !== "") {
            baseQuery += " AND t.firm_id = ?";
            params.push(String(firm_id).trim());
        }
        if (service_id && String(service_id).trim() !== "") {
            baseQuery += " AND t.service_id = ?";
            params.push(String(service_id).trim());
        }
        if (statusList.length > 0) {
            const statusPlaceholders = statusList.map(() => "?").join(", ");
            baseQuery += ` AND t.status IN (${statusPlaceholders})`;
            params.push(...statusList);
        }
        if (serviceIdList.length > 0) {
            const servicePlaceholders = serviceIdList.map(() => "?").join(", ");
            baseQuery += ` AND t.service_id IN (${servicePlaceholders})`;
            params.push(...serviceIdList);
        }
        if (ca && String(ca).trim() !== "") {
            baseQuery += " AND t.has_ca = '1' AND t.ca_id = ?";
            params.push(String(ca).trim());
        }
        if (agent && String(agent).trim() !== "") {
            baseQuery += " AND t.has_agent = '1' AND t.agent_id = ?";
            params.push(String(agent).trim());
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
              AND (
                  t.task_id LIKE ?
                  OR t.username LIKE ?
                  OR f.username LIKE ?
                  OR f.firm_name LIKE ?
                  OR s.name LIKE ?
                  OR s.service_id LIKE ?
                  OR t.status LIKE ?
              )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const countQuery = `SELECT COUNT(*) AS total ${baseQuery}`;
        const [countRows] = await pool.query(countQuery, params);
        const total = countRows[0]?.total || 0;

        const listQuery = `
            SELECT
                t.task_id,
                t.username,
                t.firm_id,
                t.service_id,
                t.has_ca,
                t.ca_id,
                t.has_agent,
                t.agent_id,
                t.fees,
                t.tax_rate,
                t.tax_value,
                t.total,
                t.due_date,
                t.target_date,
                t.billing_status,
                t.status,
                t.create_date,
                t.create_by,
                t.is_recurring,
                t.in_user,
                f.username AS firm_username,
                f.firm_name,
                s.name AS service_name
            ${baseQuery}
            ORDER BY t.create_date DESC, t.id DESC
            LIMIT ? OFFSET ?
        `;

        const listParams = [...params, limitNum, offset];
        const [rows] = await pool.query(listQuery, listParams);

        const list = [];
        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            const create_by = await USER_SNIPPED_DATA(element?.create_by);
            const modify_by = await USER_SNIPPED_DATA(element?.modify_by || element?.create_by);
            const client_profile = await USER_SNIPPED_DATA(element?.username);
            const firm_data = await SINGLE_FIRM_DATA(element?.firm_id);
            const service_data = await SINGLE_SERVICE_DATA(element?.service_id);

            const staffs = await SINGLE_TASK_STAFF_LIST(element?.task_id);
            const object = {
                task_id: element?.task_id,
                client: {
                    username: element?.username,
                    profile: client_profile
                },
                firm: {
                    firm_id: firm_data?.firm_id,
                    firm_name: firm_data?.firm_name
                },
                service: {
                    service_id: service_data?.service_id,
                    name: service_data?.name
                },
                charges: {
                    fees: Number(element?.fees) || 0,
                    tax_rate: Number(element?.tax_rate) || 0,
                    tax_value: Number(element?.tax_value) || 0,
                    total: Number(element?.total) || 0,
                },
                dates: {
                    due_date: element?.due_date,
                    create_date: element?.create_date,
                    target_date: element?.target_date,
                },
                billing_status: element?.billing_status == "0" ? 'pending' : element?.billing_status == "1" ? 'complete' : 'non billable',
                status: element?.status,
                create_by,
                modify_by,
                is_recurring: element?.is_recurring == '1',
                staffs
            }

            const has_ca = element?.has_ca == '1';
            object.has_ca = has_ca;
            if (has_ca) {
                const ca_data = await USER_SNIPPED_DATA(element?.ca_id);
                object.ca = ca_data;
            }

            const has_agent = element?.has_agent == '1';
            object.has_agent = has_agent;
            if (has_agent) {
                const agent_data = await USER_SNIPPED_DATA(element?.agent_id);
                object.agent = agent_data;
            }

            const inUser = normalizeInUser(element?.in_user);
            object.in_user = inUser
                ? await USER_SNIPPED_DATA(inUser)
                : null;

            list.push(object);
        }

        return res.status(200).json({
            success: true,
            message: "Task list retrieved successfully",
            query_payload: {
                ...req.query,
                page_no: pageNum,
                limit: limitNum,
                status: statusList,
                service_ids: serviceIdList
            },
            data: list,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });
    } catch (error) {
        console.error("Task list error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task list",
            error: error.message
        });
    }
});

router.put("/details/get-in/:task_id", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const username = String(req.headers["username"] || "").trim();
        const branch_id = req.branch_id;
        const task_id = String(req.params.task_id || "").trim();

        if (!task_id) {
            return res.status(400).json({
                success: false,
                message: "task_id is required",
            });
        }

        await conn.beginTransaction();

        const [taskRows] = await conn.query(
            `SELECT task_id, in_user
             FROM tasks
             WHERE task_id = ? AND branch_id = ?
             FOR UPDATE`,
            [task_id, branch_id]
        );

        if (!taskRows.length) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Task not found",
            });
        }

        const currentInUser = normalizeInUser(taskRows[0].in_user);

        if (currentInUser && currentInUser !== username) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: "Task is already in use by another user",
                in_user: await USER_SNIPPED_DATA(currentInUser),
            });
        }

        if (currentInUser === username) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "You are already in on this task",
            });
        }

        await conn.query(
            `UPDATE tasks SET in_user = ? WHERE task_id = ? AND branch_id = ?`,
            [username, task_id, branch_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Get in successful",
            data: {
                task_id,
                in_user: await USER_SNIPPED_DATA(username),
            },
        });
    } catch (error) {
        await conn.rollback();
        console.error("Task get-in error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to get in on task",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.put("/details/get-out/:task_id", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const username = String(req.headers["username"] || "").trim();
        const branch_id = req.branch_id;
        const task_id = String(req.params.task_id || "").trim();

        if (!task_id) {
            return res.status(400).json({
                success: false,
                message: "task_id is required",
            });
        }

        await conn.beginTransaction();

        const [taskRows] = await conn.query(
            `SELECT task_id, in_user
             FROM tasks
             WHERE task_id = ? AND branch_id = ?
             FOR UPDATE`,
            [task_id, branch_id]
        );

        if (!taskRows.length) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Task not found",
            });
        }

        const currentInUser = normalizeInUser(taskRows[0].in_user);

        if (!currentInUser) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "No user is currently in on this task",
            });
        }

        const isSelf = currentInUser === username;
        const isAdmin = await isBranchAdmin(username, branch_id);
        const hasGetOutPermission = await checkUserPermission(username, branch_id, "task_get_in");

        if (!isSelf && !isAdmin && !hasGetOutPermission) {
            await conn.rollback();
            return res.status(403).json({
                success: false,
                message: "You are not authorized to get out this user from the task",
            });
        }

        const removedUser = currentInUser;

        await conn.query(
            `UPDATE tasks SET in_user = NULL WHERE task_id = ? AND branch_id = ?`,
            [task_id, branch_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Get out successful",
            data: {
                task_id,
                in_user: null,
                removed_user: await USER_SNIPPED_DATA(removedUser),
            },
        });
    } catch (error) {
        await conn.rollback();
        console.error("Task get-out error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to get out from task",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

// edit a task
router.put("/edit/:task_id", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const username = req.headers["username"] || "";
        const branch_id = req.branch_id;
        const task_id = req.params.task_id;

        if (!task_id || task_id.trim() === "") {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "task_id is required"
            });
        }

        const body = req.body || {};
        const {
            firm_id,
            service_id,
            fees,
            tax_rate,
            ca,
            agent,
            due_date,
            target_date
        } = body;

        const [task_row] = await conn.query("SELECT * FROM tasks WHERE task_id = ? AND branch_id = ?", [task_id, branch_id]);
        if (task_row.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Task not found on this branch"
            });
        }

        const task_data = task_row[0];

        const PrevTaskBillingStatus = task_data.billing_status;
        const PrevTaskInvoiceId = task_data.invoice_id;

        let AllowFirmIdChange = false;
        let AllowServiceIdChange = false;
        let AllowFeesChange = false;
        let AllowTaxRateChange = false;
        let AllowCaChange = false;
        let AllowAgentChange = false;
        let AllowDueDateChange = false;
        let AllowTargetDateChange = false;

        if (PrevTaskBillingStatus == "0") {
            AllowFirmIdChange = true;
            AllowServiceIdChange = true;
            AllowFeesChange = true;
            AllowTaxRateChange = true;
            AllowCaChange = true;
            AllowAgentChange = true;
            AllowDueDateChange = true;
            AllowTargetDateChange = true;
        } else if (PrevTaskBillingStatus == "1") {
            AllowFeesChange = true;
            AllowTaxRateChange = true;
        } else if (PrevTaskBillingStatus == "2") {
            AllowFeesChange = true;
            AllowTaxRateChange = true;
        }

        if (firm_id && firm_id !== task_data.firm_id && AllowFirmIdChange) {
            await conn.query("UPDATE tasks SET firm_id = ? WHERE task_id = ? AND branch_id = ?", [firm_id, task_id, branch_id]);
        }
        if (service_id && service_id !== task_data.service_id && AllowServiceIdChange) {
            await conn.query("UPDATE tasks SET service_id = ? WHERE task_id = ? AND branch_id = ?", [service_id, task_id, branch_id]);
        }

        if (ca && ca.has_ca && ca.ca_id !== task_data.ca_id && AllowCaChange) {
            await conn.query("UPDATE tasks SET ca_id = ? WHERE task_id = ? AND branch_id = ?", [ca.ca_id, task_id, branch_id]);
        }
        if (ca && !ca.has_ca && AllowCaChange) {
            await conn.query("UPDATE tasks SET ca_id = NULL WHERE task_id = ? AND branch_id = ?", [task_id, branch_id]);
        }
        if (agent && agent.has_agent && agent.agent_id !== task_data.agent_id && AllowAgentChange) {
            await conn.query("UPDATE tasks SET agent_id = ? WHERE task_id = ? AND branch_id = ?", [agent.agent_id, task_id, branch_id]);
        }
        if (agent && !agent.has_agent && AllowAgentChange) {
            await conn.query("UPDATE tasks SET agent_id = NULL WHERE task_id = ? AND branch_id = ?", [task_id, branch_id]);
        }
        if (due_date && due_date !== task_data.due_date && AllowDueDateChange) {
            await conn.query("UPDATE tasks SET due_date = ? WHERE task_id = ? AND branch_id = ?", [due_date, task_id, branch_id]);
        }
        if (target_date && target_date !== task_data.target_date && AllowTargetDateChange) {
            await conn.query("UPDATE tasks SET target_date = ? WHERE task_id = ? AND branch_id = ?", [target_date, task_id, branch_id]);
        }


        if (fees && AllowFeesChange && tax_rate && AllowTaxRateChange) {
            const tax_value = (fees * tax_rate) / 100;
            const total = fees + tax_value;
            await conn.query("UPDATE tasks SET fees = ?, tax_rate = ?, tax_value = ?, total = ? WHERE task_id = ? AND branch_id = ?", [fees, tax_rate, tax_value, total, task_id, branch_id]);

            if (PrevTaskBillingStatus == "1") {
                const saleEntriesBranchId = await resolveSaleEntriesBranchId(conn, branch_id);
                if (saleEntriesBranchId != null) {
                    await conn.query("UPDATE sale_entries SET total = ? WHERE invoice_id = ? AND branch_id = ?", [total, PrevTaskInvoiceId, saleEntriesBranchId]);
                }

                await conn.query("UPDATE transactions SET amount = ? WHERE invoice_id = ? AND branch_id = ?", [total, PrevTaskInvoiceId, branch_id]);

                await conn.query("UPDATE sale_items SET fees = ?, tax_perc = ?, tax_value = ?, total = ? WHERE invoice_id = ? AND branch_id = ?", [fees, tax_rate, tax_value, total, PrevTaskInvoiceId, branch_id]);

                await conn.query("UPDATE invoice SET subtotal = ?, tax_value = ?, tax_rate = ?, total = ?, grand_total = ? WHERE invoice_id = ? AND branch_id = ?", [fees, tax_value, tax_rate, total, total, PrevTaskInvoiceId, branch_id]);
            }
        }

        await conn.commit();
        conn.release();

        return res.status(200).json({
            success: true,
            message: "Task updated successfully"
        });

    } catch (error) {
        try { await conn.rollback(); } catch { }
        conn.release();
        console.error("Edit task error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update task",
            error: error.message
        });
    }
});

// get single task details
router.get("/details/profile", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { task_id } = req.query || {};

        if (!task_id || String(task_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "task_id is required"
            });
        }

        const taskId = String(task_id).trim();

        const baseQuery = `
        FROM tasks t
        LEFT JOIN firms f
          ON f.firm_id = t.firm_id
          AND (f.is_deleted = '0' OR f.is_deleted = 0)
        LEFT JOIN services s
          ON s.service_id = t.service_id
        LEFT JOIN tasks td
          ON td.task_id = t.task_id
        WHERE t.branch_id = ?
          AND t.task_id = ?
        LIMIT 1
      `;

        const params = [branch_id, taskId];

        const detailsQuery = `
        SELECT
          t.task_id,
          t.username,
          t.firm_id,
          t.service_id,
          t.has_ca,
          t.ca_id,
          t.has_agent,
          t.agent_id,
          t.fees,
          t.tax_rate,
          t.tax_value,
          t.total,
          t.due_date,
          t.target_date,
          t.billing_status,
          t.status,
          t.create_date,
          t.create_by,
          t.is_recurring,
  
          f.username AS firm_username,
          f.firm_name,
          s.name AS service_name,
  
          td.*   -- optional: keeps extra fields from tasks (won't affect list-structure)
        ${baseQuery}
      `;

        const [rows] = await pool.query(detailsQuery, params);

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        const element = rows[0];

        // fetch related objects (parallel)
        const [
            create_by,
            modify_by,
            client_profile,
            firm_data,
            service_data,
            staffs
        ] = await Promise.all([
            safeTaskLookup("create_by", () => USER_SNIPPED_DATA(element?.create_by)),
            safeTaskLookup("modify_by", () => USER_SNIPPED_DATA(element?.modify_by || element?.create_by)),
            safeTaskLookup("client_profile", () => USER_SNIPPED_DATA(element?.username)),
            safeTaskLookup("firm_data", () => SINGLE_FIRM_DATA(element?.firm_id), {}),
            safeTaskLookup("service_data", () => SINGLE_SERVICE_DATA(element?.service_id), {}),
            safeTaskLookup("staffs", () => SINGLE_TASK_STAFF_LIST(element?.task_id), []),
        ]);

        const object = {
            task_id: element?.task_id,
            client: {
                username: element?.username,
                profile: client_profile
            },
            firm: {
                firm_id: firm_data?.firm_id || element?.firm_id,
                firm_name: firm_data?.firm_name || element?.firm_name || null,
            },
            service: {
                service_id: service_data?.service_id,
                name: service_data?.name
            },
            charges: {
                fees: Number(element?.fees) || 0,
                tax_rate: Number(element?.tax_rate) || 0,
                tax_value: Number(element?.tax_value) || 0,
                total: Number(element?.total) || 0
            },
            dates: {
                due_date: element?.due_date,
                create_date: element?.create_date,
                target_date: element?.target_date
            },
            billing_status:
                element?.billing_status == "0"
                    ? "pending"
                    : element?.billing_status == "1"
                        ? "complete"
                        : "non billable",
            status: element?.status,
            create_by,
            modify_by,
            is_recurring: element?.is_recurring == "1",
            staffs
        };

        const has_ca = element?.has_ca == "1";
        object.has_ca = has_ca;
        if (has_ca) {
            object.ca = await USER_SNIPPED_DATA(element?.ca_id);
        }

        const has_agent = element?.has_agent == "1";
        object.has_agent = has_agent;
        if (has_agent) {
            object.agent = await USER_SNIPPED_DATA(element?.agent_id);
        }

        if (element?.billing_status == "1") {
            object.invoice_id = element?.invoice_id;
            object.invoice_no = element?.invoice_no;
        }

        return res.status(200).json({
            success: true,
            message: "Task details retrieved successfully",
            data: object
        });
    } catch (error) {
        console.error("Task details error:", error);
        if (isTransientDbError(error)) {
            return res.status(503).json({
                success: false,
                message: "Database is temporarily unavailable. Please try again.",
                error: error.message,
            });
        }
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task details",
            error: error.message
        });
    }
});


// View signle task notes list
router.get("/details/note/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { task_id, page_no = 1, limit = 10 } = req.query || {};

        if (!task_id || String(task_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "task_id is required"
            });
        }

        const [task_check] = await pool.query("SELECT * FROM tasks WHERE branch_id =? AND task_id = ?", [branch_id, task_id]);
        if (task_check.length == 0) {
            return res.status(400).json({
                success: false,
                message: "Task not found"
            })
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const [total_row] = await pool.query("SELECT * FROM notes WHERE note_type = 'task' AND task_id = ? AND is_deleted = '0'", [task_id]);

        const total = total_row.length;

        const [rows] = await pool.query("SELECT * FROM notes WHERE note_type = 'task' AND task_id = ? AND is_deleted = '0' ORDER BY id DESC LIMIT ? OFFSET ?", [task_id, limitNum, offset]);

        const list = [];

        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            const create_by = await USER_SNIPPED_DATA(element?.create_by);
            const modify_by = await USER_SNIPPED_DATA(element?.modify_by || element?.create_by);
            const type = element?.type;

            const object = {
                note_id: element?.note_id,
                priority: element?.priority,
                status: element?.status,
                type,
                create_date: element?.create_date,
                modify_date: element?.modify_date,
                create_by,
                modify_by
            }

            if (type == 'text') {
                object.subject = element?.subject;
                object.note = element?.note;
            }

            if (type == 'file') {
                object.file = `${BASE_DOMAIN}/media/note/file/${element?.file}`;
                object.file_name = element?.subject;
                object.remark = element?.note;
            }

            if (type == 'voice') {
                object.file = `${BASE_DOMAIN}/media/note/voice/${element?.file}`;
            }

            list.push(object);


        }


        return res.status(200).json({
            success: true,
            data: list,
            message: 'Task notes retrived successfully',
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });
    } catch (error) {
        console.error("Task details error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task details",
            error: error.message
        });
    }
});

// Create single task note
router.post("/details/note/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const branch_id = req.branch_id;
        const create_by = req.headers["username"] || req.headers["Username"] || "";

        const body = req.body || {};
        const task_id = (body.task_id || "").trim();

        const noteObj =
            body.notes != null && typeof body.notes === "object"
                ? body.notes
                : body;

        const textArrRaw = noteObj.text;
        const attachmentsArrRaw = noteObj.attachments;
        const voiceArrRaw = noteObj.voice;

        const textArr = Array.isArray(textArrRaw) ? textArrRaw : (textArrRaw != null ? [textArrRaw] : []);
        const attachmentsArr = Array.isArray(attachmentsArrRaw) ? attachmentsArrRaw : [];
        const voiceArr = Array.isArray(voiceArrRaw) ? voiceArrRaw : (voiceArrRaw != null ? [voiceArrRaw] : []);

        if (!task_id) {
            conn.release();
            return res.status(400).json({ success: false, message: "task_id is required" });
        }

        const hasAny =
            textArr.some(v => v != null && String(v).trim() !== "") ||
            attachmentsArr.some(a => (a?.url ?? "").trim() !== "") ||
            voiceArr.some(v => v != null && String(v).trim() !== "");

        if (!hasAny) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Provide at least one note item (text / attachments / voice)"
            });
        }

        await conn.beginTransaction();

        // Validate task belongs to branch + fetch firm_id + task username
        const [taskRows] = await conn.query(
            `SELECT task_id, firm_id, username
             FROM tasks
             WHERE task_id = ? AND branch_id = ?
             LIMIT 1`,
            [task_id, branch_id]
        );

        if (!taskRows?.length) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "task_id not found or does not belong to this branch"
            });
        }

        const taskFirmId = taskRows[0]?.firm_id ?? null;
        const taskUsername = taskRows[0]?.username ?? null;

        // Download each unique URL once
        const urlToSavedFile = new Map();
        try {
            for (const att of attachmentsArr) {
                const url = (att?.url ?? "").trim();
                if (url && !urlToSavedFile.has(url)) {
                    const saved = await downloadAndSaveNoteFile(url);
                    urlToSavedFile.set(url, saved);
                }
            }
            for (const v of voiceArr) {
                const url = (v ?? "").trim();
                if (url && !urlToSavedFile.has(url)) {
                    const saved = await downloadAndSaveVoiceFile(url);
                    urlToSavedFile.set(url, saved);
                }
            }
        } catch (downloadErr) {
            try { await conn.rollback(); } catch { }
            conn.release();
            return res.status(400).json({
                success: false,
                message: downloadErr.message || "Failed to download note file or voice file"
            });
        }

        const created = [];

        // TEXT notes
        for (const t of textArr) {
            const content = t != null ? String(t).trim() : "";
            if (!content) continue;

            const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });

            const noteRow = {
                branch_id,
                note_id,
                username: taskUsername || create_by,
                firm_id: taskFirmId,
                task_id,
                note_type: "task",
                subject: content.slice(0, 255) || null,
                note: content,
                type: "text",
                priority: "low",
                status: "pending",
                create_by,
                modify_by: create_by
            };

            await insertRow(conn, "notes", noteRow);
            created.push({ ...noteRow, file: null });
        }

        // FILE notes
        for (const att of attachmentsArr) {
            const url = (att?.url ?? "").trim();
            if (!url) continue;

            const savedFile = urlToSavedFile.get(url);
            if (!savedFile) continue;

            const name = att?.name ?? att?.remark ?? "";
            const remark = att?.remark ?? att?.name ?? "";

            const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });

            const noteRow = {
                branch_id,
                note_id,
                username: taskUsername || create_by,
                firm_id: taskFirmId,
                task_id,
                note_type: "task",
                subject: String(name).slice(0, 255),
                note: String(remark),
                type: "file",
                file: savedFile,
                priority: "low",
                status: "pending",
                create_by,
                modify_by: create_by
            };

            await insertRow(conn, "notes", noteRow);
            created.push(noteRow);
        }

        // VOICE notes
        for (const v of voiceArr) {
            const url = (v ?? "").trim();
            if (!url) continue;

            const savedVoice = urlToSavedFile.get(url);
            if (!savedVoice) continue;

            const note_id = await UNIQUE_RANDOM_STRING("notes", "note_id", { length: ID_LENGTH, conn });

            const noteRow = {
                branch_id,
                note_id,
                username: taskUsername || create_by,
                firm_id: taskFirmId,
                task_id,
                note_type: "task",
                type: "voice",
                file: savedVoice,
                priority: "low",
                status: "pending",
                create_by,
                modify_by: create_by
            };

            await insertRow(conn, "notes", noteRow);
            created.push(noteRow);
        }

        if (created.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No valid note items to create (empty text / missing urls)"
            });
        }

        await conn.commit();
        conn.release();

        return res.status(200).json({
            success: true,
            message: "Notes created successfully",
        });
    } catch (e) {
        try { await conn.rollback(); } catch { }
        conn.release();
        console.error("Note create error:", e);
        return res.status(500).json({
            success: false,
            message: "Failed to create notes",
            error: e.message
        });
    }
});

/** subtask.status — DB enum `pending` | `complete` | `cancel` (database-context.json) */
const SUBTASK_STATUS_VALUES = ["pending", "complete", "cancel"];
const SUBTASK_TERMINAL_STATUSES = ["complete", "cancel"];

async function findTasksWithIncompleteSubtasks(conn, branch_id, taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) return [];

    const placeholders = taskIds.map(() => "?").join(",");
    const [rows] = await conn.query(
        `SELECT s.task_id, COUNT(*) AS incomplete_subtask_count
         FROM subtask s
         WHERE s.branch_id = ?
           AND s.task_id IN (${placeholders})
           AND (s.is_deleted = '0' OR s.is_deleted = 0)
           AND LOWER(s.status) NOT IN (${SUBTASK_TERMINAL_STATUSES.map(() => "?").join(", ")})
         GROUP BY s.task_id`,
        [branch_id, ...taskIds, ...SUBTASK_TERMINAL_STATUSES]
    );

    return rows || [];
}

// Create single task subtask
router.post("/details/subtask/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || "";
        const body = req.body || {};

        const { task_id, subtasks = [] } = body;

        // Validation
        if (!task_id || String(task_id).trim() === "") {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "task_id is required"
            });
        }

        if (!Array.isArray(subtasks) || subtasks.length === 0) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "subtasks array is required with at least one subtask"
            });
        }

        await conn.beginTransaction();

        // Verify task exists and belongs to branch
        const [taskRows] = await conn.query(
            `SELECT task_id, firm_id, username, status
             FROM tasks 
             WHERE task_id = ? AND branch_id = ? 
             LIMIT 1`,
            [task_id, branch_id]
        );

        if (!taskRows?.length) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Task not found or does not belong to this branch"
            });
        }

        if (String(taskRows[0].status ?? "").toLowerCase() === "complete") {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Cannot create subtasks when the main task is complete"
            });
        }

        // Validate each subtask
        for (const [index, st] of subtasks.entries()) {
            if (!st.type || !["text", "service"].includes(st.type)) {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Subtask at index ${index}: type must be either 'text' or 'service'`
                });
            }

            if (st.type === "text") {
                if (!st.text || String(st.text).trim() === "") {
                    await conn.rollback();
                    conn.release();
                    return res.status(400).json({
                        success: false,
                        message: `Subtask at index ${index}: text is required for type 'text'`
                    });
                }
            }

            if (st.type === "service") {
                if (!st.service_id || String(st.service_id).trim() === "") {
                    await conn.rollback();
                    conn.release();
                    return res.status(400).json({
                        success: false,
                        message: `Subtask at index ${index}: service_id is required for type 'service'`
                    });
                }

                const [serviceRows] = await conn.query(
                    `SELECT bs.service_id, s.name FROM branch_services bs
                     INNER JOIN services s ON s.service_id = bs.service_id
                     WHERE bs.service_id = ? AND bs.branch_id = ? AND bs.is_deleted = '0'
                     LIMIT 1`,
                    [st.service_id, branch_id]
                );

                if (!serviceRows?.length) {
                    await conn.rollback();
                    conn.release();
                    return res.status(404).json({
                        success: false,
                        message: `Subtask at index ${index}: service_id '${st.service_id}' not found in this branch`
                    });
                }
            }

            // Validate status if provided
            const validStatuses = ["pending", "in process", "complete", "hold", "cancelled"];
            if (st.status && !validStatuses.includes(st.status)) {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Subtask at index ${index}: status must be one of: ${validStatuses.join(', ')}`
                });
            }
        }

        // Create subtasks
        const createdSubtasks = [];

        for (const st of subtasks) {
            const subtask_id = await UNIQUE_RANDOM_STRING("subtask", "subtask_id", { length: ID_LENGTH, conn });
            const status = st.status || "pending";
            const dbType = st.type === "service" ? "task" : "text";

            const subtaskData = {
                subtask_id,
                branch_id,
                task_id,
                type: dbType,
                status,
                create_by: username,
                modify_by: username,
                is_deleted: "0"
            };

            if (dbType === "text") {
                subtaskData.text = String(st.text).trim();
                subtaskData.service_id = null;
            } else {
                subtaskData.text = null;
                subtaskData.service_id = st.service_id;
            }

            await insertRow(conn, "subtask", subtaskData);

            // Fetch created subtask with service name if applicable
            const [createdRow] = await conn.query(
                `SELECT s.*, sv.name as service_name
                 FROM subtask s
                 LEFT JOIN services sv ON sv.service_id = s.service_id
                 WHERE s.subtask_id = ?`,
                [subtask_id]
            );

            if (createdRow?.length) {
                createdSubtasks.push({
                    subtask_id: createdRow[0].subtask_id,
                    task_id: createdRow[0].task_id,
                    type: createdRow[0].type === "task" ? "service" : "text",
                    text: createdRow[0].text,
                    service: createdRow[0].type === "task" ? {
                        service_id: createdRow[0].service_id,
                        name: createdRow[0].service_name
                    } : null,
                    status: createdRow[0].status,
                    create_date: createdRow[0].create_date
                });
            }
        }

        await conn.commit();
        conn.release();

        return res.status(200).json({
            success: true,
            message: "Subtasks created successfully",
            data: {
                task_id,
                subtasks: createdSubtasks,
                count: createdSubtasks.length
            }
        });

    } catch (error) {
        try { await conn.rollback(); } catch { }
        conn.release();
        console.error("Create subtask error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create subtasks",
            error: error.message
        });
    }
});

// subtask.status — DB enum `pending` | `complete` | `cancel` (database-context.json)
router.put("/details/subtask/status", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || "";
        const { task_id, subtask_id, status } = req.body || {};

        if (!task_id || String(task_id).trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "task_id is required" });
        }
        if (!subtask_id || String(subtask_id).trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "subtask_id is required" });
        }
        if (status == null || String(status).trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "status is required" });
        }

        const statusNorm = String(status).trim().toLowerCase();
        if (!SUBTASK_STATUS_VALUES.includes(statusNorm)) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: `status must be one of: ${SUBTASK_STATUS_VALUES.join(", ")}`
            });
        }

        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT s.status AS subtask_status, s.subtask_id, s.task_id, s.type, s.text, s.service_id,
                    t.status AS task_status
             FROM subtask s
             INNER JOIN tasks t ON t.task_id = s.task_id AND t.branch_id = s.branch_id
             WHERE s.subtask_id = ? AND s.task_id = ? AND s.branch_id = ?
             AND (s.is_deleted = '0' OR s.is_deleted = 0)
             LIMIT 1`,
            [String(subtask_id).trim(), String(task_id).trim(), branch_id]
        );

        if (!rows?.length) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subtask not found or does not belong to this branch"
            });
        }

        const row = rows[0];
        const current = String(row.subtask_status ?? "").toLowerCase();
        if (current === statusNorm) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "New status is the same as the current subtask status"
            });
        }

        if (String(row.task_status ?? "").toLowerCase() === "complete") {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Cannot change subtask status when the main task is complete"
            });
        }

        await conn.query(
            `UPDATE subtask SET status = ?, modify_by = ?, modify_date = NOW()
             WHERE subtask_id = ? AND task_id = ? AND branch_id = ?
             AND (is_deleted = '0' OR is_deleted = 0)`,
            [statusNorm, username, String(subtask_id).trim(), String(task_id).trim(), branch_id]
        );

        const [updated] = await conn.query(
            `SELECT s.*, sv.name AS service_name
             FROM subtask s
             LEFT JOIN services sv ON sv.service_id = s.service_id
             WHERE s.subtask_id = ?`,
            [String(subtask_id).trim()]
        );

        await conn.commit();
        conn.release();

        const el = updated[0];
        return res.status(200).json({
            success: true,
            message: "Subtask status updated successfully",
            data: {
                task_id: el.task_id,
                subtask_id: el.subtask_id,
                type: el.type === "task" ? "service" : "text",
                text: el.text,
                service:
                    el.type === "task"
                        ? { service_id: el.service_id, name: el.service_name }
                        : null,
                status: el.status
            }
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch {
            /* ignore */
        }
        conn.release();
        console.error("Update subtask status error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update subtask status",
            error: error.message
        });
    }
});

// subtask.type — DB enum `text` | `service` (database-context.json)
router.put("/details/subtask/update", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || "";
        const body = req.body || {};
        const { task_id, subtask_id, subtasks = [] } = body;

        if (!task_id || String(task_id).trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "task_id is required" });
        }
        if (!subtask_id || String(subtask_id).trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "subtask_id is required" });
        }
        if (!Array.isArray(subtasks) || subtasks.length !== 1) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "subtasks must be an array containing exactly one subtask object"
            });
        }

        const st = subtasks[0] || {};
        if (st.status != null && String(st.status).trim() !== "") {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "status cannot be updated here; use PUT /details/subtask/status"
            });
        }

        if (!st.type || !["text", "service"].includes(st.type)) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "subtasks[0].type must be either 'text' or 'service'"
            });
        }

        if (st.type === "text") {
            if (!st.text || String(st.text).trim() === "") {
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: "subtasks[0].text is required for type 'text'"
                });
            }
        }

        if (st.type === "service") {
            if (!st.service_id || String(st.service_id).trim() === "") {
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: "subtasks[0].service_id is required for type 'service'"
                });
            }
        }

        await conn.beginTransaction();

        const [taskRows] = await conn.query(
            "SELECT task_id FROM tasks WHERE task_id = ? AND branch_id = ? LIMIT 1",
            [String(task_id).trim(), branch_id]
        );
        if (!taskRows?.length) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Task not found or does not belong to this branch"
            });
        }

        const [subRows] = await conn.query(
            `SELECT subtask_id FROM subtask
             WHERE subtask_id = ? AND task_id = ? AND branch_id = ?
             AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [String(subtask_id).trim(), String(task_id).trim(), branch_id]
        );
        if (!subRows?.length) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subtask not found or does not belong to this branch"
            });
        }

        const dbType = st.type === "service" ? "task" : "text";
        let textVal;
        let serviceIdVal;

        if (dbType === "text") {
            textVal = String(st.text).trim();
            serviceIdVal = null;
        } else {
            const [serviceRows] = await conn.query(
                `SELECT service_id FROM branch_services
                 WHERE service_id = ? AND branch_id = ? AND is_deleted = '0'
                 LIMIT 1`,
                [String(st.service_id).trim(), branch_id]
            );
            if (!serviceRows?.length) {
                await conn.rollback();
                conn.release();
                return res.status(404).json({
                    success: false,
                    message: "service_id not found in this branch"
                });
            }
            textVal = null;
            serviceIdVal = String(st.service_id).trim();
        }

        await conn.query(
            `UPDATE subtask SET type = ?, text = ?, service_id = ?, modify_by = ?, modify_date = NOW()
             WHERE subtask_id = ? AND task_id = ? AND branch_id = ?
             AND (is_deleted = '0' OR is_deleted = 0)`,
            [
                dbType,
                textVal,
                serviceIdVal,
                username,
                String(subtask_id).trim(),
                String(task_id).trim(),
                branch_id
            ]
        );

        const [createdRow] = await conn.query(
            `SELECT s.*, sv.name AS service_name
             FROM subtask s
             LEFT JOIN services sv ON sv.service_id = s.service_id
             WHERE s.subtask_id = ?`,
            [String(subtask_id).trim()]
        );

        await conn.commit();
        conn.release();

        if (!createdRow?.length) {
            return res.status(500).json({
                success: false,
                message: "Subtask updated but could not be reloaded"
            });
        }

        const el = createdRow[0];
        return res.status(200).json({
            success: true,
            message: "Subtask updated successfully",
            data: {
                task_id: el.task_id,
                subtask_id: el.subtask_id,
                subtasks: [
                    {
                        type: el.type === "task" ? "service" : "text",
                        text: el.text,
                        service:
                            el.type === "task"
                                ? { service_id: el.service_id, name: el.service_name }
                                : null,
                        status: el.status,
                        create_date: el.create_date
                    }
                ]
            }
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch {
            /* ignore */
        }
        conn.release();
        console.error("Update subtask error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update subtask",
            error: error.message
        });
    }
});

// View single task subtask list
router.get("/details/subtask/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            task_id,
            page_no = 1,
            limit = 20,
            type,
            status,
            search
        } = req.query || {};

        // Validate task_id
        if (!task_id || String(task_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "task_id is required"
            });
        }

        // Verify task exists
        const [taskCheck] = await pool.query(
            "SELECT task_id FROM tasks WHERE task_id = ? AND branch_id = ? LIMIT 1",
            [task_id, branch_id]
        );

        if (taskCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Task not found or does not belong to this branch"
            });
        }

        // Pagination
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        // Build query
        let baseQuery = `
            FROM subtask s
            LEFT JOIN services sv ON sv.service_id = s.service_id
            WHERE s.branch_id = ? 
            AND s.task_id = ?
            AND (s.is_deleted = '0' OR s.is_deleted = 0)
        `;

        const params = [branch_id, task_id];

        // Add filters
        if (type && String(type).trim() !== "") {
            const typeValue = type === "service" ? "task" : type;
            if (["text", "task"].includes(typeValue)) {
                baseQuery += " AND s.type = ?";
                params.push(typeValue);
            }
        }

        if (status && String(status).trim() !== "") {
            const validStatuses = ["pending", "in process", "complete", "hold", "cancelled"];
            if (validStatuses.includes(status)) {
                baseQuery += " AND s.status = ?";
                params.push(status);
            }
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
                AND (
                    s.text LIKE ?
                    OR sv.name LIKE ?
                )
            `;
            params.push(searchPattern, searchPattern);
        }

        // Get total count
        const countQuery = `SELECT COUNT(*) as total ${baseQuery}`;
        const [countRows] = await pool.query(countQuery, params);
        const total = countRows[0]?.total || 0;

        // Get paginated results
        const listQuery = `
            SELECT 
                s.subtask_id,
                s.task_id,
                s.type,
                s.text,
                s.service_id,
                s.status,
                s.create_date,
                s.create_by,
                s.modify_date,
                s.modify_by,
                sv.name as service_name
            ${baseQuery}
            ORDER BY s.create_date DESC, s.id DESC
            LIMIT ? OFFSET ?
        `;

        const listParams = [...params, limitNum, offset];
        const [rows] = await pool.query(listQuery, listParams);

        // Process results
        const subtasks = [];
        for (const element of rows) {
            const create_by = await USER_SNIPPED_DATA(element?.create_by);
            const modify_by = await USER_SNIPPED_DATA(element?.modify_by || element?.create_by);

            subtasks.push({
                subtask_id: element.subtask_id,
                task_id: element.task_id,
                type: element.type === "task" ? "service" : "text",
                content: element.type === "text" ? element.text : null,
                service: element.type === "task" ? {
                    service_id: element.service_id,
                    name: element.service_name
                } : null,
                status: element.status,
                dates: {
                    create_date: element.create_date,
                    modify_date: element.modify_date
                },
                created_by: create_by,
                modified_by: modify_by
            });
        }

        return res.status(200).json({
            success: true,
            message: "Subtasks retrieved successfully",
            data: subtasks,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error("List subtasks error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch subtasks",
            error: error.message
        });
    }
});

// Create single task staff assignment
router.put("/details/staff/update", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const username = req.headers["username"] || "";
        const branch_id = req.branch_id;
        const { task_id, staff_ids = [] } = req.body;

        if (!task_id) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "task_id is required"
            });
        }

        if (!Array.isArray(staff_ids)) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "staff_ids must be an array"
            });
        }

        await conn.beginTransaction();

        // Check if task exists
        const [taskRows] = await conn.query(
            "SELECT task_id FROM tasks WHERE task_id = ? AND branch_id = ?",
            [task_id, branch_id]
        );

        if (taskRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        // Soft delete all existing staff assignments for this task
        await conn.query(
            "UPDATE task_staffs SET is_deleted = '1' WHERE task_id = ? AND branch_id = ?",
            [task_id, branch_id]
        );

        const created = [];
        for (const staffId of staff_ids) {
            if (!staffId) continue;

            const assign_id = await UNIQUE_RANDOM_STRING("task_staffs", "assign_id", { length: ID_LENGTH, conn });
            await conn.query(
                `INSERT INTO task_staffs (branch_id, assign_id, task_id, username, create_by, is_deleted) 
                 VALUES (?, ?, ?, ?, ?, '0')`,
                [branch_id, assign_id, task_id, String(staffId), username]
            );

            created.push({
                assign_id,
                task_id,
                username: staffId
            });
        }

        await conn.commit();
        conn.release();

        return res.status(200).json({
            success: true,
            message: "Task staff assigned successfully",
            data: created,
            count: created.length
        });

    } catch (error) {
        await conn.rollback();
        conn.release();
        console.error("Task staff create error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to assign staff",
            error: error.message
        });
    }
});

// View single task staff assignment list
router.get("/details/staff/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            task_id,
            username,
            designation,  // Add designation filter parameter
            page_no = 1,
            limit = 20
        } = req.query;

        let baseQuery = `
            FROM task_staffs ts
            INNER JOIN branch_mapping bm ON ts.username = bm.username 
                AND bm.branch_id = ts.branch_id 
                AND bm.type = 'staff' 
                AND bm.is_deleted = '0'
            WHERE ts.branch_id = ? 
            AND (ts.is_deleted = '0' OR ts.is_deleted = 0)
        `;

        const params = [branch_id];

        if (task_id) {
            baseQuery += " AND ts.task_id = ?";
            params.push(task_id);
        }

        if (username) {
            baseQuery += " AND ts.username = ?";
            params.push(username);
        }

        // Add designation filter if provided
        if (designation && designation.trim() !== '') {
            baseQuery += " AND bm.designation LIKE ?";
            params.push(`%${designation.trim()}%`);
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const [countRows] = await pool.query(
            `SELECT COUNT(*) as total ${baseQuery}`,
            params
        );
        const total = countRows[0]?.total || 0;

        const [rows] = await pool.query(
            `SELECT 
                ts.assign_id,
                ts.task_id,
                ts.username,
                ts.create_date,
                ts.create_by,
                ts.modify_date,
                ts.modify_by,
                bm.designation,  -- Include designation from branch_mapping
                bm.status AS bm_status,
                bm.is_accepted
            ${baseQuery}
            ORDER BY ts.id DESC
            LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const list = [];
        for (const element of rows) {
            const staff_data = await USER_SNIPPED_DATA(element?.username);
            const create_by = await USER_SNIPPED_DATA(element?.create_by);

            list.push({
                assign_id: element.assign_id,
                task_id: element.task_id,
                staff: {
                    username: element.username,
                    profile: staff_data,
                    designation: element.designation,  // Add designation to response
                    branch_status: element.bm_status === "1",  // Optional: include branch mapping status
                    is_accepted: element.is_accepted === "1"   // Optional: include acceptance status
                },
                create_date: element.create_date,
                create_by,
                modify_date: element.modify_date,
                modify_by: element.modify_by ? await USER_SNIPPED_DATA(element.modify_by) : null
            });
        }

        // Calculate designation statistics if needed
        const designationStats = {};
        list.forEach(item => {
            const desig = item.staff.designation || 'unspecified';
            designationStats[desig] = (designationStats[desig] || 0) + 1;
        });

        return res.status(200).json({
            success: true,
            message: "Task staff list retrieved successfully",
            data: list,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            },
            filters: {
                applied: {
                    task_id: task_id || null,
                    username: username || null,
                    designation: designation || null
                },
                designation_stats: designationStats  // Optional: show breakdown by designation
            }
        });

    } catch (error) {
        console.error("Task staff list error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task staff list",
            error: error.message
        });
    }
});


// Create single task timelog
router.post("/details/timelog/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const username = req.headers["username"] || "";
        const branch_id = req.branch_id;

        const { task_id, work_name, start_datetime, end_datetime } = req.body;

        // Validation
        if (!task_id || !work_name || !start_datetime || !end_datetime) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "task_id, work_name, start_datetime, end_datetime are required"
            });
        }

        const startDate = new Date(start_datetime);
        const endDate = new Date(end_datetime);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Invalid datetime format. Use YYYY-MM-DD HH:MM:SS"
            });
        }

        if (endDate <= startDate) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "end_datetime must be after start_datetime"
            });
        }

        await conn.beginTransaction();

        // Check if task exists
        const [taskRows] = await conn.query(
            `SELECT task_id FROM tasks WHERE task_id = ? AND branch_id = ? LIMIT 1`,
            [task_id, branch_id]
        );

        if (taskRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        // Calculate total seconds
        const total_seconds = calculateTotalSeconds(start_datetime, end_datetime);

        // Create timelog
        const timelog_id = await UNIQUE_RANDOM_STRING("timelogs", "timelog_id", { length: ID_LENGTH, conn });

        await conn.query(
            `INSERT INTO timelogs 
             (timelog_id, branch_id, task_id, staff_username, work_name, start_datetime, end_datetime, total_seconds, create_by, modify_by, is_deleted) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
            [
                timelog_id,
                branch_id,
                task_id,
                username,
                String(work_name).trim(),
                start_datetime,
                end_datetime,
                total_seconds,
                username,
                username
            ]
        );

        await conn.commit();
        conn.release();

        const staff_data = await USER_SNIPPED_DATA(username);

        return res.status(200).json({
            success: true,
            message: "Timelog created successfully",
            data: {
                timelog_id: timelog_id,
                task_id: task_id,
                work_name: work_name,
                staff: {
                    username: username,
                    profile: staff_data
                },
                start_datetime: start_datetime,
                end_datetime: end_datetime,
                total_seconds: total_seconds,
                total_time_spent: `${Math.floor(total_seconds / 86400)} Days, ${Math.floor((total_seconds % 86400) / 3600)} Hours, ${Math.floor((total_seconds % 3600) / 60)} Minutes`,
                create_date: new Date().toISOString().slice(0, 19).replace('T', ' ')
            }
        });

    } catch (error) {
        await conn.rollback();
        conn.release();
        console.error("Create timelog error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create timelog",
            error: error.message
        });
    }
});


// View single task timelog list
router.get("/details/timelog/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { task_id, page_no = 1, limit = 20 } = req.query;

        // Debug log to see what's coming in
        console.log("LIST API called with:", { branch_id, task_id, page_no, limit });

        // task_id is required
        if (!task_id) {
            return res.status(400).json({
                success: false,
                message: "task_id is required"
            });
        }

        // First, let's check if any timelogs exist for this task (without pagination)
        const [checkRows] = await pool.query(
            `SELECT COUNT(*) as count FROM timelogs 
             WHERE branch_id = ? AND task_id = ? AND is_deleted = '0'`,
            [branch_id, task_id]
        );

        console.log(`Found ${checkRows[0].count} timelogs for task ${task_id}`);

        // Base query
        let baseQuery = `
            FROM timelogs 
            WHERE branch_id = ? 
            AND task_id = ?
            AND is_deleted = '0'
        `;

        const params = [branch_id, task_id];

        // Pagination
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        // Get total count
        const [countRows] = await pool.query(`SELECT COUNT(*) as total ${baseQuery}`, params);
        const total = countRows[0]?.total || 0;

        // If no records found, return empty array
        if (total === 0) {
            return res.status(200).json({
                success: true,
                message: "No timelogs found for this task",
                data: [],
                pagination: {
                    page_no: pageNum,
                    limit: limitNum,
                    total: 0,
                    total_pages: 0,
                    is_last_page: true
                }
            });
        }

        // Get paginated results
        const [rows] = await pool.query(
            `SELECT 
                id,
                timelog_id,
                task_id,
                staff_username,
                work_name,
                start_datetime,
                end_datetime,
                total_seconds,
                total_time_spent,
                create_date,
                create_by,
                modify_date,
                modify_by
            ${baseQuery}
            ORDER BY start_datetime DESC, id DESC
            LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        // Log the rows to see what's returned
        console.log(`Returning ${rows.length} timelogs`);

        // Process results
        const list = [];
        for (const element of rows) {
            const staff_data = await USER_SNIPPED_DATA(element.staff_username);
            const create_by = await USER_SNIPPED_DATA(element.create_by);
            const modify_by = element.modify_by ? await USER_SNIPPED_DATA(element.modify_by) : null;

            list.push({
                id: element.id,
                timelog_id: element.timelog_id,
                task_id: element.task_id,
                staff: {
                    username: element.staff_username,
                    profile: staff_data
                },
                work_name: element.work_name,
                start_datetime: element.start_datetime,
                end_datetime: element.end_datetime,
                total_seconds: Number(element.total_seconds),
                total_time_spent: element.total_time_spent,
                create_date: element.create_date,
                create_by: create_by,
                modify_date: element.modify_date,
                modify_by: modify_by
            });
        }

        return res.status(200).json({
            success: true,
            message: "Timelogs retrieved successfully",
            data: list,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error("List timelogs error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch timelogs",
            error: error.message
        });
    }
});

// Edit single task timelog
router.put("/details/timelog/edit/:timelog_id", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const username = req.headers["username"] || "";
        const branch_id = req.branch_id;
        const timelog_id = req.params.timelog_id;

        if (!timelog_id) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "timelog_id is required"
            });
        }

        const { work_name, start_datetime, end_datetime } = req.body;

        if (work_name === undefined && start_datetime === undefined && end_datetime === undefined) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No fields to update"
            });
        }

        await conn.beginTransaction();

        const [existingRows] = await conn.query(
            `SELECT * FROM timelogs WHERE timelog_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [timelog_id, branch_id]
        );

        if (existingRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Timelog not found"
            });
        }

        const existing = existingRows[0];
        const updateFields = [];
        const updateValues = [];

        let finalStart = existing.start_datetime;
        let finalEnd = existing.end_datetime;

        if (work_name !== undefined) {
            if (!work_name.trim()) {
                await conn.rollback();
                conn.release();
                return res.status(400).json({ success: false, message: "work_name cannot be empty" });
            }
            updateFields.push("work_name = ?");
            updateValues.push(work_name.trim());
        }

        if (start_datetime !== undefined) {
            const startDate = new Date(start_datetime);
            if (isNaN(startDate.getTime())) {
                await conn.rollback();
                conn.release();
                return res.status(400).json({ success: false, message: "Invalid start_datetime" });
            }
            finalStart = start_datetime;
            updateFields.push("start_datetime = ?");
            updateValues.push(start_datetime);
        }

        if (end_datetime !== undefined) {
            const endDate = new Date(end_datetime);
            if (isNaN(endDate.getTime())) {
                await conn.rollback();
                conn.release();
                return res.status(400).json({ success: false, message: "Invalid end_datetime" });
            }
            finalEnd = end_datetime;
            updateFields.push("end_datetime = ?");
            updateValues.push(end_datetime);
        }

        if (new Date(finalEnd) <= new Date(finalStart)) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({ success: false, message: "end_datetime must be after start_datetime" });
        }

        if (start_datetime !== undefined || end_datetime !== undefined) {
            const total_seconds = calculateTotalSeconds(finalStart, finalEnd);
            updateFields.push("total_seconds = ?");
            updateValues.push(total_seconds);
        }

        updateFields.push("modify_by = ?, modify_date = NOW()");
        updateValues.push(username);

        await conn.query(
            `UPDATE timelogs SET ${updateFields.join(", ")} WHERE timelog_id = ? AND branch_id = ?`,
            [...updateValues, timelog_id, branch_id]
        );

        await conn.commit();
        conn.release();

        const [updated] = await pool.query(`SELECT * FROM timelogs WHERE timelog_id = ?`, [timelog_id]);
        const staff_data = await USER_SNIPPED_DATA(updated[0].staff_username);

        return res.status(200).json({
            success: true,
            message: "Timelog updated successfully",
            data: {
                timelog_id: updated[0].timelog_id,
                task_id: updated[0].task_id,
                work_name: updated[0].work_name,
                staff: { username: updated[0].staff_username, profile: staff_data },
                start_datetime: updated[0].start_datetime,
                end_datetime: updated[0].end_datetime,
                total_seconds: updated[0].total_seconds,
                total_time_spent: updated[0].total_time_spent,
                create_date: updated[0].create_date,
                modify_date: updated[0].modify_date
            }
        });

    } catch (error) {
        await conn.rollback();
        conn.release();
        console.error("Edit timelog error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update timelog",
            error: error.message
        });
    }
});


// Bulk change task status
router.put("/change-status", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const { task_ids, status, cancel_reason } = req.body || {};

        if (!Array.isArray(task_ids) || task_ids.length === 0) {
            conn.release();
            return res.status(400).json({ success: false, message: "task_ids must be a non-empty array" });
        }

        if (status == null || String(status).trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "status is required" });
        }

        const statusVal = String(status).trim();
        if (!TASK_STATUS_ENUM.includes(statusVal)) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: `status must be one of: ${TASK_STATUS_ENUM.join(", ")}`
            });
        }

        const ids = [...new Set(task_ids.map((id) => String(id).trim()).filter(Boolean))];
        if (ids.length === 0) {
            conn.release();
            return res.status(400).json({ success: false, message: "task_ids must contain valid task ids" });
        }

        await conn.beginTransaction();

        const placeholders = ids.map(() => "?").join(",");
        const [rows] = await conn.query(
            `SELECT task_id, status FROM tasks WHERE branch_id = ? AND task_id IN (${placeholders})`,
            [branch_id, ...ids]
        );

        const found = new Set((rows || []).map((r) => String(r.task_id)));
        const notFound = ids.filter((id) => !found.has(id));
        if (notFound.length > 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "One or more tasks not found for this branch",
                not_found_task_ids: notFound
            });
        }

        const alreadyComplete = (rows || []).filter((r) => r.status === "complete").map((r) => r.task_id);
        if (alreadyComplete.length > 0) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Cannot change status of tasks that are already complete",
                blocked_task_ids: alreadyComplete
            });
        }

        let targetIds = ids;
        let blockedBySubtasks = [];

        if (statusVal === "complete") {
            blockedBySubtasks = await findTasksWithIncompleteSubtasks(conn, branch_id, ids);
            const blockedTaskIdSet = new Set(blockedBySubtasks.map((row) => String(row.task_id)));
            targetIds = ids.filter((id) => !blockedTaskIdSet.has(String(id)));

            if (targetIds.length === 0) {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: "Cannot mark task(s) as complete until all subtasks are complete or canceled",
                    blocked_task_ids: ids,
                    subtask_blockers: blockedBySubtasks
                });
            }
        }

        const targetPlaceholders = targetIds.map(() => "?").join(",");
        const changedTaskIds = (rows || [])
            .filter((r) => targetIds.includes(String(r.task_id)) && r.status !== statusVal)
            .map((r) => r.task_id);

        if (statusVal === "complete") {
            await conn.query(
                `UPDATE tasks SET status = ?, complete_date = ?, complete_by = ? WHERE branch_id = ? AND task_id IN (${targetPlaceholders})`,
                [statusVal, new Date(), username || null, branch_id, ...targetIds]
            );

            for (const taskId of targetIds) {
                try {
                    notifyTaskCompletedEmail({
                        branch_id: branch_id,
                        task_id: taskId,
                        completed_by: username || "system"
                    });
                    notifyTaskCompletedWhatsapp({
                        branch_id,
                        task_id: taskId,
                        completed_by: username || "system",
                    });
                } catch (emailError) {
                    console.error(`Failed to send completion notification for task ${taskId}:`, emailError);
                }
            }
        } else if (statusVal === "cancel") {
            await conn.query(
                `UPDATE tasks SET status = ?, cancelled_date = ?, cancelled_by = ? WHERE branch_id = ? AND task_id IN (${targetPlaceholders})`,
                [statusVal, new Date(), username || null, branch_id, ...targetIds]
            );

            for (const taskId of targetIds) {
                try {
                    await notifyTaskCanceledEmail({
                        branch_id: branch_id,
                        task_id: taskId,
                        cancelled_by: username || "system",
                        cancel_reason: cancel_reason || null
                    });
                } catch (emailError) {
                    console.error(`Failed to send cancellation email for task ${taskId}:`, emailError);
                }
            }
        } else {
            await conn.query(
                `UPDATE tasks SET status = ? WHERE branch_id = ? AND task_id IN (${targetPlaceholders})`,
                [statusVal, branch_id, ...targetIds]
            );
        }

        // Store new status in history for tasks that actually changed
        if (changedTaskIds.length > 0) {
            for (const id of changedTaskIds) {
                await conn.query(
                    "INSERT INTO task_status (branch_id, task_id, create_by, status) VALUES (?, ?, ?, ?)",
                    [branch_id, id, username, statusVal]
                );
            }
        }

        await conn.commit();
        conn.release();

        const blockedTaskIds = blockedBySubtasks.map((row) => String(row.task_id));
        const successMessage = blockedTaskIds.length > 0
            ? `${targetIds.length} task(s) updated. ${blockedTaskIds.length} task(s) could not be completed because subtasks are still pending.`
            : "Task status updated successfully";

        return res.status(200).json({
            success: true,
            message: successMessage,
            data: {
                task_ids: targetIds,
                status: statusVal,
                ...(blockedTaskIds.length > 0
                    ? { blocked_task_ids: blockedTaskIds, subtask_blockers: blockedBySubtasks }
                    : {})
            }
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch {
            /* ignore */
        }
        conn.release();
        console.error("Change status error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to change status",
            error: error.message
        });
    }
});

// Create task documents
router.post("/details/document/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    const branch_id = req.branch_id;
    const createdBy = req.headers["username"] || "";
    const { task_id = "", documents = [] } = req.body || {};

    let savedFiles = [];

    try {
        if (!task_id || typeof task_id !== "string" || task_id.trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "task_id is required" });
        }
        if (!Array.isArray(documents) || documents.length === 0) {
            conn.release();
            return res.status(400).json({ success: false, message: "documents array is required and must not be empty" });
        }

        // Validate task exists and fetch firm_id + username
        const [taskRows] = await conn.query(
            "SELECT firm_id, username FROM tasks WHERE task_id = ? AND branch_id = ? LIMIT 1",
            [task_id.trim(), branch_id]
        );

        if (!taskRows || taskRows.length === 0) {
            conn.release();
            return res.status(404).json({ success: false, message: "Task not found" });
        }

        const taskRow = taskRows[0];
        const firm_id = taskRow?.firm_id;
        const username = taskRow?.username || "";

        if (!firm_id) {
            conn.release();
            return res.status(400).json({ success: false, message: "Task firm_id not found" });
        }

        await conn.beginTransaction();

        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i] || {};
            const url = doc?.url;
            const name = doc?.name ?? null;
            const remark = doc?.remark ?? null;

            if (!url || typeof url !== "string" || url.trim() === "") {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Document at index ${i} is missing a valid url`
                });
            }

            let result;
            try {
                result = await downloadAndUploadProfileDocument(url.trim(), TASK_DOCUMENT_CATEGORY);
            } catch (downloadErr) {
                await conn.rollback();
                for (const f of savedFiles) {
                    try { await deleteProfileDocument(TASK_DOCUMENT_CATEGORY, f); } catch (_) { }
                }
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Failed to download document at index ${i}: ${downloadErr.message}`
                });
            }

            savedFiles.push(result.filename);

            const document_id = await UNIQUE_RANDOM_STRING("documents", "document_id", { length: ID_LENGTH, conn });

            await conn.query(
                `INSERT INTO documents (
                    document_id, branch_id, firm_id, username, category_id, name, f_year, type, remark, month,
                    task_id, is_reserved, file, size, mime_type, created_by, create_date, modify_by, modify_date, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "1", ?, ?, ?, ?, NOW(), ?, NOW(), '0')`,
                [
                    document_id,
                    branch_id,
                    firm_id,
                    username,
                    "TASK",
                    name,
                    null,
                    "file",
                    remark,
                    null,
                    task_id.trim(),
                    result.filename,
                    result.size,
                    result.mimeType,
                    createdBy,
                    createdBy
                ]
            );
        }

        await conn.commit();
        conn.release();

        return res.status(200).json({
            success: true,
            message: "Task documents created successfully",
            data: { task_id: task_id.trim(), count: documents.length }
        });
    } catch (error) {
        try { await conn.rollback(); } catch { }
        for (const f of savedFiles) {
            try { await deleteProfileDocument(TASK_DOCUMENT_CATEGORY, f); } catch (_) { }
        }
        conn.release();
        console.error("Task documents create error:", error);
        return res.status(500).json({ success: false, message: "Failed to create task documents", error: error.message });
    }
});

router.get("/details/document/list", auth, validateBranch, async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const branch_id = req.branch_id;
        const { task_id = "", page_no = 1, limit = 20, search = "" } = req.query || {};

        if (!task_id || typeof task_id !== "string" || task_id.trim() === "") {
            conn.release();
            return res.status(400).json({ success: false, message: "task_id is required" });
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const searchRaw = typeof search === "string" ? search : String(search ?? "");
        const searchTerm = searchRaw.trim();
        const searchClause =
            searchTerm.length > 0 ? " AND (name LIKE ? OR remark LIKE ?)" : "";
        const searchPattern = searchTerm.length > 0 ? `%${searchTerm}%` : null;

        const whereParams = [branch_id, task_id.trim()];
        if (searchPattern !== null) {
            whereParams.push(searchPattern, searchPattern);
        }

        const [totalRows] = await conn.query(
            `SELECT COUNT(*) AS total FROM documents WHERE branch_id = ? AND task_id = ? AND category_id = 'TASK' AND is_reserved = '1' AND is_deleted = '0'${searchClause}`,
            whereParams
        );

        const [rows] = await conn.query(
            `SELECT * FROM documents WHERE branch_id = ? AND task_id = ? AND category_id = 'TASK' AND is_reserved = '1' AND is_deleted = '0'${searchClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...whereParams, limitNum, offset]
        );

        const list = [];

        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];
            const create_by_snipped_data = await USER_SNIPPED_DATA(element.created_by);
            const modify_by_snipped_data = await USER_SNIPPED_DATA(element.modify_by || element.create_by);
            list.push({
                document_id: element.document_id,
                branch_id: element.branch_id,
                firm_id: element.firm_id,
                name: element.name,
                remark: element.remark,
                file: element.file
                    ? await getProfileDocumentAccessUrl(TASK_DOCUMENT_CATEGORY, element.file)
                    : null,
                size: element.size,
                mime_type: element.mime_type,
                create_date: element.create_date,
                create_by: create_by_snipped_data,
                modify_by: modify_by_snipped_data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Task documents retrieved successfully",
            data: list,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total: totalRows[0].total,
                total_pages: Math.ceil(totalRows[0].total / limitNum),
                is_last_page: offset + list.length >= totalRows[0].total
            }
        });
    } catch (error) {
        console.error("Error retrieving task documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve task documents",
            error: error.message
        });
    } finally {
        if (conn) conn.release();
    }
});

router.delete("/details/document/delete", auth, validateBranch, async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || req.headers["Username"] || "";
        // Allow both body and query for DELETE; prefer body for array support.
        const { document_ids } = req.body || {};

        if (!Array.isArray(document_ids) || document_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "document_ids must be a non-empty array"
            });
        }

        const ids = [...new Set(document_ids.map((id) => String(id).trim()).filter(Boolean))];
        if (ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "document_ids must contain valid document ids"
            });
        }

        const placeholders = ids.map(() => "?").join(",");

        const [rows] = await conn.query(
            `SELECT document_id, file FROM documents WHERE branch_id = ? AND document_id IN (${placeholders})
             AND category_id = 'TASK' AND is_reserved = '1' AND is_deleted = '0'`,
            [branch_id, ...ids]
        );

        const foundRows = rows || [];
        const foundIds = new Set(foundRows.map((r) => String(r.document_id)));
        const notFound = ids.filter((id) => !foundIds.has(id));
        if (notFound.length > 0) {
            return res.status(404).json({
                success: false,
                message: "One or more task documents not found for this branch",
                not_found_document_ids: notFound
            });
        }

        const orderedIds = ids.filter((id) => foundIds.has(id));

        await conn.beginTransaction();
        await conn.query(
            `UPDATE documents SET is_deleted = '1', modify_by = ?, modify_date = NOW()
             WHERE branch_id = ? AND document_id IN (${placeholders})
             AND category_id = 'TASK' AND is_reserved = '1' AND is_deleted = '0'`,
            [modifyBy, branch_id, ...orderedIds]
        );
        await conn.commit();

        for (const row of foundRows) {
            if (row.file) {
                try {
                    await deleteProfileDocument(TASK_DOCUMENT_CATEGORY, String(row.file));
                } catch {
                    /* file may already be missing */
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "Task documents deleted successfully",
            data: { document_ids: orderedIds, deleted_count: orderedIds.length }
        });
    } catch (error) {
        try {
            await conn?.rollback();
        } catch {
            /* ignore */
        }
        console.error("Error deleting task documents:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete task documents",
            error: error.message
        });
    } finally {
        if (conn) conn.release();
    }
});
/**
 * Get tasks filtered by service_id and status with firm and client details
 * GET /api/email/tasks/filter
 */
router.get("/tasks/filter", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            service_id,
            status = null,
            billing_status = null,
            search = ''
        } = req.query;

        // Validation
        if (!service_id || service_id.trim() === '') {
            return res.status(400).json({
                success: false,
                message: "service_id is required"
            });
        }

        // Parse status filter - accept both display formats and database formats
        let statusList = [];
        if (status && status !== 'all') {
            const statusStrings = String(status).split(',').map(s => s.trim()).filter(s => s);

            // Map display status to database status
            const statusMapping = {
                'complete': 'complete',
                'completed': 'complete',
                'cancel': 'cancel',
                'cancelled': 'cancel',
                'canceled': 'cancel',
                'in process': 'in process',
                'in_process': 'in process',
                'inprogress': 'in process',
                'pending from client': 'pending from client',
                'pending_client': 'pending from client',
                'pending from department': 'pending from department',
                'pending_department': 'pending from department'
            };

            statusList = statusStrings.map(s => {
                const lowerS = s.toLowerCase();
                return statusMapping[lowerS] || lowerS;
            }).filter(s => s);
        }

        // Build the SQL query with LEFT JOIN to ensure we get tasks even if firm/profile data is missing
        let sql = `
            SELECT 
                t.task_id,
                t.firm_id,
                t.service_id,
                t.fees,
                t.tax_rate,
                t.tax_value,
                t.total,
                t.due_date,
                t.target_date,
                t.billing_status,
                t.status as task_status,
                t.create_date as task_create_date,
                t.complete_date,
                t.cancelled_date,
                t.is_recurring,
                
                f.firm_name,
                f.firm_type,
                f.gst_no,
                f.pan_no,
                f.tan_no,
                f.cin_no,
                f.file_no,
                f.address_line_1 as firm_address_line1,
                f.address_line_2 as firm_address_line2,
                f.city as firm_city,
                f.district as firm_district,
                f.state as firm_state,
                f.country as firm_country,
                f.pincode as firm_pincode,
                
                p.username,
                p.name as client_name,
                p.email as client_email,
                p.mobile as client_mobile,
                p.country_code as client_country_code,
                p.pan_number as client_pan,
                p.gender as client_gender,
                p.date_of_birth as client_dob,
                p.user_type as client_user_type,
                p.address_line_1 as client_address,
                p.city as client_city,
                p.state as client_state,
                p.pincode as client_pincode,
                p.image as client_image,
                p.create_date as client_create_date,
                p.status as profile_status
                
            FROM tasks t
            LEFT JOIN firms f ON f.firm_id = t.firm_id AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN profile p ON p.username = f.username
            WHERE t.branch_id = ? 
              AND t.service_id = ?
        `;

        let params = [branch_id, service_id];

        // Add status filter
        if (statusList.length > 0) {
            const placeholders = statusList.map(() => '?').join(',');
            sql += ` AND LOWER(t.status) IN (${placeholders})`;
            params.push(...statusList);
        }

        // Add billing status filter
        if (billing_status && billing_status !== 'all' && billing_status !== '') {
            const billingValue = parseInt(billing_status);
            if (!isNaN(billingValue) && [0, 1, 2].includes(billingValue)) {
                sql += ` AND t.billing_status = ?`;
                params.push(billingValue.toString());
            }
        }

        // Add search filter
        if (search && search.trim() !== '') {
            const searchPattern = `%${search.trim()}%`;
            sql += ` AND (f.firm_name LIKE ? OR p.name LIKE ? OR p.email LIKE ? OR t.task_id LIKE ?)`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        sql += ` ORDER BY t.create_date DESC, t.id DESC`;

        console.log("Executing SQL:", sql);
        console.log("Params:", params);

        const [rows] = await pool.query(sql, params);
        console.log(`Found ${rows.length} tasks`);

        // Helper function to format status for display
        function formatStatus(status) {
            if (!status) return 'Unknown';

            const statusMap = {
                'complete': 'Complete',
                'cancel': 'Canceled',
                'in process': 'In Process',
                'pending from client': 'Pending from Client',
                'pending from department': 'Pending from Department'
            };

            return statusMap[status.toLowerCase()] || status;
        }

        // Format results - Group by status
        const tasksByStatus = {};
        const tasks = [];

        for (const row of rows) {
            const formattedStatus = formatStatus(row.task_status);

            const taskData = {
                task_id: row.task_id,
                service_id: row.service_id,
                status: formattedStatus,  // Return formatted status
                status_raw: row.task_status,  // Also return raw status if needed
                financials: {
                    fees: Number(row.fees) || 0,
                    tax_rate: Number(row.tax_rate) || 0,
                    tax_value: Number(row.tax_value) || 0,
                    total: Number(row.total) || 0
                },
                dates: {
                    due_date: row.due_date,
                    target_date: row.target_date,
                    created_at: row.task_create_date,
                    completed_at: row.complete_date,
                    cancelled_at: row.cancelled_date
                },
                billing_status: row.billing_status == '0' ? 'pending' : (row.billing_status == '1' ? 'completed' : 'non_billable'),
                is_recurring: row.is_recurring == '1',
                firm: row.firm_name ? {
                    firm_id: row.firm_id,
                    firm_name: row.firm_name,
                    firm_type: row.firm_type,
                    tax_details: {
                        gst_no: row.gst_no,
                        pan_no: row.pan_no,
                        tan_no: row.tan_no,
                        cin_no: row.cin_no
                    },
                    file_no: row.file_no,
                    address: {
                        line1: row.firm_address_line1,
                        line2: row.firm_address_line2,
                        city: row.firm_city,
                        district: row.firm_district,
                        state: row.firm_state,
                        country: row.firm_country,
                        pincode: row.firm_pincode
                    }
                } : null,
                client: row.username ? {
                    username: row.username,
                    name: row.client_name,
                    email: row.client_email,
                    mobile: row.client_mobile,
                    country_code: row.client_country_code,
                    pan_number: row.client_pan,
                    gender: row.client_gender,
                    date_of_birth: row.client_dob,
                    user_type: row.client_user_type,
                    profile_status: row.profile_status,
                    address: {
                        line1: row.client_address,
                        city: row.client_city,
                        state: row.client_state,
                        pincode: row.client_pincode
                    },
                    image: row.client_image,
                    created_at: row.client_create_date
                } : null
            };

            tasks.push(taskData);

            // Group by formatted status
            if (!tasksByStatus[formattedStatus]) {
                tasksByStatus[formattedStatus] = [];
            }
            tasksByStatus[formattedStatus].push(taskData);
        }

        // Get service details
        const [serviceDetails] = await pool.query(
            `SELECT s.name, s.sac_code, s.type, bs.fees as default_fees, bs.gst_rate
             FROM services s
             LEFT JOIN branch_services bs ON bs.service_id = s.service_id AND bs.branch_id = ? AND bs.is_deleted = '0'
             WHERE s.service_id = ?`,
            [branch_id, service_id]
        );

        // Get summary by status with formatted status keys
        const summary = {};
        for (const [statusKey, statusTasks] of Object.entries(tasksByStatus)) {
            summary[statusKey] = {
                count: statusTasks.length,
                total_revenue: statusTasks.reduce((sum, task) => sum + task.financials.total, 0),
                tasks: statusTasks
            };
        }

        // Define all possible statuses for the response
        const allStatuses = ['Complete', 'Canceled', 'In Process', 'Pending from Client', 'Pending from Department'];

        // Ensure all statuses are present in summary (even if empty)
        for (const statusName of allStatuses) {
            if (!summary[statusName]) {
                summary[statusName] = {
                    count: 0,
                    total_revenue: 0,
                    tasks: []
                };
            }
        }

        return res.status(200).json({
            success: true,
            message: "Tasks filtered successfully",
            data: {
                service: {
                    service_id: service_id,
                    name: serviceDetails[0]?.name || '',
                    sac_code: serviceDetails[0]?.sac_code || '',
                    type: serviceDetails[0]?.type || '',
                    default_fees: serviceDetails[0]?.default_fees || 0,
                    gst_rate: serviceDetails[0]?.gst_rate || 0
                },
                summary_by_status: summary,
                total_tasks: tasks.length,
                all_tasks: tasks,
                filters_applied: {
                    service_id: service_id,
                    status: statusList.length > 0 ? statusList : 'all',
                    billing_status: billing_status === 'all' ? 'all' : (billing_status || 'all'),
                    search: search || null
                }
            }
        });

    } catch (error) {
        console.error("Task filter error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch tasks",
            error: error.message
        });
    }
});

export default router;