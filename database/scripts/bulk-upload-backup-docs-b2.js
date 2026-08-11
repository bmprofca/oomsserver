/**
 * Bulk-upload local document folders to Backblaze B2 with resumable JSON log.
 *
 * Sources → destinations:
 *   backup/general → media/profile/document/general/
 *   backup/it      → media/profile/document/it/
 *
 * Usage (from SERVER/):
 *   node database/scripts/bulk-upload-backup-docs-b2.js --only it --concurrency 1
 *   node database/scripts/bulk-upload-backup-docs-b2.js --reset-it --only it --concurrency 1
 *   node database/scripts/bulk-upload-backup-docs-b2.js --dry-run
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { uploadProfileDocumentBuffer } from "../../helpers/b2Storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../");
const DEFAULT_LOG = path.join(ROOT, "backup", "b2-upload-log.json");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per file

const FOLDERS = [
    { category: "general", localDir: path.join(ROOT, "backup", "general") },
    { category: "it", localDir: path.join(ROOT, "backup", "it") },
];

function parseArgs(argv) {
    const args = {
        concurrency: 1,
        only: null,
        dryRun: false,
        log: DEFAULT_LOG,
        maxRetries: 5,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        resetIt: false,
    };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--concurrency" && argv[i + 1]) args.concurrency = Math.max(1, Number(argv[++i]) || 1);
        else if (argv[i] === "--only" && argv[i + 1]) args.only = String(argv[++i]).toLowerCase();
        else if (argv[i] === "--log" && argv[i + 1]) args.log = path.resolve(argv[++i]);
        else if (argv[i] === "--dry-run") args.dryRun = true;
        else if (argv[i] === "--reset-it") args.resetIt = true;
        else if (argv[i] === "--max-retries" && argv[i + 1]) args.maxRetries = Math.max(1, Number(argv[++i]) || 5);
        else if (argv[i] === "--timeout-ms" && argv[i + 1]) {
            args.timeoutMs = Math.max(60000, Number(argv[++i]) || DEFAULT_TIMEOUT_MS);
        }
    }
    return args;
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

function logKey(category, filename) {
    return `${category}/${filename}`;
}

function loadLog(logPath) {
    if (!fs.existsSync(logPath)) {
        return { uploaded: {}, failed: {}, startedAt: null, updatedAt: null };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(logPath, "utf8"));
        return {
            uploaded: raw.uploaded && typeof raw.uploaded === "object" ? raw.uploaded : {},
            failed: raw.failed && typeof raw.failed === "object" ? raw.failed : {},
            startedAt: raw.startedAt || null,
            updatedAt: raw.updatedAt || null,
        };
    } catch {
        return { uploaded: {}, failed: {}, startedAt: null, updatedAt: null };
    }
}

function saveLog(logPath, log) {
    log.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
}

function resetCategoryInLog(log, category) {
    const prefix = `${category}/`;
    let removedUploaded = 0;
    let removedFailed = 0;
    for (const key of Object.keys(log.uploaded || {})) {
        if (key.startsWith(prefix)) {
            delete log.uploaded[key];
            removedUploaded += 1;
        }
    }
    for (const key of Object.keys(log.failed || {})) {
        if (key.startsWith(prefix)) {
            delete log.failed[key];
            removedFailed += 1;
        }
    }
    return { removedUploaded, removedFailed };
}

function listFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile()) out.push(full);
        }
    };
    walk(dir);
    return out;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err) {
    const status = err?.response?.status;
    const msg = String(err?.message || err || "").toLowerCase();
    if (status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true;
    }
    return (
        msg.includes("timeout") ||
        msg.includes("too many") ||
        msg.includes("econnreset") ||
        msg.includes("socket hang up") ||
        msg.includes("network") ||
        msg.includes("429")
    );
}

function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "0B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 1;
    return `${v.toFixed(digits)}${units[i]}`;
}

function formatSpeed(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0KB/s";
    return `${formatBytes(bytesPerSec)}/s`;
}

function renderProgress(state) {
    const { done, total, skipped, uploaded, failed, active } = state;
    const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
    const barWidth = 24;
    const filled = Math.round((pct / 100) * barWidth);
    const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;

    let activeText = "(idle)";
    if (active.size > 0) {
        activeText = [...active.values()]
            .map((a) => {
                const sent = formatBytes(a.loaded || 0);
                const totalSize = formatBytes(a.total || a.size || 0);
                const speed = formatSpeed(a.speed || 0);
                return `${a.category}/${a.filename} ${sent}/${totalSize} @ ${speed}`;
            })
            .join(" | ");
    }

    const line =
        `[${bar}] ${pct}%  ${done}/${total}  ` +
        `↑${uploaded} skip=${skipped} fail=${failed}  ` +
        `now: ${activeText}`;
    process.stdout.write(`\r${line.slice(0, 220).padEnd(220)}`);
}

async function uploadOne(job, args, log, state) {
    const key = logKey(job.category, job.filename);
    const fileSize = job.size || fs.statSync(job.fullPath).size;

    state.active.set(key, {
        category: job.category,
        filename: job.filename,
        size: fileSize,
        loaded: 0,
        total: fileSize,
        speed: 0,
    });
    renderProgress(state);

    if (args.dryRun) {
        state.active.delete(key);
        state.uploaded += 1;
        state.done += 1;
        renderProgress(state);
        return;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= args.maxRetries; attempt++) {
        try {
            const buffer = fs.readFileSync(job.fullPath);
            const mimeType = mimeFromFilename(job.filename);
            const startedAt = Date.now();
            let lastTick = startedAt;
            let lastLoaded = 0;

            const result = await uploadProfileDocumentBuffer(
                job.category,
                job.filename,
                buffer,
                mimeType,
                {
                    timeoutMs: args.timeoutMs,
                    onUploadProgress: (evt) => {
                        const loaded = Number(evt.loaded) || 0;
                        const total = Number(evt.total) || fileSize || loaded;
                        const now = Date.now();
                        const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
                        const instantDt = Math.max(0.001, (now - lastTick) / 1000);
                        const instantSpeed = (loaded - lastLoaded) / instantDt;
                        const avgSpeed = loaded / elapsedSec;
                        const speed = instantSpeed > 0 ? instantSpeed : avgSpeed;

                        lastTick = now;
                        lastLoaded = loaded;

                        state.active.set(key, {
                            category: job.category,
                            filename: job.filename,
                            size: fileSize,
                            loaded,
                            total,
                            speed,
                        });
                        renderProgress(state);
                    },
                }
            );

            // Mark complete bytes before logging success
            state.active.set(key, {
                category: job.category,
                filename: job.filename,
                size: result.size,
                loaded: result.size,
                total: result.size,
                speed: result.size / Math.max(0.001, (Date.now() - startedAt) / 1000),
            });
            renderProgress(state);

            log.uploaded[key] = {
                category: job.category,
                filename: job.filename,
                key: result.key,
                size: result.size,
                mimeType: result.mimeType,
                uploadedAt: new Date().toISOString(),
            };
            delete log.failed[key];
            saveLog(args.log, log);

            state.active.delete(key);
            state.uploaded += 1;
            state.done += 1;
            renderProgress(state);
            console.log(
                `\n  ✅ ${job.category}/${job.filename} (${formatBytes(result.size)}/${formatBytes(result.size)}) → ${result.key}`
            );
            renderProgress(state);
            return;
        } catch (err) {
            lastError = err;
            const retryable = isRetryable(err);
            if (!retryable || attempt === args.maxRetries) break;
            const waitMs = Math.min(60000, 2000 * 2 ** (attempt - 1));
            console.log(
                `\n  ⏳ retry ${attempt}/${args.maxRetries} ${job.category}/${job.filename} in ${waitMs}ms — ${err.message}`
            );
            renderProgress(state);
            await sleep(waitMs);
        }
    }

    log.failed[key] = {
        category: job.category,
        filename: job.filename,
        error: lastError?.message || String(lastError),
        failedAt: new Date().toISOString(),
    };
    saveLog(args.log, log);

    state.active.delete(key);
    state.failed += 1;
    state.done += 1;
    renderProgress(state);
    console.log(`\n  ❌ ${job.category}/${job.filename}: ${lastError?.message || lastError}`);
    renderProgress(state);
}

async function runPool(jobs, concurrency, worker) {
    let idx = 0;
    const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (idx < jobs.length) {
            const current = idx;
            idx += 1;
            await worker(jobs[current]);
        }
    });
    await Promise.all(runners);
}

async function main() {
    const args = parseArgs(process.argv);
    const folders = FOLDERS.filter((f) => !args.only || f.category === args.only);

    console.log("Bulk B2 document upload");
    console.log(`Log: ${args.log}`);
    console.log(`Concurrency: ${args.concurrency}${args.dryRun ? " [DRY RUN]" : ""}`);
    console.log(`Timeout per file: ${Math.round(args.timeoutMs / 1000)}s`);
    console.log("Sort: file size ASC (smallest first)");

    const log = loadLog(args.log);
    if (!log.startedAt) log.startedAt = new Date().toISOString();

    if (args.resetIt) {
        const cleared = resetCategoryInLog(log, "it");
        saveLog(args.log, log);
        console.log(
            `Reset IT log entries: uploaded removed=${cleared.removedUploaded}, failed removed=${cleared.removedFailed}`
        );
    }

    const jobs = [];
    let alreadyUploaded = 0;

    for (const folder of folders) {
        if (!fs.existsSync(folder.localDir)) {
            console.warn(`Missing folder: ${folder.localDir}`);
            continue;
        }
        const files = listFiles(folder.localDir);
        console.log(`${folder.category}: ${files.length} file(s) in ${folder.localDir}`);
        for (const fullPath of files) {
            const filename = path.basename(fullPath);
            const key = logKey(folder.category, filename);
            if (log.uploaded[key]) {
                alreadyUploaded += 1;
                continue;
            }
            const size = fs.statSync(fullPath).size;
            jobs.push({
                category: folder.category,
                filename,
                fullPath,
                size,
            });
        }
    }

    // Smallest files first
    jobs.sort((a, b) => a.size - b.size || a.filename.localeCompare(b.filename));

    const total = jobs.length + alreadyUploaded;
    const state = {
        total,
        done: alreadyUploaded,
        skipped: alreadyUploaded,
        uploaded: 0,
        failed: 0,
        active: new Map(),
    };

    console.log(
        `Pending: ${jobs.length} | Already logged (skip): ${alreadyUploaded} | Total: ${total}\n`
    );
    if (jobs.length) {
        console.log(
            `First (smallest): ${jobs[0].category}/${jobs[0].filename} (${formatBytes(jobs[0].size)})`
        );
        console.log(
            `Last (largest): ${jobs[jobs.length - 1].category}/${jobs[jobs.length - 1].filename} (${formatBytes(jobs[jobs.length - 1].size)})\n`
        );
    }
    renderProgress(state);

    if (jobs.length === 0) {
        console.log("\nNothing to upload.");
        return;
    }

    await runPool(jobs, args.concurrency, (job) => uploadOne(job, args, log, state));

    saveLog(args.log, log);
    console.log("\n\n========== SUMMARY ==========");
    console.log(`Uploaded this run: ${state.uploaded}`);
    console.log(`Skipped (log): ${state.skipped}`);
    console.log(`Failed: ${state.failed}`);
    console.log(`Log file: ${args.log}`);
    console.log(`Logged uploaded total: ${Object.keys(log.uploaded).length}`);
    console.log("=============================\n");
}

main().catch((err) => {
    console.error("\nFatal:", err);
    process.exit(1);
});
