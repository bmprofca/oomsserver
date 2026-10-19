import test from "node:test";
import assert from "node:assert/strict";
import { collectIdentifiers, sanitizeBlock, scrubText } from "../ai/redact.js";
import { runChat } from "../ai/orchestrator.js";
import { createMcpForRequest } from "../ai/mcp/createMcpForRequest.js";
import { createFakeDb, createScriptedProvider, finalText, makeCtx, toolUse, TEST_CONFIG } from "./helpers/aiFakes.js";

test("collectIdentifiers finds ID values under ID-like keys only", () => {
    const ids = collectIdentifiers({
        tasks: [{ task_id: "PL3WEZZ0PD", service: "GST Return", client_username: "usr_Z2JLMZ270G", assigned_usernames: ["usr_A21SC6HWHT"] }],
        member: { username: "usr_FX3YUT41C7", name: "DEBASISH PAN" },
        id: 7, // numbers are never collected
        status: "pending",
    });
    assert.deepEqual([...ids].sort(), ["PL3WEZZ0PD", "usr_A21SC6HWHT", "usr_FX3YUT41C7", "usr_Z2JLMZ270G"]);
});

test("scrubText removes IDs (exact values and known patterns) and tidies the text", () => {
    const ids = new Set(["PL3WEZZ0PD", "usr_Z2JLMZ270G"]);
    assert.equal(scrubText("Arun Pawan (usr_Z2JLMZ270G) has 2 tasks.", ids), "Arun Pawan has 2 tasks.");
    assert.equal(scrubText("Task ID: PL3WEZZ0PD is overdue.", ids), "Task is overdue.");
    assert.equal(scrubText("Open `PL3WEZZ0PD` from the table.", ids), "Open from the table.");
    assert.equal(scrubText("- GST Return, task APP2025_BRN2025_1748718004331_15120830, due 25 Oct", ids), "- GST Return, task, due 25 Oct");
    assert.equal(scrubText("Username: usr_UFQ4SI85SS", new Set()), "");
    // Text without IDs is returned untouched (no tidying side effects).
    const plain = "You have 3 pending tasks (1 overdue). See the table below.";
    assert.equal(scrubText(plain, ids), plain);
    // Real names and words are never touched.
    assert.equal(scrubText("Ask PL3 team", ids), "Ask PL3 team");
});

test("sanitizeBlock drops ID columns, keeps link keys hidden, scrubs visible cells", () => {
    const block = {
        type: "table",
        title: "Task PL3WEZZ0PD",
        columns: [
            { key: "service", label: "Task", type: "text", href: "/task/{task_id}" },
            { key: "username", label: "Username", type: "text" },
            { key: "assigned_to", label: "Assigned to", type: "text" },
        ],
        rows: [{ service: "GST Return", task_id: "PL3WEZZ0PD", username: "usr_Z2JLMZ270G", assigned_to: "usr_A21SC6HWHT" }],
        total: 1,
        truncated: false,
    };
    const out = sanitizeBlock(block, new Set(["PL3WEZZ0PD"]));
    assert.deepEqual(out.columns.map((c) => c.key), ["service", "assigned_to"]);
    assert.deepEqual(out.rows[0], { service: "GST Return", task_id: "PL3WEZZ0PD", assigned_to: null }, "task_id kept only for the link");
    assert.equal(out.title, "Task");

    const clar = sanitizeBlock({ type: "clarification", question: "Which Arun?", options: ["Arun Pawan (usr_Z2JLMZ270G)", "Arun Pawan (Clerk)"] });
    assert.deepEqual(clar.options, ["Arun Pawan", "Arun Pawan (Clerk)"]);
});

test("end to end: IDs never reach the user even when the model writes them", async () => {
    const db = createFakeDb([
        [/FROM branch_mapping bm\s+WHERE bm.branch_id = \? AND bm.username = \?/, () => [{ username: "usr_Z2JLMZ270G", name: "Arun Pawan" }]],
        [/SELECT COUNT\(\*\) AS total/, () => [{ total: 1 }]],
        [/SELECT t.task_id/, () => [{ task_id: "PL3WEZZ0PD", status: "pending", due_date: "2026-10-25", service_name: "GST Return", client_name: "Mahfuzur Rahman", client_username: "usr_A21SC6HWHT", assigned_to: "Arun Pawan" }]],
    ]);
    const provider = createScriptedProvider([
        toolUse("u1", "get_staff_tasks", { staff_username: "usr_Z2JLMZ270G" }),
        finalText("Arun Pawan (username: usr_Z2JLMZ270G) has 1 pending task:\n- GST Return for Mahfuzur Rahman (task ID PL3WEZZ0PD), due 25 Oct."),
    ]);
    const ctx = makeCtx({ username: "boss", permissions: ["staff_view_manage"] });
    const mcp = await createMcpForRequest(ctx, { db }, { timeoutMs: 1000 });
    let result;
    try {
        result = await runChat({ provider, mcpClient: mcp.client, system: "s", history: [], userMessage: "Show Arun's task ids", config: TEST_CONFIG });
    } finally {
        await mcp.close();
    }

    // The model itself still received the IDs (it needs them for tool calls).
    assert.match(JSON.stringify(provider.requests[1].messages), /PL3WEZZ0PD/);

    const visible = JSON.stringify({ text: result.text, blocks: result.blocks.map(({ rows, ...b }) => ({ ...b, rows: rows?.map(({ task_id, ...r }) => r) })) });
    assert.doesNotMatch(visible, /PL3WEZZ0PD|usr_Z2JLMZ270G|usr_A21SC6HWHT/);
    assert.match(result.text, /Arun Pawan has 1 pending task/);
    assert.match(result.text, /GST Return for Mahfuzur Rahman, due 25 Oct\./);

    const table = result.blocks.find((b) => b.type === "table");
    assert.ok(!table.columns.some((c) => /task_id|username/.test(c.key)));
    assert.equal(table.columns[0].href, "/task/{task_id}");
    assert.equal(table.rows[0].task_id, "PL3WEZZ0PD", "link target still works");
});
