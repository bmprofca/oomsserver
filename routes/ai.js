import express from "express";
import crypto from "crypto";
import * as z from "zod";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { createAiRateLimiter, aiRateLimit } from "../middleware/aiRateLimit.js";
import { resolveUserAccess } from "../helpers/permissionCheck.js";
import { getAiConfig } from "../ai/config.js";
import { todayIst } from "../ai/dateRange.js";
import { createDefaultDeps } from "../ai/deps.js";
import { createMcpForRequest } from "../ai/mcp/createMcpForRequest.js";
import { runChat, buildHistory } from "../ai/orchestrator.js";
import { buildSystemPrompt } from "../ai/prompts/system.js";
import { getProviderForConnection, createProvider } from "../ai/providers/index.js";
import { ProviderError } from "../ai/providers/errors.js";
import { ensureAiTables } from "../ai/schema.js";
import { AI_PROVIDER_IDS, MODEL_ID_PATTERN, getProviderInfo, publicProviderCatalog } from "../ai/providers/catalog.js";
import { AI_ACCESS_MODES, AI_EFFORTS, getBranchAiSettings, saveBranchAiSettings } from "../ai/settings.js";
import { cancelAction, confirmAction } from "../ai/actions/execute.js";
import { getActionStates, getPendingAction } from "../ai/actions/pending.js";
import { isWriteModeOn } from "../ai/actions/mode.js";
import {
    MAX_CONNECTIONS,
    createConnection,
    deleteConnection,
    getConnectionWithKey,
    getRuntimeConnections,
    listConnections,
    recordConnectionStatus,
    reorderConnections,
    updateConnection,
} from "../ai/connections.js";
import { createHealthTracker, runWithFailover } from "../ai/failover.js";
import { checkQuestion, createSafetyLimiter } from "../ai/safety.js";
import { createConnectorLimiter } from "./mcpRemote.js";
import {
    MAX_MCP_CONNECTORS,
    connectorBaseUrl,
    createMcpConnector,
    deleteMcpConnector,
    getMcpConnector,
    listConnectorMembers,
    listMcpConnectors,
    rotateMcpConnector,
    updateMcpConnector,
} from "../ai/mcpConnectors.js";
import * as store from "../ai/store.js";
import { collectIdentifiers, sanitizeBlock, scrubText } from "../ai/redact.js";
import { aiLog, hashUser } from "../ai/log.js";

/**
 * AI assistant API (mounted at /api/v1/ai). Configuration is per branch, managed by branch
 * admins — no environment variables.
 *
 *   GET    /status                     is the assistant available for this branch? (any member)
 *   GET    /settings                   branch switch, rate limits, connections (keys masked) (admin)
 *   PUT    /settings                   save branch switch + rate limits (admin)
 *   POST   /settings/test              test an unsaved provider/key/model (admin)
 *   POST   /connections                add a connection (admin)
 *   PATCH  /connections/:id            edit / enable / disable / replace key (admin)
 *   DELETE /connections/:id            delete a connection and its key (admin)
 *   PUT    /connections/order          set failover priority (admin)
 *   POST   /connections/:id/test       test a saved connection (admin)
 *   GET    /mcp-connectors             remote MCP connectors (Claude custom connector) (admin)
 *   POST   /mcp-connectors             create one (optionally read & write); returns its secret URL once (admin)
 *   PATCH  /mcp-connectors/:id         rename / switch on-off / change member (admin)
 *   POST   /mcp-connectors/:id/rotate  new secret URL; the old one stops working (admin)
 *   DELETE /mcp-connectors/:id         delete (admin)
 *   GET    /actions/:id                state of a write action proposed in chat
 *   POST   /actions/:id/confirm        a person confirms → the action is sent (read-write mode)
 *   POST   /actions/:id/cancel         a person cancels the action
 *   POST   /chat                       ask a question (SSE stream, or JSON with stream:false)
 *   GET    /conversations              own conversations in this branch
 *   GET    /conversations/:id          messages of one own conversation
 *   DELETE /conversations/:id          soft delete one own conversation
 *
 * Identity, branch and permissions come only from auth + validateBranch + resolveUserAccess.
 * Every question passes the safety guard (ai/safety.js) before any AI provider is called.
 */

const ADMIN_SETTINGS_HINT = "Ask your branch admin to check Settings → AI Assistant.";
const FRIENDLY_ERRORS = {
    RATE_LIMITED: { code: "AI_PROVIDER_BUSY", message: "The AI service is busy right now. Please try again in a minute." },
    NOT_CONFIGURED: { code: "AI_NOT_CONFIGURED", message: `The AI assistant has no active AI connection for this office. ${ADMIN_SETTINGS_HINT}` },
    BILLING: { code: "AI_NO_CREDIT", message: `The AI provider account for this office has run out of credit. ${ADMIN_SETTINGS_HINT}` },
    INVALID_KEY: { code: "AI_INVALID_KEY", message: `The AI API key for this office was rejected. ${ADMIN_SETTINGS_HINT}` },
    MODEL_UNAVAILABLE: { code: "AI_MODEL_UNAVAILABLE", message: `The selected AI model is not available for this API key. ${ADMIN_SETTINGS_HINT}` },
    UNAVAILABLE: { code: "AI_PROVIDER_UNAVAILABLE", message: "The AI service is temporarily unavailable. Please try again." },
    BAD_REQUEST: { code: "AI_PROVIDER_UNAVAILABLE", message: "The AI service could not process this question. Please rephrase and try again." },
    TIMEOUT: { code: "AI_TIMEOUT", message: "This took too long. Please try a narrower question." },
    ALL_FAILED: { code: "AI_ALL_CONNECTIONS_FAILED", message: `None of this office's AI connections could answer right now. ${ADMIN_SETTINGS_HINT}` },
};

