import OpenAI from "openai";
import { ProviderError } from "./errors.js";
import { mapOpenAIError } from "./openai.js";
import { EFFORTS, VENDOR_BLOCK, foldHistoryIntoQuestion, normalizedResponse, parseToolArguments, vendorDataOf } from "./translate.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek provider: OpenAI-compatible Chat Completions via the `openai` SDK
 * (DeepSeek's documented integration), pointed at api.deepseek.com.
 *
 * - Thinking mode is on by default; effort → reasoning_effort (DeepSeek maps medium → high).
 * - With tools, DeepSeek requires every earlier assistant turn's reasoning_content to be sent
 *   back. Within a question the raw assistant message is replayed verbatim (vendor block);
 *   stored history has no reasoning, so earlier turns are folded into the question as text.
 */
export function createDeepSeekProvider({ apiKey, model, effort = "medium", client: injected } = {}) {
    if (!apiKey) throw new ProviderError("NOT_CONFIGURED", "No API key configured for this branch");
    const client = injected || new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL, maxRetries: 1 });
    const effortLevel = EFFORTS.includes(effort) ? effort : "medium";

    return {
        name: "deepseek",
        model,
        async createMessage({ system, messages, tools, maxTokens, disableTools = false, signal, timeoutMs }) {
            const params = {
                model,
                messages: [{ role: "system", content: system }, ...toDeepSeekMessages(messages)],
                max_tokens: maxTokens,
                reasoning_effort: effortLevel,
                ...(tools?.length
                    ? {
                        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
                        tool_choice: disableTools ? "none" : "auto",
                    }
                    : {}),
            };
            let completion;
            try {
                completion = await client.chat.completions.create(params, { signal, timeout: timeoutMs });
            } catch (err) {
                throw mapOpenAIError(err);
            }
            return fromDeepSeekCompletion(completion);
        },
        async verify({ timeoutMs = 15000 } = {}) {
            let page;
            try {
                page = await client.models.list({ timeout: timeoutMs });
            } catch (err) {
                throw mapOpenAIError(err);
            }
            const ids = (page?.data || []).map((m) => m.id);
            if (ids.length && !ids.includes(model)) throw new ProviderError("MODEL_UNAVAILABLE", "Model not available for this key");
            return true;
        },
    };
}

/** Anthropic-shaped messages → Chat Completions messages (system prompt added by caller). */
export function toDeepSeekMessages(messages) {
    const out = [];
    for (const m of foldHistoryIntoQuestion(messages)) {
        if (typeof m.content === "string") {
            out.push({ role: m.role, content: m.content });
            continue;
        }
        if (m.role === "assistant") {
            const raw = vendorDataOf(m.content, "deepseek");
            if (raw) {
                out.push(raw);
                continue;
            }
            const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
            if (text) out.push({ role: "assistant", content: text });
            continue;
        }
        for (const b of m.content) {
            if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content ?? "") });
            else if (b.type === "text" && b.text) out.push({ role: "user", content: b.text });
        }
    }
    return out;
}

export function fromDeepSeekCompletion(completion) {
    const choice = completion.choices?.[0] || {};
    const msg = choice.message || {};
    const content = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    for (const call of msg.tool_calls || []) {
        if (call.type !== "function" || !call.function) continue;
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolArguments(call.function.arguments) });
    }
    // Replay exactly what the model returned, reasoning_content included.
    const raw = { role: "assistant", content: msg.content ?? "" };
    if (msg.reasoning_content !== undefined && msg.reasoning_content !== null) raw.reasoning_content = msg.reasoning_content;
    if (msg.tool_calls?.length) raw.tool_calls = msg.tool_calls;
    content.push({ type: VENDOR_BLOCK, provider: "deepseek", data: raw });

    const hasTools = content.some((b) => b.type === "tool_use");
    const finish = choice.finish_reason;
    const stopReason = hasTools
        ? "tool_use"
        : finish === "length"
            ? "max_tokens"
            : finish === "content_filter"
                ? "refusal"
                : "end_turn";
    return normalizedResponse({
        content,
        stopReason,
        inputTokens: completion.usage?.prompt_tokens,
        outputTokens: completion.usage?.completion_tokens,
    });
}
