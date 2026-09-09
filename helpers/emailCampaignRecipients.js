import pool from "../db.js";

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function mergeRecipient(map, candidate, meta) {
    const email = String(candidate?.recipient_email || "")
        .trim()
        .toLowerCase();
    if (!email || !isValidEmail(email)) {
        meta.skipped_invalid_email += 1;
        return;
    }
    const existing = map.get(email);
    if (!existing) {
        map.set(email, { ...candidate, recipient_email: email });
        return;
    }
    meta.duplicates_skipped += 1;
    if (Number(candidate.profile_id || 0) > Number(existing.profile_id || 0)) {
        map.set(email, { ...candidate, recipient_email: email });
    }
}

async function fetchLatestProfilesWithEmail(branchId, { usernames = null } = {}) {
    const params = [branchId, branchId];
    let usernameFilter = "";
    if (Array.isArray(usernames) && usernames.length) {
        const unique = [
            ...new Set(usernames.map((u) => String(u || "").trim()).filter(Boolean)),
        ];
        if (!unique.length) return [];
        usernameFilter = ` AND c.username IN (${unique.map(() => "?").join(",")})`;
        params.push(...unique);
    }

    const [rows] = await pool.query(
        `SELECT
            c.username,
            p.id AS profile_id,
            p.name,
            p.mobile,
            p.email
         FROM clients c
         INNER JOIN profile p
            ON p.username = c.username
           AND p.status = '1'
         INNER JOIN (
            SELECT p2.username, MAX(p2.id) AS max_id
            FROM profile p2
            INNER JOIN clients c2
               ON c2.username = p2.username
              AND c2.branch_id = ?
              AND c2.user_type = 'client'
              AND c2.is_deleted = '0'
            WHERE p2.status = '1'
              AND p2.email IS NOT NULL
              AND TRIM(p2.email) <> ''
            GROUP BY p2.username
         ) latest
            ON latest.username = p.username
           AND latest.max_id = p.id
         WHERE c.branch_id = ?
           AND c.user_type = 'client'
           AND c.is_deleted = '0'
           AND p.email IS NOT NULL
           AND TRIM(p.email) <> ''
           ${usernameFilter}`,
        params
    );

    return rows;
}

/**
 * Resolve campaign audience to unique email recipients.
 * Same audience shapes as SMS/WhatsApp: client | group | task.
 */
