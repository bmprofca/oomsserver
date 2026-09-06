import pool from "../db.js";
import { SendMail } from "./Mail.js";
import { APP_NAME } from "./Config.js";
import { TIMESTAMP } from "./function.js";

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function loadTaskEmailContext(branch_id, task_id) {
    const [rows] = await pool.query(
        `SELECT
            t.task_id,
            t.ca_id,
            t.udin,
            t.compliance_year,
            t.compliance_period,
            t.status AS task_status,
            s.name AS service_name,
            f.firm_name,
            f.pan_no AS firm_pan,
            bl.name AS branch_name,
            cp.name AS client_name
         FROM tasks t
         LEFT JOIN services s ON s.service_id = t.service_id
         LEFT JOIN firms f
            ON f.firm_id = t.firm_id
           AND (f.is_deleted = '0' OR f.is_deleted = 0)
         LEFT JOIN branch_list bl ON bl.branch_id = t.branch_id
         LEFT JOIN profile cp
            ON cp.username = t.username
           AND cp.id = (
                SELECT MAX(cp2.id)
                FROM profile cp2
                WHERE cp2.username = t.username
           )
         WHERE t.branch_id = ?
           AND t.task_id = ?
         LIMIT 1`,
        [branch_id, task_id]
    );
    return rows[0] || null;
}

async function loadCaProfile(ca_username) {
    if (!ca_username) return null;
    const [rows] = await pool.query(
        `SELECT p.username, p.name, p.email
         FROM profile p
         INNER JOIN clients c
            ON c.username = p.username
           AND c.user_type = 'ca'
           AND (c.is_deleted = '0' OR c.is_deleted = 0)
         WHERE p.username = ?
           AND p.status = '1'
         LIMIT 1`,
        [String(ca_username).trim()]
    );
    return rows[0] || null;
}

async function loadBranchAdminEmails(branch_id) {
    const [rows] = await pool.query(
        `SELECT DISTINCT p.email, p.name
         FROM branch_mapping bm
         INNER JOIN profile p ON p.username = bm.username
         INNER JOIN users u ON u.username = bm.username AND u.status = '1'
         WHERE bm.branch_id = ?
           AND bm.type = 'admin'
           AND bm.is_deleted = '0'
           AND bm.status = '1'
           AND bm.is_accepted = '1'
           AND p.email IS NOT NULL
           AND TRIM(p.email) <> ''`,
        [branch_id]
    );
    return (rows || []).filter((row) => isValidEmail(row.email));
}

function taskDetailRows(ctx) {
    const rows = [
        ["Task ID", ctx.task_id],
        ["Branch", ctx.branch_name],
        ["Service", ctx.service_name],
        ["Firm", ctx.firm_name],
        ["Firm PAN", ctx.firm_pan],
        ["Client", ctx.client_name],
        ["Compliance year", ctx.compliance_year],
        ["Compliance period", ctx.compliance_period],
        ["UDIN", ctx.udin],
        ["Activity time", ctx.activity_at],
    ];
    return rows
        .filter(([, value]) => value != null && String(value).trim() !== "")
        .map(
            ([label, value]) =>
                `<tr>
                    <td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;vertical-align:top;">${escapeHtml(label)}</td>
                    <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${escapeHtml(value)}</td>
                </tr>`
        )
        .join("");
}

