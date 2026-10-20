import * as z from "zod";
import { ToolError, dateRangeFields, has, resolveRange } from "../tools/common.js";
import { checkAnswer } from "../safety.js";
import { containsInternalId } from "../redact.js";
import { displayPhone, isValidEmail, resolveRecipient, whatsappNumber } from "./recipients.js";

/**
 * Write actions the AI can PROPOSE in read-write mode. Each definition:
 *   allowed(ctx)                     — OOMS permission of the acting user
 *   prepare(ctx, args, deps)         — validate everything up front → { payload, preview }
 *                                      (no side effects; becomes a pending action)
 *   execute(payload, run)            — the real send, only after a person confirms
 *
 * Permissions (server-side, stricter than the app's UI where it has none):
 *   send_whatsapp / send_email       broadcast_send
 *   share_client_documents           any branch member (same as the app's document share)
 *   share_ledger_statement           finance_report (same as viewing the ledger statement)
 */

const CHANNEL_LABEL = { whatsapp: "WhatsApp", email: "Email" };
const WHATSAPP_CHANNEL_LABEL = { "ooms web": "WhatsApp (OOMS Web)", onechatting: "WhatsApp (OneChatting)", "ooms system": "WhatsApp (OOMS System)" };

function recipientLabel(r) {
    return `${r.name} (${r.type === "client" ? "client" : "team member"})`;
}

/** Outgoing text must not carry system details or internal IDs to an outside person. */
function assertSafeOutgoing(text, recipient) {
    if (containsInternalId(text)) throw new ToolError("INVALID", "The message contains internal OOMS identifiers. Rewrite it using names only.");
    const verdict = checkAnswer(text, `${recipient.name}\n${recipient.email}`);
    if (!verdict.ok) throw new ToolError("INVALID", "The message contains system or technical details that cannot be sent. Rewrite it in plain business language.");
}

async function requireRecipient(deps, ctx, type, username) {
    const recipient = await resolveRecipient(deps.db, ctx.branch_id, { type, username });
    if (!recipient) {
        throw new ToolError("NOT_FOUND", type === "client" ? "No client with that username in this office. Use search_parties first." : "No active team member with that username. Use search_staff first.");
    }
    return recipient;
}

/** Check each requested channel can actually deliver to this recipient. */
async function assertChannels(deps, ctx, recipient, channels) {
    const fields = [];
    for (const channel of channels) {
        if (channel === "email") {
            if (!isValidEmail(recipient.email)) throw new ToolError("INVALID", `${recipient.name} has no valid email address in OOMS.`);
            if (await deps.senders.isUnsubscribed(ctx.branch_id, recipient.email)) throw new ToolError("INVALID", `${recipient.name} has unsubscribed from emails.`);
            if (!(await deps.senders.hasActiveSmtp(ctx.branch_id))) throw new ToolError("INVALID", "Email is not set up for this office (Broadcast → Email → SMTP settings).");
            fields.push({ label: "Email to", value: recipient.email });
        } else if (channel === "whatsapp") {
            if (!whatsappNumber(recipient)) throw new ToolError("INVALID", `${recipient.name} has no mobile number in OOMS.`);
            const ch = await deps.senders.whatsappChannel(ctx.branch_id);
            if (!ch || ch === "disabled") throw new ToolError("INVALID", "WhatsApp is not set up for this office (Broadcast → WhatsApp).");
            fields.push({ label: "WhatsApp to", value: displayPhone(recipient) });
        }
    }
    return fields;
}

function summarizeChannels(results) {
    const values = Object.values(results);
    const sent = values.filter((r) => r.status === "sent").length;
    return sent === values.length ? "done" : sent > 0 ? "partial" : "failed";
}

/** Delivery errors can carry URLs or hosts; keep only a short readable reason. */
export function friendlyReason(err, fallback) {
    const msg = String(err?.response?.data?.message || err?.message || "").replace(/https?:\/\/\S+/g, "").replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "").trim();
    return (msg || fallback).slice(0, 200);
}

