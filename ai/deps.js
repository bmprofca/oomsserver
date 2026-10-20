import pool from "../db.js";
import { GET_BALANCE } from "../helpers/function.js";
import { collectLedgerStatement } from "../helpers/ledgerReport.js";
import { getOppositePartySnippet } from "../helpers/transactionParty.js";
import { createDefaultSenders } from "./actions/senders.js";

/**
 * Production dependencies for AI tools. Tools never import db.js / helpers directly,
 * so tests can inject fakes. `senders` (real WhatsApp / email / document delivery) is only
 * reached through confirmed write actions (ai/actions/execute.js).
 */
export function createDefaultDeps() {
    return {
        db: pool,
        getBalance: GET_BALANCE,
        collectLedger: (opts) => collectLedgerStatement({ ...opts, getOppositePartySnippet }),
        senders: createDefaultSenders(pool),
    };
}
