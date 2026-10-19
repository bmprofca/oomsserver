/**
 * Helpers shared by the non-Anthropic adapters.
 *
 * Internal (canonical) format = Anthropic Messages shape, which the orchestrator speaks:
 *   { role: "user" | "assistant", content: string | Block[] }
 *   Block: {type:"text", text} | {type:"tool_use", id, name, input} | {type:"tool_result", tool_use_id, content, is_error?}
 *
 * Each adapter returns { stop_reason, content, usage } in that shape. The vendor's raw
 * assistant output is kept in a `vendor` block on the same turn so it can be replayed
 * verbatim on the next call (OpenAI encrypted reasoning, Gemini thought signatures,
 * DeepSeek reasoning_content). Vendor blocks only ever go back to the adapter that made them.
 */

export const VENDOR_BLOCK = "vendor";
export const EFFORTS = ["low", "medium", "high"];

export function vendorDataOf(content, provider) {
    if (!Array.isArray(content)) return null;
    const block = content.find((b) => b?.type === VENDOR_BLOCK && b.provider === provider);
    return block ? block.data : null;
}

/** Tool arguments arrive as a JSON string; invalid JSON becomes an input the strict schema rejects. */
export function parseToolArguments(raw) {
    if (raw && typeof raw === "object") return raw;
    if (raw === undefined || raw === null || raw === "") return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { _invalid_arguments: true };
    } catch (_) {
        return { _invalid_arguments: true };
    }
}

/** Map tool_use id → tool name across the conversation (tool results only carry the id). */
export function toolNameLookup(messages) {
    const names = new Map();
    for (const m of messages) {
        if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);
    }
    return names;
}

export function normalizedResponse({ content, stopReason, inputTokens, outputTokens }) {
    return {
        stop_reason: stopReason,
        content,
        usage: { input_tokens: Number(inputTokens) || 0, output_tokens: Number(outputTokens) || 0 },
    };
}

/**
 * Fold plain-text history (turns before the current question) into the question itself.
 * Used where the vendor requires reasoning data on every earlier assistant turn, which
 * stored history does not have. Returns a new message array.
 */
export function foldHistoryIntoQuestion(messages) {
    let current = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user" && typeof messages[i].content === "string") {
            current = i;
            break;
        }
    }
    if (current <= 0) return messages;
    const earlier = messages.slice(0, current).filter((m) => typeof m.content === "string" && m.content.trim());
    if (!earlier.length) return messages.slice(current);
    const transcript = earlier.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n\n");
    return [
        {
            role: "user",
            content: `Earlier in this conversation (context only):\n\n${transcript}\n\n---\nCurrent question:\n${messages[current].content}`,
        },
        ...messages.slice(current + 1),
    ];
}
