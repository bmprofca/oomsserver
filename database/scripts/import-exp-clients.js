/**
 * Import clients from exp.php.json into branch SQU4SK.
 * Documents: DB metadata only (files assumed already on B2 under original filenames).
 *
 * Usage:
 *   node database/scripts/import-exp-clients.js
 *   node database/scripts/import-exp-clients.js --limit 50 --offset 0
 *   node database/scripts/import-exp-clients.js --dry-run
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";
import {
    SET_OPENING_BALANCE,
    UNIQUE_RANDOM_STRING,
    ID_LENGTH,
    TODAY_DATE,
} from "../../helpers/function.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRANCH_ID = "SQU4SK";
const CREATE_BY = "usr_LH06YBU1L5";
const DEFAULT_JSON = path.resolve(__dirname, "../../../exp.php.json");
const REPORT_DIR = path.join(__dirname, "migrate-v3", "reports");

function parseArgs(argv) {
    const args = {
        limit: Number.MAX_SAFE_INTEGER,
        offset: 0,
        dryRun: false,
        json: DEFAULT_JSON,
        quiet: false,
    };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]);
        else if (argv[i] === "--offset" && argv[i + 1]) args.offset = Number(argv[++i]);
        else if (argv[i] === "--json" && argv[i + 1]) args.json = path.resolve(argv[++i]);
        else if (argv[i] === "--dry-run") args.dryRun = true;
        else if (argv[i] === "--quiet") args.quiet = true;
    }
    return args;
}

function clean(value) {
    if (value == null) return "";
    return String(value).trim();
}

function numBalance(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function isValidPan(pan) {
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
}

/** Deterministic unique placeholder PAN from username (A–Z / 0–9 only). */
function placeholderPan(username, salt = "") {
    const src = String(`${username}${salt}` || "IMPORT").toUpperCase().replace(/[^A-Z0-9]/g, "X");
    const letters = (src.replace(/[^A-Z]/g, "") + "XXXXX").slice(0, 5);
    let digits = src.replace(/[^0-9]/g, "");
    while (digits.length < 4) {
        digits += String((letters.charCodeAt(digits.length % 5) + digits.length + salt.length) % 10);
    }
    digits = digits.slice(0, 4);
    const last = letters[0] || "A";
    return `${letters}${digits}${last}`;
}

function mimeFromFilename(filename) {
    const ext = path.extname(String(filename || "")).toLowerCase();
    const map = {
        ".pdf": "application/pdf",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".csv": "text/csv",
        ".txt": "text/plain",
        ".zip": "application/zip",
    };
    return map[ext] || "application/octet-stream";
}

function mapDocCategory(docType) {
    const t = clean(docType).toLowerCase();
    if (t === "it" || t === "income tax" || t === "income-tax") {
        return { categoryId: "IT", folder: "it" };
    }
    if (t === "gst") {
        return { categoryId: "GST", folder: "gst" };
    }
    if (t === "mca") {
        return { categoryId: "MCA", folder: "mca" };
    }
    return { categoryId: null, folder: "general" };
}

async function ensureGeneralCategory(conn, nameHint) {
    const name = clean(nameHint) || "General";
    const [existing] = await conn.query(
        `SELECT category_id FROM document_categories
         WHERE CAST(branch_id AS CHAR) = ? AND name = ? AND is_deleted = '0'
         LIMIT 1`,
        [BRANCH_ID, name]
    );
    if (existing?.[0]?.category_id) return existing[0].category_id;

    const category_id = await UNIQUE_RANDOM_STRING("document_categories", "category_id", {
        length: ID_LENGTH,
        conn,
    });
    await conn.query(
        `INSERT INTO document_categories
         (category_id, branch_id, name, remark, create_by, modify_by, create_date, modify_date, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), '0')`,
        [category_id, BRANCH_ID, name, "Imported from exp.php.json", CREATE_BY, CREATE_BY]
    );
    return category_id;
}

async function clientExists(conn, username) {
    const [rows] = await conn.query(
        `SELECT username FROM clients
         WHERE username = ? AND CAST(branch_id AS CHAR) = ? AND is_deleted = '0'
         LIMIT 1`,
        [username, BRANCH_ID]
    );
    return rows.length > 0;
}

