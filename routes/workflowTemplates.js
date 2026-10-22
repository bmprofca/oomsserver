import express from "express";
import crypto from "crypto";
import pool from "../db.js";
import { auth, checkSubscription, requireFeature, validateBranch } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import { normalizeWorkflowTemplateInput } from "../helpers/workflowTemplates.js";

const router = express.Router();
const readAccess = [auth, validateBranch, checkSubscription, requireFeature("core")];
const manageAccess = [...readAccess, requirePermission("workflow_template_manage")];

function actor(req) {
    return String(req.headers.username || req.headers.Username || "").trim();
}

function sendError(res, error, fallback) {
    return res.status(Number(error?.status) || 500).json({
        success: false,
        message: error?.message || fallback,
    });
}

router.get("/", ...readAccess, async (req, res) => {
    try {
        const params = [req.branch_id];
        let serviceSql = "";
        if (req.query.service_id) {
            serviceSql = " AND (service_id = ? OR service_id IS NULL)";
            params.push(String(req.query.service_id).trim());
        }
        const [rows] = await pool.query(
            `SELECT workflow_template_id, service_id, version, name, status, definition_json, create_by, create_date
             FROM workflow_templates
             WHERE branch_id = ? AND status = 'active'${serviceSql}
             ORDER BY name, version DESC`,
            params
        );
        return res.json({ success: true, data: rows });
    } catch (error) {
        return sendError(res, error, "Failed to fetch workflow templates");
    }
});

router.post("/", ...manageAccess, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const definition = normalizeWorkflowTemplateInput(req.body || {});
        const templateId = await UNIQUE_RANDOM_STRING("workflow_templates", "workflow_template_id", {
            prefix: "wft",
            conn,
        });
        await conn.beginTransaction();
        await conn.query(
            `INSERT INTO workflow_templates
             (workflow_template_id, branch_id, service_id, version, name, status, definition_json, create_by)
             VALUES (?, ?, ?, 1, ?, 'active', ?, ?)`,
            [templateId, req.branch_id, definition.service_id, definition.name, JSON.stringify(definition), actor(req)]
        );
        await conn.query(
            `INSERT INTO audit_events
             (event_id, branch_id, actor_username, event_type, entity_type, entity_id, metadata)
             VALUES (?, ?, ?, 'workflow_template_created', 'workflow_template', ?, ?)`,
            [
                `aud_${crypto.randomUUID()}`,
                req.branch_id,
                actor(req),
                templateId,
                JSON.stringify({ version: 1, service_id: definition.service_id }),
            ]
        );
        await conn.commit();
        return res.status(201).json({ success: true, data: { workflow_template_id: templateId, version: 1 } });
    } catch (error) {
        try { await conn.rollback(); } catch (_) { }
        return sendError(res, error, "Failed to create workflow template");
    } finally {
        conn.release();
    }
});

router.put("/:workflow_template_id", ...manageAccess, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const definition = normalizeWorkflowTemplateInput(req.body || {});
        const templateId = String(req.params.workflow_template_id || "").trim();
        await conn.beginTransaction();
        const [currentRows] = await conn.query(
            `SELECT version, service_id, name
             FROM workflow_templates
             WHERE branch_id = ? AND workflow_template_id = ? AND status = 'active'
             ORDER BY version DESC LIMIT 1 FOR UPDATE`,
            [req.branch_id, templateId]
        );
        const current = currentRows[0];
        if (!current) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: "Workflow template not found" });
        }
        const version = Number(current.version) + 1;
        await conn.query(
            `UPDATE workflow_templates
             SET status = 'archived'
             WHERE branch_id = ? AND workflow_template_id = ? AND status = 'active'`,
            [req.branch_id, templateId]
        );
        await conn.query(
            `INSERT INTO workflow_templates
             (workflow_template_id, branch_id, service_id, version, name, status, definition_json, create_by)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
            [
                templateId,
                req.branch_id,
                definition.service_id ?? current.service_id,
                version,
                definition.name,
                JSON.stringify(definition),
                actor(req),
            ]
        );
        await conn.query(
            `INSERT INTO audit_events
             (event_id, branch_id, actor_username, event_type, entity_type, entity_id, metadata)
             VALUES (?, ?, ?, 'workflow_template_versioned', 'workflow_template', ?, ?)`,
            [
                `aud_${crypto.randomUUID()}`,
                req.branch_id,
                actor(req),
                templateId,
                JSON.stringify({ version, previous_version: Number(current.version) }),
            ]
        );
        await conn.commit();
        return res.json({ success: true, data: { workflow_template_id: templateId, version } });
    } catch (error) {
        try { await conn.rollback(); } catch (_) { }
        return sendError(res, error, "Failed to version workflow template");
    } finally {
        conn.release();
    }
});

router.delete("/:workflow_template_id", ...manageAccess, async (req, res) => {
    try {
        const templateId = String(req.params.workflow_template_id || "").trim();
        const [result] = await pool.query(
            `UPDATE workflow_templates
             SET status = 'archived'
             WHERE branch_id = ? AND workflow_template_id = ? AND status = 'active'`,
            [req.branch_id, templateId]
        );
        if (!result.affectedRows) return res.status(404).json({ success: false, message: "Workflow template not found" });
        await pool.query(
            `INSERT INTO audit_events
             (event_id, branch_id, actor_username, event_type, entity_type, entity_id, metadata)
             VALUES (?, ?, ?, 'workflow_template_archived', 'workflow_template', ?, ?)` ,
            [`aud_${crypto.randomUUID()}`, req.branch_id, actor(req), templateId, JSON.stringify({})]
        );
        return res.json({ success: true, data: { workflow_template_id: templateId, status: "archived" } });
    } catch (error) {
        return sendError(res, error, "Failed to archive workflow template");
    }
});

export default router;
