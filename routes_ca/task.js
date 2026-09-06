import express from "express";
import pool from "../db.js";
import { validateCaSession } from "../middleware/validateCaSession.js";
import {
    getProfileDocumentAccessUrl,
    downloadAndUploadProfileDocument,
    deleteProfileDocument,
} from "../helpers/b2Storage.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";
import { notifyCaApprovalComplete } from "../helpers/caApprovalEmail.js";

const router = express.Router();

const TASK_DOCUMENT_CATEGORY = "task";
/** UDIN + new docs only while approval is sent (locked after complete). */
const CA_APPROVAL_EDITABLE = new Set(["sent"]);

const ALLOWED_STATUSES = [
    "in process",
    "pending from client",
    "pending from department",
    "complete",
    "cancel",
];

const ALLOWED_CA_APPROVALS = ["pending", "sent", "complete"];

const ALLOWED_FREQUENCIES = new Set([
    "monthly",
    "quarterly",
    "half-yearly",
    "yearly",
]);

function normalizeFrequency(frequency) {
    const key = String(frequency || "").trim().toLowerCase().replace(/_/g, "-");
    if (key === "halfyearly" || key === "half-year") return "half-yearly";
    if (key === "annual" || key === "annually") return "yearly";
    return key;
}

function parseQueryArray(value) {
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

    if (raw.startsWith("[") && raw.endsWith("]")) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return toCleanStringArray(parsed);
            }
        } catch (_) { }
    }

    return toCleanStringArray(raw.split(","));
}

function formatTaskListItem(row) {
    return {
        task_id: row.task_id,
        task_type: row.task_type || null,
        client: {
            username: row.username,
            name: row.client_name ?? null,
            profile: {
                username: row.username,
                name: row.client_name ?? null,
            },
        },
        firm: {
            firm_id: row.firm_id,
            firm_name: row.firm_name,
            pan_no: row.pan_no || null,
            file_no: row.file_no || null,
            firm_type: row.firm_type || null,
        },
        service: {
            service_id: row.service_id,
            name: row.service_name,
            type: row.service_type || null,
            frequency: row.service_frequency || null,
        },
        status: row.status,
        ca_approval: row.ca_approval || "pending",
        udin: row.udin ?? null,
        dates: {
            due_date: row.due_date,
            create_date: row.create_date,
            target_date: row.target_date,
            complete_date: row.complete_date ?? null,
            compliance_year: row.compliance_year ?? null,
            compliance_period: row.compliance_period ?? null,
        },
        complete_date: row.complete_date ?? null,
        compliance_year: row.compliance_year ?? null,
        compliance_period: row.compliance_period ?? null,
    };
}