async function importClient(conn, entry, { dryRun, failedDocs, quiet = false }) {
    const log = (...args) => {
        if (!quiet) console.log(...args);
    };
    const username = clean(entry.username);
    if (!username) throw new Error("Missing username");

    const firms = Array.isArray(entry.firms) ? entry.firms : [];
    const documents = Array.isArray(entry.documents) ? entry.documents : [];
    const balance = numBalance(entry.balance);
    const primaryFirm = firms[0] || null;

    const name =
        clean(primaryFirm?.firm_name) ||
        `Imported Client ${username}`;
    let pan = clean(primaryFirm?.pan).toUpperCase().replace(/\s+/g, "");
    if (!isValidPan(pan)) pan = placeholderPan(username);

    const state = clean(primaryFirm?.state) || "West Bengal";
    const district = clean(primaryFirm?.dist) || "Hooghly";
    const town = clean(primaryFirm?.town) || "NA";
    const pincode = clean(primaryFirm?.pincode) || "700001";
    const address1 = clean(primaryFirm?.address_line_1) || null;
    const address2 = clean(primaryFirm?.address_line_2) || null;

    const result = {
        username,
        created: false,
        skipped: false,
        firms: 0,
        documents: 0,
        docsFailed: 0,
        opening_balance: null,
    };

    if (await clientExists(conn, username)) {
        result.skipped = true;
        log(`  ⏭  client ${username} already exists`);
    }

    if (dryRun) {
        result.created = !result.skipped;
        result.firms = firms.length;
        result.documents = documents.length;
        if (balance !== 0) {
            result.opening_balance = {
                amount: Math.abs(balance),
                type: balance < 0 ? "credit" : "debit",
            };
        }
        return result;
    }

    if (!result.skipped) {
        const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", {
            length: ID_LENGTH,
            conn,
        });

        // Ensure PAN unique in branch
        for (let attempt = 0; attempt < 8; attempt++) {
            const candidate = attempt === 0 ? pan : placeholderPan(username, String(attempt));
            const [panClash] = await conn.query(
                `SELECT p.username
                 FROM profile p
                 JOIN clients c ON c.username = p.username
                 WHERE p.pan_number = ?
                   AND c.user_type = 'client'
                   AND c.is_deleted = '0'
                   AND CAST(c.branch_id AS CHAR) = ?
                 LIMIT 1`,
                [candidate, BRANCH_ID]
            );
            if (panClash.length === 0) {
                pan = candidate;
                break;
            }
            if (attempt === 7) pan = placeholderPan(username, `${Date.now()}`);
        }

        await conn.query(
            `INSERT INTO clients
             (username, user_type, branch_id, create_by, status, is_deleted, create_date)
             VALUES (?, 'client', ?, ?, '1', '0', NOW())`,
            [username, BRANCH_ID, CREATE_BY]
        );

        await conn.query(
            `INSERT INTO profile
             (profile_id, username, create_by, user_type, name, care_of, guardian_name,
              date_of_birth, gender, country_code, mobile, email, pan_number,
              state, district, city, village_town, pincode, address_line_1, address_line_2, status, create_date)
             VALUES (?, ?, ?, 'client', ?, 'S/O', 'N/A',
                     '1990-01-01', 'male', '91', ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, '1', NOW())`,
            [
                profile_id,
                username,
                CREATE_BY,
                name,
                String(
                    9000000000 +
                        (Array.from(username).reduce((a, c) => a + c.charCodeAt(0), 0) % 99999999)
                ).slice(0, 10),
                `${username.toLowerCase()}@import.local`,
                pan,
                state,
                district,
                district,
                town,
                pincode,
                address1,
                address2,
            ]
        );
        result.created = true;
    }

    // Firms
    const firmIdMap = new Map();
    for (const firm of firms) {
        const oldFirmId = clean(firm.firm_id);
        let firm_id = oldFirmId;
        if (!firm_id) {
            firm_id = await UNIQUE_RANDOM_STRING("firms", "firm_id", { length: ID_LENGTH, conn });
        } else {
            const [exists] = await conn.query(
                `SELECT firm_id FROM firms WHERE firm_id = ? LIMIT 1`,
                [firm_id]
            );
            if (exists.length > 0) {
                firmIdMap.set(oldFirmId, firm_id);
                result.firms += 1;
                continue;
            }
        }

        const firmPan = clean(firm.pan).toUpperCase().replace(/\s+/g, "") || pan;
        const firmType = clean(firm.firm_type) || "individual";
        await conn.query(
            `INSERT INTO firms
             (firm_id, branch_id, username, firm_name, firm_type, pan_no, gst_no, tan_no, vat_no, cin_no, file_no,
              state, district, city, pincode, address_line_1, address_line_2, create_by, modify_by, status, is_deleted, create_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', '0', NOW())`,
            [
                firm_id,
                BRANCH_ID,
                username,
                clean(firm.firm_name) || name,
                firmType,
                firmPan || null,
                clean(firm.gst) || null,
                clean(firm.tan) || null,
                clean(firm.vat) || null,
                clean(firm.cin) || null,
                clean(firm.file_no) || null,
                clean(firm.state) || null,
                clean(firm.dist) || null,
                clean(firm.town) || null,
                clean(firm.pincode) || null,
                clean(firm.address_line_1) || null,
                clean(firm.address_line_2) || null,
                CREATE_BY,
                CREATE_BY,
            ]
        );
        firmIdMap.set(oldFirmId || firm_id, firm_id);
        result.firms += 1;
    }

    let defaultFirmId = [...firmIdMap.values()][0] || null;
    if (!defaultFirmId) {
        const [existingFirms] = await conn.query(
            `SELECT firm_id FROM firms
             WHERE username = ? AND CAST(branch_id AS CHAR) = ? AND is_deleted = '0'
             ORDER BY id ASC LIMIT 1`,
            [username, BRANCH_ID]
        );
        defaultFirmId = existingFirms?.[0]?.firm_id || null;
    }

    if (documents.length > 0 && !defaultFirmId) {
        defaultFirmId = await UNIQUE_RANDOM_STRING("firms", "firm_id", { length: ID_LENGTH, conn });
        await conn.query(
            `INSERT INTO firms
             (firm_id, branch_id, username, firm_name, firm_type, pan_no,
              create_by, modify_by, status, is_deleted, create_date)
             VALUES (?, ?, ?, ?, 'individual', ?, ?, ?, '1', '0', NOW())`,
            [defaultFirmId, BRANCH_ID, username, name, pan, CREATE_BY, CREATE_BY]
        );
        firmIdMap.set(defaultFirmId, defaultFirmId);
        result.firms += 1;
    }

    // Documents — DB only; files already on B2 with original filenames
    for (const doc of documents) {
        const document_id =
            clean(doc.document_id) ||
            (await UNIQUE_RANDOM_STRING("documents", "document_id", { length: ID_LENGTH, conn }));
        const [docExists] = await conn.query(
            `SELECT document_id FROM documents WHERE document_id = ? LIMIT 1`,
            [document_id]
        );
        if (docExists.length > 0) {
            result.documents += 1;
            continue;
        }

        const mapped = mapDocCategory(doc.type);
        let category_id = mapped.categoryId;
        if (!category_id) {
            category_id = await ensureGeneralCategory(conn, clean(doc.name) || "General");
        }

        const firm_id = defaultFirmId;
        if (!firm_id) {
            failedDocs.push({
                username,
                document_id,
                reason: "No firm_id available",
                url: doc.document_url,
            });
            result.docsFailed += 1;
            continue;
        }

        const filename = clean(doc.file_name) || `${document_id}.bin`;
        const docName =
            clean(doc.name) ||
            clean(doc.document_type) ||
            clean(doc.file_name) ||
            "Document";
        const year = clean(doc.year) || null;
        const month = clean(doc.month) || null;
        const typeVal = clean(doc.document_type) || clean(doc.type) || null;

        await conn.query(
            `INSERT INTO documents
             (document_id, branch_id, firm_id, username, category_id, name, f_year, a_year, type, remark, month,
              is_reserved, file, size, mime_type, created_by, create_date, modify_by, modify_date, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '1', ?, 0, ?, ?, NOW(), ?, NOW(), '0')`,
            [
                document_id,
                BRANCH_ID,
                firm_id,
                username,
                category_id,
                docName,
                year,
                year,
                typeVal,
                month || null,
                filename,
                mimeFromFilename(filename),
                CREATE_BY,
                CREATE_BY,
            ]
        );
        result.documents += 1;
    }

    if (balance !== 0) {
        result.opening_balance = {
            amount: Math.abs(balance),
            type: balance < 0 ? "credit" : "debit",
            pending: true,
        };
    }

    console.log(
        `  ${result.skipped ? "⏭" : "✅"} ${username} | firms=${result.firms} docs=${result.documents}` +
            (result.opening_balance?.pending
                ? ` OB=${result.opening_balance.type} ${result.opening_balance.amount}`
                : "")
    );

    return result;
}

