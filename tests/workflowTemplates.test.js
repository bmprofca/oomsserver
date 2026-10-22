import test from "node:test";
import assert from "node:assert/strict";
import {
    buildWorkflowSnapshot,
    normalizeWorkflowTemplateInput,
} from "../helpers/workflowTemplates.js";

test("workflow templates normalize steps, SLA, documents, and assignees", () => {
    const template = normalizeWorkflowTemplateInput({
        name: "Monthly GST",
        service_id: "gst",
        steps: [
            {
                title: "Collect records",
                sla_hours: 24,
                document_requirements: ["Sales register"],
                default_assignee_type: "staff",
            },
        ],
    });
    assert.equal(template.steps[0].order, 1);
    assert.equal(template.steps[0].required, true);
    assert.deepEqual(template.steps[0].document_requirements, ["Sales register"]);
});

test("workflow templates reject invalid SLA and assignee values", () => {
    assert.throws(() => normalizeWorkflowTemplateInput({ name: "Bad", steps: [{ title: "x", sla_hours: -1 }] }), /invalid sla_hours/);
    assert.throws(() => normalizeWorkflowTemplateInput({ name: "Bad", steps: [{ title: "x", default_assignee_type: "external" }] }), /invalid default assignee/);
});

test("workflow snapshots retain the versioned definition", () => {
    const snapshot = buildWorkflowSnapshot({
        workflow_template_id: "wft_1",
        version: 2,
        name: "Monthly GST",
        service_id: "gst",
        definition_json: JSON.stringify({ steps: [{ title: "Review" }] }),
    });
    assert.deepEqual(snapshot, {
        workflow_template_id: "wft_1",
        version: 2,
        name: "Monthly GST",
        service_id: "gst",
        definition: { steps: [{ title: "Review" }] },
    });
});