router.get("/list", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const {
            page_no = 1,
            limit = 20,
            search,
            status,
            ca_approval,
            firm_id,
            service_id,
            service_ids,
            frequency,
            compliance_year,
            compliance_period,
        } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let statusList = parseQueryArray(status).map((item) => item.toLowerCase());
        // Explicit "all" / empty means no status filter (CA UI "All Status")
        statusList = statusList.filter((s) => s && s !== "all" && s !== "__all__");

        const invalidStatuses = statusList.filter((item) => !ALLOWED_STATUSES.includes(item));
        if (invalidStatuses.length) {
            return res.status(400).json({
                success: false,
                message: `Invalid status value(s): ${invalidStatuses.join(", ")}`,
            });
        }

        let caApprovalList = parseQueryArray(ca_approval).map((item) => item.toLowerCase());
        caApprovalList = caApprovalList.filter((s) => s && s !== "all" && s !== "__all__");
        const invalidCaApprovals = caApprovalList.filter(
            (item) => !ALLOWED_CA_APPROVALS.includes(item)
        );
        if (invalidCaApprovals.length) {
            return res.status(400).json({
                success: false,
                message: `Invalid ca_approval value(s): ${invalidCaApprovals.join(", ")}`,
            });
        }

        const serviceIdList = [
            ...parseQueryArray(service_ids),
            ...(service_id && String(service_id).trim() !== ""
                ? [String(service_id).trim()]
                : []),
        ].filter((id, index, arr) => id && arr.indexOf(id) === index);

        const frequencyNorm = normalizeFrequency(frequency);
        if (frequencyNorm && !ALLOWED_FREQUENCIES.has(frequencyNorm)) {
            return res.status(400).json({
                success: false,
                message: "frequency must be monthly, quarterly, half-yearly, or yearly",
            });
        }

        const hasComplianceYear =
            compliance_year != null && String(compliance_year).trim() !== "";
        const hasCompliancePeriod =
            compliance_period != null && String(compliance_period).trim() !== "";

        if (hasCompliancePeriod && !hasComplianceYear) {
            return res.status(400).json({
                success: false,
                message: "compliance_year is required when compliance_period is provided",
            });
        }

        let baseQuery = `
            FROM tasks t
            LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN services s
                ON s.service_id = t.service_id
            LEFT JOIN profile cp
                ON cp.username = t.username
                AND cp.id = (
                    SELECT MAX(cp2.id)
                    FROM profile cp2
                    WHERE cp2.username = t.username
                )
            WHERE t.branch_id = ?
              AND t.has_ca = '1'
              AND t.ca_id = ?
        `;

        const params = [branch_id, ca_username];

        if (statusList.length > 0) {
            const placeholders = statusList.map(() => "?").join(", ");
            baseQuery += ` AND LOWER(TRIM(t.status)) IN (${placeholders})`;
            params.push(...statusList);
        }

        if (caApprovalList.length > 0) {
            const placeholders = caApprovalList.map(() => "?").join(", ");
            baseQuery += ` AND LOWER(TRIM(COALESCE(t.ca_approval, 'pending'))) IN (${placeholders})`;
            params.push(...caApprovalList);
        }

        if (firm_id && String(firm_id).trim() !== "") {
            baseQuery += " AND t.firm_id = ?";
            params.push(String(firm_id).trim());
        }

        if (serviceIdList.length > 0) {
            const placeholders = serviceIdList.map(() => "?").join(", ");
            baseQuery += ` AND t.service_id IN (${placeholders})`;
            params.push(...serviceIdList);
        }

        if (frequencyNorm) {
            baseQuery += ` AND LOWER(s.type) = 'compliance'`;
            if (frequencyNorm === "half-yearly") {
                baseQuery += ` AND LOWER(REPLACE(TRIM(COALESCE(s.frequency, '')), '_', '-')) IN ('half-yearly', 'halfyearly')`;
            } else if (frequencyNorm === "yearly") {
                baseQuery += ` AND LOWER(REPLACE(TRIM(COALESCE(s.frequency, '')), '_', '-')) IN ('yearly', 'annual', 'annually')`;
            } else {
                baseQuery += ` AND LOWER(REPLACE(TRIM(COALESCE(s.frequency, '')), '_', '-')) = ?`;
                params.push(frequencyNorm);
            }
        }

        if (hasComplianceYear || hasCompliancePeriod) {
            baseQuery += " AND LOWER(s.type) = 'compliance'";
            if (hasComplianceYear) {
                baseQuery += " AND t.compliance_year = ?";
                params.push(String(compliance_year).trim());
            }
            if (hasCompliancePeriod) {
                baseQuery += " AND t.compliance_period = ?";
                params.push(String(compliance_period).trim());
            }
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
              AND (
                  t.task_id LIKE ?
                  OR t.username LIKE ?
                  OR cp.name LIKE ?
                  OR f.firm_name LIKE ?
                  OR s.name LIKE ?
                  OR s.service_id LIKE ?
                  OR t.status LIKE ?
                  OR t.ca_approval LIKE ?
                  OR t.udin LIKE ?
              )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
        const total = Number(countRows[0]?.total || 0);

        const [rows] = await pool.query(
            `SELECT
                t.task_id,
                t.username,
                t.firm_id,
                t.service_id,
                t.task_type,
                t.compliance_year,
                t.compliance_period,
                t.status,
                t.ca_approval,
                t.udin,
                t.due_date,
                t.target_date,
                t.create_date,
                t.complete_date,
                f.firm_name,
                f.firm_type,
                f.pan_no,
                f.file_no,
                s.name AS service_name,
                s.type AS service_type,
                s.frequency AS service_frequency,
                cp.name AS client_name
             ${baseQuery}
             ORDER BY t.create_date DESC, t.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const data = rows.map((row) => formatTaskListItem(row));

        return res.status(200).json({
            success: true,
            message: "Task list retrieved successfully",
            data,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
            filters_applied: {
                status: statusList,
                ca_approval: caApprovalList,
                firm_id: firm_id ? String(firm_id).trim() : null,
                service_ids: serviceIdList,
                frequency: frequencyNorm || null,
                compliance_year: hasComplianceYear ? String(compliance_year).trim() : null,
                compliance_period: hasCompliancePeriod
                    ? String(compliance_period).trim()
                    : null,
                search: search ? String(search).trim() : null,
            },
        });
    } catch (error) {
        console.error("CA TASK LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task list",
        });
    }
});

router.get("/details/:task_id", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const task_id = String(req.params.task_id || "").trim();

        if (!task_id) {
            return res.status(400).json({
                success: false,
                message: "task_id is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT
                t.task_id,
                t.username,
                t.firm_id,
                t.service_id,
                t.task_type,
                t.compliance_year,
                t.compliance_period,
                t.status,
                t.due_date,
                t.target_date,
                t.complete_date,
                t.create_date,
                t.ca_approval,
                t.udin,
                f.firm_name,
                f.firm_type,
                f.gst_no,
                f.pan_no,
                f.file_no,
                s.name AS service_name,
                s.type AS service_type,
                s.frequency AS service_frequency,
                cp.name AS client_name
             FROM tasks t
             LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LEFT JOIN services s
                ON s.service_id = t.service_id
             LEFT JOIN profile cp
                ON cp.username = t.username
                AND cp.id = (
                    SELECT MAX(cp2.id)
                    FROM profile cp2
                    WHERE cp2.username = t.username
                )
             WHERE t.branch_id = ?
               AND t.task_id = ?
               AND t.has_ca = '1'
               AND t.ca_id = ?
             LIMIT 1`,
            [branch_id, task_id, ca_username]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Task not found",
            });
        }

        const row = rows[0];

        return res.status(200).json({
            success: true,
            message: "Task details retrieved successfully",
            data: {
                task_id: row.task_id,
                task_type: row.task_type || null,
                status: row.status,
                ca_approval: row.ca_approval || "pending",
                udin: row.udin ?? null,
                dates: {
                    due_date: row.due_date,
                    target_date: row.target_date,
                    complete_date: row.complete_date,
                    create_date: row.create_date,
                    compliance_year: row.compliance_year ?? null,
                    compliance_period: row.compliance_period ?? null,
                },
                compliance_year: row.compliance_year ?? null,
                compliance_period: row.compliance_period ?? null,
                client: {
                    username: row.username,
                    name: row.client_name ?? null,
                },
                firm: {
                    firm_id: row.firm_id,
                    firm_name: row.firm_name,
                    firm_type: row.firm_type,
                    gst_no: row.gst_no,
                    pan_no: row.pan_no,
                    file_no: row.file_no,
                },
                service: {
                    service_id: row.service_id,
                    name: row.service_name,
                    type: row.service_type,
                    frequency: row.service_frequency,
                },
            },
        });
    } catch (error) {
        console.error("CA TASK DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task details",
        });
    }
});

