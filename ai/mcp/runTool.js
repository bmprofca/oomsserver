import { ToolError } from "../tools/common.js";
import { collectIdentifiers } from "../redact.js";

export const BLOCKS_META_KEY = "ooms/blocks";
export const IDS_META_KEY = "ooms/ids";

/**
 * Shrink a JSON-able value until its serialisation fits maxChars, by trimming the
 * longest arrays first. The model is told when data was trimmed so it never
 * presents a partial list as complete.
 */
export function truncateForModel(data, maxChars) {
    let text = JSON.stringify(data);
    if (text.length <= maxChars) return text;

    const clone = JSON.parse(text);
    const arrays = [];
    const walk = (node) => {
        if (Array.isArray(node)) {
            arrays.push(node);
            node.forEach(walk);
        } else if (node && typeof node === "object") {
            Object.values(node).forEach(walk);
        }
    };
    walk(clone);
    arrays.sort((a, b) => b.length - a.length);

    for (let i = 0; i < 12 && text.length > maxChars; i++) {
        const target = arrays.find((a) => a.length > 1);
        if (!target) break;
        target.length = Math.max(1, Math.floor(target.length / 2));
        clone._truncated = "Some lists were shortened to fit. Say that more rows exist; totals and summaries are still complete.";
        text = JSON.stringify(clone);
    }
    if (text.length > maxChars) {
        text = JSON.stringify({ _truncated: "Result too large; only a prefix is shown.", prefix: text.slice(0, maxChars - 120) });
    }
    return text;
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error("Tool timed out");
            err.code = "TIMEOUT";
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function countRows(data) {
    if (!data || typeof data !== "object") return null;
    for (const v of Object.values(data)) if (Array.isArray(v)) return v.length;
    return null;
}

/**
 * Execute one tool with defence-in-depth checks. Returns an MCP CallToolResult.
 * Blocks travel in _meta (never shown to the model); the model only sees `content`.
 *
 * @param {object} tool  tool definition from ai/tools
 * @param {object} ctx   frozen server-side auth context
 * @param {object} rawArgs arguments supplied by the model
 * @param {object} deps  { db, getBalance, collectLedger }
 * @param {object} opts  { timeoutMs, maxChars, onAudit }
 */
export async function runTool(tool, ctx, rawArgs, deps, { timeoutMs = 8000, maxChars = 12000, onAudit } = {}) {
    const started = Date.now();
    const audit = (status, extra = {}) => {
        try {
            onAudit?.({ tool: tool.name, args: rawArgs, status, durationMs: Date.now() - started, ...extra });
        } catch (_) {
            /* auditing must never break a tool call */
        }
    };
    const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });

    // Permission re-check even though unauthorised tools are never registered.
    if (!tool.allowed(ctx)) {
        audit("denied", { errorCode: "DENIED" });
        return errorResult("You do not have permission to use this data.");
    }

    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        audit("invalid", { errorCode: "INVALID_ARGS" });
        const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        return errorResult(`Invalid arguments: ${msg}`.slice(0, 500));
    }

    try {
        const result = await withTimeout(Promise.resolve(tool.handler(ctx, parsed.data, deps)), timeoutMs);
        const data = result?.data ?? {};
        const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
        audit("ok", { rowCount: countRows(data) });
        // Internal IDs in this result (full data, not the truncated copy) so the orchestrator
        // can keep them out of anything the user sees.
        const ids = collectIdentifiers(blocks.map((b) => b?.rows || []), collectIdentifiers(data));
        return {
            content: [{ type: "text", text: truncateForModel(data, maxChars) }],
            _meta: { [BLOCKS_META_KEY]: blocks, [IDS_META_KEY]: [...ids] },
        };
    } catch (err) {
        if (err instanceof ToolError) {
            audit(err.code === "DENIED" ? "denied" : err.code === "INVALID" ? "invalid" : "ok", { errorCode: err.code, rowCount: 0 });
            return errorResult(`${err.code}: ${err.message}`);
        }
        if (err?.code === "TIMEOUT") {
            audit("timeout", { errorCode: "TIMEOUT" });
            return errorResult("The query took too long. Suggest a narrower filter or shorter period.");
        }
        // Never leak SQL, stack traces or driver messages to the model or the user.
        audit("error", { errorCode: String(err?.code || "INTERNAL").slice(0, 60) });
        return errorResult("The data could not be loaded because of an internal error.");
    }
}
