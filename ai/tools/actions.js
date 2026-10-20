import * as z from "zod";
import { actionBlock, tableBlock } from "../blocks.js";
import { ACTION_DEFINITIONS } from "../actions/definitions.js";
import { ACTION_TTL_MINUTES, createPendingAction } from "../actions/pending.js";
import { cancelAction, confirmAction } from "../actions/execute.js";
import { isWriteModeOn } from "../actions/mode.js";
import { ToolError, idString, limitField, searchString, ymd } from "./common.js";

/**
 * Read-write mode tools.
 *
 * - send_whatsapp, send_email, share_client_documents, share_ledger_statement only PREPARE a
 *   pending action (validated recipient, channel, permission, content) and return a
 *   confirmation card. Nothing is sent by these tools.
 * - In the OOMS app the user confirms by clicking the card (POST /ai/actions/:id/confirm);
 *   the model has no confirm tool there.
 * - For connectors (source mcp:<id>) confirm_action / cancel_action exist; MCP clients such
 *   as Claude ask their user before calling a non-read-only tool.
 * - Registered only when ctx.accessMode === "read_write" (branch or connector setting).
 */

const isWriteMode = (ctx) => ctx.accessMode === "read_write";
const isConnector = (ctx) => String(ctx.source || "").startsWith("mcp:");

const DESCRIPTIONS = {
    send_whatsapp:
        "PREPARE a WhatsApp text message to one client or team member of this office (read-write mode). Does NOT send: it returns a confirmation request the user must approve. Requires the office's OOMS Web WhatsApp channel. Resolve the person first with search_parties / search_staff.",
    send_email:
        "PREPARE an email to one client or team member of this office via the office's email settings (read-write mode). Does NOT send: the user must approve it. Write a clear subject and a polite plain-text body signed on behalf of the office.",
    share_client_documents:
        "PREPARE sharing up to 10 of a client's stored documents with that client by WhatsApp and/or email (read-write mode). Does NOT send: the user must approve it. Get document_ids from list_client_documents.",
    share_ledger_statement:
        "PREPARE sharing a client's ledger statement PDF for a period (default this financial year, max 366 days) by WhatsApp and/or email (read-write mode). Does NOT send: the user must approve it.",
};

const writeTools = Object.entries(ACTION_DEFINITIONS).map(([name, def]) => ({
    name,
    description: DESCRIPTIONS[name],
    input: def.input,
    write: true,
    allowed: (ctx) => isWriteMode(ctx) && def.allowed(ctx),
    async handler(ctx, args, deps) {
        const { payload, preview } = await def.prepare(ctx, args, deps);
        const actionId = await createPendingAction(deps.db, {
            branchId: ctx.branch_id,
            username: ctx.username,
            source: ctx.source || "chat",
            type: name,
            payload,
            preview,
        });
        const confirmHow = isConnector(ctx)
            ? "Show the user this summary and ask them to approve; only if they agree, call confirm_action with this action_id (or cancel_action)."
            : "The user must click Confirm on the card shown below your reply. Tell them to review and confirm; do not say it was sent.";
        return {
            data: {
                status: "awaiting_confirmation",
                action_id: actionId,
                summary: { title: preview.title, details: preview.fields, message: preview.body || null, documents: preview.items || null },
                expires_in_minutes: ACTION_TTL_MINUTES,
                instructions: `Nothing has been sent yet. ${confirmHow}`,
            },
            blocks: [actionBlock({ actionId, actionType: name, preview, expiresMinutes: ACTION_TTL_MINUTES })],
        };
    },
}));

const actionIdInput = z.object({ action_id: z.string().trim().regex(/^[0-9a-f-]{36}$/, "action_id from the prepare step") }).strict();

