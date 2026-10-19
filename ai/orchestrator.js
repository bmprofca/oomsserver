import { BLOCKS_META_KEY, IDS_META_KEY } from "./mcp/runTool.js";
import { sanitizeBlock, scrubText } from "./redact.js";
import { checkAnswer } from "./safety.js";
import { ProviderError } from "./providers/errors.js";

/**
 * AI tool-calling loop.
 *
 *   user message + bounded history → model → tool_use? → MCP callTool → tool_result → model … → final text
 *
 * Limits: max model iterations (the last one forces a text answer), max tool calls per
 * request, per-provider-call timeout, overall request deadline, duplicate tool calls served
 * from a per-request cache. Blocks (tables / KPIs / charts) are collected from tool results
 * only — the model's text is never parsed for data. Internal IDs reported by tools are
 * removed from the final text and from every visible block string (ai/redact.js).
 */

const STATUS_LABELS = {
    search_staff: "Finding team members",
    search_tasks: "Looking up tasks",
    get_staff_tasks: "Looking up tasks",
    get_task_details: "Loading task details",
    task_summary: "Calculating task statistics",
    attendance_report: "Checking attendance",
    leave_summary: "Checking leave records",
    search_parties: "Finding accounts",
    get_party_balance: "Calculating balance",
    get_outstanding_balances: "Loading outstanding balances",
    get_ledger_statement: "Building ledger statement",
    expense_report: "Totalling expenses",
    sales_report: "Totalling sales",
    dashboard_summary: "Preparing office snapshot",
    ask_clarification: "Preparing a question",
};

function toProviderTools(mcpTools) {
    return mcpTools.map((t) => {
        const { $schema, ...schema } = t.inputSchema || { type: "object", properties: {} };
        return { name: t.name, description: t.description || "", input_schema: schema };
    });
}

