/**
 * Is read-write mode currently on for an action's source?
 *   "chat"          → branch_ai_settings: assistant enabled + access_mode = read_write
 *   "mcp:<id>"      → that connector: enabled + access_mode = read_write
 * Read fresh from the database at confirmation time.
 */
export async function isWriteModeOn(db, branchId, source) {
    if (source === "chat") {
        const [rows] = await db.query("SELECT enabled, access_mode FROM branch_ai_settings WHERE branch_id = ? LIMIT 1", [branchId]);
        const row = rows?.[0];
        return Boolean(row) && String(row.enabled) === "1" && row.access_mode === "read_write";
    }
    if (String(source).startsWith("mcp:")) {
        const [rows] = await db.query(
            "SELECT enabled, access_mode FROM branch_mcp_connectors WHERE branch_id = ? AND connector_id = ? LIMIT 1",
            [branchId, String(source).slice(4)]
        );
        const row = rows?.[0];
        return Boolean(row) && String(row.enabled) === "1" && row.access_mode === "read_write";
    }
    return false;
}