const confirmTool = {
    name: "confirm_action",
    description:
        "SEND a prepared action (WhatsApp, email or document share) after the user has explicitly approved it. Only call this when the user clearly said yes to that exact action.",
    input: actionIdInput,
    write: true,
    destructive: true,
    allowed: (ctx) => isWriteMode(ctx) && isConnector(ctx),
    async handler(ctx, args, deps) {
        const r = await confirmAction({
            db: deps.db,
            senders: deps.senders,
            actionId: args.action_id,
            branchId: ctx.branch_id,
            username: ctx.username,
            isModeOn: (source) => isWriteModeOn(deps.db, ctx.branch_id, source),
            onAudit: deps.onActionAudit,
        });
        if (r.code === "NOT_FOUND") throw new ToolError("NOT_FOUND", r.message);
        if (r.code === "DENIED" || r.code === "MODE_OFF") throw new ToolError("DENIED", r.message);
        if (r.code === "NOT_PENDING") {
            // Already sent, cancelled or expired: say so plainly so the client never reports a second send.
            return { data: { status: "not_pending", current_status: r.status || "unknown", message: r.message } };
        }
        return { data: { status: r.status, message: r.message, channels: r.result?.channels || null } };
    },
};

const cancelTool = {
    name: "cancel_action",
    description: "Cancel a prepared action the user does not want sent.",
    input: actionIdInput,
    write: true,
    allowed: (ctx) => isWriteMode(ctx) && isConnector(ctx),
    async handler(ctx, args, deps) {
        const r = await cancelAction({ db: deps.db, actionId: args.action_id, branchId: ctx.branch_id, username: ctx.username });
        if (r.code === "NOT_FOUND") throw new ToolError("NOT_FOUND", r.message);
        return { data: { status: r.status, message: r.message } };
    },
};

const STANDARD_CATEGORIES = { GST: "GST", IT: "Income Tax", MCA: "MCA", TASK: "Task", SHARABLE: "Shared by client" };

/** Read tool (both modes): a client's stored documents, to pick what to share. */
const listClientDocuments = {
    name: "list_client_documents",
    description:
        "List a client's stored documents (name, category, firm, date) so you can refer to them or share them. Optional search on the document name.",
    input: z.object({
        client_username: idString("client_username"),
        search: searchString.optional(),
        limit: limitField,
    }).strict(),
    allowed: () => true,
    async handler(ctx, args, deps) {
        const params = [ctx.branch_id, args.client_username];
        let where = "";
        if (args.search) {
            where = "AND d.name LIKE ?";
            params.push(`%${args.search}%`);
        }
        const [[client]] = await deps.db.query(
            "SELECT username FROM clients WHERE branch_id = ? AND username = ? AND user_type = 'client' AND is_deleted = '0' LIMIT 1",
            [ctx.branch_id, args.client_username]
        );
        if (!client) throw new ToolError("NOT_FOUND", "No client with that username in this office. Use search_parties first.");
        const [rows] = await deps.db.query(
            `SELECT d.document_id, d.name, d.category_id, d.create_date, d.f_year, f.firm_name, dc.name AS category_name
             FROM documents d
             LEFT JOIN firms f ON f.firm_id = d.firm_id AND f.branch_id = d.branch_id
             LEFT JOIN document_categories dc ON dc.category_id = d.category_id AND dc.branch_id = d.branch_id
             WHERE d.branch_id = ? AND d.username = ? AND d.is_deleted = '0' AND d.file IS NOT NULL AND d.file <> '' ${where}
             ORDER BY d.create_date DESC, d.id DESC
             LIMIT ?`,
            [...params, args.limit + 1]
        );
        const truncated = rows.length > args.limit;
        const documents = rows.slice(0, args.limit).map((r) => ({
            document_id: r.document_id,
            name: r.name || "Document",
            category: STANDARD_CATEGORIES[String(r.category_id || "").toUpperCase()] || r.category_name || "General",
            firm: r.firm_name || null,
            financial_year: r.f_year || null,
            added_on: ymd(r.create_date),
        }));
        return {
            data: { documents, count: documents.length, truncated },
            blocks: documents.length
                ? [tableBlock({
                    title: "Client documents",
                    columns: [
                        { key: "name", label: "Document" },
                        { key: "category", label: "Category" },
                        { key: "firm", label: "Firm" },
                        { key: "added_on", label: "Added", type: "date" },
                    ],
                    rows: documents,
                    truncated,
                })]
                : [],
        };
    },
};

export default [listClientDocuments, ...writeTools, confirmTool, cancelTool];
