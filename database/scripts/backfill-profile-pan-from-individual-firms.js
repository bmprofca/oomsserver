/**
 * Backfill profile.pan_number from firms.pan_no for clients.
 *
 * Flow:
 *   1. Fetch all clients (user_type = client)
 *   2. Check profile.pan_number — if already set, skip
 *   3. If null/empty, find that client's firm where firm_type = individual
 *   4. Copy firms.pan_no → profile.pan_number
 *
 * Usage:
 *   node database/scripts/backfill-profile-pan-from-individual-firms.js --dry-run
 *   node database/scripts/backfill-profile-pan-from-individual-firms.js
 *   node database/scripts/backfill-profile-pan-from-individual-firms.js --limit=50
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORT_DIR = path.join(__dirname, "reports");

const REASON = {
    UPDATED: "updated",
    WOULD_UPDATE: "would_update",
    SKIPPED_NO_INDIVIDUAL_FIRM: "skipped_no_individual_firm",
    SKIPPED_EMPTY_FIRM_PAN: "skipped_empty_firm_pan",
    SKIPPED_PROFILE_ALREADY_HAS_PAN: "skipped_profile_already_has_pan",
    SKIPPED_NO_PROFILE: "skipped_no_profile",
    CONFLICT: "conflict",
    ERROR: "error",
};

function parseArgs(argv) {
    const dryRun = argv.includes("--dry-run");
    let limit = null;
    for (const arg of argv) {
        if (arg.startsWith("--limit=")) {
            const n = Number(arg.slice("--limit=".length));
            if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
        }
    }
    return { dryRun, limit };
}

function normalizePan(value) {
    if (value == null) return "";
    return String(value).trim().toUpperCase();
}

function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}

function emptyTotals() {
    return {
        scanned: 0,
        needs_pan: 0,
        updated: 0,
        would_update: 0,
        skipped_no_individual_firm: 0,
        skipped_empty_firm_pan: 0,
        skipped_profile_already_has_pan: 0,
        skipped_no_profile: 0,
        conflict: 0,
        error: 0,
    };
}

function makeDetail({
    username,
    branch_id = null,
    firm_ids = [],
    firm_pans = [],
    firm_pan = null,
    profile_pan_before = null,
    reason,
    message = "",
}) {
    return {
        username,
        branch_id,
        firm_ids,
        firm_pans,
        firm_pan,
        profile_pan_before,
        reason,
        message,
    };
}

function writeReport({ dryRun, limit, totals, details, startedAt, finishedAt }) {
    if (!fs.existsSync(REPORT_DIR)) {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
    }

    const id = stamp();
    const baseName = `backfill-profile-pan-${id}`;
    const jsonPath = path.join(REPORT_DIR, `${baseName}.json`);
    const txtPath = path.join(REPORT_DIR, `${baseName}.txt`);

    const payload = {
        script: "backfill-profile-pan-from-individual-firms.js",
        dry_run: dryRun,
        limit,
        started_at: startedAt,
        finished_at: finishedAt,
        totals,
        details,
        failures: details.filter((d) =>
            [REASON.CONFLICT, REASON.ERROR].includes(d.reason),
        ),
    };

    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

    const lines = [
        "Backfill profile PAN from individual firms",
        `Mode: ${dryRun ? "DRY-RUN" : "LIVE"}`,
        `Started:  ${startedAt}`,
        `Finished: ${finishedAt}`,
        limit != null ? `Limit: ${limit}` : "Limit: none",
        "",
        "Totals:",
        ...Object.entries(totals).map(([k, v]) => `  ${k}: ${v}`),
        "",
        "Conflicts / errors:",
    ];

    const failures = payload.failures;
    if (!failures.length) {
        lines.push("  (none)");
    } else {
        for (const row of failures) {
            lines.push(
                `  [${row.reason}] ${row.username}` +
                    (row.branch_id ? ` (branch=${row.branch_id})` : "") +
                    ` — ${row.message || ""}` +
                    (row.firm_pans?.length ? ` pans=[${row.firm_pans.join(", ")}]` : ""),
            );
        }
    }

    lines.push("", `JSON report: ${jsonPath}`);
    fs.writeFileSync(txtPath, lines.join("\n") + "\n", "utf8");

    return { jsonPath, txtPath };
}

/** Step 1 — fetch all clients */
async function loadClients(limit) {
    const sql = `
        SELECT username, MIN(branch_id) AS branch_id
        FROM clients
        WHERE user_type = 'client'
          AND is_deleted = '0'
          AND status = '1'
        GROUP BY username
        ORDER BY username
        ${limit != null ? "LIMIT ?" : ""}
    `;
    const params = limit != null ? [limit] : [];
    const [rows] = await pool.query(sql, params);
    return rows;
}