router.get("/details/:task_id/documents", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const task_id = String(req.params.task_id || "").trim();
        const {
            page_no = 1,
            limit = 20,
            search = "",
            scope = "all",
        } = req.query || {};

        if (!task_id) {
            return res.status(400).json({
                success: false,
                message: "task_id is required",
            });
        }

        const [owned] = await pool.query(
            `SELECT task_id, ca_approval
             FROM tasks
             WHERE branch_id = ?
               AND task_id = ?
               AND has_ca = '1'
               AND ca_id = ?
             LIMIT 1`,
            [branch_id, task_id, ca_username]
        );

        if (!owned.length) {
            return res.status(404).json({
                success: false,
                message: "Task not found",
            });
        }

        const docsLocked =
            String(owned[0].ca_approval || "pending").toLowerCase() === "complete";

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const scopeKey = String(scope || "all").toLowerCase();
        let scopeClause = "";
        const scopeParams = [];
        if (scopeKey === "me") {
            scopeClause = " AND created_by = ?";
            scopeParams.push(ca_username);
        } else if (scopeKey === "office") {
            scopeClause = " AND (created_by IS NULL OR created_by = '' OR created_by <> ?)";
            scopeParams.push(ca_username);
        }

        const searchTerm = String(search ?? "").trim();
        const searchClause =
            searchTerm.length > 0 ? " AND (name LIKE ? OR remark LIKE ?)" : "";
        const searchPattern = searchTerm.length > 0 ? `%${searchTerm}%` : null;

        const whereParams = [branch_id, task_id, ...scopeParams];
        if (searchPattern !== null) {
            whereParams.push(searchPattern, searchPattern);
        }

        const [totalRows] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM documents
             WHERE branch_id = ?
               AND task_id = ?
               AND category_id = 'TASK'
               AND is_reserved = '1'
               AND is_deleted = '0'${scopeClause}${searchClause}`,
            whereParams
        );

        const [rows] = await pool.query(
            `SELECT document_id, firm_id, name, remark, file, size, mime_type, created_by, create_date, modify_date
             FROM documents
             WHERE branch_id = ?
               AND task_id = ?
               AND category_id = 'TASK'
               AND is_reserved = '1'
               AND is_deleted = '0'${scopeClause}${searchClause}
             ORDER BY id DESC
             LIMIT ? OFFSET ?`,
            [...whereParams, limitNum, offset]
        );

        const list = [];
        for (const element of rows) {
            const createdBy = element.created_by || null;
            list.push({
                document_id: element.document_id,
                firm_id: element.firm_id,
                name: element.name,
                remark: element.remark,
                file: element.file
                    ? await getProfileDocumentAccessUrl(TASK_DOCUMENT_CATEGORY, element.file)
                    : null,
                size: element.size,
                mime_type: element.mime_type,
                created_by: createdBy,
                can_delete:
                    !docsLocked &&
                    createdBy != null &&
                    String(createdBy) === String(ca_username),
                create_date: element.create_date,
                modify_date: element.modify_date,
            });
        }

        const total = Number(totalRows[0]?.total || 0);

        return res.status(200).json({
            success: true,
            message: "Task documents retrieved successfully",
            data: list,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + list.length >= total,
            },
            scope: scopeKey === "me" || scopeKey === "office" ? scopeKey : "all",
        });
    } catch (error) {
        console.error("CA TASK DOCUMENTS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task documents",
        });
    }
});

/**
 * CA: save UDIN (+ optional documents[]) only when approval is sent (not after complete).
 * Body: {
 *   udin,
 *   documents?: [{ url, name?, remark? }],  // same shape as staff task document create
 *   document?: { url, name?, remark? },     // legacy single doc
 *   mark_complete?: boolean
 * }
 */
router.put("/details/:task_id/udin", validateCaSession, async (req, res) => {
    const conn = await pool.getConnection();
    const branch_id = req.branch_id;
    const ca_username = req.ca_username;
    const task_id = String(req.params.task_id || "").trim();
    const {
        udin = null,
        documents = null,
        document = null,
        mark_complete = false,
    } = req.body || {};
    const savedFiles = [];

    try {
        if (!task_id) {
            conn.release();
            return res.status(400).json({ success: false, message: "task_id is required" });
        }

        const nextUdin =
            udin == null || String(udin).trim() === ""
                ? null
                : String(udin).trim().slice(0, 100);

        if (!nextUdin) {
            conn.release();
            return res.status(400).json({ success: false, message: "UDIN number is required" });
        }

        const docList = [];
        if (Array.isArray(documents)) {
            for (const item of documents) {
                if (item && typeof item === "object") docList.push(item);
            }
        } else if (document && typeof document === "object") {
            docList.push(document);
        }

        const [rows] = await conn.query(
            `SELECT task_id, firm_id, username, ca_approval, udin
             FROM tasks
             WHERE branch_id = ?
               AND task_id = ?
               AND has_ca = '1'
               AND ca_id = ?
             LIMIT 1`,
            [branch_id, task_id, ca_username]
        );

        if (!rows.length) {
            conn.release();
            return res.status(404).json({ success: false, message: "Task not found" });
        }

        const task = rows[0];
        const approval = String(task.ca_approval || "pending").toLowerCase();
        if (!CA_APPROVAL_EDITABLE.has(approval)) {
            conn.release();
            return res.status(400).json({
                success: false,
                message:
                    approval === "complete"
                        ? "UDIN and documents cannot be updated after CA approval is marked complete"
                        : "UDIN can only be updated when CA approval is sent",
            });
        }

        if (docList.length > 0 && !task.firm_id) {
            conn.release();
            return res.status(400).json({ success: false, message: "Task firm_id not found" });
        }

        await conn.beginTransaction();

        const createdDocumentIds = [];
        for (let i = 0; i < docList.length; i++) {
            const doc = docList[i] || {};
            const url = String(doc.url || "").trim();
            if (!url) {
                await conn.rollback();
                for (const f of savedFiles) {
                    try { await deleteProfileDocument(TASK_DOCUMENT_CATEGORY, f); } catch (_) { /* ignore */ }
                }
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Document at index ${i} is missing a valid url`,
                });
            }

            let result;
            try {
                result = await downloadAndUploadProfileDocument(url, TASK_DOCUMENT_CATEGORY);
            } catch (downloadErr) {
                await conn.rollback();
                for (const f of savedFiles) {
                    try { await deleteProfileDocument(TASK_DOCUMENT_CATEGORY, f); } catch (_) { /* ignore */ }
                }
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: `Failed to download document at index ${i}: ${downloadErr.message}`,
                });
            }

            savedFiles.push(result.filename);
            const document_id = await UNIQUE_RANDOM_STRING("documents", "document_id", {
                length: ID_LENGTH,
                conn,
            });

            await conn.query(
                `INSERT INTO documents (
                    document_id, branch_id, firm_id, username, category_id, name, f_year, type, remark, month,
                    task_id, is_reserved, file, size, mime_type, created_by, create_date, modify_by, modify_date, is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', ?, ?, ?, ?, NOW(), ?, NOW(), '0')`,
                [
                    document_id,
                    branch_id,
                    task.firm_id,
                    task.username || "",
                    "TASK",
                    doc.name || "UDIN Document",
                    null,
                    "file",
                    doc.remark != null && String(doc.remark).trim() !== ""
                        ? String(doc.remark).trim()
                        : "",
                    null,
                    task_id,
                    result.filename,
                    result.size,
                    result.mimeType,
                    ca_username,
                    ca_username,
                ]
            );
            createdDocumentIds.push(document_id);
        }

        const nextApproval = mark_complete ? "complete" : approval;
        await conn.query(
            `UPDATE tasks
             SET udin = ?, ca_approval = ?
             WHERE branch_id = ? AND task_id = ?`,
            [nextUdin, nextApproval, branch_id, task_id]
        );

        await conn.commit();
        conn.release();

        return res.status(200).json({
            success: true,
            message: mark_complete
                ? "UDIN saved and CA approval marked complete"
                : "UDIN saved successfully",
            data: {
                task_id,
                udin: nextUdin,
                ca_approval: nextApproval,
                document_ids: createdDocumentIds,
                documents_count: createdDocumentIds.length,
            },
        });
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) { /* ignore */ }
        for (const f of savedFiles) {
            try {
                await deleteProfileDocument(TASK_DOCUMENT_CATEGORY, f);
            } catch (_) { /* ignore */ }
        }
        try {
            conn.release();
        } catch (_) { /* ignore */ }
        console.error("CA TASK UDIN UPDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update UDIN",
        });
    }
});