function wrapEmail({ title, intro, ctx, footerNote }) {
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="background:#0f172a;color:#ffffff;padding:18px 22px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.75;">${escapeHtml(APP_NAME)}</div>
      <div style="font-size:18px;font-weight:700;margin-top:4px;">${escapeHtml(title)}</div>
    </div>
    <div style="padding:22px;">
      <p style="margin:0 0 14px;color:#334155;font-size:14px;line-height:1.5;">${intro}</p>
      <table style="width:100%;border-collapse:collapse;margin:8px 0 16px;">
        ${taskDetailRows(ctx)}
      </table>
      ${footerNote ? `<p style="margin:0;color:#64748b;font-size:12px;line-height:1.5;">${footerNote}</p>` : ""}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Notify assigned CA when staff sets ca_approval = sent.
 * Uses company/platform SendMail.
 */
export async function notifyCaApprovalSent({ branch_id, task_id, ca_username, activity_at }) {
    try {
        const ctx = await loadTaskEmailContext(branch_id, task_id);
        if (!ctx) {
            console.warn("CA approval sent email skipped: task not found", { branch_id, task_id });
            return { sent: false, reason: "task_not_found" };
        }

        ctx.activity_at =
            activity_at != null && String(activity_at).trim() !== ""
                ? String(activity_at).trim()
                : TIMESTAMP();

        const ca = await loadCaProfile(ca_username || ctx.ca_id);
        if (!ca || !isValidEmail(ca.email)) {
            console.warn("CA approval sent email skipped: CA email missing", {
                branch_id,
                task_id,
                ca_username: ca_username || ctx.ca_id,
            });
            return { sent: false, reason: "ca_email_missing" };
        }

        const caPortalUrl = String(process.env.CA_PORTAL_URL || process.env.CA_APP_URL || "").trim();
        const portalHint = caPortalUrl
            ? ` Open the CA portal to review and add UDIN: <a href="${escapeHtml(caPortalUrl)}">${escapeHtml(caPortalUrl)}</a>`
            : " Please sign in to the CA portal to review the task and add the UDIN.";

        await SendMail({
            to: String(ca.email).trim(),
            subject: `${APP_NAME}: Task sent for CA approval — ${ctx.task_id}`,
            html: wrapEmail({
                title: "Task sent for CA approval",
                intro: `Hello ${escapeHtml(ca.name || "CA")}, a task has been sent for your approval.${portalHint}`,
                ctx,
                footerNote: "This is an automated message from OOMS.",
            }),
        });

        return { sent: true, to: String(ca.email).trim() };
    } catch (error) {
        console.error("CA approval sent email error:", error?.message || error);
        return { sent: false, reason: "send_failed", error: error?.message || String(error) };
    }
}

/**
 * Notify branch admins when CA marks approval complete.
 * Uses company/platform SendMail.
 */
export async function notifyCaApprovalComplete({
    branch_id,
    task_id,
    ca_username,
    udin,
    activity_at,
}) {
    try {
        const ctx = await loadTaskEmailContext(branch_id, task_id);
        if (!ctx) {
            console.warn("CA approval complete email skipped: task not found", { branch_id, task_id });
            return { sent: false, reason: "task_not_found" };
        }

        if (udin != null && String(udin).trim() !== "") {
            ctx.udin = String(udin).trim();
        }

        ctx.activity_at =
            activity_at != null && String(activity_at).trim() !== ""
                ? String(activity_at).trim()
                : TIMESTAMP();

        const ca = await loadCaProfile(ca_username || ctx.ca_id);
        const admins = await loadBranchAdminEmails(branch_id);
        if (!admins.length) {
            console.warn("CA approval complete email skipped: no branch admin emails", {
                branch_id,
                task_id,
            });
            return { sent: false, reason: "admin_email_missing" };
        }

        const caLabel = ca?.name || ca_username || ctx.ca_id || "CA";
        const recipients = [...new Set(admins.map((a) => String(a.email).trim().toLowerCase()))];

        await Promise.all(
            recipients.map((to) =>
                SendMail({
                    to,
                    subject: `${APP_NAME}: CA approval completed — ${ctx.task_id}`,
                    html: wrapEmail({
                        title: "CA approval marked complete",
                        intro: `Hello, <strong>${escapeHtml(caLabel)}</strong> has marked CA approval as complete for the task below.`,
                        ctx,
                        footerNote: "This is an automated message from OOMS.",
                    }),
                })
            )
        );

        return { sent: true, to: recipients };
    } catch (error) {
        console.error("CA approval complete email error:", error?.message || error);
        return { sent: false, reason: "send_failed", error: error?.message || String(error) };
    }
}
