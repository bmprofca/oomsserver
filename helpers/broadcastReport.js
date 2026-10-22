export const BROADCAST_REPORT_CHANNELS = Object.freeze(["email", "sms"]);

export function normalizeBroadcastReportQuery(query = {}) {
    const channel = String(query.channel || "").trim().toLowerCase();
    if (!BROADCAST_REPORT_CHANNELS.includes(channel)) {
        throw new Error("channel must be email or sms");
    }
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const status = query.status ? String(query.status).trim().toLowerCase() : null;
    const from = query.from ? String(query.from).trim() : null;
    const to = query.to ? String(query.to).trim() : null;
    for (const [name, value] of [["from", from], ["to", to]]) {
        if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            throw new Error(`${name} must be YYYY-MM-DD`);
        }
    }
    return { channel, page, limit, status, from, to };
}

export function buildBroadcastReportSql({ channel, status, from, to }) {
    const params = [];
    const where = ["branch_id = ?"];
    if (channel === "email") {
        params.push("__BRANCH__");
        if (status) {
            where.push("status = ?");
            params.push(status);
        }
        if (from) {
            where.push("create_date >= ?");
            params.push(`${from} 00:00:00`);
        }
        if (to) {
            where.push("create_date < DATE_ADD(?, INTERVAL 1 DAY)");
            params.push(to);
        }
        return {
            sql: `SELECT broadcast_id AS campaign_id, 'email' AS channel, broadcast_name AS name,
                         status, total_recipients AS total_count, total_sent AS sent_count,
                         total_failed AS failed_count, total_pending AS pending_count,
                         total_skipped AS skipped_count, create_date, started_at, completed_at
                  FROM email_broadcasts
                  WHERE ${where.join(" AND ")}
                  ORDER BY create_date DESC, id DESC`,
            params,
        };
    }

    params.push("__BRANCH__");
    if (status) {
        where.push("status = ?");
        params.push(status);
    }
    if (from) {
        where.push("create_date >= ?");
        params.push(`${from} 00:00:00`);
    }
    if (to) {
        where.push("create_date < DATE_ADD(?, INTERVAL 1 DAY)");
        params.push(to);
    }
    return {
        sql: `SELECT campaign_id, 'sms' AS channel, name, status,
                     total_count, sent_count, failed_count,
                     GREATEST(total_count - sent_count - failed_count, 0) AS pending_count,
                     0 AS skipped_count, create_date, NULL AS started_at, NULL AS completed_at
              FROM sms_fast2sms_campaigns
              WHERE ${where.join(" AND ")}
              ORDER BY create_date DESC, id DESC`,
        params,
    };
}
