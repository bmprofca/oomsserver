/**
 * Supported AI providers, their suggested models and API-key formats. Shared by settings
 * validation (routes/ai.js), the settings page (sent to CLIENT_WEB) and the provider factory.
 *
 * Model lists are suggestions: a branch admin may also enter any other model ID their key
 * can use ("Test connection" checks it). Key patterns are loose sanity checks only — the
 * provider is the real judge.
 */
export const AI_PROVIDER_CATALOG = Object.freeze([
    {
        id: "anthropic",
        label: "Anthropic Claude",
        keyPattern: /^sk-ant-[A-Za-z0-9_-]{10,300}$/,
        keyPlaceholder: "sk-ant-…",
        keyHelp: "Create a key at console.anthropic.com → API Keys.",
        keyUrl: "https://console.anthropic.com/settings/keys",
        supportsEffort: true,
        defaultModel: "claude-sonnet-5-5",
        models: [
            { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (recommended — fast, balanced cost)" },
            { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable, higher cost)" },
            { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, lowest cost)" },
        ],
    },
    {
        id: "openai",
        label: "OpenAI",
        keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/,
        keyPlaceholder: "sk-…",
        keyHelp: "Create a key at platform.openai.com → API keys.",
        keyUrl: "https://platform.openai.com/api-keys",
        supportsEffort: true,
        defaultModel: "gpt-6.1-sol",
        models: [
            { id: "gpt-6.1-sol", label: "GPT-6.1 Sol (recommended — balanced)" },
            { id: "gpt-6-astra", label: "GPT-6 Astra (most capable, higher cost)" },
            { id: "gpt-6-luna", label: "GPT-6 Luna (fastest, lowest cost)" },
        ],
    },
    {
        id: "gemini",
        label: "Google Gemini",
        keyPattern: /^(?!sk-)[A-Za-z0-9._-]{30,300}$/, // never an sk-… key of another provider
        keyPlaceholder: "AIza…",
        keyHelp: "Create a key at aistudio.google.com → Get API key.",
        keyUrl: "https://aistudio.google.com/apikey",
        supportsEffort: true,
        defaultModel: "gemini-3.8-flash",
        models: [
            { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (recommended — fast, balanced)" },
            { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro preview (most capable)" },
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (lowest cost)" },
        ],
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/,
        keyPlaceholder: "sk-…",
        keyHelp: "Create a key at platform.deepseek.com → API keys.",
        keyUrl: "https://platform.deepseek.com/api_keys",
        supportsEffort: true,
        defaultModel: "deepseek-flash",
        models: [
            { id: "deepseek-flash", label: "DeepSeek Flash (recommended — low cost)" },
            { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro (most capable)" },
        ],
    },
]);

export const AI_PROVIDER_IDS = AI_PROVIDER_CATALOG.map((p) => p.id);

/** Any model ID a provider might accept (letters, digits, . _ : / -). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,99}$/;

export function getProviderInfo(id) {
    return AI_PROVIDER_CATALOG.find((p) => p.id === id) || null;
}

/** Catalog as plain JSON for the settings page (RegExp → no pattern sent). */
export function publicProviderCatalog() {
    return AI_PROVIDER_CATALOG.map(({ keyPattern, ...rest }) => rest);
}
