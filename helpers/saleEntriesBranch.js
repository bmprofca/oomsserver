/**
 * `sale_entries.branch_id` stores `branch_list.id` (int), not `branch_list.branch_id` (varchar code).
 */
export async function resolveSaleEntriesBranchId(db, branchCode) {
    const code = String(branchCode || "").trim();
    if (!code) return null;

    const [rows] = await db.query(
        `SELECT id FROM branch_list
         WHERE branch_id = ?
           AND (is_deleted = '0' OR is_deleted = 0 OR is_deleted IS NULL)
         LIMIT 1`,
        [code]
    );

    if (!rows?.length) {
        const [fallbackRows] = await db.query(
            `SELECT id FROM branch_list WHERE branch_id = ? LIMIT 1`,
            [code]
        );
        if (!fallbackRows?.length) return null;
        const fallbackId = Number(fallbackRows[0].id);
        return Number.isFinite(fallbackId) ? fallbackId : null;
    }

    const numericId = Number(rows[0].id);
    return Number.isFinite(numericId) ? numericId : null;
}
