/**
 * Test doubles for AI assistant tests. No real database, network or AI provider is used.
 */

/**
 * Fake mysql2-style db: routes each query to the first handler whose regex matches the SQL.
 * Every call is recorded so tests can assert on SQL and parameters (e.g. branch scoping).
 */
export function createFakeDb(handlers = []) {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            calls.push({ sql, params });
            for (const [pattern, fn] of handlers) {
                if (pattern.test(sql)) {
                    const rows = await fn(params, sql);
                    return [rows, []];
                }
            }
            return [[], []];
        },
    };
}

export function makeCtx(overrides = {}) {
    return Object.freeze({
        username: "staff1",
        branch_id: "BR1",
        isAdmin: false,
        permissions: new Set(),
        today: "2026-10-19",
        correlationId: "test-cid",
        ...overrides,
        ...(overrides.permissions ? { permissions: new Set(overrides.permissions) } : {}),
    });
}

/** Scripted provider: returns the queued responses in order and records requests. */
export function createScriptedProvider(responses) {
    const requests = [];
    let i = 0;
    return {
        name: "fake",
        model: "fake-model",
        requests,
        async createMessage(req) {
            requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })));
            const next = responses[Math.min(i, responses.length - 1)];
            i += 1;
            if (next instanceof Error) throw next;
            return typeof next === "function" ? next(req) : next;
        },
    };
}

export function toolUse(id, name, input) {
    return {
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "tool_use", id, name, input }],
    };
}

export function finalText(text) {
    return { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text }] };
}

export const TEST_CONFIG = {
    maxToolIterations: 6,
    maxToolCalls: 12,
    toolTimeoutMs: 2000,
    providerTimeoutMs: 5000,
    requestTimeoutMs: 20000,
    maxOutputTokens: 1000,
    historyMessages: 12,
    maxContextChars: 40000,
    toolResultMaxChars: 12000,
};
