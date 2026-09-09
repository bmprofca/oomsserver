/**
 * Client balance effect rules (matches GET_BALANCE in function.js).
 * balance = sum(party2 amounts) - sum(party1 amounts).
 *
 * IMPORTANT: Aggregate transaction effects FIRST, then filter clients/profile
 * with EXISTS. Never JOIN clients/profile before SUM(effect) — duplicate
 * profile (or clients) rows multiply the balance (e.g. 2× ledger balance).
 */

/** Per-row client balance effects from transactions (includes transaction_date). */
export const CLIENT_BALANCE_EFFECTS_SQL = `
    SELECT party1_id AS party_id,
           -ABS(amount) AS effect,
           transaction_date
    FROM transactions
    WHERE branch_id = ?
      AND party1_type = 'client'
      AND party1_id IS NOT NULL
      AND party1_id != ''
    UNION ALL
    SELECT party2_id AS party_id,
           ABS(amount) AS effect,
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

/**
 * Filter aggregated balances to active branch clients that have a client profile.
 * Uses EXISTS so duplicate clients/profile rows cannot inflate SUM(effect).
 * Params: branchId (1).
 */
const CLIENT_EXISTS_SQL = `
    AND EXISTS (
        SELECT 1
        FROM clients c
        WHERE c.username = bal.party_id
          AND CAST(c.branch_id AS CHAR) = CAST(? AS CHAR)
          AND c.user_type = 'client'
          AND (c.is_deleted = '0' OR c.is_deleted = 0)
    )
    AND EXISTS (
        SELECT 1
        FROM profile pr
        WHERE pr.username = bal.party_id
          AND LOWER(TRIM(pr.user_type)) = 'client'
    )
`;

/** Effects aggregated per party — no joins that can multiply rows. */
const CLIENT_BALANCE_AGG_SQL = `
    SELECT party_id,
           SUM(effect) AS balance,
           MAX(transaction_date) AS last_transaction_date
    FROM (${CLIENT_BALANCE_EFFECTS_SQL}) e
    GROUP BY party_id
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
            OR MAX(p.pan_number) LIKE ?
            OR MAX(f.firm_name) LIKE ?
            OR MAX(f.gst_no) LIKE ?
            OR MAX(f.pan_no) LIKE ?
        )`,
        params: Array(9).fill(pattern),
    };
}

function clientBalanceWhereClause(side, balanceAfter = 0) {
    if (side === "debtor") {
        const min = Math.max(0, Number(balanceAfter) || 0);
        if (min > 0) {
            return { sql: "AND bal.balance >= ?", params: [min] };
        }
        return { sql: "AND bal.balance > 0.02", params: [] };
    }
    return { sql: "AND bal.balance < -0.02", params: [] };
}

/**
 * Count clients with balance on debtor/creditor side.
 * @param {'debtor'|'creditor'} side
 */
export function clientBalanceCountSql(side) {
    const { sql: balanceWhere } = clientBalanceWhereClause(side, 0);
    return `
        SELECT COUNT(*) AS total_count,
               COALESCE(SUM(balance), 0) AS total_amount
        FROM (
            SELECT bal.party_id, bal.balance
            FROM (${CLIENT_BALANCE_AGG_SQL}) bal
            WHERE 1 = 1
              ${CLIENT_EXISTS_SQL}
              ${balanceWhere}
        ) counted
    `;
}

/** Params: branchId x3 (effects x2, clients EXISTS x1) */
export function clientBalanceCountParams(branchId) {
    return [branchId, branchId, branchId];
}

/**
 * Paginated debtor/creditor list with profile/firm joins.
 * @param {'debtor'|'creditor'} side
 */
export function clientBalanceListSql(side, search = "", balanceAfter = 0) {
    const { sql: balanceWhere } = clientBalanceWhereClause(side, balanceAfter);
    const lastPaymentJoin = side === "debtor"
        ? `LEFT JOIN (${CLIENT_LAST_PAYMENT_SQL}) lp ON lp.party_id = bal.party_id`
        : "";
    const lastDateExpr = side === "debtor"
        ? "lp.last_payment_date"
        : "bal.last_transaction_date";
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
            MAX(p.pan_number) AS pan_number,
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
                bal.party_id AS username,
                bal.balance,
                ${lastDateExpr} AS last_transaction_date
            FROM (${CLIENT_BALANCE_AGG_SQL}) bal
            ${lastPaymentJoin}
            WHERE 1 = 1
              ${CLIENT_EXISTS_SQL}
              ${balanceWhere}
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

export function clientBalanceListParams(branchId, limit, offset, search = "", side = "debtor", balanceAfter = 0) {
    const { params: searchParams } = clientBalanceSearchHaving(search);
    const lastPaymentParam = side === "debtor" ? [branchId] : [];
    const { params: balanceParams } = clientBalanceWhereClause(side, balanceAfter);
    // effects x2, lastPayment?, clients EXISTS, balance?, firms, search..., limit, offset
    return [
        branchId,
        branchId,
        ...lastPaymentParam,
        branchId,
        ...balanceParams,
        branchId,
        ...searchParams,
        limit,
        offset,
    ];
}

export function clientBalanceTotalSql(side, search = "", balanceAfter = 0) {
    const { sql: balanceWhere } = clientBalanceWhereClause(side, balanceAfter);
    const { sql: searchHaving } = clientBalanceSearchHaving(search);
    return `
        SELECT COUNT(*) AS total,
               COALESCE(SUM(total_balance), 0) AS balance_sum
        FROM (
            SELECT agg.username, MAX(agg.balance) AS total_balance
            FROM (
                SELECT
                    bal.party_id AS username,
                    bal.balance
                FROM (${CLIENT_BALANCE_AGG_SQL}) bal
                WHERE 1 = 1
                  ${CLIENT_EXISTS_SQL}
                  ${balanceWhere}
            ) agg
            INNER JOIN profile p ON p.username = agg.username
              AND LOWER(TRIM(p.user_type)) = 'client'
            LEFT JOIN firms f ON f.username = agg.username AND CAST(f.branch_id AS CHAR) = CAST(? AS CHAR)
            GROUP BY agg.username
            ${searchHaving}
        ) counted
    `;
}

export function clientBalanceTotalParams(branchId, search = "", side = "debtor", balanceAfter = 0) {
    const { params: searchParams } = clientBalanceSearchHaving(search);
    const { params: balanceParams } = clientBalanceWhereClause(side, balanceAfter);
    // effects x2, clients EXISTS, balance?, firms, search...
    return [branchId, branchId, branchId, ...balanceParams, branchId, ...searchParams];
}
