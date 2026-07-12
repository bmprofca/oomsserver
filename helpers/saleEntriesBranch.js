/**
 * `sale_entries.branch_id` stores `branch_list.branch_id` (branch code), not `branch_list.id`.
 */
export async function resolveSaleEntriesBranchId(db, branchCode) {
    const code = String(branchCode || "").trim();
    if (!code) return null;

    const [rows] = await db.query(
        `SELECT branch_id FROM branch_list
         WHERE branch_id = ?
           AND (is_deleted = '0' OR is_deleted = 0 OR is_deleted IS NULL)
         LIMIT 1`,
        [code]
    );

    if (!rows?.length) {
        const [fallbackRows] = await db.query(
            `SELECT branch_id FROM branch_list WHERE branch_id = ? LIMIT 1`,
            [code]
        );
        if (!fallbackRows?.length) return null;
        return fallbackRows[0].branch_id;
    }

    return rows[0].branch_id;
}
