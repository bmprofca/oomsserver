/**
 * Update SQU4SK client profiles from "client data to be updated.json" by name match.
 *
 * Matches profile.name (and firm.firm_name as fallback) case-insensitively after trim/collapse.
 *
 * Usage:
 *   node database/scripts/update-squ4sk-client-profiles.js
 *   node database/scripts/update-squ4sk-client-profiles.js --dry-run
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRANCH_ID = "SQU4SK";
const DEFAULT_JSON = path.resolve(__dirname, "../../../client data to be updated.json");
const REPORT_DIR = path.join(__dirname, "migrate-v3", "reports");

function parseArgs(argv) {
    const args = { dryRun: false, json: DEFAULT_JSON };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--dry-run") args.dryRun = true;
        else if (argv[i] === "--json" && argv[i + 1]) args.json = path.resolve(argv[++i]);
    }
    return args;
}

function clean(value) {
    if (value == null) return "";
    return String(value).trim();
}

/** Normalize for matching: trim, collapse spaces, uppercase */
function normName(value) {
    return clean(value)
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .replace(/[.\u00A0]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

/** Looser key: drop parentheticals, M/S prefix, trailing referral notes */
function looseName(value) {
    return normName(value)
        .replace(/\(.*?\)/g, " ")
        .replace(/^M\/S\s+/i, "")
        .replace(/,.*$/g, " ")
        .replace(/[^A-Z0-9 &]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function addIndex(map, key, row) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
}

function uniqueRows(rows) {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
        if (seen.has(r.username)) continue;
        seen.add(r.username);
        out.push(r);
    }
    return out;
}

function normalizeCareOf(value) {
    const v = clean(value).replace(/\\/g, "");
    if (!v) return null;
    // Prefer compact form used in UI (c/o, S/O, etc.)
    return v.replace(/\s+/g, " ");
}

function normalizeCountryCode(value) {
    const digits = clean(value).replace(/\D/g, "");
    return digits || null;
}

function normalizeMobile(value) {
    const digits = clean(value).replace(/\D/g, "");
    return digits || null;
}

function normalizeDob(value) {
    const v = clean(value);
    if (!v || v.startsWith("0000")) return null;
    // Accept YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const m = v.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
}

function normalizeEmail(value) {
    const v = clean(value).toLowerCase();
    return v || null;
}

async function main() {
    const args = parseArgs(process.argv);
    const raw = JSON.parse(fs.readFileSync(args.json, "utf8"));
    const entries = Array.isArray(raw) ? raw : raw.data || [];

    console.log(`JSON: ${args.json}`);
    console.log(`Entries: ${entries.length}`);
    console.log(`Branch: ${BRANCH_ID}`);
    console.log(`Mode: ${args.dryRun ? "DRY RUN" : "LIVE"}`);

    const [dbRows] = await pool.query(
        `SELECT c.username,
                p.profile_id,
                p.name AS profile_name,
                p.country_code,
                p.mobile,
                p.email,
                p.care_of,
                p.guardian_name,
                p.date_of_birth,
                (
                  SELECT f.firm_name
                  FROM firms f
                  WHERE f.username = c.username
                    AND CAST(f.branch_id AS CHAR) = ?
                    AND f.is_deleted = '0'
                  ORDER BY f.create_date ASC
                  LIMIT 1
                ) AS firm_name
         FROM clients c
         JOIN profile p ON p.username = c.username
         WHERE CAST(c.branch_id AS CHAR) = ?
           AND c.user_type = 'client'
           AND c.is_deleted = '0'`,
        [BRANCH_ID, BRANCH_ID]
    );

    console.log(`DB clients: ${dbRows.length}`);

    // Index DB by exact and loose profile/firm names
    const byExact = new Map();
    const byLoose = new Map();
    for (const row of dbRows) {
        addIndex(byExact, normName(row.profile_name), row);
        addIndex(byExact, normName(row.firm_name), row);
        addIndex(byLoose, looseName(row.profile_name), row);
        addIndex(byLoose, looseName(row.firm_name), row);
    }

    const report = {
        updated: [],
        ambiguous: [],
        notFound: [],
        skippedEmpty: [],
        alreadyUsed: [],
        errors: [],
    };

    let updatedCount = 0;
    const usedUsernames = new Set();

    const conn = await pool.getConnection();
    try {
        if (!args.dryRun) await conn.beginTransaction();

        for (const entry of entries) {
            const name = clean(entry.name);
            const key = normName(name);
            const looseKey = looseName(name);
            if (!key) {
                report.skippedEmpty.push(entry);
                continue;
            }

            let matches = uniqueRows(byExact.get(key) || []);
            let matchVia = "exact";
            if (matches.length === 0 && looseKey) {
                matches = uniqueRows(byLoose.get(looseKey) || []);
                matchVia = "loose";
            }

            // Prefer unused clients when duplicates exist; assign one-by-one in username order
            const free = matches
                .filter((m) => !usedUsernames.has(m.username))
                .sort((a, b) => String(a.username).localeCompare(String(b.username)));

            if (free.length === 0) {
                if (matches.length > 0) {
                    report.alreadyUsed.push({
                        name,
                        key,
                        usernames: matches.map((m) => m.username),
                    });
                } else {
                    report.notFound.push({ name, key, looseKey });
                }
                continue;
            }

            if (free.length > 1) {
                report.ambiguous.push({
                    name,
                    key,
                    usernames: free.map((m) => m.username),
                    matchVia: `${matchVia}+ordered-assign`,
                    assigned: free[0].username,
                });
            }

            const row = free[0];
            usedUsernames.add(row.username);
            const country_code = normalizeCountryCode(entry.country_code);
            const mobile = normalizeMobile(entry.mobile);
            const email = normalizeEmail(entry.email);
            const care_of = normalizeCareOf(entry.care_of);
            const guardian_name = clean(entry.guardian_name) || null;
            const date_of_birth = normalizeDob(entry.date_of_birth);

            const payload = {
                username: row.username,
                name,
                matchVia,
                before: {
                    country_code: row.country_code,
                    mobile: row.mobile,
                    email: row.email,
                    care_of: row.care_of,
                    guardian_name: row.guardian_name,
                    date_of_birth: row.date_of_birth,
                },
                after: {
                    country_code,
                    mobile,
                    email,
                    care_of,
                    guardian_name,
                    date_of_birth,
                },
            };

            try {
                if (!args.dryRun) {
                    await conn.query(
                        `UPDATE profile
                         SET country_code = ?,
                             mobile = ?,
                             email = ?,
                             care_of = ?,
                             guardian_name = ?,
                             date_of_birth = ?
                         WHERE profile_id = ? AND username = ?`,
                        [
                            country_code,
                            mobile,
                            email,
                            care_of,
                            guardian_name,
                            date_of_birth,
                            row.profile_id,
                            row.username,
                        ]
                    );
                }
                updatedCount += 1;
                report.updated.push(payload);
                console.log(`  ✅ ${row.username} ← ${name} (${matchVia})`);
            } catch (err) {
                report.errors.push({ name, username: row.username, error: err.message });
                console.error(`  ❌ ${name}: ${err.message}`);
            }
        }

        if (!args.dryRun) await conn.commit();
    } catch (err) {
        if (!args.dryRun) await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(
        REPORT_DIR,
        `update-squ4sk-profiles-${Date.now()}.json`
    );
    fs.writeFileSync(
        reportPath,
        JSON.stringify(
            {
                branch: BRANCH_ID,
                dryRun: args.dryRun,
                json: args.json,
                summary: {
                    jsonEntries: entries.length,
                    updated: updatedCount,
                    notFound: report.notFound.length,
                    ambiguous: report.ambiguous.length,
                    alreadyUsed: report.alreadyUsed.length,
                    skippedEmpty: report.skippedEmpty.length,
                    errors: report.errors.length,
                },
                ...report,
            },
            null,
            2
        )
    );

    console.log("\n========== SUMMARY ==========");
    console.log(`Updated: ${updatedCount}`);
    console.log(`Not found: ${report.notFound.length}`);
    console.log(`Ambiguous: ${report.ambiguous.length}`);
    console.log(`Already used (dup JSON name): ${report.alreadyUsed.length}`);
    console.log(`Errors: ${report.errors.length}`);
    if (report.notFound.length) {
        console.log("\nNot found (first 30):");
        for (const x of report.notFound.slice(0, 30)) console.log(`  - ${x.name}`);
    }
    if (report.ambiguous.length) {
        console.log("\nAmbiguous:");
        for (const x of report.ambiguous) {
            console.log(`  - ${x.name} → ${x.usernames.join(", ")}`);
        }
    }
    if (report.alreadyUsed.length) {
        console.log("\nDuplicate JSON names (no free match left):");
        for (const x of report.alreadyUsed) {
            console.log(`  - ${x.name}`);
        }
    }
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
