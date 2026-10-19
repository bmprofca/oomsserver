import pool from "../db.js";

/** Party types supported on sale/purchase create and edit. */
export const TRANSACTION_PARTY_TYPES = ["client", "ca", "staff", "bank", "capital"];

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

/**
 * Opposite-party display snippet for ledger rows (client / bank).
 * Moved unchanged from routes/transactions.js so ledger statements can be built outside that route.
 */
export async function getOppositePartySnippet(branch_id, party_type, party_id) {
    if (!party_type || !party_id) return {};
    const type = String(party_type).trim();
    const id = String(party_id).trim();
    if (type === "client") {
        const [rows] = await pool.query(
            `SELECT p.name, p.email, p.mobile, p.country_code, c.username
             FROM clients c
             LEFT JOIN profile p ON p.username = c.username AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = c.username)
             WHERE c.username = ? AND c.branch_id = ? AND c.is_deleted = '0' LIMIT 1`,
            [id, branch_id]
        );
        const r = rows?.[0];
        if (!r) return {};
        return {
            client: {
                username: r?.username,
                name: r?.name ?? null,
                email: r?.email ?? null,
                mobile: r?.mobile ?? null,
                country_code: r?.country_code ?? null
            }
        };
    }
    if (type === "bank") {
        const [rows] = await pool.query(
            "SELECT bank_id, account_no, holder, ifsc, bank, branch, type FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1",
            [branch_id, id]
        );
        const r = rows?.[0];
        if (!r) return {};
        return {
            bank: {
                bank_id: r?.bank_id,
                bank: r?.bank ?? null,
                account_no: r?.account_no ?? null,
                holder: r?.holder ?? null,
                ifsc: r?.ifsc ?? null,
                branch: r?.branch ?? null,
                type: r?.type ?? null
            }
        };
    }
    return {};
}
