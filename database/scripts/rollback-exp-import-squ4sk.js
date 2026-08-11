/**
 * Rollback the SQU4SK client-data import.
 * Deletes clients, profiles, firms, documents, opening-balance txns/invoices,
 * password groups/credentials, and import-created document categories.
 *
 * Usage:
 *   node database/scripts/rollback-exp-import-squ4sk.js
 *   node database/scripts/rollback-exp-import-squ4sk.js --dry-run
 */
import pool from "../../db.js";

const BRANCH_ID = "SQU4SK";
const CREATE_BY = "usr_LH06YBU1L5";
const dryRun = process.argv.includes("--dry-run");

const conn = await pool.getConnection();
try {
    const [clientRows] = await conn.query(
        `SELECT username FROM clients
         WHERE CAST(branch_id AS CHAR) = ?
           AND user_type = 'client'
           AND create_by = ?
           AND is_deleted = '0'`,
        [BRANCH_ID, CREATE_BY]
    );
    const USERNAMES = clientRows.map((r) => r.username);

    const [pwGroupRows] = await conn.query(
        `SELECT group_id FROM password_groups WHERE CAST(branch_id AS CHAR) = ?`,
        [BRANCH_ID]
    );
    const GROUP_IDS = pwGroupRows.map((r) => r.group_id);

    if (USERNAMES.length === 0 && GROUP_IDS.length === 0) {
        console.log("No imported clients/password groups found on branch", BRANCH_ID);
        process.exit(0);
    }

    console.log(`Branch: ${BRANCH_ID}`);
    console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
    console.log(`Imported clients to remove: ${USERNAMES.length}`);
    console.log(`Password groups to remove: ${GROUP_IDS.length}`);

    if (!dryRun) await conn.beginTransaction();

    const count = async (sql, params = []) => {
        const [rows] = await conn.query(sql, params);
        return rows[0]?.c ?? 0;
    };

    const before = {
        clients: USERNAMES.length
            ? await count(
                  `SELECT COUNT(*) c FROM clients WHERE CAST(branch_id AS CHAR)=? AND username IN (?)`,
                  [BRANCH_ID, USERNAMES]
              )
            : 0,
        profiles: USERNAMES.length
            ? await count(`SELECT COUNT(*) c FROM profile WHERE username IN (?)`, [USERNAMES])
            : 0,
        firms: USERNAMES.length
            ? await count(
                  `SELECT COUNT(*) c FROM firms WHERE CAST(branch_id AS CHAR)=? AND username IN (?)`,
                  [BRANCH_ID, USERNAMES]
              )
            : 0,
        documents: USERNAMES.length
            ? await count(
                  `SELECT COUNT(*) c FROM documents WHERE CAST(branch_id AS CHAR)=? AND username IN (?)`,
                  [BRANCH_ID, USERNAMES]
              )
            : 0,
        transactions: USERNAMES.length
            ? await count(
                  `SELECT COUNT(*) c FROM transactions
                   WHERE CAST(branch_id AS CHAR)=?
                     AND (party1_id IN (?) OR party2_id IN (?))`,
                  [BRANCH_ID, USERNAMES, USERNAMES]
              )
            : 0,
        password_groups: GROUP_IDS.length,
        password_credentials: GROUP_IDS.length
            ? await count(
                  `SELECT COUNT(*) c FROM password_group_firms WHERE group_id IN (?)`,
                  [GROUP_IDS]
              )
            : 0,
    };
    console.log("Before:", before);

    // Password credentials + groups first (FK to firms)
    let credsDeleted = 0;
    let groupsDeleted = 0;
    if (GROUP_IDS.length) {
        if (!dryRun) {
            const [delCreds] = await conn.query(
                `DELETE FROM password_group_firms WHERE group_id IN (?)`,
                [GROUP_IDS]
            );
            credsDeleted = delCreds.affectedRows || 0;
            const [delGroups] = await conn.query(
                `DELETE FROM password_groups WHERE CAST(branch_id AS CHAR) = ? AND group_id IN (?)`,
                [BRANCH_ID, GROUP_IDS]
            );
            groupsDeleted = delGroups.affectedRows || 0;
        } else {
            credsDeleted = before.password_credentials;
            groupsDeleted = before.password_groups;
        }
    }
    console.log("password_group_firms deleted", credsDeleted);
    console.log("password_groups deleted", groupsDeleted);

    // Opening-balance (and any other) transactions for these clients
    let obTx = [];
    if (USERNAMES.length) {
        const [rows] = await conn.query(
            `SELECT transaction_id, invoice_id, invoice_no
             FROM transactions
             WHERE CAST(branch_id AS CHAR) = ?
               AND (party1_id IN (?) OR party2_id IN (?))`,
            [BRANCH_ID, USERNAMES, USERNAMES]
        );
        obTx = rows;
    }
    console.log("transactions to delete", obTx.length);

    const invoiceIds = [...new Set(obTx.map((t) => t.invoice_id).filter(Boolean))];
    const txnIds = obTx.map((t) => t.transaction_id).filter(Boolean);

    if (txnIds.length && !dryRun) {
        await conn.query(
            `DELETE FROM transactions
             WHERE CAST(branch_id AS CHAR) = ? AND transaction_id IN (?)`,
            [BRANCH_ID, txnIds]
        );
    }
    if (invoiceIds.length && !dryRun) {
        await conn.query(
            `DELETE FROM invoice
             WHERE CAST(branch_id AS CHAR) = ? AND invoice_id IN (?)`,
            [BRANCH_ID, invoiceIds]
        );
    }

    // Documents + import categories
    let categoryIds = [];
    if (USERNAMES.length) {
        const [docCats] = await conn.query(
            `SELECT DISTINCT category_id FROM documents
             WHERE CAST(branch_id AS CHAR) = ? AND username IN (?)`,
            [BRANCH_ID, USERNAMES]
        );
        categoryIds = docCats
            .map((r) => r.category_id)
            .filter((id) => id && !["IT", "GST", "MCA"].includes(String(id).toUpperCase()));
    }

    let docsDeleted = 0;
    if (USERNAMES.length) {
        if (!dryRun) {
            const [delDocs] = await conn.query(
                `DELETE FROM documents WHERE CAST(branch_id AS CHAR) = ? AND username IN (?)`,
                [BRANCH_ID, USERNAMES]
            );
            docsDeleted = delDocs.affectedRows || 0;
        } else {
            docsDeleted = before.documents;
        }
    }
    console.log("documents deleted", docsDeleted);

    let catsDeleted = 0;
    if (!dryRun) {
        if (categoryIds.length) {
            for (const category_id of categoryIds) {
                const [still] = await conn.query(
                    `SELECT 1 FROM documents WHERE category_id = ? LIMIT 1`,
                    [category_id]
                );
                if (still.length) continue;
                const [d] = await conn.query(
                    `DELETE FROM document_categories
                     WHERE category_id = ? AND CAST(branch_id AS CHAR) = ?
                       AND (remark LIKE 'Imported%' OR remark LIKE 'System category%')`,
                    [category_id, BRANCH_ID]
                );
                catsDeleted += d.affectedRows || 0;
            }
        }
        const [dCats] = await conn.query(
            `DELETE FROM document_categories
             WHERE CAST(branch_id AS CHAR) = ?
               AND (
                 remark LIKE 'Imported from exp.php.json%'
                 OR remark LIKE 'Imported from client data JSON%'
                 OR remark LIKE 'System category for import%'
               )`,
            [BRANCH_ID]
        );
        catsDeleted += dCats.affectedRows || 0;
    }
    console.log("document_categories deleted", catsDeleted);

    let firmIds = [];
    if (USERNAMES.length) {
        const [firms] = await conn.query(
            `SELECT firm_id FROM firms WHERE CAST(branch_id AS CHAR) = ? AND username IN (?)`,
            [BRANCH_ID, USERNAMES]
        );
        firmIds = firms.map((f) => f.firm_id);
    }

    if (firmIds.length && !dryRun) {
        // Any leftover credentials tied to firms (safety)
        await conn.query(`DELETE FROM password_group_firms WHERE firm_id IN (?)`, [firmIds]);
        const [gf] = await conn.query(`DELETE FROM group_firms WHERE firm_id IN (?)`, [firmIds]);
        console.log("group_firms deleted", gf.affectedRows);
    }

    let firmsDeleted = 0;
    if (USERNAMES.length) {
        if (!dryRun) {
            const [delFirms] = await conn.query(
                `DELETE FROM firms WHERE CAST(branch_id AS CHAR) = ? AND username IN (?)`,
                [BRANCH_ID, USERNAMES]
            );
            firmsDeleted = delFirms.affectedRows || 0;
        } else {
            firmsDeleted = before.firms;
        }
    }
    console.log("firms deleted", firmsDeleted);

    let profilesDeleted = 0;
    if (USERNAMES.length) {
        if (!dryRun) {
            const [delProfiles] = await conn.query(`DELETE FROM profile WHERE username IN (?)`, [
                USERNAMES,
            ]);
            profilesDeleted = delProfiles.affectedRows || 0;
        } else {
            profilesDeleted = before.profiles;
        }
    }
    console.log("profiles deleted", profilesDeleted);

    let clientsDeleted = 0;
    if (USERNAMES.length) {
        if (!dryRun) {
            const [delClients] = await conn.query(
                `DELETE FROM clients WHERE CAST(branch_id AS CHAR) = ? AND username IN (?)`,
                [BRANCH_ID, USERNAMES]
            );
            clientsDeleted = delClients.affectedRows || 0;
        } else {
            clientsDeleted = before.clients;
        }
    }
    console.log("clients deleted", clientsDeleted);

    if (obTx.length && !dryRun) {
        await conn.query(
            `UPDATE invoice_prefix
             SET current = GREATEST(0, CAST(current AS SIGNED) - ?)
             WHERE CAST(branch_id AS CHAR) = ? AND type = 'opening balance' AND is_deleted = '0'`,
            [obTx.length, BRANCH_ID]
        );
        console.log("invoice_prefix opening balance current reduced by", obTx.length);
    }

    if (!dryRun) await conn.commit();

    console.log("\n========== SUMMARY ==========");
    console.log(`Clients removed: ${clientsDeleted}`);
    console.log(`Profiles removed: ${profilesDeleted}`);
    console.log(`Firms removed: ${firmsDeleted}`);
    console.log(`Documents removed: ${docsDeleted}`);
    console.log(`Transactions removed: ${obTx.length}`);
    console.log(`Invoices removed: ${invoiceIds.length}`);
    console.log(`Document categories removed: ${catsDeleted}`);
    console.log(`Password credentials removed: ${credsDeleted}`);
    console.log(`Password groups removed: ${groupsDeleted}`);
    console.log("=============================\n");
    console.log(dryRun ? "Dry run complete — no changes made." : "Done.");
} catch (e) {
    if (!dryRun) await conn.rollback();
    console.error(e);
    process.exitCode = 1;
} finally {
    conn.release();
    process.exit(process.exitCode || 0);
}
