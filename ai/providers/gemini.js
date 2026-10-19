import { ApiError, GoogleGenAI } from "@google/genai";
import { ProviderError, isBillingMessage } from "./errors.js";
import { EFFORTS, VENDOR_BLOCK, normalizedResponse, toolNameLookup, vendorDataOf } from "./translate.js";

/**
 * Google Gemini provider (official @google/genai SDK, Gemini Developer API key).
 *
 * - The model's Content is replayed verbatim (vendor block) so thought signatures on
 *   function calls survive between tool rounds — Gemini 3+ rejects calls without them.
 * - Effort → thinkingConfig.thinkingLevel (Gemini 3+ models only).
 * - Function calling mode NONE on the last round forces a text answer.
 */
const REFUSAL_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

export function createGeminiProvider({ apiKey, model, effort = "medium", client: injected } = {}) {
    if (!apiKey) throw new ProviderError("NOT_CONFIGURED", "No API key configured for this branch");
    const client = injected || new GoogleGenAI({ apiKey });
    const effortLevel = EFFORTS.includes(effort) ? effort : "medium";
    const supportsThinkingLevel = !/^gemini-(1|2)\./.test(model || "");

    return {
        name: "gemini",
        model,
        async createMessage({ system, messages, tools, maxTokens, disableTools = false, signal, timeoutMs }) {
            const config = {
                systemInstruction: system,
                maxOutputTokens: maxTokens,
                ...(supportsThinkingLevel ? { thinkingConfig: { thinkingLevel: effortLevel.toUpperCase() } } : {}),
                ...(tools?.length
                    ? {
                        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }],
                        toolConfig: { functionCallingConfig: { mode: disableTools ? "NONE" : "AUTO" } },
                    }
                    : {}),
                ...(signal ? { abortSignal: signal } : {}),
                ...(timeoutMs ? { httpOptions: { timeout: timeoutMs } } : {}),
            };
            let response;
            try {
                response = await client.models.generateContent({ model, contents: toGeminiContents(messages), config });
            } catch (err) {
                throw mapGeminiError(err, signal);
            }
            return fromGeminiResponse(response);
        },
        async verify({ timeoutMs = 15000 } = {}) {
            try {
                await client.models.get({ model, config: { httpOptions: { timeout: timeoutMs } } });
                return true;
            } catch (err) {
                throw mapGeminiError(err);
            }
        },
    };
}

/** Anthropic-shaped messages → Gemini contents. */
export function toGeminiContents(messages) {
    const names = toolNameLookup(messages);
    const generatedIds = new Set();
    const contents = [];
    for (const m of messages) {
        if (typeof m.content === "string") {
            contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
            continue;
        }
        if (m.role === "assistant") {
            const raw = vendorDataOf(m.content, "gemini");
            if (raw?.content) {
                contents.push(raw.content);
                for (const id of raw.generatedIds || []) generatedIds.add(id);
                continue;
            }
            const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
            if (text) contents.push({ role: "model", parts: [{ text }] });
            continue;
        }
        const parts = [];
        for (const b of m.content) {
            if (b.type === "tool_result") {
                const output = parseMaybeJson(b.content);
                parts.push({
                    functionResponse: {
                        // Only echo ids Gemini itself issued.
                        ...(generatedIds.has(b.tool_use_id) ? {} : { id: b.tool_use_id }),
                        name: names.get(b.tool_use_id) || "unknown_tool",
                        response: b.is_error ? { error: output } : { output },
                    },
                });
            } else if (b.type === "text" && b.text) {
                parts.push({ text: b.text });
            }
        }
        if (parts.length) contents.push({ role: "user", parts });
    }
    return contents;
}

export function fromGeminiResponse(response) {
    const candidate = response.candidates?.[0];
    const usage = response.usageMetadata || {};
    const inputTokens = usage.promptTokenCount;
    const outputTokens = (Number(usage.candidatesTokenCount) || 0) + (Number(usage.thoughtsTokenCount) || 0);

    if (!candidate) {
        // Prompt blocked before generation.
        return normalizedResponse({ content: [], stopReason: response.promptFeedback?.blockReason ? "refusal" : "end_turn", inputTokens, outputTokens });
    }

    const parts = candidate.content?.parts || [];
    const content = [];
    const generatedIds = [];
    parts.forEach((part, index) => {
        if (part.thought) return;
        if (part.functionCall) {
            let id = part.functionCall.id;
            if (!id) {
                id = `gemini_call_${index}_${Math.random().toString(36).slice(2, 10)}`;
                generatedIds.push(id);
            }
            content.push({ type: "tool_use", id, name: part.functionCall.name, input: part.functionCall.args || {} });
        } else if (typeof part.text === "string" && part.text) {
            content.push({ type: "text", text: part.text });
        }
    });
    content.push({ type: VENDOR_BLOCK, provider: "gemini", data: { content: candidate.content || { role: "model", parts: [] }, generatedIds } });

    const hasTools = content.some((b) => b.type === "tool_use");
    const finish = candidate.finishReason;
    const stopReason = hasTools
        ? "tool_use"
        : REFUSAL_REASONS.has(finish)
            ? "refusal"
            : finish === "MAX_TOKENS"
                ? "max_tokens"
                : "end_turn";
    return normalizedResponse({ content, stopReason, inputTokens, outputTokens });
}

function parseMaybeJson(text) {
    const s = String(text ?? "");
    try {
        const v = JSON.parse(s);
        return v && typeof v === "object" ? v : s;
    } catch (_) {
        return s;
    }
}

export function mapGeminiError(err, signal) {
    if (err instanceof ProviderError) return err;
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
        return signal?.aborted ? new ProviderError("ABORTED", "Request aborted", err) : new ProviderError("TIMEOUT", "AI provider timed out", err);
    }
    if (err instanceof ApiError || typeof err?.status === "number") {
        const status = Number(err.status);
        const message = String(err.message || "");
        if (status === 401 || status === 403 || (status === 400 && /api key|API_KEY_INVALID/i.test(message))) {
            return new ProviderError("INVALID_KEY", "AI provider rejected the credentials", err);
        }
        if (status === 402 || isBillingMessage(message)) return new ProviderError("BILLING", "AI provider account has no credit", err);
        if (status === 404) return new ProviderError("MODEL_UNAVAILABLE", "Model not available for this key", err);
        if (status === 429) return new ProviderError("RATE_LIMITED", "AI provider rate limit", err);
        if (status >= 500) return new ProviderError("UNAVAILABLE", `AI provider error ${status}`, err);
        return new ProviderError("BAD_REQUEST", "AI provider rejected the request", err);
    }
    return new ProviderError("UNAVAILABLE", "AI provider unreachable", err);
}
