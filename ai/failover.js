import { ProviderError } from "./providers/errors.js";

/**
 * Failover across a branch's AI connections.
 *
 * Connections are tried in priority order. A provider-side failure (no credit, rejected key,
 * unavailable model, rate limit, outage, timeout, rejected request) moves on to the next
 * connection; the question is re-run from the start there, because each vendor keeps its own
 * conversation state. A user abort stops immediately.
 *
 * A failed connection is "cooling down" for a while (in-memory, per process) and is tried
 * after the healthy ones, so users don't wait on a dead connection every time.
 */

export const FAILOVER_CODES = new Set(["BILLING", "INVALID_KEY", "MODEL_UNAVAILABLE", "RATE_LIMITED", "UNAVAILABLE", "TIMEOUT", "BAD_REQUEST", "NOT_CONFIGURED"]);
const COOLDOWN_MS = {
    BILLING: 15 * 60_000,
    INVALID_KEY: 15 * 60_000,
    MODEL_UNAVAILABLE: 15 * 60_000,
    NOT_CONFIGURED: 15 * 60_000,
    RATE_LIMITED: 60_000,
    UNAVAILABLE: 60_000,
    TIMEOUT: 60_000,
    BAD_REQUEST: 60_000,
};
export const MAX_ATTEMPTS = 3;

export function createHealthTracker({ now = () => Date.now() } = {}) {
    const cooling = new Map(); // connection id -> { until, code }
    return {
        markFailed(id, code) {
            const ms = COOLDOWN_MS[code];
            if (ms) cooling.set(id, { until: now() + ms, code });
        },
        markOk(id) {
            cooling.delete(id);
        },
        isCooling(id) {
            const entry = cooling.get(id);
            if (!entry) return false;
            if (entry.until <= now()) {
                cooling.delete(id);
                return false;
            }
            return true;
        },
        /** Healthy connections first (priority order kept), then cooling ones as a last resort. */
        order(connections) {
            const healthy = connections.filter((c) => !this.isCooling(c.id));
            const coolingList = connections.filter((c) => this.isCooling(c.id));
            return [...healthy, ...coolingList];
        },
    };
}

export const defaultHealth = createHealthTracker();

/**
 * @param {object}   p
 * @param {object[]} p.connections   enabled runtime connections, priority order
 * @param {(c) => object} p.buildProvider
 * @param {(provider, c) => Promise<any>} p.attempt   runs the whole question on one provider
 * @param {object}   [p.health]
 * @param {(info: {from: object, to: object, code: string}) => void} [p.onSwitch]
 * @param {(c: object, status: string) => void} [p.onOutcome]   "ok" or an error code
 * @param {() => boolean} [p.canRetry]   false when not enough time is left for another attempt
 * @returns {Promise<{ result: any, connection: object, attempts: {id: string, code: string}[] }>}
 */
export async function runWithFailover({ connections, buildProvider, attempt, health = defaultHealth, onSwitch = () => {}, onOutcome = () => {}, canRetry = () => true }) {
    const ordered = health.order(connections).slice(0, MAX_ATTEMPTS);
    if (!ordered.length) throw new ProviderError("NOT_CONFIGURED", "No enabled AI connection");
    const attempts = [];
    let lastError = null;

    for (let i = 0; i < ordered.length; i++) {
        const connection = ordered[i];
        try {
            const provider = buildProvider(connection);
            const result = await attempt(provider, connection);
            health.markOk(connection.id);
            onOutcome(connection, "ok");
            return { result, connection, attempts };
        } catch (err) {
            const error = err instanceof ProviderError ? err : new ProviderError("UNAVAILABLE", "AI provider failed", err);
            if (error.code === "ABORTED" || !FAILOVER_CODES.has(error.code)) throw error;
            attempts.push({ id: connection.id, code: error.code });
            health.markFailed(connection.id, error.code);
            onOutcome(connection, error.code);
            lastError = error;
            const next = ordered[i + 1];
            if (!next || !canRetry()) break;
            onSwitch({ from: connection, to: next, code: error.code });
        }
    }
    lastError.attempts = attempts;
    throw lastError;
}
