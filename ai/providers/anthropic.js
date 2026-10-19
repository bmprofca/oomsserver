import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, isBillingMessage } from "./errors.js";

/**
 * Claude provider (official @anthropic-ai/sdk). The orchestrator speaks the Messages API
 * shape (content blocks, tool_use / tool_result) natively; the other adapters translate to it.
 *
 * - API key, model and effort come from the branch's settings (branch_ai_settings).
 * - Adaptive thinking is the model default; effort is set explicitly.
 * - Server-side refusal fallback ("default" routing) is enabled.
 * - Top-level cache_control caches the stable prefix (tools + system prompt).
 */
export function createAnthropicProvider({ apiKey, model, effort = "medium", client: injected } = {}) {
    if (!apiKey) {
        throw new ProviderError("NOT_CONFIGURED", "No API key configured for this branch");
    }
    const client = injected || new Anthropic({ apiKey, maxRetries: 1 });
    const effortLevel = ["low", "medium", "high"].includes(effort) ? effort : "medium";

    return {
        name: "anthropic",
        model,
        /**
         * @param {{system: string, messages: object[], tools: object[], maxTokens: number,
         *          disableTools?: boolean, signal?: AbortSignal, timeoutMs?: number}} req
         */
        async createMessage({ system, messages, tools, maxTokens, disableTools = false, signal, timeoutMs }) {
            const params = {
                model,
                max_tokens: maxTokens,
                system,
                messages,
                cache_control: { type: "ephemeral" },
                output_config: { effort: effortLevel },
                ...(tools?.length ? { tools, tool_choice: { type: disableTools ? "none" : "auto" } } : {}),
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default",
            };
            try {
                return await client.beta.messages.create(params, { signal, timeout: timeoutMs });
            } catch (err) {
                throw mapError(err);
            }
        },
        /** Cheap credential check (no tokens used): looks up the configured model. */
        async verify({ timeoutMs = 15000 } = {}) {
            try {
                await client.models.retrieve(model, null, { timeout: timeoutMs });
                return true;
            } catch (err) {
                throw mapError(err);
            }
        },
    };
}

function mapError(err) {
    if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("ABORTED", "Request aborted", err);
    if (err instanceof Anthropic.RateLimitError) return new ProviderError("RATE_LIMITED", "AI provider rate limit", err);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return new ProviderError("INVALID_KEY", "AI provider rejected the credentials", err);
    }
    if (err instanceof Anthropic.NotFoundError) return new ProviderError("MODEL_UNAVAILABLE", "Model not available for this key", err);
    if (err instanceof Anthropic.BadRequestError) {
        if (isBillingMessage(err.message)) return new ProviderError("BILLING", "AI provider account has no credit", err);
        return new ProviderError("BAD_REQUEST", "AI provider rejected the request", err);
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("TIMEOUT", "AI provider timed out", err);
    if (err instanceof Anthropic.APIConnectionError) return new ProviderError("UNAVAILABLE", "AI provider unreachable", err);
    if (err instanceof Anthropic.APIError) {
        return new ProviderError(err.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST", `AI provider error ${err.status}`, err);
    }
    return new ProviderError("UNAVAILABLE", "AI provider failed", err);
}
