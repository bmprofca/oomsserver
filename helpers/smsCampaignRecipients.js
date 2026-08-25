import pool from "../db.js";

function normalizeMobileDigits(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "");
    if (digits.length >= 10) return digits.slice(-10);
    return "";
}

function mergeRecipient(map, candidate, meta) {
    if (!candidate?.mobile) {
        meta.skipped_invalid_mobile += 1;
        return;
    }
    const existing = map.get(candidate.mobile);
    if (!existing) {
        map.set(candidate.mobile, candidate);
        return;
    }
    meta.duplicates_skipped += 1;
    if (Number(candidate.profile_id || 0) > Number(existing.profile_id || 0)) {
        map.set(candidate.mobile, candidate);
    }
}

async function fetchLatestProfilesWithMobile(branchId, { usernames = null } = {}) {
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
            p.mobile
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
              AND p2.mobile IS NOT NULL
              AND TRIM(p2.mobile) <> ''
            GROUP BY p2.username
         ) latest
            ON latest.username = p.username
           AND latest.max_id = p.id
         WHERE c.branch_id = ?
           AND c.user_type = 'client'
           AND c.is_deleted = '0'
           AND p.mobile IS NOT NULL
           AND TRIM(p.mobile) <> ''
           ${usernameFilter}`,
        params
    );

    return rows;
}

/**
 * Resolve campaign audience to unique 10-digit mobile numbers.
 * Same audience shapes as OneChatting: client | group | task.
 */
export async function resolveSmsCampaignRecipients(branchId, audience = {}) {
    const audience_type = String(audience.audience_type || "").trim().toLowerCase();
    const meta = {
        duplicates_skipped: 0,
        skipped_invalid_mobile: 0,
    };
    const byMobile = new Map();

    const pushRow = (row) => {
        const mobile = normalizeMobileDigits(row.mobile);
        if (!mobile) {
            meta.skipped_invalid_mobile += 1;
            return;
        }
        mergeRecipient(
            byMobile,
            {
                mobile,
                name: String(row.name || "").trim() || mobile,
                username: String(row.username || "").trim(),
                profile_id: Number(row.profile_id) || 0,
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
        const rows = await fetchLatestProfilesWithMobile(branchId, {
            usernames: selectAll ? null : usernames,
        });
        rows.forEach(pushRow);
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
                p.mobile
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
                  AND p2.mobile IS NOT NULL
                  AND TRIM(p2.mobile) <> ''
                GROUP BY p2.username
             ) latest
                ON latest.username = p.username
               AND latest.max_id = p.id
             WHERE g.branch_id = ?
               AND g.is_deleted = '0'
               AND g.group_id IN (${placeholders})
               AND p.mobile IS NOT NULL
               AND TRIM(p.mobile) <> ''`,
            [branchId, ...group_ids]
        );
        rows.forEach(pushRow);
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
                p.mobile
            FROM tasks t
            INNER JOIN firms f
               ON f.firm_id = t.firm_id
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
            INNER JOIN profile p
               ON p.username = f.username
              AND p.status = '1'
            INNER JOIN (
                SELECT p2.username, MAX(p2.id) AS max_id
                FROM profile p2
                WHERE p2.status = '1'
                  AND p2.mobile IS NOT NULL
                  AND TRIM(p2.mobile) <> ''
                GROUP BY p2.username
            ) latest
               ON latest.username = p.username
              AND latest.max_id = p.id
            WHERE t.branch_id = ?
              AND t.service_id = ?
              AND p.mobile IS NOT NULL
              AND TRIM(p.mobile) <> ''
        `;
        const params = [branchId, service_id];
        if (statusList.length) {
            sql += ` AND LOWER(t.status) IN (${statusList.map(() => "?").join(",")})`;
            params.push(...statusList);
        }

        const [rows] = await pool.query(sql, params);
        rows.forEach(pushRow);
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

    const data = [...byMobile.values()].sort(
        (a, b) => Number(b.profile_id) - Number(a.profile_id)
    );

    return {
        ok: true,
        data,
        count: data.length,
        meta,
    };
}
