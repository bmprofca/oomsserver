/**
 * Full SQU4SK import from "client data to be updated.json":
 * clients, profiles, firms, opening balances, document categories,
 * general + IT documents (DB metadata only), password groups + credentials.
 *
 * Usage:
 *   node database/scripts/import-squ4sk-client-data.js
 *   node database/scripts/import-squ4sk-client-data.js --dry-run
 *   node database/scripts/import-squ4sk-client-data.js --json "path/to.json"
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
const DEFAULT_JSON = path.resolve(__dirname, "../../../client data to be updated.json");
const REPORT_DIR = path.join(__dirname, "migrate-v3", "reports");

function parseArgs(argv) {
    const args = { dryRun: false, json: DEFAULT_JSON, skipPreflight: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--dry-run") args.dryRun = true;
        else if (argv[i] === "--json" && argv[i + 1]) args.json = path.resolve(argv[++i]);
        else if (argv[i] === "--skip-preflight") args.skipPreflight = true;
    }
    return args;
}

function clean(value) {
    if (value == null) return "";
    return String(value).trim();
}

function decodeHtml(value) {
    return clean(value)
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function numBalance(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function isValidPan(pan) {
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
}

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

function normalizeDob(value) {
    const v = clean(value);
    if (!v || v.startsWith("0000")) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return null;
}

function normalizeGender(value) {
    const v = clean(value).toLowerCase();
    if (v === "male" || v === "female" || v === "other") return v;
    return null;
}

function normalizeCountryCode(value) {
    const digits = clean(value).replace(/\D/g, "");
    return digits || "91";
}

function normalizeCareOf(value) {
    const v = clean(value).replace(/\\/g, "");
    return v || null;
}

async function countBranch(conn, sql, params = []) {
    const [rows] = await conn.query(sql, params);
    return rows[0]?.c ?? 0;
}

async function preflight(conn) {
    const counts = {
        clients: await countBranch(
            conn,
            `SELECT COUNT(*) AS c FROM clients WHERE CAST(branch_id AS CHAR) = ?`,
            [BRANCH_ID]
        ),
        firms: await countBranch(
            conn,
            `SELECT COUNT(*) AS c FROM firms WHERE CAST(branch_id AS CHAR) = ?`,
            [BRANCH_ID]
        ),
        documents: await countBranch(
            conn,
            `SELECT COUNT(*) AS c FROM documents WHERE CAST(branch_id AS CHAR) = ?`,
            [BRANCH_ID]
        ),
        password_groups: await countBranch(
            conn,
            `SELECT COUNT(*) AS c FROM password_groups WHERE CAST(branch_id AS CHAR) = ?`,
            [BRANCH_ID]
        ),
        document_categories: await countBranch(
            conn,
            `SELECT COUNT(*) AS c FROM document_categories WHERE CAST(branch_id AS CHAR) = ?`,
            [BRANCH_ID]
        ),
        opening_balances: await countBranch(
            conn,
            `SELECT COUNT(*) AS c FROM transactions
             WHERE CAST(branch_id AS CHAR) = ? AND transaction_type = 'opening balance'`,
            [BRANCH_ID]
        ),
    };
    const dirty = Object.values(counts).some((n) => n > 0);
    return { counts, dirty };
}

async function ensureUniquePan(conn, pan, username) {
    let candidate = pan;
    for (let attempt = 0; attempt < 8; attempt++) {
        if (attempt > 0) candidate = placeholderPan(username, String(attempt));
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
        if (panClash.length === 0) return candidate;
    }
    return placeholderPan(username, String(Date.now()));
}

async function ensureSystemCategory(conn, categoryId, name) {
    const [existing] = await conn.query(
        `SELECT category_id FROM document_categories
         WHERE CAST(branch_id AS CHAR) = ? AND category_id = ? AND is_deleted = '0'
         LIMIT 1`,
        [BRANCH_ID, categoryId]
    );
    if (existing.length) return categoryId;

    await conn.query(
        `INSERT INTO document_categories
         (category_id, branch_id, name, remark, create_by, modify_by, create_date, modify_date, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), '0')`,
        [
            categoryId,
            BRANCH_ID,
            name,
            "System category for import",
            CREATE_BY,
            CREATE_BY,
        ]
    );
    return categoryId;
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
    if (obRows.length > 0) return { skipped: true };

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
    return { amount: absAmount, type: isCredit ? "credit" : "debit" };
}

async function importClient(conn, entry, firmMap, stats) {
    const username = clean(entry.username);
    if (!username) throw new Error("Missing client username");

    const firms = Array.isArray(entry.firms) ? entry.firms : [];
    const primaryFirm = firms[0] || null;
    const name = clean(entry.name) || clean(primaryFirm?.firm_name) || `Imported Client ${username}`;

    let pan = clean(primaryFirm?.pan).toUpperCase().replace(/\s+/g, "");
    if (!isValidPan(pan)) pan = placeholderPan(username);
    pan = await ensureUniquePan(conn, pan, username);

    const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", {
        length: ID_LENGTH,
        conn,
    });

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
         VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', NOW())`,
        [
            profile_id,
            username,
            CREATE_BY,
            name,
            normalizeCareOf(entry.care_of) || "c/o",
            clean(entry.guardian_name) || "N/A",
            normalizeDob(entry.date_of_birth) || "1990-01-01",
            normalizeGender(entry.gender) || "male",
            normalizeCountryCode(entry.country_code),
            clean(entry.mobile).replace(/\D/g, "") || null,
            clean(entry.email).toLowerCase() || null,
            pan,
            clean(primaryFirm?.state) || "West Bengal",
            clean(primaryFirm?.dist) || "Hooghly",
            clean(primaryFirm?.dist) || "Hooghly",
            clean(primaryFirm?.town) || "NA",
            clean(primaryFirm?.pincode) || "700001",
            clean(primaryFirm?.address_line_1) || null,
            clean(primaryFirm?.address_line_2) || null,
        ]
    );
    stats.clients += 1;
    stats.profiles += 1;

    let defaultFirmId = null;
    for (const firm of firms) {
        const firm_id = clean(firm.firm_id) || (await UNIQUE_RANDOM_STRING("firms", "firm_id", { length: ID_LENGTH, conn }));
        const [exists] = await conn.query(`SELECT firm_id FROM firms WHERE firm_id = ? LIMIT 1`, [firm_id]);
        if (exists.length) {
            firmMap.set(firm_id, { firm_id, clientUsername: username });
            if (!defaultFirmId) defaultFirmId = firm_id;
            stats.firms += 1;
            continue;
        }

        const firmPan = clean(firm.pan).toUpperCase().replace(/\s+/g, "") || pan;
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
                clean(firm.firm_type) || "individual",
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
        firmMap.set(firm_id, { firm_id, clientUsername: username });
        if (!defaultFirmId) defaultFirmId = firm_id;
        stats.firms += 1;
    }

    if (!defaultFirmId) {
        defaultFirmId = await UNIQUE_RANDOM_STRING("firms", "firm_id", { length: ID_LENGTH, conn });
        await conn.query(
            `INSERT INTO firms
             (firm_id, branch_id, username, firm_name, firm_type, pan_no,
              create_by, modify_by, status, is_deleted, create_date)
             VALUES (?, ?, ?, ?, 'individual', ?, ?, ?, '1', '0', NOW())`,
            [defaultFirmId, BRANCH_ID, username, name, pan, CREATE_BY, CREATE_BY]
        );
        firmMap.set(defaultFirmId, { firm_id: defaultFirmId, clientUsername: username });
        stats.firms += 1;
    }

    return { username, balance: entry.balance };
}

async function importDocuments(conn, docs, { categoryId, firmMap, stats, kind }) {
    for (const doc of docs) {
        const document_id =
            clean(doc.document_id) ||
            (await UNIQUE_RANDOM_STRING("documents", "document_id", { length: ID_LENGTH, conn }));

        if (document_id.length > 50) {
            stats.docErrors.push({ document_id, reason: "document_id too long for varchar(50)" });
            continue;
        }

        const [exists] = await conn.query(
            `SELECT document_id FROM documents WHERE document_id = ? LIMIT 1`,
            [document_id]
        );
        if (exists.length) {
            stats.documents += 1;
            continue;
        }

        const firm_id = clean(doc.firm_id);
        const mapped = firmMap.get(firm_id);
        if (!mapped) {
            stats.docErrors.push({ document_id, firm_id, reason: "Unknown firm_id", kind });
            continue;
        }

        let cat = categoryId || clean(doc.category_id) || null;
        if (!cat) {
            stats.docErrors.push({ document_id, reason: "Missing category_id", kind });
            continue;
        }

        const filename = clean(doc.file_name) || `${document_id}.bin`;
        const docType = decodeHtml(doc.document_type);
        const docName = clean(doc.name) || docType || filename || "Document";
        const year = clean(doc.a_year) || clean(doc.year) || null;
        const remark = clean(doc.remark) || null;
        const typeVal = docType || kind || null;

        await conn.query(
            `INSERT INTO documents
             (document_id, branch_id, firm_id, username, category_id, name, f_year, a_year, type, remark, month,
              is_reserved, file, size, mime_type, created_by, create_date, modify_by, modify_date, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, 0, ?, ?, NOW(), ?, NOW(), 0)`,
            [
                document_id,
                BRANCH_ID,
                mapped.firm_id,
                mapped.clientUsername,
                cat,
                docName.slice(0, 100),
                year,
                year,
                typeVal ? String(typeVal).slice(0, 50) : null,
                remark,
                filename.slice(0, 100),
                mimeFromFilename(filename),
                CREATE_BY,
                CREATE_BY,
            ]
        );
        stats.documents += 1;
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (!fs.existsSync(args.json)) {
        console.error(`JSON not found: ${args.json}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(args.json, "utf8"));
    const clients = Array.isArray(data.client) ? data.client : [];
    const passwordGroups = Array.isArray(data.password_group) ? data.password_group : [];
    const generalCategories = Array.isArray(data.document?.general_categories)
        ? data.document.general_categories
        : [];
    const generalDocuments = Array.isArray(data.document?.general_documents)
        ? data.document.general_documents
        : [];
    const itDocuments = Array.isArray(data.document?.it_documents) ? data.document.it_documents : [];

    console.log(`\nJSON: ${args.json}`);
    console.log(`Branch: ${BRANCH_ID}`);
    console.log(`Mode: ${args.dryRun ? "DRY RUN" : "LIVE"}`);
    console.log(
        `Payload: clients=${clients.length}, pwGroups=${passwordGroups.length}, ` +
            `cats=${generalCategories.length}, genDocs=${generalDocuments.length}, itDocs=${itDocuments.length}`
    );

    const stats = {
        clients: 0,
        profiles: 0,
        firms: 0,
        categories: 0,
        documents: 0,
        passwordGroups: 0,
        credentials: 0,
        openingBalances: 0,
        openingBalanceErrors: [],
        docErrors: [],
        credentialErrors: [],
        clientErrors: [],
    };

    const firmMap = new Map();
    const pendingOb = [];
    const conn = await pool.getConnection();

    try {
        if (!args.skipPreflight) {
            const { counts, dirty } = await preflight(conn);
            console.log("Preflight:", counts);
            if (dirty && !args.dryRun) {
                throw new Error(
                    "Branch SQU4SK is not empty. Rollback first or pass --skip-preflight."
                );
            }
        }

        if (!args.dryRun) await conn.beginTransaction();

        // 1) Clients / profiles / firms
        let i = 0;
        for (const entry of clients) {
            i += 1;
            try {
                if (args.dryRun) {
                    const username = clean(entry.username);
                    const firms = Array.isArray(entry.firms) ? entry.firms : [];
                    for (const f of firms) {
                        const firm_id = clean(f.firm_id);
                        if (firm_id) firmMap.set(firm_id, { firm_id, clientUsername: username });
                    }
                    stats.clients += 1;
                    stats.profiles += 1;
                    stats.firms += firms.length || 1;
                    if (numBalance(entry.balance) !== 0) pendingOb.push(entry);
                } else {
                    const r = await importClient(conn, entry, firmMap, stats);
                    if (numBalance(r.balance) !== 0) pendingOb.push(r);
                }
            } catch (err) {
                stats.clientErrors.push({ username: entry.username, error: err.message });
                console.error(`  ❌ client ${entry.username}: ${err.message}`);
            }
            if (i % 50 === 0) console.log(`… clients ${i}/${clients.length}`);
        }
        console.log(`Clients/firms done. firmMap=${firmMap.size}`);

        // 2) Document categories
        if (!args.dryRun) {
            await ensureSystemCategory(conn, "IT", "Income Tax");
            await ensureSystemCategory(conn, "GST", "GST");
            await ensureSystemCategory(conn, "MCA", "MCA");
        }
        for (const cat of generalCategories) {
            const category_id = clean(cat.category_id);
            const name = clean(cat.category_name) || "General";
            if (!category_id) continue;
            if (args.dryRun) {
                stats.categories += 1;
                continue;
            }
            const [exists] = await conn.query(
                `SELECT category_id FROM document_categories WHERE category_id = ? LIMIT 1`,
                [category_id]
            );
            if (exists.length) {
                stats.categories += 1;
                continue;
            }
            await conn.query(
                `INSERT INTO document_categories
                 (category_id, branch_id, name, remark, create_by, modify_by, create_date, modify_date, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), '0')`,
                [
                    category_id,
                    BRANCH_ID,
                    name,
                    "Imported from client data JSON",
                    CREATE_BY,
                    CREATE_BY,
                ]
            );
            stats.categories += 1;
        }
        console.log(`Categories done: ${stats.categories}`);

        // 3) Documents
        if (args.dryRun) {
            stats.documents = generalDocuments.length + itDocuments.length;
        } else {
            await importDocuments(conn, generalDocuments, {
                categoryId: null,
                firmMap,
                stats,
                kind: "general",
            });
            await importDocuments(conn, itDocuments, {
                categoryId: "IT",
                firmMap,
                stats,
                kind: "it",
            });
        }
        console.log(`Documents done: ${stats.documents} (errors=${stats.docErrors.length})`);

        // 4) Password groups + credentials
        for (const group of passwordGroups) {
            const group_id = clean(group.password_group_id);
            const group_name = clean(group.group_name) || "UNNAMED";
            if (!group_id) continue;

            if (!args.dryRun) {
                const [exists] = await conn.query(
                    `SELECT group_id FROM password_groups WHERE group_id = ? LIMIT 1`,
                    [group_id]
                );
                if (!exists.length) {
                    await conn.query(
                        `INSERT INTO password_groups
                         (group_id, group_name, branch_id, status, create_by, create_date, modify_by, modify_date, is_deleted)
                         VALUES (?, ?, ?, '1', ?, NOW(), ?, NOW(), '0')`,
                        [group_id, group_name, BRANCH_ID, CREATE_BY, CREATE_BY]
                    );
                }
            }
            stats.passwordGroups += 1;

            const credentials = Array.isArray(group.credentials) ? group.credentials : [];
            for (const cred of credentials) {
                const credential_id = clean(cred.password_id);
                const firm_id = clean(cred.firm_id);
                const mapped = firmMap.get(firm_id);
                if (!mapped) {
                    stats.credentialErrors.push({
                        credential_id,
                        firm_id,
                        reason: "Unknown firm_id",
                    });
                    continue;
                }
                const loginUsername = clean(cred.username);
                if (!credential_id || !loginUsername) {
                    stats.credentialErrors.push({
                        credential_id,
                        firm_id,
                        reason: "Missing credential_id or username",
                    });
                    continue;
                }

                if (args.dryRun) {
                    stats.credentials += 1;
                    continue;
                }

                const [exists] = await conn.query(
                    `SELECT credential_id FROM password_group_firms WHERE credential_id = ? LIMIT 1`,
                    [credential_id]
                );
                if (exists.length) {
                    stats.credentials += 1;
                    continue;
                }

                await conn.query(
                    `INSERT INTO password_group_firms
                     (credential_id, group_id, firm_id, username, password, description,
                      status, create_by, create_date, modify_by, modify_date, is_deleted)
                     VALUES (?, ?, ?, ?, ?, ?, '1', ?, NOW(), ?, NOW(), '0')`,
                    [
                        credential_id,
                        group_id,
                        mapped.firm_id,
                        loginUsername,
                        cred.password == null ? "" : String(cred.password),
                        clean(cred.description) || null,
                        CREATE_BY,
                        CREATE_BY,
                    ]
                );
                stats.credentials += 1;
            }
        }
        console.log(
            `Passwords done: groups=${stats.passwordGroups} creds=${stats.credentials} (errors=${stats.credentialErrors.length})`
        );

        if (args.dryRun) {
            await conn.rollback();
            stats.openingBalances = pendingOb.length;
        } else {
            await conn.commit();
        }
    } catch (err) {
        if (!args.dryRun) await conn.rollback();
        conn.release();
        console.error(err);
        process.exit(1);
    }

    conn.release();

    // Opening balances outside client txn (SET_OPENING_BALANCE uses its own connection)
    if (!args.dryRun) {
        let oi = 0;
        for (const entry of pendingOb) {
            oi += 1;
            try {
                const ob = await applyOpeningBalance(entry.username, entry.balance);
                if (ob && !ob.skipped) stats.openingBalances += 1;
            } catch (obErr) {
                stats.openingBalanceErrors.push({
                    username: entry.username,
                    error: obErr.message,
                });
                console.error(`  ❌ OB ${entry.username}: ${obErr.message}`);
            }
            if (oi % 25 === 0) console.log(`… opening balances ${oi}/${pendingOb.length}`);
        }
    }

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(
        REPORT_DIR,
        `import-squ4sk-client-data-${Date.now()}.json`
    );
    fs.writeFileSync(
        reportPath,
        JSON.stringify(
            {
                branch: BRANCH_ID,
                dryRun: args.dryRun,
                json: args.json,
                stats,
            },
            null,
            2
        )
    );

    console.log("\n========== SUMMARY ==========");
    console.log(`Clients: ${stats.clients}`);
    console.log(`Profiles: ${stats.profiles}`);
    console.log(`Firms: ${stats.firms}`);
    console.log(`Categories: ${stats.categories}`);
    console.log(`Documents: ${stats.documents}`);
    console.log(`Password groups: ${stats.passwordGroups}`);
    console.log(`Credentials: ${stats.credentials}`);
    console.log(`Opening balances: ${stats.openingBalances}`);
    console.log(`Client errors: ${stats.clientErrors.length}`);
    console.log(`Doc errors: ${stats.docErrors.length}`);
    console.log(`Credential errors: ${stats.credentialErrors.length}`);
    console.log(`OB errors: ${stats.openingBalanceErrors.length}`);
    console.log(`Report: ${reportPath}`);
    console.log("=============================\n");

    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {
        /* ignore */
    }
    process.exit(1);
});
