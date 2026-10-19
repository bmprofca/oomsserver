import crypto from "crypto";
import { createAnthropicProvider } from "./anthropic.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { ProviderError } from "./errors.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAIProvider } from "./openai.js";

/**
 * Provider factories. Every provider exposes the same contract:
 *   createMessage({system, messages, tools, maxTokens, disableTools, signal, timeoutMs})
 *     → { stop_reason, content, usage }   (Anthropic Messages shape)
 *   verify({timeoutMs}) → true, or throws ProviderError
 * Add a provider here and in catalog.js; tools, orchestrator and UI stay unchanged.
 */
const FACTORIES = {
    anthropic: createAnthropicProvider,
    openai: createOpenAIProvider,
    gemini: createGeminiProvider,
    deepseek: createDeepSeekProvider,
};

const cache = new Map(); // connection id -> { signature, provider }
const MAX_CACHED = 1000;

/** Build an uncached provider (also used to test a key before saving it). */
export function createProvider({ provider = "anthropic", apiKey, model, effort }) {
    const factory = FACTORIES[provider];
    if (!factory) throw new ProviderError("NOT_CONFIGURED", `Unsupported AI provider "${provider}"`);
    return factory({ apiKey, model, effort });
}

/**
 * Provider for one saved connection (ai/connections.js runtime row with decrypted key).
 * Cached per connection until its provider, model, effort or key changes.
 */
export function getProviderForConnection(connection) {
    const { id, provider, model, effort, apiKey } = connection;
    const signature = `${provider}:${model}:${effort}:${apiKey.length}:${crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
    const hit = cache.get(id);
    if (hit?.signature === signature) return hit.provider;
    const built = createProvider({ provider, apiKey, model, effort });
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(id, { signature, provider: built });
    return built;
}

export { ProviderError };