/** CA: mark approval complete (requires UDIN already set). */
router.put("/details/:task_id/udin/complete", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const task_id = String(req.params.task_id || "").trim();

        if (!task_id) {
            return res.status(400).json({ success: false, message: "task_id is required" });
        }

        const [rows] = await pool.query(
            `SELECT task_id, ca_approval, udin
             FROM tasks
             WHERE branch_id = ?
               AND task_id = ?
               AND has_ca = '1'
               AND ca_id = ?
             LIMIT 1`,
            [branch_id, task_id, ca_username]
        );

        if (!rows.length) {
            return res.status(404).json({ success: false, message: "Task not found" });
        }

        const task = rows[0];
        const approval = String(task.ca_approval || "pending").toLowerCase();
        if (approval === "pending") {
            return res.status(400).json({
                success: false,
                message: "Task has not been sent for CA approval yet",
            });
        }
        if (approval === "complete") {
            return res.status(400).json({
                success: false,
                message: "CA approval is already marked complete",
            });
        }
        if (!task.udin || String(task.udin).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Please save the UDIN number before marking complete",
            });
        }

        await pool.query(
            `UPDATE tasks SET ca_approval = 'complete' WHERE branch_id = ? AND task_id = ?`,
            [branch_id, task_id]
        );

        notifyCaApprovalComplete({
            branch_id,
            task_id,
            ca_username,
            udin: task.udin,
        }).catch((err) => {
            console.error("CA approval complete notify error:", err?.message || err);
        });

        return res.status(200).json({
            success: true,
            message: "CA approval marked complete",
            data: {
                task_id,
                ca_approval: "complete",
                udin: task.udin,
            },
        });
    } catch (error) {
        console.error("CA TASK UDIN COMPLETE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to mark CA approval complete",
        });
    }
});

