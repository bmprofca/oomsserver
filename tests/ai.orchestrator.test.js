import test from "node:test";
import assert from "node:assert/strict";
import { runChat, buildHistory } from "../ai/orchestrator.js";
import { createMcpForRequest } from "../ai/mcp/createMcpForRequest.js";
import { ProviderError } from "../ai/providers/errors.js";
import { createFakeDb, createScriptedProvider, finalText, makeCtx, toolUse, TEST_CONFIG } from "./helpers/aiFakes.js";

function staffDb() {
    return createFakeDb([
        [/FROM branch_mapping bm\s+LEFT JOIN profile/, () => [{ username: "arun", type: "staff", name: "Arun Pawan", designation: "Accountant" }]],
        [/FROM branch_mapping bm\s+WHERE bm.branch_id = \? AND bm.username = \?/, () => [{ username: "arun", name: "Arun Pawan" }]],
        [/SELECT COUNT\(\*\) AS total/, () => [{ total: 1, in_process: 1, complete: 0, cancel: 0, overdue: 0 }]],
        [/SELECT t.task_id/, () => [{ task_id: "T9", status: "in process", due_date: "2026-10-25", service_name: "GST" }]],
    ]);
}

async function chat({ ctx = makeCtx({ username: "boss", permissions: ["staff_view_manage"] }), responses, db = staffDb(), history = [], config = TEST_CONFIG, audits = [] }) {
    const provider = createScriptedProvider(responses);
    const mcp = await createMcpForRequest(ctx, { db }, { timeoutMs: 1000, onAudit: (a) => audits.push(a) });
    try {
        const result = await runChat({ provider, mcpClient: mcp.client, system: "sys", history, userMessage: "Tasks of Arun Pawan?", config });
        return { result, provider, audits };
    } finally {
        await mcp.close();
    }
}

test("multi-step tool loop: resolve person, fetch tasks, answer", async () => {
    const { result, provider } = await chat({
        responses: [
            toolUse("u1", "search_staff", { search: "Arun Pawan" }),
            toolUse("u2", "get_staff_tasks", { staff_username: "arun" }),
            finalText("Arun Pawan has 1 task in process. See the table below."),
        ],
    });
    assert.equal(result.status, "ok");
    assert.equal(result.text, "Arun Pawan has 1 task in process. See the table below.");
    assert.deepEqual(result.toolCalls.map((c) => c.name), ["search_staff", "get_staff_tasks"]);
    const table = result.blocks.find((b) => b.type === "table");
    assert.equal(table.rows[0].task_id, "T9", "table rows come from the tool, not the model");
    // Tools offered to the model come from the per-request MCP server.
    assert.ok(provider.requests[0].tools.some((t) => t.name === "get_staff_tasks"));
    assert.ok(!provider.requests[0].tools.some((t) => t.name === "get_party_balance"));
    // Tool results are sent back as tool_result blocks in one user message.
    const turn = provider.requests[1].messages.at(-1);
    assert.equal(turn.role, "user");
    assert.equal(turn.content[0].type, "tool_result");
    assert.equal(turn.content[0].tool_use_id, "u1");
});

test("runaway tool loops stop and the last round forces a text answer", async () => {
    const config = { ...TEST_CONFIG, maxToolIterations: 3 };
    let n = 0;
    const { result, provider } = await chat({
        config,
        responses: [(req) => (req.disableTools ? finalText("Stopping here.") : toolUse(`u${n++}`, "search_staff", { search: `x${n}` }))],
    });
    assert.equal(provider.requests.length, 3);
    assert.equal(provider.requests[2].disableTools, true);
    assert.equal(result.text, "Stopping here.");
});

test("duplicate tool calls are served from cache and not re-executed", async () => {
    const db = staffDb();
    await chat({
        db,
        responses: [
            toolUse("a", "search_staff", { search: "Arun" }),
            toolUse("b", "search_staff", { search: "Arun" }),
            finalText("done"),
        ],
    });
    assert.equal(db.calls.filter((c) => /LEFT JOIN profile p ON p.username = bm.username/.test(c.sql)).length, 1);
});

test("tool call budget is enforced", async () => {
    const config = { ...TEST_CONFIG, maxToolCalls: 2, maxToolIterations: 6 };
    let n = 0;
    const db = staffDb();
    const { result } = await chat({
        db,
        config,
        responses: [(req) => (req.disableTools ? finalText("ok") : toolUse(`u${n}`, "search_staff", { search: `q${n++}` }))],
    });
    assert.equal(result.toolCalls.length, 2);
});

test("unauthorised tool names requested by the model are refused", async () => {
    const audits = [];
    const { result, provider } = await chat({
        ctx: makeCtx(),
        audits,
        responses: [toolUse("u1", "get_party_balance", { party_type: "client", party_id: "x" }), finalText("You don't have permission.")],
    });
    const sent = provider.requests[1].messages.at(-1).content[0];
    assert.equal(sent.is_error, true);
    assert.equal(result.blocks.length, 0);
    assert.equal(audits.length, 0, "tool never ran");
});

test("clarification ends the turn with option chips", async () => {
    const { result, provider } = await chat({
        responses: [
            toolUse("c1", "ask_clarification", { question: "Which Arun do you mean?", options: ["Arun Pawan (Accountant)", "Arun Pawan (Clerk)"] }),
            finalText("should not be called"),
        ],
    });
    assert.equal(result.status, "clarification");
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(result.blocks[0], { type: "clarification", question: "Which Arun do you mean?", options: ["Arun Pawan (Accountant)", "Arun Pawan (Clerk)"] });
});

test("provider failures surface as ProviderError for graceful handling", async () => {
    await assert.rejects(
        chat({ responses: [new ProviderError("UNAVAILABLE", "down")] }),
        (err) => err instanceof ProviderError && err.code === "UNAVAILABLE"
    );
});

test("refusals return a safe message", async () => {
    const { result } = await chat({ responses: [{ stop_reason: "refusal", content: [], usage: {} }] });
    assert.equal(result.status, "refusal");
    assert.match(result.text, /can't help/);
});

test("history keeps follow-up context and tool notes, bounded and alternating", () => {
    const rows = [
        { role: "assistant", content: "orphan" },
        { role: "user", content: "Tasks of Arun?" },
        { role: "assistant", content: "Arun has 3 tasks.", tool_calls: [{ name: "get_staff_tasks", args: { staff_username: "arun" } }] },
        { role: "user", content: "failed question" },
    ];
    const history = buildHistory(rows, { maxMessages: 12, maxChars: 10000 });
    assert.equal(history[0].role, "user");
    assert.equal(history.length, 2);
    assert.match(history[1].content, /get_staff_tasks \{"staff_username":"arun"\}/);

    const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    assert.ok(buildHistory(long, { maxMessages: 12, maxChars: 10000 }).length <= 12);
});

test("follow-up tool calls are re-authorised: history cannot grant access", async () => {
    // Earlier turn (from a manager session) mentioned a colleague; a non-manager follow-up must still be denied.
    const history = [
        { role: "user", content: "Tasks of Arun?" },
        { role: "assistant", content: "Arun has tasks.\n\n[Tools used for this answer: get_staff_tasks {\"staff_username\":\"arun\"}]" },
    ];
    const { provider } = await chat({
        ctx: makeCtx(),
        history,
        responses: [toolUse("u1", "get_staff_tasks", { staff_username: "arun" }), finalText("You can only see your own tasks.")],
    });
    assert.match(provider.requests[1].messages.at(-1).content[0].content, /DENIED/);
});