const modelId = z.string().trim().regex(MODEL_ID_PATTERN, "Enter a valid model ID");
const apiKeyInput = z.string().trim().min(1).max(400);
const label = z.string().trim().max(60).regex(/^[^<>{}`]*$/, "Label contains characters that are not allowed");
const CONNECTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function keyFormatError(providerId, apiKey) {
    const info = getProviderInfo(providerId);
    if (!apiKey || !info || info.keyPattern.test(apiKey)) return null;
    return `This does not look like a ${info.label} API key (${info.keyPlaceholder})`;
}

const accessModeFields = {
    access_mode: z.enum(AI_ACCESS_MODES).optional(),
    // Switching to read-write must be explicitly acknowledged (the settings page shows a confirmation).
    acknowledge_write: z.boolean().optional(),
};
const requireAcknowledgement = (body, ctx) => {
    if (body.access_mode === "read_write" && body.acknowledge_write !== true) {
        ctx.addIssue({ code: "custom", path: ["acknowledge_write"], message: "Confirm that the assistant may send messages and share documents" });
    }
};

const settingsSchema = z.object({
    enabled: z.boolean(),
    rate_per_min: z.number().int().min(1).max(60),
    rate_per_day: z.number().int().min(1).max(5000),
    ...accessModeFields,
}).strict().superRefine(requireAcknowledgement);

const createConnectionSchema = z.object({
    label: label.optional(),
    provider: z.enum(AI_PROVIDER_IDS),
    model: modelId,
    effort: z.enum(AI_EFFORTS).default("medium"),
    api_key: apiKeyInput,
    enabled: z.boolean().default(true),
}).strict();

const updateConnectionSchema = z.object({
    label: label.optional(),
    provider: z.enum(AI_PROVIDER_IDS).optional(),
    model: modelId.optional(),
    effort: z.enum(AI_EFFORTS).optional(),
    api_key: apiKeyInput.optional(),
    enabled: z.boolean().optional(),
}).strict();

const orderSchema = z.object({ ids: z.array(z.string().regex(CONNECTION_ID_RE)).min(1).max(MAX_CONNECTIONS) }).strict();

const memberId = z.string().trim().regex(/^[A-Za-z0-9_.@-]{1,100}$/, "Choose a team member");
const createMcpSchema = z.object({ label: label.optional(), run_as: memberId, ...accessModeFields }).strict().superRefine(requireAcknowledgement);
const updateMcpSchema = z.object({ label: label.optional(), enabled: z.boolean().optional(), run_as: memberId.optional(), ...accessModeFields }).strict().superRefine(requireAcknowledgement);

const testSchema = z.object({
    provider: z.enum(AI_PROVIDER_IDS),
    api_key: apiKeyInput,
    model: modelId,
    effort: z.enum(AI_EFFORTS).optional(),
}).strict();

function zodMessage(error) {
    return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ").slice(0, 300);
}

export function createAiRouter({
    db = pool,
    deps = createDefaultDeps(),
    getProvider = getProviderForConnection,
    buildTestProvider = createProvider,
    limiter = createAiRateLimiter(),
    health = createHealthTracker(),
    safetyLimiter = createSafetyLimiter(),
    authMiddleware = [auth, validateBranch],
} = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        req.cid = crypto.randomUUID();
        res.setHeader("X-Correlation-Id", req.cid);
        next();
    });

    router.use(...authMiddleware);

    // Tables are created on first use (no manual migration needed).
    router.use(async (req, res, next) => {
        try {
            await ensureAiTables(db);
            next();
        } catch (err) {
            aiLog("schema_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "AI assistant storage is unavailable" });
        }
    });

    // Build the trusted, frozen request context once.
    router.use(async (req, res, next) => {
        try {
            const username = String(req.headers.username || "");
            const access = await resolveUserAccess(db, username, req.branch_id);
            if (!access.isMapped) return res.status(403).json({ success: false, message: "User is not mapped to this branch" });
            req.aiCtx = Object.freeze({
                username,
                branch_id: req.branch_id,
                isAdmin: access.isAdmin,
                permissions: access.permissions,
                today: todayIst(),
                correlationId: req.cid,
            });
            next();
        } catch (err) {
            aiLog("context_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to load your permissions" });
        }
    });

    const requireBranchAdmin = (req, res, next) => {
        if (!req.aiCtx.isAdmin) {
            return res.status(403).json({ success: false, code: "AI_ADMIN_ONLY", message: "Only a branch admin can manage AI settings." });
        }
        next();
    };

    const validConnectionId = (req, res, next) => {
        if (!CONNECTION_ID_RE.test(String(req.params.id || ""))) return res.status(404).json({ success: false, message: "Connection not found" });
        next();
    };

    const adminLog = (req, event, extra = {}) =>
        aiLog(event, { cid: req.cid, branch_id: req.aiCtx.branch_id, user: hashUser(req.aiCtx.username), ...extra });

    /** Verify key + model with the provider: model lookup, then one tiny generation (credit check). */
    async function verifyCredentials({ provider: providerId, apiKey, model, effort = "low" }) {
        const info = getProviderInfo(providerId);
        const name = info?.label || "the AI provider";
        try {
            const provider = buildTestProvider({ provider: providerId, apiKey, model, effort });
            await provider.verify();
            await provider.createMessage({
                system: "Reply with the single word OK.",
                messages: [{ role: "user", content: "ping" }],
                tools: [],
                maxTokens: 16,
                timeoutMs: 20000,
            });
            return { ok: true, status: "ok", message: "Connection successful. The API key works with the selected model." };
        } catch (err) {
            const code = err instanceof ProviderError ? err.code : "UNAVAILABLE";
            const friendly = FRIENDLY_ERRORS[code] || FRIENDLY_ERRORS.UNAVAILABLE;
            const message = code === "BILLING"
                ? `The API key is valid, but the ${name} account has no credit. Add credits on the provider's billing page, then test again.`
                : code === "INVALID_KEY"
                    ? `The API key was rejected by ${name}. Check that it is correct and active.`
                    : code === "MODEL_UNAVAILABLE"
                        ? "This API key cannot use the selected model."
                        : friendly.message;
            return { ok: false, status: code, code: friendly.code, message };
        }
    }

    const settingsPayload = async (branchId) => ({
        settings: await getBranchAiSettings(db, branchId),
        connections: await listConnections(db, branchId),
        providers: publicProviderCatalog(),
        efforts: AI_EFFORTS,
        limits: { max_connections: MAX_CONNECTIONS },
    });

    /* ---------------------------- status & settings ---------------------------- */

    router.get("/status", async (req, res) => {
        try {
            const s = await getBranchAiSettings(db, req.aiCtx.branch_id);
            const connections = await listConnections(db, req.aiCtx.branch_id);
            const active = connections.some((c) => c.enabled);
            res.json({
                success: true,
                data: { enabled: s.enabled && active, configured: connections.length > 0, can_manage: req.aiCtx.isAdmin, access_mode: s.access_mode },
            });
        } catch (err) {
            res.status(500).json({ success: false, message: "Failed to load AI status" });
        }
    });

    router.get("/settings", requireBranchAdmin, async (req, res) => {
        try {
            res.json({ success: true, data: await settingsPayload(req.aiCtx.branch_id) });
        } catch (err) {
            aiLog("settings_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to load AI settings" });
        }
    });

    router.put("/settings", requireBranchAdmin, async (req, res) => {
        const parsed = settingsSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ success: false, code: "INVALID_SETTINGS", message: zodMessage(parsed.error) });
        const body = parsed.data;
        try {
            if (body.enabled) {
                const connections = await listConnections(db, req.aiCtx.branch_id);
                if (!connections.some((c) => c.enabled)) {
                    return res.status(400).json({ success: false, code: "NO_ACTIVE_CONNECTION", message: "Add and switch on at least one AI connection before enabling the assistant." });
                }
            }
            const before = await getBranchAiSettings(db, req.aiCtx.branch_id);
            await saveBranchAiSettings(db, req.aiCtx.branch_id, req.aiCtx.username, {
                enabled: body.enabled,
                ratePerMin: body.rate_per_min,
                ratePerDay: body.rate_per_day,
                accessMode: body.access_mode,
            });
            adminLog(req, "settings_updated", { status: body.enabled ? "enabled" : "disabled" });
            if (body.access_mode && body.access_mode !== before.access_mode) adminLog(req, "access_mode_changed", { status: body.access_mode });
            res.json({ success: true, data: await settingsPayload(req.aiCtx.branch_id) });
        } catch (err) {
            aiLog("settings_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to save AI settings" });
        }
    });

    router.post("/settings/test", requireBranchAdmin, async (req, res) => {
        const parsed = testSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ success: false, code: "INVALID_KEY_FORMAT", message: zodMessage(parsed.error) });
        const formatError = keyFormatError(parsed.data.provider, parsed.data.api_key);
        if (formatError) return res.status(400).json({ success: false, code: "INVALID_KEY_FORMAT", message: formatError });
        const result = await verifyCredentials({ provider: parsed.data.provider, apiKey: parsed.data.api_key, model: parsed.data.model, effort: parsed.data.effort });
        adminLog(req, "connection_test", { provider: parsed.data.provider, status: result.status });
        const { status, ...data } = result;
        res.json({ success: true, data });
    });

    /* -------------------------------- connections ------------------------------- */

    router.post("/connections", requireBranchAdmin, async (req, res) => {
        const parsed = createConnectionSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ success: false, code: "INVALID_CONNECTION", message: zodMessage(parsed.error) });
        const body = parsed.data;
        const formatError = keyFormatError(body.provider, body.api_key);
        if (formatError) return res.status(400).json({ success: false, code: "INVALID_KEY_FORMAT", message: formatError });
        try {
            const id = await createConnection(db, req.aiCtx.branch_id, req.aiCtx.username, {
                label: body.label,
                provider: body.provider,
                model: body.model,
                effort: body.effort,
                apiKey: body.api_key,
                enabled: body.enabled,
            });
            adminLog(req, "connection_added", { provider: body.provider, model: body.model });
            res.status(201).json({ success: true, data: { id, ...(await settingsPayload(req.aiCtx.branch_id)) } });
        } catch (err) {
            if (err?.code === "CONNECTION_LIMIT") return res.status(400).json({ success: false, code: "CONNECTION_LIMIT", message: err.message });
            aiLog("connection_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to add the connection" });
        }
    });

    router.patch("/connections/:id", requireBranchAdmin, validConnectionId, async (req, res) => {
        const parsed = updateConnectionSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ success: false, code: "INVALID_CONNECTION", message: zodMessage(parsed.error) });
        const body = parsed.data;
        try {
            const existing = await getConnectionWithKey(db, req.aiCtx.branch_id, req.params.id);
            if (!existing) return res.status(404).json({ success: false, message: "Connection not found" });
            const providerChanges = body.provider && body.provider !== existing.provider;
            if (providerChanges && !body.api_key) {
                return res.status(400).json({ success: false, code: "API_KEY_REQUIRED", message: "Enter an API key for the new provider." });
            }
            const formatError = keyFormatError(body.provider || existing.provider, body.api_key);
            if (formatError) return res.status(400).json({ success: false, code: "INVALID_KEY_FORMAT", message: formatError });
            await updateConnection(db, req.aiCtx.branch_id, req.aiCtx.username, req.params.id, {
                label: body.label,
                provider: body.provider,
                model: body.model,
                effort: body.effort,
                enabled: body.enabled,
                apiKey: body.api_key,
            });
            health.markOk(req.params.id); // edited: give it a fresh chance
            adminLog(req, "connection_updated", { provider: body.provider || existing.provider, key_replaced: Boolean(body.api_key) });
            res.json({ success: true, data: await settingsPayload(req.aiCtx.branch_id) });
        } catch (err) {
            aiLog("connection_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to update the connection" });
        }
    });

    router.delete("/connections/:id", requireBranchAdmin, validConnectionId, async (req, res) => {
        try {
            const ok = await deleteConnection(db, req.aiCtx.branch_id, req.params.id);
            if (!ok) return res.status(404).json({ success: false, message: "Connection not found" });
            adminLog(req, "connection_deleted");
            res.json({ success: true, data: await settingsPayload(req.aiCtx.branch_id) });
        } catch (err) {
            aiLog("connection_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to delete the connection" });
        }
    });

    router.put("/connections/order", requireBranchAdmin, async (req, res) => {
        const parsed = orderSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ success: false, code: "INVALID_ORDER", message: zodMessage(parsed.error) });
        try {
            const ok = await reorderConnections(db, req.aiCtx.branch_id, req.aiCtx.username, parsed.data.ids);
            if (!ok) return res.status(400).json({ success: false, code: "INVALID_ORDER", message: "The list of connections changed. Reload the page and try again." });
            adminLog(req, "connections_reordered");
            res.json({ success: true, data: await settingsPayload(req.aiCtx.branch_id) });
        } catch (err) {
            aiLog("connection_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to save the order" });
        }
    });

    router.post("/connections/:id/test", requireBranchAdmin, validConnectionId, async (req, res) => {
        try {
            const connection = await getConnectionWithKey(db, req.aiCtx.branch_id, req.params.id);
            if (!connection) return res.status(404).json({ success: false, message: "Connection not found" });
            if (!connection.apiKey) {
                return res.json({ success: true, data: { ok: false, code: "AI_INVALID_KEY", message: "The saved key can no longer be read. Replace the key." } });
            }
            const result = await verifyCredentials(connection);
            await recordConnectionStatus(db, req.aiCtx.branch_id, connection.id, result.status);
            if (result.ok) health.markOk(connection.id);
            else health.markFailed(connection.id, result.status);
            adminLog(req, "connection_test", { provider: connection.provider, status: result.status });
            const { status, ...data } = result;
            res.json({ success: true, data: { ...data, connections: await listConnections(db, req.aiCtx.branch_id) } });
        } catch (err) {
            aiLog("connection_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to test the connection" });
        }
    });

    /* ------------------------- remote MCP connectors (Claude) ------------------------- */

    const mcpPayload = async (req) => {
        const url = connectorBaseUrl(req);
        return {
            connectors: await listMcpConnectors(db, req.aiCtx.branch_id),
            members: await listConnectorMembers(db, req.aiCtx.branch_id),
            endpoint: url.endpoint,
            public: url.public,
            limits: { max_connectors: MAX_MCP_CONNECTORS },
        };
    };
    const connectorUrl = (req, token) => `${connectorBaseUrl(req).endpoint}/${token}`;
    const isActiveMember = async (branchId, username) =>
        (await listConnectorMembers(db, branchId)).some((m) => m.username === username);

    router.get("/mcp-connectors", requireBranchAdmin, async (req, res) => {
        try {
            res.json({ success: true, data: await mcpPayload(req) });
        } catch (err) {
            aiLog("mcp_connector_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to load connectors" });
        }
    });

    router.post("/mcp-connectors", requireBranchAdmin, async (req, res) => {
        const parsed = createMcpSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ success: false, code: "INVALID_CONNECTOR", message: zodMessage(parsed.error) });
        try {
            if (!(await isActiveMember(req.aiCtx.branch_id, parsed.data.run_as))) {
                return res.status(400).json({ success: false, code: "INVALID_MEMBER", message: "Choose an active team member of this branch." });
            }
            const { id, token } = await createMcpConnector(db, req.aiCtx.branch_id, req.aiCtx.username, {
                label: parsed.data.label,
                runAs: parsed.data.run_as,
                accessMode: parsed.data.access_mode,
            });
            adminLog(req, "mcp_connector_created", { member: hashUser(parsed.data.run_as), access_mode: parsed.data.access_mode || "read" });
            res.status(201).json({ success: true, data: { id, url: connectorUrl(req, token), ...(await mcpPayload(req)) } });
        } catch (err) {
            if (err?.code === "CONNECTOR_LIMIT") return res.status(400).json({ success: false, code: "CONNECTOR_LIMIT", message: err.message });
            aiLog("mcp_connector_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to create the connector" });
        }
    });

    router.patch("/mcp-connectors/:id", requireBranchAdmin, validConnectionId, async (req, res) => {
        const parsed = updateMcpSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ success: false, code: "INVALID_CONNECTOR", message: zodMessage(parsed.error) });
        try {
            if (!(await getMcpConnector(db, req.aiCtx.branch_id, req.params.id))) return res.status(404).json({ success: false, message: "Connector not found" });
            if (parsed.data.run_as && !(await isActiveMember(req.aiCtx.branch_id, parsed.data.run_as))) {
                return res.status(400).json({ success: false, code: "INVALID_MEMBER", message: "Choose an active team member of this branch." });
            }
            await updateMcpConnector(db, req.aiCtx.branch_id, req.aiCtx.username, req.params.id, {
                label: parsed.data.label,
                enabled: parsed.data.enabled,
                runAs: parsed.data.run_as,
                accessMode: parsed.data.access_mode,
            });
            adminLog(req, "mcp_connector_updated", parsed.data.access_mode ? { status: parsed.data.access_mode } : {});
            res.json({ success: true, data: await mcpPayload(req) });
        } catch (err) {
            aiLog("mcp_connector_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to update the connector" });
        }
    });

    router.post("/mcp-connectors/:id/rotate", requireBranchAdmin, validConnectionId, async (req, res) => {
        try {
            const token = await rotateMcpConnector(db, req.aiCtx.branch_id, req.aiCtx.username, req.params.id);
            if (!token) return res.status(404).json({ success: false, message: "Connector not found" });
            adminLog(req, "mcp_connector_rotated");
            res.json({ success: true, data: { id: req.params.id, url: connectorUrl(req, token), ...(await mcpPayload(req)) } });
        } catch (err) {
            aiLog("mcp_connector_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to regenerate the URL" });
        }
    });

    router.delete("/mcp-connectors/:id", requireBranchAdmin, validConnectionId, async (req, res) => {
        try {
            const ok = await deleteMcpConnector(db, req.aiCtx.branch_id, req.params.id);
            if (!ok) return res.status(404).json({ success: false, message: "Connector not found" });
            adminLog(req, "mcp_connector_deleted");
            res.json({ success: true, data: await mcpPayload(req) });
        } catch (err) {
            aiLog("mcp_connector_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to delete the connector" });
        }
    });

    /* ------------------------------- conversations ------------------------------ */

    router.get("/conversations", async (req, res) => {
        try {
            const page = Math.min(50, Math.max(1, Number(req.query.page) || 1));
            const rows = await store.listConversations(db, {
                branchId: req.aiCtx.branch_id,
                username: req.aiCtx.username,
                limit: 20,
                offset: (page - 1) * 20,
            });
            res.json({ success: true, data: rows, page });
        } catch (err) {
            aiLog("list_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to load conversations" });
        }
    });

    router.get("/conversations/:id", async (req, res) => {
        try {
            const owner = { conversationId: req.params.id, branchId: req.aiCtx.branch_id, username: req.aiCtx.username };
            const conversation = await store.getConversation(db, owner);
            if (!conversation) return res.status(404).json({ success: false, message: "Conversation not found" });
            const messages = await store.getMessages(db, { ...owner, limit: 200 });
            // Write-action cards show their current state (pending / sent / cancelled / expired).
            const actionIds = messages.flatMap((m) => (m.blocks || []).filter((b) => b?.type === "action" && b.action_id).map((b) => b.action_id));
            const states = await getActionStates(db, { branchId: req.aiCtx.branch_id, username: req.aiCtx.username, actionIds: [...new Set(actionIds)].slice(0, 200) });
            for (const m of messages) {
                m.blocks = (m.blocks || []).map((b) => (b?.type === "action" && states.has(b.action_id) ? { ...b, state: actionView(states.get(b.action_id)) } : b));
            }
            res.json({
                success: true,
                data: {
                    conversation,
                    // Saved before IDs were hidden? Sanitize on the way out as well.
                    messages: messages.map(({ tool_calls, ...m }) => {
                        const ids = collectIdentifiers([tool_calls || [], (m.blocks || []).map((bl) => bl?.rows || [])]);
                        return { ...m, content: scrubText(m.content, ids), blocks: (m.blocks || []).map((bl) => sanitizeBlock(bl, ids)) };
                    }),
                },
            });
        } catch (err) {
            aiLog("get_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to load conversation" });
        }
    });

    router.delete("/conversations/:id", async (req, res) => {
        try {
            const ok = await store.deleteConversation(db, {
                conversationId: req.params.id,
                branchId: req.aiCtx.branch_id,
                username: req.aiCtx.username,
            });
            if (!ok) return res.status(404).json({ success: false, message: "Conversation not found" });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, message: "Failed to delete conversation" });
        }
    });

    /* ------------------------------- write actions ------------------------------- */

    const ACTION_ID_RE = /^[0-9a-f-]{36}$/;
    const confirmLimiter = createConnectorLimiter({ perMinute: 10, perDay: 300 });
    const actionView = (state) => ({ status: state.status, message: state.result?.message || null, channels: state.result?.channels || null });

    router.get("/actions/:id", async (req, res) => {
        if (!ACTION_ID_RE.test(req.params.id)) return res.status(404).json({ success: false, message: "Action not found" });
        try {
            const action = await getPendingAction(db, { actionId: req.params.id, branchId: req.aiCtx.branch_id, username: req.aiCtx.username });
            if (!action) return res.status(404).json({ success: false, message: "Action not found" });
            res.json({ success: true, data: actionView(action) });
        } catch (err) {
            res.status(500).json({ success: false, message: "Failed to load the action" });
        }
    });

    router.post("/actions/:id/confirm", async (req, res) => {
        if (!ACTION_ID_RE.test(req.params.id)) return res.status(404).json({ success: false, message: "Action not found" });
        if (!confirmLimiter(`${req.aiCtx.branch_id}:${req.aiCtx.username}`)) {
            return res.status(429).json({ success: false, code: "AI_ACTION_RATE_LIMITED", message: "Too many confirmations. Please wait a minute." });
        }
        try {
            const r = await confirmAction({
                db,
                senders: deps.senders,
                actionId: req.params.id,
                branchId: req.aiCtx.branch_id,
                username: req.aiCtx.username,
                isModeOn: (source) => isWriteModeOn(db, req.aiCtx.branch_id, source),
                onAudit: (a) => store.addToolCallAudit(db, [{ ...a, conversationId: "action", branchId: req.aiCtx.branch_id, username: req.aiCtx.username, correlationId: req.cid }]).catch(() => {}),
            });
            aiLog("ai_action", { cid: req.cid, branch_id: req.aiCtx.branch_id, user: hashUser(req.aiCtx.username), status: r.status || r.code, error_code: r.ok ? undefined : r.code });
            if (r.code === "NOT_FOUND") return res.status(404).json({ success: false, message: r.message });
            if (r.code === "DENIED" || r.code === "MODE_OFF") return res.status(403).json({ success: false, code: `AI_ACTION_${r.code}`, message: r.message });
            if (r.code === "NOT_PENDING") return res.status(409).json({ success: false, code: "AI_ACTION_NOT_PENDING", message: r.message, data: { status: r.status, message: r.result?.message || null, channels: r.result?.channels || null } });
            res.json({ success: true, data: { status: r.status, message: r.message, channels: r.result?.channels || null } });
        } catch (err) {
            aiLog("ai_action", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "The action could not be completed." });
        }
    });

    router.post("/actions/:id/cancel", async (req, res) => {
        if (!ACTION_ID_RE.test(req.params.id)) return res.status(404).json({ success: false, message: "Action not found" });
        try {
            const r = await cancelAction({ db, actionId: req.params.id, branchId: req.aiCtx.branch_id, username: req.aiCtx.username });
            if (r.code === "NOT_FOUND") return res.status(404).json({ success: false, message: r.message });
            if (!r.ok) return res.status(409).json({ success: false, code: "AI_ACTION_NOT_PENDING", message: r.message, data: { status: r.status } });
            res.json({ success: true, data: { status: "cancelled", message: r.message } });
        } catch (err) {
            res.status(500).json({ success: false, message: "Failed to cancel the action" });
        }
    });

    /* ------------------------------------ chat ----------------------------------- */

    // Branch must have the assistant switched on and at least one usable connection.
    const requireBranchAi = async (req, res, next) => {
        try {
            const settings = await getBranchAiSettings(db, req.aiCtx.branch_id);
            if (!settings.enabled) {
                return res.status(404).json({ success: false, code: "AI_DISABLED", message: "The AI assistant is not enabled for this office." });
            }
            const connections = await getRuntimeConnections(db, req.aiCtx.branch_id);
            if (!connections.length) {
                return res.status(503).json({ success: false, ...FRIENDLY_ERRORS.NOT_CONFIGURED });
            }
            req.aiSettings = settings;
            req.aiConnections = connections;
            next();
        } catch (err) {
            aiLog("settings_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" });
            res.status(500).json({ success: false, message: "Failed to load AI settings" });
        }
    };

    const safetyKey = (ctx) => `${ctx.branch_id}:${ctx.username}`;

    // Users who keep trying to break the rules are paused for a while.
    const safetyPause = (req, res, next) => {
        const minutes = safetyLimiter.isPaused(safetyKey(req.aiCtx));
        if (minutes) {
            return res.status(429).json({
                success: false,
                code: "AI_SAFETY_PAUSED",
                message: `The assistant is paused for you for about ${minutes} minute${minutes === 1 ? "" : "s"} because several questions were outside what it can answer.`,
            });
        }
        next();
    };

    // Connection health shown on the settings page; "ok" writes are throttled.
    const lastOkWrite = new Map();
    const recordOutcome = (branchId, connection, status) => {
        if (status === "ok") {
            const last = lastOkWrite.get(connection.id) || 0;
            if (Date.now() - last < 60_000 && connection.last_status === "ok") return;
            lastOkWrite.set(connection.id, Date.now());
        }
        recordConnectionStatus(db, branchId, connection.id, status, { used: status === "ok" }).catch((err) =>
            aiLog("health_error", { status: "error", error_code: err?.code || "INTERNAL" })
        );
    };

    router.post("/chat", requireBranchAi, safetyPause, aiRateLimit(limiter), async (req, res) => {
        const ctx = req.aiCtx;
        const config = getAiConfig();
        const started = Date.now();
        const raw = typeof req.body?.message === "string" ? req.body.message : "";
        const wantStream = req.body?.stream !== false;
        const logBase = { cid: req.cid, branch_id: ctx.branch_id, user: hashUser(ctx.username) };

        // 1. Safety first: normalise and check the question before anything else happens.
        const verdict = checkQuestion(raw);
        const message = verdict.text;
        if (!message || message.length > 2000) {
            return res.status(400).json({ success: false, code: "INVALID_MESSAGE", message: "Message must be 1-2000 characters." });
        }

        // Conversation ownership is checked before anything streams.
        let conversationId = req.body?.conversation_id || null;
        let historyRows = [];
        try {
            const owner = { branchId: ctx.branch_id, username: ctx.username };
            if (conversationId) {
                const existing = await store.getConversation(db, { ...owner, conversationId });
                if (!existing) return res.status(404).json({ success: false, message: "Conversation not found" });
                historyRows = await store.getMessages(db, { ...owner, conversationId, limit: config.historyMessages });
            } else {
                conversationId = await store.createConversation(db, { ...owner, title: verdict.ok ? message.slice(0, 80) : "Question not answered" });
            }
            await store.addMessage(db, { ...owner, conversationId, role: "user", content: message, correlationId: req.cid });
        } catch (err) {
            aiLog("chat", { ...logBase, status: "error", error_code: err?.code || "STORE" });
            return res.status(500).json({ success: false, message: "Failed to save your message" });
        }

        const send = (event, data) => {
            if (!wantStream || res.writableEnded) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const startStream = () => {
            if (!wantStream) return;
            res.status(200);
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders?.();
        };

        // 2. Blocked question: fixed reply, no AI provider is called.
        if (!verdict.ok) {
            const paused = safetyLimiter.strike(safetyKey(ctx));
            aiLog("safety_block", { ...logBase, status: "blocked", error_code: verdict.category, paused });
            let messageId = null;
            try {
                messageId = await store.addMessage(db, {
                    branchId: ctx.branch_id,
                    username: ctx.username,
                    conversationId,
                    role: "assistant",
                    content: verdict.reply,
                    status: "refusal",
                    correlationId: req.cid,
                });
            } catch (_) {
                /* the reply is still sent */
            }
            if (wantStream) {
                startStream();
                send("meta", { conversation_id: conversationId, correlation_id: req.cid });
                send("text", { text: verdict.reply });
                send("done", { message_id: messageId, status: "refusal" });
                return res.end();
            }
            return res.json({ success: true, data: { conversation_id: conversationId, message_id: messageId, text: verdict.reply, blocks: [], status: "refusal" } });
        }

        startStream();
        send("meta", { conversation_id: conversationId, correlation_id: req.cid });

        const abort = new AbortController();
        res.on("close", () => {
            if (!res.writableEnded) abort.abort();
        });

        const audits = [];
        let mcp;
        try {
            let branchName = null;
            try {
                const [[branch]] = await db.query("SELECT name FROM branch_list WHERE branch_id = ? LIMIT 1", [ctx.branch_id]);
                branchName = branch?.name || null;
            } catch (_) {
                branchName = null;
            }

            // Read-write mode adds the prepare-only write tools (confirmed by a click on the card).
            const chatCtx = Object.freeze({ ...ctx, accessMode: req.aiSettings.access_mode, source: "chat" });
            mcp = await createMcpForRequest(chatCtx, deps, {
                timeoutMs: config.toolTimeoutMs,
                maxChars: config.toolResultMaxChars,
                onAudit: (a) => audits.push(a),
            });
            const history = buildHistory(historyRows, { maxMessages: config.historyMessages, maxChars: config.maxContextChars });
            const system = buildSystemPrompt({ today: ctx.today, branchName, accessMode: req.aiSettings.access_mode });
            const deadline = started + config.requestTimeoutMs;

            // 3. Ask the highest-priority working connection; fail over to the next on provider errors.
            const { result, connection, attempts } = await runWithFailover({
                connections: req.aiConnections,
                buildProvider: (c) => getProvider(c),
                health,
                attempt: (provider) =>
                    runChat({
                        provider,
                        mcpClient: mcp.client,
                        system,
                        history,
                        userMessage: message,
                        config: { ...config, requestTimeoutMs: Math.max(5000, deadline - Date.now()) },
                        signal: abort.signal,
                        onEvent: (e) => send("status", { label: e.label }),
                    }),
                onSwitch: () => send("status", { label: "Switching to a backup AI service" }),
                onOutcome: (c, status) => recordOutcome(ctx.branch_id, c, status),
                canRetry: () => deadline - Date.now() > 15000 && !abort.signal.aborted,
            });

            if (result.safety) aiLog("safety_answer_blocked", { ...logBase, status: "blocked", error_code: result.safety });

            const modelLabel = `${connection.provider}:${result.model}`.slice(0, 80);
            const messageId = await store.addMessage(db, {
                branchId: ctx.branch_id,
                username: ctx.username,
                conversationId,
                role: "assistant",
                content: result.text,
                blocks: result.blocks,
                toolCalls: result.toolCalls,
                status: result.status,
                model: modelLabel,
                usage: result.usage,
                correlationId: req.cid,
            });

            aiLog("chat", {
                ...logBase,
                status: result.status,
                model: modelLabel,
                connection_priority: connection.priority,
                failover: attempts.map((a) => a.code),
                safety: result.safety || undefined,
                tools: result.toolCalls.map((c) => c.name),
                tool_count: result.toolCalls.length,
                blocks: result.blocks.length,
                input_tokens: result.usage.input_tokens,
                output_tokens: result.usage.output_tokens,
                duration_ms: Date.now() - started,
            });

            const payload = { conversation_id: conversationId, message_id: messageId, text: result.text, blocks: result.blocks, status: result.status };
            if (wantStream) {
                for (const block of result.blocks) send("block", block);
                send("text", { text: result.text });
                send("done", { message_id: messageId, status: result.status });
                res.end();
            } else {
                res.json({ success: true, data: payload });
            }
        } catch (err) {
            if (err instanceof ProviderError && err.code === "ABORTED") {
                aiLog("chat", { ...logBase, status: "aborted", duration_ms: Date.now() - started });
                if (!res.writableEnded) res.end();
                return;
            }
            const tried = err?.attempts?.length || 0;
            const friendly = tried > 1
                ? FRIENDLY_ERRORS.ALL_FAILED
                : (err instanceof ProviderError && FRIENDLY_ERRORS[err.code]) || FRIENDLY_ERRORS.UNAVAILABLE;
            aiLog("chat", {
                ...logBase,
                status: "error",
                error_code: err instanceof ProviderError ? err.code : "INTERNAL",
                failover: (err?.attempts || []).map((a) => a.code),
                duration_ms: Date.now() - started,
            });
            try {
                await store.addMessage(db, {
                    branchId: ctx.branch_id,
                    username: ctx.username,
                    conversationId,
                    role: "assistant",
                    content: friendly.message,
                    status: "error",
                    correlationId: req.cid,
                });
            } catch (_) {
                /* keep the original error */
            }
            if (wantStream) {
                send("error", { ...friendly, conversation_id: conversationId });
                if (!res.writableEnded) res.end();
            } else if (!res.headersSent) {
                res.status(err?.code === "RATE_LIMITED" && tried <= 1 ? 429 : 503).json({ success: false, ...friendly, conversation_id: conversationId });
            }
        } finally {
            await mcp?.close();
            if (audits.length) {
                store.addToolCallAudit(db, audits.map((a) => ({
                    ...a,
                    conversationId,
                    branchId: ctx.branch_id,
                    username: ctx.username,
                    correlationId: req.cid,
                }))).catch((err) => aiLog("audit_error", { cid: req.cid, status: "error", error_code: err?.code || "INTERNAL" }));
            }
        }
    });

    return router;
}

export default createAiRouter();