/** Step 2 — load active profiles for those clients */
async function loadActiveProfiles(usernames) {
    if (!usernames.length) return new Map();

    const byUser = new Map();
    const chunkSize = 500;

    for (let i = 0; i < usernames.length; i += chunkSize) {
        const chunk = usernames.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        const [rows] = await pool.query(
            `SELECT p.username, p.profile_id, p.pan_number, p.user_type, p.status
             FROM profile p
             INNER JOIN (
                SELECT username, MAX(id) AS max_id
                FROM profile
                WHERE status = '1'
                  AND username IN (${placeholders})
                GROUP BY username
             ) latest ON latest.username = p.username AND latest.max_id = p.id`,
            chunk,
        );

        for (const row of rows) {
            byUser.set(row.username, row);
        }
    }

    return byUser;
}

/**
 * Step 3 — only for clients whose profile pan is missing:
 * load individual firms (firm_type = individual).
 */
async function loadIndividualFirms(usernames) {
    if (!usernames.length) return new Map();

    const byUser = new Map();
    const chunkSize = 500;

    for (let i = 0; i < usernames.length; i += chunkSize) {
        const chunk = usernames.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        const [rows] = await pool.query(
            `SELECT firm_id, username, firm_name, firm_type, pan_no
             FROM firms
             WHERE is_deleted = '0'
               AND LOWER(firm_type) = 'individual'
               AND username IN (${placeholders})
             ORDER BY username, firm_id`,
            chunk,
        );

        for (const row of rows) {
            if (!byUser.has(row.username)) byUser.set(row.username, []);
            byUser.get(row.username).push(row);
        }
    }

    return byUser;
}

/** Resolve a single PAN from individual firms for a client that needs one. */
function resolveFirmPan({ username, branch_id, firms, profilePanBefore }) {
    const firmList = firms || [];

    if (!firmList.length) {
        return makeDetail({
            username,
            branch_id,
            profile_pan_before: profilePanBefore,
            reason: REASON.SKIPPED_NO_INDIVIDUAL_FIRM,
            message: "Profile pan empty, but no individual firm found",
        });
    }

    const firmIds = firmList.map((f) => f.firm_id);
    const nonEmpty = firmList
        .map((f) => ({
            firm_id: f.firm_id,
            pan: normalizePan(f.pan_no),
        }))
        .filter((f) => f.pan);

    if (!nonEmpty.length) {
        return makeDetail({
            username,
            branch_id,
            firm_ids: firmIds,
            firm_pans: [],
            profile_pan_before: profilePanBefore,
            reason: REASON.SKIPPED_EMPTY_FIRM_PAN,
            message: "Profile pan empty; individual firm(s) found but pan_no empty",
        });
    }

    const distinctPans = [...new Set(nonEmpty.map((f) => f.pan))];
    if (distinctPans.length > 1) {
        return makeDetail({
            username,
            branch_id,
            firm_ids: firmIds,
            firm_pans: distinctPans,
            profile_pan_before: profilePanBefore,
            reason: REASON.CONFLICT,
            message: "Multiple individual firms have different PAN values",
        });
    }

    const chosenPan = distinctPans[0];
    return makeDetail({
        username,
        branch_id,
        firm_ids: firmIds,
        firm_pans: [chosenPan],
        firm_pan: chosenPan,
        profile_pan_before: profilePanBefore,
        reason: REASON.WOULD_UPDATE,
        message: "Ready to set profile.pan_number from individual firm pan_no",
    });
}

/** Step 4 — update profile.pan_number */
async function applyUpdate(username, pan) {
    const [result] = await pool.query(
        `UPDATE profile
         SET pan_number = ?
         WHERE username = ?
           AND status = '1'
           AND (pan_number IS NULL OR TRIM(pan_number) = '')`,
        [pan, username],
    );
    return result.affectedRows || 0;
}

