/**
 * Client balance effect rules (matches GET_BALANCE in function.js).
 * party1=sender (effect=-amount unless party2 is null i.e. opening balance),
 * party2=receiver (effect=+amount).
 */

/** Per-row client balance effects from transactions (includes transaction_date). */
export const CLIENT_BALANCE_EFFECTS_SQL = `
    SELECT party1_id AS party_id,
           CASE WHEN party2_id IS NULL THEN amount ELSE -amount END AS effect,
           transaction_date
    FROM transactions
    WHERE branch_id = ?
      AND party1_type = 'client'
      AND party1_id IS NOT NULL
      AND party1_id != ''
    UNION ALL
    SELECT party2_id AS party_id,
           amount AS effect,
           transaction_date
    FROM transactions
    WHERE branch_id = ?
      AND party2_type = 'client'
      AND party2_id IS NOT NULL
      AND party2_id != ''
`;

/** Last client payment (money received from client). */
export const CLIENT_LAST_PAYMENT_SQL = `
    SELECT party1_id AS party_id,
           MAX(transaction_date) AS last_payment_date
    FROM transactions
    WHERE branch_id = ?
      AND party1_type = 'client'
      AND party1_id IS NOT NULL
      AND party1_id != ''
      AND LOWER(transaction_type) IN ('receive', 'received')
    GROUP BY party1_id
`;

/** Legacy dashboard SQL (pre-fix) for diagnostics only. */
export const LEGACY_DASHBOARD_EFFECTS_SQL = `
    SELECT party2_id AS party_id,
           amount AS effect,
           transaction_date
    FROM transactions
    WHERE branch_id = ?
      AND party2_type = 'client'
      AND party2_id IS NOT NULL
      AND party2_id NOT REGEXP '^[0-9]+$'
    UNION ALL
    SELECT party1_id AS party_id,
           -amount AS effect,
           transaction_date
    FROM transactions
    WHERE branch_id = ?
      AND party1_type = 'client'
      AND party1_id IS NOT NULL
      AND party1_id NOT REGEXP '^[0-9]+$'
`;

const CLIENT_JOIN_SQL = `
    INNER JOIN clients c ON c.username = b.party_id
      AND CAST(c.branch_id AS CHAR) = CAST(? AS CHAR)
      AND c.user_type = 'client'
      AND (c.is_deleted = '0' OR c.is_deleted = 0)
    INNER JOIN profile pr ON pr.username = c.username
      AND LOWER(TRIM(pr.user_type)) = 'client'
`;

function clientBalanceSearchHaving(search) {
    const term = String(search || "").trim();
    if (!term) return { sql: "", params: [] };
    const pattern = `%${term}%`;
    return {
        sql: `HAVING (
            MAX(p.name) LIKE ?
            OR MAX(p.mobile) LIKE ?
            OR MAX(p.email) LIKE ?
            OR agg.username LIKE ?
            OR MAX(p.guardian_name) LIKE ?
            OR MAX(f.firm_name) LIKE ?
            OR MAX(f.gst_no) LIKE ?
            OR MAX(f.pan_no) LIKE ?
        )`,
        params: Array(8).fill(pattern),
    };
}

/**
 * Count clients with balance on debtor/creditor side.
 * @param {'debtor'|'creditor'} side
 */
export function clientBalanceCountSql(side) {
    const having = side === "debtor" ? "HAVING balance > 0.02" : "HAVING balance < -0.02";
    return `
        SELECT COUNT(*) AS total_count,
               COALESCE(SUM(balance), 0) AS total_amount
        FROM (
            SELECT b.party_id, SUM(b.effect) AS balance
            FROM (${CLIENT_BALANCE_EFFECTS_SQL}) b
            ${CLIENT_JOIN_SQL}
            GROUP BY b.party_id
            ${having}
        ) counted
    `;
}

/** Params: branchId x4 (effects x2, join x1, and branchId repeated in subquery structure) */
export function clientBalanceCountParams(branchId) {
    return [branchId, branchId, branchId];
}

/**
 * Paginated debtor/creditor list with profile/firm joins.
 * @param {'debtor'|'creditor'} side
 */
