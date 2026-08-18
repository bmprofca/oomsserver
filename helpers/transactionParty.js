/** Party types supported on sale/purchase create and edit. */
export const TRANSACTION_PARTY_TYPES = ["client", "ca", "staff", "agent", "bank", "capital"];

/**
 * Validate party_id exists for the given party_type within the branch context.
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} db
 */
export async function validateTransactionParty(db, branch_id, party_type, party_id) {
    const partyTypeVal = String(party_type).trim().toLowerCase();
    const partyIdVal = String(party_id).trim();

    if (!TRANSACTION_PARTY_TYPES.includes(partyTypeVal)) {
        const err = new Error(`party_type must be one of: ${TRANSACTION_PARTY_TYPES.join(", ")}`);
        err.statusCode = 400;
        throw err;
    }
    if (!partyIdVal) {
        const err = new Error("party_id is required");
        err.statusCode = 400;
        throw err;
    }

    if (partyTypeVal === "bank") {
        const [[row]] = await db.query(
            "SELECT bank_id FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1",
            [branch_id, partyIdVal]
        );
        if (!row) {
            const err = new Error("Invalid bank_id");
            err.statusCode = 400;
            throw err;
        }
        return { partyTypeVal, partyIdVal };
    }

    if (partyTypeVal === "capital") {
        const [[row]] = await db.query(
            "SELECT capital_id FROM capitals WHERE branch_id = ? AND capital_id = ? LIMIT 1",
            [branch_id, partyIdVal]
        );
        if (!row) {
            const err = new Error("Invalid capital_id");
            err.statusCode = 400;
            throw err;
        }
        return { partyTypeVal, partyIdVal };
    }

    if (partyTypeVal === "staff") {
        const [[row]] = await db.query(
            `SELECT username FROM branch_mapping
             WHERE branch_id = ? AND username = ? AND type = 'staff' AND is_deleted = '0' LIMIT 1`,
            [branch_id, partyIdVal]
        );
        if (!row) {
            const err = new Error("Invalid staff party_id");
            err.statusCode = 400;
            throw err;
        }
        return { partyTypeVal, partyIdVal };
    }

    const [[profile]] = await db.query(
        "SELECT username FROM profile WHERE username = ? AND status = '1' LIMIT 1",
        [partyIdVal]
    );
    if (!profile) {
        const err = new Error(`Invalid party_id for party_type ${partyTypeVal}`);
        err.statusCode = 400;
        throw err;
    }

    return { partyTypeVal, partyIdVal };
}
