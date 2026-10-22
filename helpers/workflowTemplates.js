export const WORKFLOW_ASSIGNEE_TYPES = Object.freeze([
    "default",
    "staff",
    "ca",
    "manager",
]);

function text(value, fallback = "") {
    return String(value ?? fallback).trim();
}

function bool(value, fallback = false) {
    if (value === undefined) return fallback;
    return value === true || value === 1 || value === "1" || value === "true";
}

export function normalizeWorkflowTemplateInput(input = {}) {
    const name = text(input.name);
    if (!name) throw new Error("name is required");
    if (name.length > 150) throw new Error("name is too long");

    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    if (!rawSteps.length) throw new Error("at least one workflow step is required");
    if (rawSteps.length > 100) throw new Error("workflow cannot contain more than 100 steps");

    const steps = rawSteps.map((step, index) => {
        const title = text(step?.title || step?.name);
        if (!title) throw new Error(`workflow step ${index + 1} requires a title`);
        const slaHours = Number(step?.sla_hours ?? step?.slaHours ?? 0);
        if (!Number.isFinite(slaHours) || slaHours < 0 || slaHours > 8760) {
            throw new Error(`workflow step ${index + 1} has an invalid sla_hours value`);
        }
        const assignee = text(step?.default_assignee_type || step?.defaultAssigneeType || "default").toLowerCase();
        if (!WORKFLOW_ASSIGNEE_TYPES.includes(assignee)) {
            throw new Error(`workflow step ${index + 1} has an invalid default assignee type`);
        }
        const documents = Array.isArray(step?.document_requirements || step?.documentRequirements)
            ? (step.document_requirements || step.documentRequirements)
                .map((item) => text(item))
                .filter(Boolean)
                .slice(0, 50)
            : [];
        return {
            key: text(step?.key || `step_${index + 1}`).slice(0, 80),
            title: title.slice(0, 255),
            order: index + 1,
            sla_hours: slaHours,
            document_requirements: documents,
            default_assignee_type: assignee,
            required: bool(step?.required, true),
        };
    });

    return {
        name,
        service_id: input.service_id ? text(input.service_id).slice(0, 50) : null,
        steps,
    };
}

export function buildWorkflowSnapshot(row) {
    if (!row) return null;
    const definition = typeof row.definition_json === "string"
        ? JSON.parse(row.definition_json)
        : row.definition_json;
    return {
        workflow_template_id: row.workflow_template_id,
        version: Number(row.version),
        name: row.name,
        service_id: row.service_id || null,
        definition,
    };
}

export async function loadWorkflowTemplateSnapshot(conn, {
    branch_id,
    service_id,
    workflow_template_id,
    task_id,
    actor_username,
}) {
    const templateId = workflow_template_id ? String(workflow_template_id).trim() : "";
    if (!templateId) return null;
    const [rows] = await conn.query(
        `SELECT workflow_template_id, service_id, version, name, definition_json
         FROM workflow_templates
         WHERE branch_id = ? AND workflow_template_id = ? AND status = 'active'
           AND (service_id = ? OR service_id IS NULL)
         ORDER BY CASE WHEN service_id = ? THEN 0 ELSE 1 END, version DESC
         LIMIT 1`,
        [branch_id, templateId, service_id || null, service_id || null]
    );
    const snapshot = buildWorkflowSnapshot(rows?.[0]);
    if (!snapshot) throw new Error("workflow_template_id is not active for this branch and service");
    await conn.query(
        `INSERT INTO task_workflow_snapshots
         (branch_id, task_id, workflow_template_id, template_version, snapshot_json, create_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE task_id = task_id`,
        [branch_id, task_id, snapshot.workflow_template_id, snapshot.version, JSON.stringify(snapshot), actor_username]
    );
    return snapshot;
}