/** String values of a tool result (no JSON keys) — used to tell office data from leaks. */
function dataValuesOf(text, out = []) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        return out;
    }
    const walk = (v, depth = 0) => {
        if (depth > 8 || v === null || v === undefined) return;
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
        else if (typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(parsed);
    return out;
}

function textOf(content) {
    return (content || [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n\n")
        .trim();
}

/**
 * @param {object} p
 * @param {object} p.provider    provider from ai/providers
 * @param {object} p.mcpClient   connected MCP client (per request)
 * @param {string} p.system      system prompt
 * @param {Array}  p.history     prior turns [{role, content: string}]
 * @param {string} p.userMessage
 * @param {object} p.config      getAiConfig()
 * @param {(e: {type: string, label?: string, tool?: string}) => void} [p.onEvent]
 * @param {AbortSignal} [p.signal]
 */
export async function runChat({ provider, mcpClient, system, history, userMessage, config, onEvent = () => {}, signal }) {
    const deadline = Date.now() + config.requestTimeoutMs;
    const { tools: mcpTools } = await mcpClient.listTools();
    const tools = toProviderTools(mcpTools);

    const messages = [...history, { role: "user", content: userMessage }];
    const blocks = [];
    const blockKeys = new Set();
    const toolCalls = [];
    const callCache = new Map();
    const internalIds = new Set();
    const dataValues = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let toolCallCount = 0;
    let status = "ok";
    let text = "";

    const addBlocks = (list) => {
        for (const b of list || []) {
            const key = JSON.stringify(b);
            if (blockKeys.has(key)) continue;
            blockKeys.add(key);
            blocks.push(b);
        }
    };

    for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
        if (signal?.aborted) throw new ProviderError("ABORTED", "Request aborted");
        const remaining = deadline - Date.now();
        if (remaining < 3000) {
            status = "partial";
            break;
        }
        const lastRound = iteration === config.maxToolIterations - 1 || toolCallCount >= config.maxToolCalls;

        onEvent({ type: "status", label: iteration === 0 ? "Understanding your question" : "Analysing the results" });
        const response = await provider.createMessage({
            system,
            messages,
            tools,
            maxTokens: config.maxOutputTokens,
            disableTools: lastRound,
            signal,
            timeoutMs: Math.min(config.providerTimeoutMs, remaining),
        });
        usage.input_tokens += Number(response.usage?.input_tokens) || 0;
        usage.output_tokens += Number(response.usage?.output_tokens) || 0;

        if (response.stop_reason === "refusal") {
            status = "refusal";
            text = "I can't help with that request. Please rephrase your question about your office data.";
            break;
        }

        // Pass the full content back (thinking / fallback blocks must be preserved unchanged).
        messages.push({ role: "assistant", content: response.content });
        const toolUses = (response.content || []).filter((b) => b.type === "tool_use");

        if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
            text = textOf(response.content);
            if (response.stop_reason === "max_tokens") status = "partial";
            break;
        }

        const results = [];
        let clarified = false;
        for (const use of toolUses) {
            const cacheKey = `${use.name}:${JSON.stringify(use.input ?? {})}`;
            let result = callCache.get(cacheKey);

            if (!result && toolCallCount >= config.maxToolCalls) {
                result = { content: [{ type: "text", text: "Tool call limit reached for this question. Answer with the data already retrieved." }], isError: true };
            } else if (!result) {
                toolCallCount += 1;
                onEvent({ type: "status", label: STATUS_LABELS[use.name] || "Looking up data", tool: use.name });
                try {
                    result = await mcpClient.callTool({ name: use.name, arguments: use.input ?? {} });
                } catch (_) {
                    // MCP transport/protocol failure (e.g. unknown tool): report as a tool error, keep going.
                    result = { content: [{ type: "text", text: "This tool is not available." }], isError: true };
                }
                callCache.set(cacheKey, result);
                toolCalls.push({ name: use.name, args: use.input ?? {}, ok: !result.isError });
                addBlocks(result._meta?.[BLOCKS_META_KEY]);
                for (const id of result._meta?.[IDS_META_KEY] || []) internalIds.add(id);
            }

            if (use.name === "ask_clarification" && !result.isError) clarified = true;
            const resultText = (result.content || [])
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n") || "{}";
            if (!result.isError && use.name !== "ask_clarification") dataValuesOf(resultText, dataValues);
            results.push({ type: "tool_result", tool_use_id: use.id, content: resultText, ...(result.isError ? { is_error: true } : {}) });
        }
        // All tool results for one assistant turn go back in a single user message.
        messages.push({ role: "user", content: results });

        if (clarified) {
            text = textOf(response.content);
            status = "clarification";
            break;
        }
    }

    if (!text && status !== "clarification") {
        status = status === "ok" ? "partial" : status;
        text = blocks.length
            ? "Here is what I found. I couldn't finish the full summary in time — the details are below."
            : "I couldn't complete this request in time. Please try a narrower question.";
    }

    // Safety: the reply must not expose code, SQL, internal names, secrets, the prompt or vendor.
    const dataText = dataValues.join("\n");
    let safety = null;
    const verdict = checkAnswer(text, dataText);
    if (!verdict.ok) {
        safety = verdict.reason;
        text = verdict.reply;
    }
    const safeBlocks = blocks.filter((b) => {
        if (b.type !== "clarification") return true; // tool-built data blocks
        const ok = checkAnswer([b.question, ...(b.options || [])].join("\n"), dataText).ok;
        if (!ok) safety = safety || "clarification";
        return ok;
    });

    return {
        text: scrubText(text, internalIds),
        blocks: safeBlocks.map((b) => sanitizeBlock(b, internalIds)),
        safety,
        toolCalls,
        usage,
        status,
        model: provider.model,
    };
}

/**
 * Turn stored conversation rows into bounded model history.
 * Assistant turns carry a compact note of the tools/arguments used so follow-ups
 * ("what about last month?") can reuse the same person. Authorization is still
 * enforced again on every tool call.
 */
export function buildHistory(rows, { maxMessages, maxChars }) {
    const recent = rows.slice(-maxMessages);
    const out = [];
    let total = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        const row = recent[i];
        let content = String(row.content || "").trim();
        if (row.role === "assistant" && Array.isArray(row.tool_calls) && row.tool_calls.length) {
            const note = row.tool_calls
                .slice(0, 6)
                .map((c) => `${c.name} ${JSON.stringify(c.args)}`)
                .join("; ");
            content += `\n\n[Tools used for this answer: ${note}]`;
        }
        if (!content) continue;
        content = content.slice(0, 4000);
        if (total + content.length > maxChars) break;
        total += content.length;
        out.unshift({ role: row.role === "assistant" ? "assistant" : "user", content });
    }
    // Must start with a user turn and alternate roles.
    while (out.length && out[0].role !== "user") out.shift();
    const merged = [];
    for (const m of out) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
        else merged.push({ ...m });
    }
    if (merged.length && merged[merged.length - 1].role === "user") merged.pop(); // a failed turn left no answer
    return merged;
}
