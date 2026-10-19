import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { ProviderError, isBillingMessage } from "./errors.js";
import { EFFORTS, VENDOR_BLOCK, normalizedResponse, parseToolArguments, vendorDataOf } from "./translate.js";

/**
 * OpenAI provider (official `openai` SDK, Responses API).
 *
 * The orchestrator speaks the Anthropic Messages shape; this adapter translates both ways.
 * - Stateless: store:false + encrypted reasoning items, replayed verbatim between tool calls
 *   (kept in a vendor block on the assistant turn).
 * - Effort → reasoning.effort. tool_choice "none" on the last round forces a text answer.
 */
export function createOpenAIProvider({ apiKey, model, effort = "medium", client: injected } = {}) {
    if (!apiKey) throw new ProviderError("NOT_CONFIGURED", "No API key configured for this branch");
    const client = injected || new OpenAI({ apiKey, maxRetries: 1 });
    const effortLevel = EFFORTS.includes(effort) ? effort : "medium";

    return {
        name: "openai",
        model,
        async createMessage({ system, messages, tools, maxTokens, disableTools = false, signal, timeoutMs }) {
            const params = {
                model,
                instructions: system,
                input: toOpenAIInput(messages),
                max_output_tokens: maxTokens,
                reasoning: { effort: effortLevel },
                store: false,
                include: ["reasoning.encrypted_content"],
                ...(tools?.length
                    ? {
                        tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
                        tool_choice: disableTools ? "none" : "auto",
                    }
                    : {}),
            };
            let response;
            try {
                response = await client.responses.create(params, { signal, timeout: timeoutMs });
            } catch (err) {
                throw mapOpenAIError(err);
            }
            return fromOpenAIResponse(response);
        },
        async verify({ timeoutMs = 15000 } = {}) {
            try {
                await client.models.retrieve(model, { timeout: timeoutMs });
                return true;
            } catch (err) {
                throw mapOpenAIError(err);
            }
        },
    };
}

/** Anthropic-shaped messages → Responses API input items. */
export function toOpenAIInput(messages) {
    const input = [];
    for (const m of messages) {
        if (typeof m.content === "string") {
            input.push({ role: m.role, content: m.content });
            continue;
        }
        if (m.role === "assistant") {
            const raw = vendorDataOf(m.content, "openai");
            if (raw) {
                input.push(...toResponseInputItems(raw));
                continue;
            }
            const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
            if (text) input.push({ role: "assistant", content: text });
            continue;
        }
        for (const b of m.content) {
            if (b.type === "tool_result") {
                input.push({ type: "function_call_output", call_id: b.tool_use_id, output: String(b.content ?? "") });
            } else if (b.type === "text" && b.text) {
                input.push({ role: "user", content: b.text });
            }
        }
    }
    return input;
}

/** Responses API result → normalized Anthropic-shaped response. */
export function fromOpenAIResponse(response) {
    const output = response.output || [];
    const content = [];
    let refused = false;
    for (const item of output) {
        if (item.type === "message") {
            for (const part of item.content || []) {
                if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
                if (part.type === "refusal") refused = true;
            }
        } else if (item.type === "function_call") {
            content.push({ type: "tool_use", id: item.call_id, name: item.name, input: parseToolArguments(item.arguments) });
        }
    }
    content.push({ type: VENDOR_BLOCK, provider: "openai", data: output });

    const hasTools = content.some((b) => b.type === "tool_use");
    let stopReason = hasTools ? "tool_use" : "end_turn";
    if (refused && !hasTools) stopReason = "refusal";
    else if (response.status === "incomplete" && response.incomplete_details?.reason === "content_filter") stopReason = "refusal";
    else if (response.status === "incomplete" && !hasTools) stopReason = "max_tokens";

    return normalizedResponse({
        content,
        stopReason,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
    });
}

/** Error mapping for the openai SDK (also used by the DeepSeek adapter). */
export function mapOpenAIError(err) {
    if (err instanceof ProviderError) return err;
    if (err instanceof OpenAI.APIUserAbortError) return new ProviderError("ABORTED", "Request aborted", err);
    if (err instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError("TIMEOUT", "AI provider timed out", err);
    // 402 and some 400/429 responses mean an exhausted quota or unpaid balance.
    if (err instanceof OpenAI.APIError && (err.status === 402 || isBillingMessage(err.message))) {
        return new ProviderError("BILLING", "AI provider account has no credit", err);
    }
    if (err instanceof OpenAI.RateLimitError) return new ProviderError("RATE_LIMITED", "AI provider rate limit", err);
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
        return new ProviderError("INVALID_KEY", "AI provider rejected the credentials", err);
    }
    if (err instanceof OpenAI.NotFoundError) return new ProviderError("MODEL_UNAVAILABLE", "Model not available for this key", err);
    if (err instanceof OpenAI.BadRequestError) {
        if (/model/i.test(err.message || "") && /not exist|not found|invalid|unsupported/i.test(err.message || "")) {
            return new ProviderError("MODEL_UNAVAILABLE", "Model not available for this key", err);
        }
        return new ProviderError("BAD_REQUEST", "AI provider rejected the request", err);
    }
    if (err instanceof OpenAI.APIConnectionError) return new ProviderError("UNAVAILABLE", "AI provider unreachable", err);
    if (err instanceof OpenAI.APIError) {
        return new ProviderError(err.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST", `AI provider error ${err.status}`, err);
    }
    return new ProviderError("UNAVAILABLE", "AI provider failed", err);
}