async function applyOpeningBalance(username, balance) {
    const n = numBalance(balance);
    if (n === 0) return null;

    const [obRows] = await pool.query(
        `SELECT transaction_id FROM transactions
         WHERE CAST(branch_id AS CHAR) = ?
           AND transaction_type = 'opening balance'
           AND (
             (party1_type = 'client' AND party1_id = ?)
             OR (party2_type = 'client' AND party2_id = ?)
           )
         LIMIT 1`,
        [BRANCH_ID, username, username]
    );
    if (obRows.length > 0) {
        return { skipped: true };
    }

    const isCredit = n < 0;
    const absAmount = Math.abs(n);
    await SET_OPENING_BALANCE({
        req: {
            branch_id: BRANCH_ID,
            headers: { username: CREATE_BY },
        },
        type: isCredit ? "1" : "0",
        party_type: "client",
        party_id: username,
        amount: absAmount,
        remark: "Imported opening balance",
        transaction_date: TODAY_DATE(),
    });
    return {
        amount: absAmount,
        type: isCredit ? "credit" : "debit",
    };
}

async function main() {
    const args = parseArgs(process.argv);
    if (!fs.existsSync(args.json)) {
        console.error(`JSON not found: ${args.json}`);
        process.exit(1);
    }

    const all = JSON.parse(fs.readFileSync(args.json, "utf8"));
    if (!Array.isArray(all)) {
        console.error("Expected JSON array");
        process.exit(1);
    }

    const slice = all.slice(args.offset, args.offset + args.limit);
    console.log(
        `\nImporting ${slice.length} client(s) into branch ${BRANCH_ID}` +
            ` from ${args.json}` +
            ` (offset=${args.offset})${args.dryRun ? " [DRY RUN]" : ""}` +
            ` — documents DB-only (no B2 upload)\n`
    );

    const failedDocs = [];
    const summary = [];
    const conn = await pool.getConnection();
    let i = 0;

    try {
        for (const entry of slice) {
            i += 1;
            try {
                await conn.beginTransaction();
                const r = await importClient(conn, entry, {
                    dryRun: args.dryRun,
                    failedDocs,
                    quiet: true,
                });
                if (args.dryRun) {
                    await conn.rollback();
                    summary.push(r);
                } else {
                    await conn.commit();
                    if (r.opening_balance?.pending) {
                        try {
                            const ob = await applyOpeningBalance(entry.username, entry.balance);
                            r.opening_balance = ob;
                        } catch (obErr) {
                            console.error(`  ❌ OB failed ${entry.username}: ${obErr.message}`);
                            r.opening_balance_error = obErr.message;
                        }
                    }
                    summary.push(r);
                }
                if (i % 25 === 0) {
                    console.log(`… progress ${i}/${slice.length}`);
                }
            } catch (err) {
                await conn.rollback();
                console.error(`  ❌ failed ${entry.username}: ${err.message}`);
                summary.push({
                    username: entry.username,
                    error: err.message,
                });
            }
        }
    } finally {
        conn.release();
    }

    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(
        REPORT_DIR,
        `import-exp-clients-${BRANCH_ID}-${Date.now()}.json`
    );
    fs.writeFileSync(
        reportPath,
        JSON.stringify({ branch_id: BRANCH_ID, args, summary, failedDocs }, null, 2)
    );

    const firms = summary.reduce((a, s) => a + (s.firms || 0), 0);
    const docs = summary.reduce((a, s) => a + (s.documents || 0), 0);
    const obs = summary.filter((s) => s.opening_balance && !s.opening_balance.skipped && s.opening_balance.amount).length;

    console.log("\n========== SUMMARY ==========");
    console.log(`Clients processed: ${summary.length}`);
    console.log(`Created: ${summary.filter((s) => s.created).length}`);
    console.log(`Skipped existing: ${summary.filter((s) => s.skipped).length}`);
    console.log(`Firms: ${firms}`);
    console.log(`Documents: ${docs}`);
    console.log(`Opening balances set: ${obs}`);
    console.log(`Errors: ${summary.filter((s) => s.error).length}`);
    console.log(`Doc failures: ${failedDocs.length}`);
    console.log(`Report: ${reportPath}`);
    console.log("=============================\n");

    process.exit(summary.some((s) => s.error) ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
