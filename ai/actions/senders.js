import pool from "../../db.js";
import { getActivePaymentTemplate, getActiveSmtpConfig, renderTemplate, sendEmail } from "../../routes/payment_reminder.js";
import { sendDocumentSharingWhatsapp } from "../../helpers/whatsappNotification.js";
import { sendWhatsappWebMessage } from "../../helpers/whatsappWeb.js";
import { uploadBufferToOneSaas } from "../../services/onesaasUploadService.js";
import { downloadProfileDocument } from "../../helpers/b2Storage.js";
import { collectLedgerStatement, generateLedgerPdfBuffer } from "../../helpers/ledgerReport.js";
import { buildLedgerDownloadFilename } from "../../helpers/ledgerFilename.js";
import { getOppositePartySnippet } from "../../helpers/transactionParty.js";
import { getSubscriptionStatus } from "../../services/subscriptionService.js";

/**
 * Real side effects for AI write actions, built only from the helpers the OOMS app itself
 * uses (client document share, ledger share, WhatsApp Web send, branch SMTP). Executed only
 * after a person confirms (ai/actions/execute.js). Tests inject fakes instead.
 */

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

/** Same mapping as documentCategoryFolder in routes/client.js. */
export function documentFolder(categoryId) {
    const id = String(categoryId || "").trim().toUpperCase();
    if (id === "GST") return "gst";
    if (id === "IT") return "it";
    if (id === "MCA") return "mca";
    if (id === "TASK") return "task";
    if (id === "SHARABLE") return "sharable";
    return "general";
}

function shareVariables({ recipient, sharedByName, documentName, documentUrl, firmName = "", remark = "" }) {
    const v = {
        name: recipient.name,
        mobile: recipient.mobile,
        email: recipient.email,
        firm_name: firmName,
        document_name: documentName,
        document_link: documentUrl,
        shared_by: sharedByName,
        remark,
    };
    // The Document Share template supports both bare and {{braced}} keys (as the app sends them).
    for (const [k, val] of Object.entries({ ...v })) v[`{{${k}}}`] = val;
    return v;
}

export function createDefaultSenders(db = pool) {
    return {
        async whatsappChannel(branchId) {
            const [rows] = await db.query("SELECT whatsapp_channel FROM branch_list WHERE branch_id = ? AND is_deleted = '0' LIMIT 1", [branchId]);
            return String(rows?.[0]?.whatsapp_channel || "disabled").trim().toLowerCase();
        },

        /** Same rule as requirePlan(['BusinessPro']) on /broadcast/whatsapp. */
        async hasPlan(branchId, plans) {
            const status = await getSubscriptionStatus(branchId);
            const active = (status?.active_plans || []).filter((p) => p.is_active).map((p) => p.plan_name);
            return status?.is_subscribed === "yes" && plans.some((p) => active.includes(p));
        },

        async hasActiveSmtp(branchId) {
            try {
                await getActiveSmtpConfig(branchId);
                return true;
            } catch (_) {
                return false;
            }
        },

        async isUnsubscribed(branchId, email) {
            const [rows] = await db.query(
                "SELECT 1 FROM email_unsubscribes WHERE branch_id = ? AND LOWER(email) = LOWER(?) AND status = 'active' LIMIT 1",
                [branchId, email]
            );
            return Boolean(rows?.length);
        },

        async sendWhatsappText({ branchId, number, message }) {
            await sendWhatsappWebMessage({ branch_id: branchId, number, template_type: "text", content: { message } });
        },

        async sendEmail({ branchId, to, subject, html, text, attachments = [] }) {
            const smtp = await getActiveSmtpConfig(branchId);
            const result = await sendEmail(smtp, to, subject, html, text, attachments);
            return { messageId: result?.messageId || null };
        },

        async loadDocument({ categoryId, file }) {
            const { stream, mimeType } = await downloadProfileDocument(documentFolder(categoryId), file);
            return { buffer: await streamToBuffer(stream), mimeType };
        },

        async uploadPublic({ buffer, filename, mimeType }) {
            const { url } = await uploadBufferToOneSaas({ buffer, filename, mimeType });
            return url;
        },

        async buildLedgerPdf({ branchId, partyId, fromDate, toDate }) {
            const ledger = await collectLedgerStatement({ branch_id: branchId, partyType: "client", partyId, fromDate, toDate, getOppositePartySnippet });
            const buffer = await generateLedgerPdfBuffer({
                partyDetails: ledger.partyDetails,
                branchDetails: ledger.branchDetails,
                fromDate,
                toDate,
                openingDebit: ledger.openingDebit,
                openingCredit: ledger.openingCredit,
                openingBalance: ledger.openingBalance,
                statementData: ledger.statementData,
                summary: ledger.summary,
            });
            const filename = buildLedgerDownloadFilename({ name: ledger.partyDetails?.name || "ledger", fromDate, toDate, extension: "pdf" });
            return { buffer, filename, firmName: ledger.partyDetails?.name || "" };
        },

        /** Document Share email template + branch SMTP, with the file attached (as routes/client.js). */
        async shareDocumentEmail({ branchId, recipient, sharedByName, documentName, documentUrl, firmName, remark, attachment }) {
            const template = await getActivePaymentTemplate(branchId, "Document Share");
            const smtp = await getActiveSmtpConfig(branchId);
            const variables = shareVariables({ recipient, sharedByName, documentName, documentUrl, firmName, remark });
            const result = await sendEmail(
                smtp,
                recipient.email,
                renderTemplate(template.subject, variables),
                renderTemplate(template.html_body, variables),
                template.text_body ? renderTemplate(template.text_body, variables) : null,
                attachment ? [attachment] : []
            );
            return { messageId: result?.messageId || null };
        },

        /** Document sharing WhatsApp template on the branch's channel (as routes/client.js). */
        async shareDocumentWhatsapp({ branchId, recipient, sentBy, documentName, documentUrl, firmName, remark }) {
            await sendDocumentSharingWhatsapp({
                branch_id: branchId,
                username: recipient.username,
                sent_by: sentBy,
                document_name: documentName,
                document_link: documentUrl,
                remark: remark || "",
                firm_name: firmName || "",
                mobile: recipient.mobile,
                email: recipient.email,
                country_code: recipient.countryCode,
            });
        },
    };
}