export async function resolveEmailCampaignRecipients(branchId, audience = {}) {
    const audience_type = String(audience.audience_type || "").trim().toLowerCase();
    const meta = {
        duplicates_skipped: 0,
        skipped_invalid_email: 0,
    };
    const byEmail = new Map();

    const pushRow = (row, extraVars = {}) => {
        mergeRecipient(
            byEmail,
            {
                recipient_email: String(row.email || "").trim(),
                recipient_name: String(row.name || "").trim() || null,
                profile_id: Number(row.profile_id) || 0,
                variable_values_json: {
                    username: String(row.username || "").trim(),
                    mobile: String(row.mobile || "").trim(),
                    ...extraVars,
                },
            },
            meta
        );
    };

    if (audience_type === "client") {
        const selectAll = Boolean(audience.select_all_clients);
        const usernames = Array.isArray(audience.usernames) ? audience.usernames : [];
        if (!selectAll && !usernames.length) {
            return {
                ok: false,
                status: 400,
                data: {
                    success: false,
                    message: "Select at least one client or enable select all clients",
                },
            };
        }
        const rows = await fetchLatestProfilesWithEmail(branchId, {
            usernames: selectAll ? null : usernames,
        });
        rows.forEach((row) => pushRow(row));
    } else if (audience_type === "group") {
        const group_ids = [
            ...new Set(
                (Array.isArray(audience.group_ids) ? audience.group_ids : [])
                    .map((id) => String(id ?? "").trim())
                    .filter((id) => id.length > 0)
            ),
        ];
        if (!group_ids.length) {
            return {
                ok: false,
                status: 400,
                data: {
                    success: false,
                    message: "Select at least one group",
                },
            };
        }
        const placeholders = group_ids.map(() => "?").join(",");
        const [rows] = await pool.query(
            `SELECT
                p.username,
                p.id AS profile_id,
                p.name,
                p.mobile,
                p.email,
                f.firm_name
             FROM groups g
             INNER JOIN group_firms gf
                ON gf.group_id = g.group_id
               AND gf.is_deleted = '0'
             INNER JOIN firms f
                ON f.firm_id = gf.firm_id
               AND f.is_deleted = '0'
             INNER JOIN profile p
                ON p.username = f.username
               AND p.status = '1'
             INNER JOIN (
                SELECT p2.username, MAX(p2.id) AS max_id
                FROM profile p2
                WHERE p2.status = '1'
                  AND p2.email IS NOT NULL
                  AND TRIM(p2.email) <> ''
                GROUP BY p2.username
             ) latest
                ON latest.username = p.username
               AND latest.max_id = p.id
             WHERE g.branch_id = ?
               AND g.is_deleted = '0'
               AND g.group_id IN (${placeholders})
               AND p.email IS NOT NULL
               AND TRIM(p.email) <> ''`,
            [branchId, ...group_ids]
        );
        rows.forEach((row) =>
            pushRow(row, { firm_name: String(row.firm_name || "").trim() })
        );
    } else if (audience_type === "task") {
        const service_id =
            audience.service_id != null ? String(audience.service_id).trim() : "";
        if (!service_id) {
            return {
                ok: false,
                status: 400,
                data: {
                    success: false,
                    message: "service_id is required for task audience",
                },
            };
        }

        const statusRaw =
            audience.status != null ? String(audience.status).trim().toLowerCase() : "all";
        const statusMapping = {
            complete: "complete",
            completed: "complete",
            cancel: "cancel",
            cancelled: "cancel",
            canceled: "cancel",
            "in process": "in process",
            in_process: "in process",
            inprogress: "in process",
            "pending from client": "pending from client",
            pending_client: "pending from client",
            "pending from department": "pending from department",
            pending_department: "pending from department",
        };

        let statusList = [];
        if (statusRaw && statusRaw !== "all") {
            statusList = statusRaw
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean)
                .map((s) => statusMapping[s] || s);
        }

        let sql = `
            SELECT
                p.username,
                p.id AS profile_id,
                p.name,
                p.mobile,
                p.email,
                t.task_id,
                s.name AS service_name
            FROM tasks t
            INNER JOIN firms f
               ON f.firm_id = t.firm_id
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
            INNER JOIN profile p
               ON p.username = f.username
              AND p.status = '1'
            LEFT JOIN services s
               ON s.service_id = t.service_id
            INNER JOIN (
                SELECT p2.username, MAX(p2.id) AS max_id
                FROM profile p2
                WHERE p2.status = '1'
                  AND p2.email IS NOT NULL
                  AND TRIM(p2.email) <> ''
                GROUP BY p2.username
            ) latest
               ON latest.username = p.username
              AND latest.max_id = p.id
            WHERE t.branch_id = ?
              AND t.service_id = ?
              AND p.email IS NOT NULL
              AND TRIM(p.email) <> ''
        `;
        const params = [branchId, service_id];
        if (statusList.length) {
            sql += ` AND LOWER(t.status) IN (${statusList.map(() => "?").join(",")})`;
            params.push(...statusList);
        }

        const [rows] = await pool.query(sql, params);
        rows.forEach((row) =>
            pushRow(row, {
                task_id: String(row.task_id || "").trim(),
                service_name: String(row.service_name || "").trim(),
            })
        );
    } else {
        return {
            ok: false,
            status: 400,
            data: {
                success: false,
                message: "audience_type must be client, group, or task",
            },
        };
    }

    const data = [...byEmail.values()].sort(
        (a, b) => Number(b.profile_id) - Number(a.profile_id)
    );

    return {
        ok: true,
        data,
        count: data.length,
        meta,
    };
}
