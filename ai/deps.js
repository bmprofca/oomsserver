import pool from "../db.js";
import { GET_BALANCE } from "../helpers/function.js";
import { collectLedgerStatement } from "../helpers/ledgerReport.js";
import { getOppositePartySnippet } from "../helpers/transactionParty.js";

/**
 * Production dependencies for AI tools. Tools never import db.js / helpers directly,
 * so tests can inject fakes and no tool can reach outside this read-only surface.
 */
export function createDefaultDeps() {
    return {
        db: pool,
        getBalance: GET_BALANCE,
        collectLedger: (opts) => collectLedgerStatement({ ...opts, getOppositePartySnippet }),
    };
}