async function main() {
    const { dryRun, limit } = parseArgs(process.argv.slice(2));
    const startedAt = new Date().toISOString();
    const totals = emptyTotals();
    const details = [];

    console.log("Backfill profile PAN from individual firms");
    console.log(`Mode: ${dryRun ? "DRY-RUN (no UPDATE)" : "LIVE"}`);
    if (limit != null) console.log(`Limit: ${limit}`);
    console.log("");

    try {
        // 1) Fetch all clients first
        const clients = await loadClients(limit);
        totals.scanned = clients.length;
        console.log(`Step 1 — Clients fetched: ${clients.length}`);

        const allUsernames = clients.map((c) => c.username);

        // 2) Check profile pan_number for each client
        const profilesByUser = await loadActiveProfiles(allUsernames);
        console.log(`Step 2 — Active profiles loaded: ${profilesByUser.size}`);

        const needsPan = [];
        for (const client of clients) {
            const { username, branch_id } = client;
            const profile = profilesByUser.get(username) || null;

            if (!profile) {
                const row = makeDetail({
                    username,
                    branch_id,
                    reason: REASON.SKIPPED_NO_PROFILE,
                    message: "No active profile row (status=1)",
                });
                details.push(row);
                totals.skipped_no_profile += 1;
                continue;
            }

            const profilePan = normalizePan(profile.pan_number);
            if (profilePan) {
                const row = makeDetail({
                    username,
                    branch_id,
                    profile_pan_before: profile.pan_number,
                    reason: REASON.SKIPPED_PROFILE_ALREADY_HAS_PAN,
                    message: "Profile pan_number already set — skipped firm lookup",
                });
                details.push(row);
                totals.skipped_profile_already_has_pan += 1;
                continue;
            }

            // pan is null/empty → candidate for firm lookup
            needsPan.push({
                username,
                branch_id,
                profile_pan_before: profile.pan_number ?? null,
            });
        }

        totals.needs_pan = needsPan.length;
        console.log(
            `Step 2 — Profiles with null/empty pan_number: ${needsPan.length}` +
                ` (already has pan: ${totals.skipped_profile_already_has_pan},` +
                ` no profile: ${totals.skipped_no_profile})`,
        );

        // 3) Only for missing PAN — fetch individual firms
        const needsUsernames = needsPan.map((c) => c.username);
        const firmsByUser = await loadIndividualFirms(needsUsernames);
        console.log(
            `Step 3 — Individual firms loaded for candidates: ${firmsByUser.size} usernames with ≥1 individual firm`,
        );
        console.log("");

        for (const candidate of needsPan) {
            const { username, branch_id, profile_pan_before } = candidate;
            try {
                const classified = resolveFirmPan({
                    username,
                    branch_id,
                    firms: firmsByUser.get(username) || [],
                    profilePanBefore: profile_pan_before,
                });

                if (classified.reason !== REASON.WOULD_UPDATE) {
                    details.push(classified);
                    if (totals[classified.reason] != null) {
                        totals[classified.reason] += 1;
                    }
                    continue;
                }

                // 4) Update profile from firm pan
                if (dryRun) {
                    details.push(classified);
                    totals.would_update += 1;
                    continue;
                }

                const affected = await applyUpdate(username, classified.firm_pan);
                if (affected > 0) {
                    details.push({
                        ...classified,
                        reason: REASON.UPDATED,
                        message: `Updated profile.pan_number (${affected} row(s))`,
                    });
                    totals.updated += 1;
                } else {
                    details.push(
                        makeDetail({
                            username,
                            branch_id,
                            firm_ids: classified.firm_ids,
                            firm_pans: classified.firm_pans,
                            firm_pan: classified.firm_pan,
                            profile_pan_before,
                            reason: REASON.ERROR,
                            message:
                                "UPDATE matched 0 rows (profile may have changed concurrently)",
                        }),
                    );
                    totals.error += 1;
                }
            } catch (err) {
                details.push(
                    makeDetail({
                        username,
                        branch_id,
                        profile_pan_before,
                        reason: REASON.ERROR,
                        message: err?.message || String(err),
                    }),
                );
                totals.error += 1;
                console.error(`Error processing ${username}:`, err?.message || err);
            }
        }

        const finishedAt = new Date().toISOString();
        const { jsonPath, txtPath } = writeReport({
            dryRun,
            limit,
            totals,
            details,
            startedAt,
            finishedAt,
        });

        console.log("Summary:");
        for (const [key, value] of Object.entries(totals)) {
            console.log(`  ${key}: ${value}`);
        }
        console.log("");
        console.log(`Report JSON: ${jsonPath}`);
        console.log(`Report text: ${txtPath}`);

        if (totals.conflict || totals.error) {
            console.log("");
            console.log("Conflicts / errors (see report for full list):");
            details
                .filter((d) => [REASON.CONFLICT, REASON.ERROR].includes(d.reason))
                .slice(0, 30)
                .forEach((d) => {
                    console.log(`  [${d.reason}] ${d.username}: ${d.message}`);
                });
            if (totals.conflict + totals.error > 30) {
                console.log(`  … and ${totals.conflict + totals.error - 30} more`);
            }
        }

        console.log("");
        console.log(
            dryRun
                ? "Dry-run complete. Re-run without --dry-run to apply."
                : "Backfill complete.",
        );
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
});