export function clientBalanceListSql(side, search = "") {
    const having = side === "debtor" ? "HAVING balance > 0.02" : "HAVING balance < -0.02";
    const lastPaymentJoin = side === "debtor"
        ? `LEFT JOIN (${CLIENT_LAST_PAYMENT_SQL}) lp ON lp.party_id = b.party_id`
        : "";
    const lastDateExpr = side === "debtor"
        ? "MAX(lp.last_payment_date)"
        : "MAX(b.transaction_date)";
    const order = side === "debtor"
        ? "ORDER BY (last_transaction_date IS NULL) DESC, last_transaction_date ASC, total_balance DESC"
        : "ORDER BY total_balance ASC";
    const { sql: searchHaving } = clientBalanceSearchHaving(search);
    return `
        SELECT
            agg.username,
            MAX(p.name) AS name,
            MAX(p.guardian_name) AS guardian_name,
            MAX(p.care_of) AS care_of,
            MAX(p.mobile) AS mobile,
            MAX(p.email) AS email,
            MAX(p.country_code) AS country_code,
            MAX(f.firm_name) AS firm_name,
            MAX(f.firm_id) AS firm_id,
            MAX(f.gst_no) AS gst_no,
            MAX(f.pan_no) AS pan_no,
            MAX(agg.balance) AS total_balance,
            MAX(agg.last_transaction_date) AS last_transaction_date,
            DATEDIFF(CURDATE(), MAX(agg.last_transaction_date)) AS days_since_last_payment,
            CASE
                WHEN MAX(agg.last_transaction_date) IS NULL THEN 'No payment'
                WHEN DATEDIFF(CURDATE(), MAX(agg.last_transaction_date)) <= 1 THEN 'Today'
                WHEN DATEDIFF(CURDATE(), MAX(agg.last_transaction_date)) <= 7 THEN 'Last 7 days'
                WHEN DATEDIFF(CURDATE(), MAX(agg.last_transaction_date)) <= 30 THEN 'Last 30 days'
                WHEN DATEDIFF(CURDATE(), MAX(agg.last_transaction_date)) <= 90 THEN 'Last 90 days'
                ELSE '90+ days'
            END AS last_received_in
        FROM (
            SELECT
                b.party_id AS username,
                SUM(b.effect) AS balance,
                ${lastDateExpr} AS last_transaction_date
            FROM (${CLIENT_BALANCE_EFFECTS_SQL}) b
            ${CLIENT_JOIN_SQL}
            ${lastPaymentJoin}
            GROUP BY b.party_id
            ${having}
        ) agg
        INNER JOIN profile p ON p.username = agg.username
          AND LOWER(TRIM(p.user_type)) = 'client'
        LEFT JOIN firms f ON f.username = agg.username AND CAST(f.branch_id AS CHAR) = CAST(? AS CHAR)
        GROUP BY agg.username
        ${searchHaving}
        ${order}
        LIMIT ? OFFSET ?
    `;
}

export function clientBalanceListParams(branchId, limit, offset, search = "", side = "debtor") {
    const { params: searchParams } = clientBalanceSearchHaving(search);
    const lastPaymentParam = side === "debtor" ? [branchId] : [];
    return [branchId, branchId, branchId, ...lastPaymentParam, branchId, ...searchParams, limit, offset];
}

export function clientBalanceTotalSql(side, search = "") {
    const having = side === "debtor" ? "HAVING balance > 0.02" : "HAVING balance < -0.02";
    const { sql: searchHaving } = clientBalanceSearchHaving(search);
    return `
        SELECT COUNT(*) AS total
        FROM (
            SELECT agg.username
            FROM (
                SELECT b.party_id AS username, SUM(b.effect) AS balance
                FROM (${CLIENT_BALANCE_EFFECTS_SQL}) b
                ${CLIENT_JOIN_SQL}
                GROUP BY b.party_id
                ${having}
            ) agg
            INNER JOIN profile p ON p.username = agg.username
              AND LOWER(TRIM(p.user_type)) = 'client'
            LEFT JOIN firms f ON f.username = agg.username AND CAST(f.branch_id AS CHAR) = CAST(? AS CHAR)
            GROUP BY agg.username
            ${searchHaving}
        ) counted
    `;
}

export function clientBalanceTotalParams(branchId, search = "") {
    const { params: searchParams } = clientBalanceSearchHaving(search);
    return [branchId, branchId, branchId, branchId, ...searchParams];
}