const channelsInput = () => z.array(z.enum(["whatsapp", "email"])).min(1).max(2).refine((a) => new Set(a).size === a.length, "Channels must be unique");

function buildActionDefinitions() {
    const recipientFields = {
        recipient_type: z.enum(["client", "staff"]).describe("client = a client of the office; staff = a team member"),
        recipient_username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.@+-]+$/).describe("username from search_parties / search_staff results"),
    };

    return {
        send_whatsapp: {
            label: "Send WhatsApp message",
            allowed: (ctx) => has(ctx, "broadcast_send"),
            input: z.object({ ...recipientFields, message: z.string().trim().min(1).max(1000) }).strict(),
            async prepare(ctx, args, deps) {
                const recipient = await requireRecipient(deps, ctx, args.recipient_type, args.recipient_username);
                const number = whatsappNumber(recipient);
                if (!number) throw new ToolError("INVALID", `${recipient.name} has no mobile number in OOMS.`);
                const channel = await deps.senders.whatsappChannel(ctx.branch_id);
                if (channel !== "ooms web") {
                    throw new ToolError(
                        "INVALID",
                        channel === "disabled" || !channel
                            ? "WhatsApp is not set up for this office."
                            : `Free-text WhatsApp messages need the OOMS Web WhatsApp channel; this office uses ${WHATSAPP_CHANNEL_LABEL[channel] || channel}, which only sends approved templates. Documents can still be shared with share_client_documents.`
                    );
                }
                if (!(await deps.senders.hasPlan(ctx.branch_id, ["BusinessPro"]))) throw new ToolError("DENIED", "WhatsApp messaging needs the BusinessPro plan.");
                assertSafeOutgoing(args.message, recipient);
                return {
                    payload: { recipient, number, message: args.message },
                    preview: {
                        title: "Send WhatsApp message",
                        fields: [
                            { label: "To", value: recipientLabel(recipient) },
                            { label: "WhatsApp", value: `+${number}` },
                        ],
                        body: args.message,
                    },
                };
            },
            async execute(payload, run) {
                try {
                    await run.senders.sendWhatsappText({ branchId: run.branchId, number: payload.number, message: payload.message });
                    return { status: "done", message: `WhatsApp message sent to ${payload.recipient.name}.`, channels: { whatsapp: { status: "sent" } } };
                } catch (err) {
                    const reason = friendlyReason(err, "WhatsApp could not deliver the message.");
                    return { status: "failed", message: reason, channels: { whatsapp: { status: "failed", reason } } };
                }
            },
        },

        send_email: {
            label: "Send email",
            allowed: (ctx) => has(ctx, "broadcast_send"),
            input: z.object({ ...recipientFields, subject: z.string().trim().min(1).max(150), body: z.string().trim().min(1).max(5000) }).strict(),
            async prepare(ctx, args, deps) {
                const recipient = await requireRecipient(deps, ctx, args.recipient_type, args.recipient_username);
                const fields = await assertChannels(deps, ctx, recipient, ["email"]);
                assertSafeOutgoing(`${args.subject}\n${args.body}`, recipient);
                return {
                    payload: { recipient, subject: args.subject, body: args.body },
                    preview: { title: "Send email", fields: [{ label: "To", value: recipientLabel(recipient) }, ...fields, { label: "Subject", value: args.subject }], body: args.body },
                };
            },
            async execute(payload, run) {
                const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const html = payload.body.split(/\n{2,}/).map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`).join("\n");
                try {
                    const r = await run.senders.sendEmail({ branchId: run.branchId, to: payload.recipient.email, subject: payload.subject, html, text: payload.body });
                    return { status: "done", message: `Email sent to ${payload.recipient.name}.`, channels: { email: { status: "sent", message_id: r?.messageId || null } } };
                } catch (err) {
                    const reason = friendlyReason(err, "The email could not be sent.");
                    return { status: "failed", message: reason, channels: { email: { status: "failed", reason } } };
                }
            },
        },

        share_client_documents: {
            label: "Share documents",
            allowed: () => true,
            input: z.object({
                client_username: recipientFields.recipient_username,
                document_ids: z.array(z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.@+-]+$/)).min(1).max(10).describe("document_id values from list_client_documents"),
                channels: channelsInput(),
            }).strict(),
            async prepare(ctx, args, deps) {
                const recipient = await requireRecipient(deps, ctx, "client", args.client_username);
                const ids = [...new Set(args.document_ids)];
                const [rows] = await deps.db.query(
                    `SELECT d.document_id, d.category_id, d.name, d.remark, d.file, d.mime_type, f.firm_name
                     FROM documents d
                     LEFT JOIN firms f ON f.firm_id = d.firm_id AND f.branch_id = d.branch_id
                     WHERE d.branch_id = ? AND d.username = ? AND d.is_deleted = '0' AND d.document_id IN (${ids.map(() => "?").join(", ")})`,
                    [ctx.branch_id, recipient.username, ...ids]
                );
                const byId = new Map((rows || []).map((r) => [String(r.document_id), r]));
                const missing = ids.filter((id) => !byId.has(id));
                if (missing.length) throw new ToolError("NOT_FOUND", `${missing.length} document(s) were not found for this client. Use list_client_documents.`);
                const documents = ids.map((id) => byId.get(id));
                if (documents.some((d) => !d.file)) throw new ToolError("INVALID", "One of the documents has no file attached.");
                const fields = await assertChannels(deps, ctx, recipient, args.channels);
                return {
                    payload: {
                        recipient,
                        channels: args.channels,
                        documents: documents.map((d) => ({ document_id: d.document_id, name: d.name || d.file, category_id: d.category_id, file: d.file, mime_type: d.mime_type, firm_name: d.firm_name || "", remark: d.remark || "" })),
                    },
                    preview: {
                        title: documents.length === 1 ? "Share a document" : `Share ${documents.length} documents`,
                        fields: [
                            { label: "To", value: recipientLabel(recipient) },
                            { label: "Via", value: args.channels.map((c) => CHANNEL_LABEL[c]).join(" + ") },
                            ...fields,
                        ],
                        items: documents.map((d) => d.name || d.file),
                    },
                };
            },
            async execute(payload, run) {
                const prepared = [];
                for (const d of payload.documents) {
                    try {
                        const { buffer, mimeType } = await run.senders.loadDocument({ categoryId: d.category_id, file: d.file });
                        const base = String(d.name || d.file).replace(/[^\w.\-]+/g, "_").slice(0, 80);
                        const ext = String(d.file).includes(".") ? `.${String(d.file).split(".").pop()}` : "";
                        const documentName = /\.[a-z0-9]+$/i.test(base) ? base : `${base}${ext}`;
                        const type = mimeType || d.mime_type || "application/octet-stream";
                        const url = await run.senders.uploadPublic({ buffer, filename: documentName, mimeType: type });
                        prepared.push({ documentName, url, firmName: d.firm_name, remark: d.remark, attachment: { filename: documentName, content: buffer, contentType: type } });
                    } catch (err) {
                        return { status: "failed", message: friendlyReason(err, `Could not read ${d.name}.`), channels: {} };
                    }
                }
                const channels = {};
                for (const channel of payload.channels) {
                    let failures = 0;
                    let reason = "";
                    for (const item of prepared) {
                        try {
                            if (channel === "email") {
                                await run.senders.shareDocumentEmail({ branchId: run.branchId, recipient: payload.recipient, sharedByName: run.actorName, documentName: item.documentName, documentUrl: item.url, firmName: item.firmName, remark: item.remark, attachment: item.attachment });
                            } else {
                                await run.senders.shareDocumentWhatsapp({ branchId: run.branchId, recipient: payload.recipient, sentBy: run.actor, documentName: item.documentName, documentUrl: item.url, firmName: item.firmName, remark: item.remark });
                            }
                        } catch (err) {
                            failures += 1;
                            reason = friendlyReason(err, `${CHANNEL_LABEL[channel]} could not deliver.`);
                        }
                    }
                    channels[channel] = failures ? { status: "failed", reason: failures === prepared.length ? reason : `${failures} of ${prepared.length} document(s) failed: ${reason}` } : { status: "sent" };
                }
                const status = summarizeChannels(channels);
                const what = prepared.length === 1 ? prepared[0].documentName : `${prepared.length} documents`;
                return { status, message: status === "done" ? `Shared ${what} with ${payload.recipient.name}.` : status === "partial" ? `Shared ${what} on some channels only.` : `Could not share ${what}.`, channels };
            },
        },

        share_ledger_statement: {
            label: "Share ledger statement",
            allowed: (ctx) => has(ctx, "finance_report"),
            input: z.object({
                client_username: recipientFields.recipient_username,
                ...dateRangeFields,
                channels: channelsInput(),
            }).strict(),
            async prepare(ctx, args, deps) {
                const recipient = await requireRecipient(deps, ctx, "client", args.client_username);
                const range = resolveRange(args, ctx, { maxDays: 366, defaultPreset: "this_fy" });
                const fields = await assertChannels(deps, ctx, recipient, args.channels);
                return {
                    payload: { recipient, channels: args.channels, from: range.from, to: range.to },
                    preview: {
                        title: "Share ledger statement",
                        fields: [
                            { label: "To", value: recipientLabel(recipient) },
                            { label: "Period", value: `${range.from} to ${range.to}` },
                            { label: "Via", value: args.channels.map((c) => CHANNEL_LABEL[c]).join(" + ") },
                            ...fields,
                        ],
                        items: [`Ledger statement (PDF), ${range.from} to ${range.to}`],
                    },
                };
            },
            async execute(payload, run) {
                let pdf;
                let url;
                try {
                    pdf = await run.senders.buildLedgerPdf({ branchId: run.branchId, partyId: payload.recipient.username, fromDate: payload.from, toDate: payload.to });
                    url = await run.senders.uploadPublic({ buffer: pdf.buffer, filename: pdf.filename, mimeType: "application/pdf" });
                } catch (err) {
                    return { status: "failed", message: friendlyReason(err, "Could not prepare the ledger statement."), channels: {} };
                }
                const remark = `Ledger ${payload.from} to ${payload.to}`;
                const channels = {};
                for (const channel of payload.channels) {
                    try {
                        if (channel === "email") {
                            await run.senders.shareDocumentEmail({ branchId: run.branchId, recipient: payload.recipient, sharedByName: run.actorName, documentName: pdf.filename, documentUrl: url, firmName: pdf.firmName, remark, attachment: { filename: pdf.filename, content: pdf.buffer, contentType: "application/pdf" } });
                        } else {
                            await run.senders.shareDocumentWhatsapp({ branchId: run.branchId, recipient: payload.recipient, sentBy: run.actor, documentName: pdf.filename, documentUrl: url, firmName: pdf.firmName, remark });
                        }
                        channels[channel] = { status: "sent" };
                    } catch (err) {
                        channels[channel] = { status: "failed", reason: friendlyReason(err, `${CHANNEL_LABEL[channel]} could not deliver.`) };
                    }
                }
                const status = summarizeChannels(channels);
                return { status, message: status === "done" ? `Ledger statement shared with ${payload.recipient.name}.` : status === "partial" ? "Ledger statement shared on some channels only." : "Could not share the ledger statement.", channels };
            },
        },
    };
}

export const ACTION_DEFINITIONS = buildActionDefinitions();