/**
 * CA: soft-delete own TASK documents only (created_by = CA), and only before approval complete.
 * Body: { document_ids: string[] }
 */
router.delete("/details/:task_id/documents", validateCaSession, async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const task_id = String(req.params.task_id || "").trim();
        const { document_ids } = req.body || {};

        if (!task_id) {
            return res.status(400).json({ success: false, message: "task_id is required" });
        }
        if (!Array.isArray(document_ids) || document_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "document_ids must be a non-empty array",
            });
        }

        const ids = [
            ...new Set(document_ids.map((id) => String(id).trim()).filter(Boolean)),
        ];
        if (ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "document_ids must contain valid document ids",
            });
        }

        const [owned] = await conn.query(
            `SELECT task_id, ca_approval
             FROM tasks
             WHERE branch_id = ?
               AND task_id = ?
               AND has_ca = '1'
               AND ca_id = ?
             LIMIT 1`,
            [branch_id, task_id, ca_username]
        );

        if (!owned.length) {
            return res.status(404).json({ success: false, message: "Task not found" });
        }

        if (String(owned[0].ca_approval || "").toLowerCase() === "complete") {
            return res.status(400).json({
                success: false,
                message: "Documents cannot be deleted after CA approval is marked complete",
            });
        }

        const placeholders = ids.map(() => "?").join(",");
        const [rows] = await conn.query(
            `SELECT document_id, file, created_by
             FROM documents
             WHERE branch_id = ?
               AND task_id = ?
               AND document_id IN (${placeholders})
               AND category_id = 'TASK'
               AND is_reserved = '1'
               AND is_deleted = '0'`,
            [branch_id, task_id, ...ids]
        );

        const foundRows = rows || [];
        const foundIds = new Set(foundRows.map((r) => String(r.document_id)));
        const notFound = ids.filter((id) => !foundIds.has(id));
        if (notFound.length > 0) {
            return res.status(404).json({
                success: false,
                message: "One or more task documents not found",
                not_found_document_ids: notFound,
            });
        }

        const notOwned = foundRows.filter(
            (r) => String(r.created_by || "") !== String(ca_username)
        );
        if (notOwned.length > 0) {
            return res.status(400).json({
                success: false,
                message: "You can only delete documents you uploaded",
                forbidden_document_ids: notOwned.map((r) => r.document_id),
            });
        }

        await conn.beginTransaction();
        await conn.query(
            `UPDATE documents
             SET is_deleted = '1', modify_by = ?, modify_date = NOW()
             WHERE branch_id = ?
               AND task_id = ?
               AND document_id IN (${placeholders})
               AND category_id = 'TASK'
               AND is_reserved = '1'
               AND is_deleted = '0'
               AND created_by = ?`,
            [ca_username, branch_id, task_id, ...ids, ca_username]
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
            message: "Documents deleted successfully",
            data: { document_ids: ids, deleted_count: ids.length },
        });
    } catch (error) {
        try {
            await conn?.rollback();
        } catch {
            /* ignore */
        }
        console.error("CA TASK DOCUMENT DELETE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete documents",
        });
    } finally {
        if (conn) conn.release();
    }
});

export default router;
