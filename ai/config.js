/**
 * Fixed operational limits for the AI assistant. Branch-specific settings (enabled, API key,
 * model, effort, rate limits) live in the database — see ai/settings.js. No environment
 * variables are used for AI configuration.
 */
export const AI_LIMITS = Object.freeze({
    maxToolIterations: 6, // model rounds per question; the last one forces a text answer
    maxToolCalls: 12, // tool executions per question
    toolTimeoutMs: 8000,
    providerTimeoutMs: 45000,
    requestTimeoutMs: 90000,
    maxOutputTokens: 8000, // includes adaptive-thinking tokens
    historyMessages: 12,
    maxContextChars: 40000,
    toolResultMaxChars: 12000,
});

/** Limits merged with a branch's settings (model / effort / rate limits). */
export function getAiConfig(branchSettings = {}) {
    return { ...AI_LIMITS, ...branchSettings };
}
