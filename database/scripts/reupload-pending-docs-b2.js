/**
 * Re-upload pending imported documents to B2 for branch SQU4SK.
 *
 * Source options (in order):
 *  1) --from-dir <path>  match files by original filename under this folder (recursive)
 *  2) URL in documents.remark ("Source: https://...")
 *
 * Usage:
 *   node database/scripts/reupload-pending-docs-b2.js
 *   node database/scripts/reupload-pending-docs-b2.js --from-dir "C:/path/to/uploads/documents"
 *   node database/scripts/reupload-pending-docs-b2.js --usernames AQGTV7EUP6,ILYRAZPBXF
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";
import { downloadAndUploadProfileDocument } from "../../helpers/b2Storage.js";
import { RANDOM_STRING } from "../../helpers/function.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRANCH_ID = "SQU4SK";
const DEFAULT_USERNAMES = [
    "ANBD1WI02M",
    "HW49ARNJPF",
    "AQGTV7EUP6",
    "ILYRAZPBXF",
    "SBZM5DT2AK",
];

function parseArgs(argv) {
    const args = { fromDir: null, usernames: DEFAULT_USERNAMES };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--from-dir" && argv[i + 1]) args.fromDir = path.resolve(argv[++i]);
        else if (argv[i] === "--usernames" && argv[i + 1]) {
            args.usernames = String(argv[++i])
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }
    return args;
}

function decodeHtml(u) {
    return String(u || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function folderForCategory(categoryId) {
    const c = String(categoryId || "").toUpperCase();
    if (c === "IT") return "it";
    if (c === "GST") return "gst";
    if (c === "MCA") return "mca";
    return "general";
}

function walkFiles(dir, map = new Map()) {
    if (!dir || !fs.existsSync(dir)) return map;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walkFiles(full, map);
        else if (ent.isFile()) {
            map.set(ent.name.toLowerCase(), full);
            // also key by basename without worrying about case
            map.set(ent.name, full);
        }
    }
    return map;
}

function extractSourceUrl(remark) {
    const m = String(remark || "").match(/Source:\s*(\S+)/i);
    return m ? decodeHtml(m[1]) : null;
}

async function uploadLocalFile(localPath, categoryFolder) {
    const buffer = fs.readFileSync(localPath);
    const ext = path.extname(localPath).replace(".", "").toLowerCase() || "bin";
    const mimeGuess =
        ext === "pdf"
            ? "application/pdf"
            : ext === "xlsx"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : ext === "xls"
                ? "application/vnd.ms-excel"
                : ext === "jpg" || ext === "jpeg"
                  ? "image/jpeg"
                  : ext === "png"
                    ? "image/png"
                    : "application/octet-stream";

    // Serve locally once so we can reuse downloadAndUploadProfileDocument → B2.
    const http = await import("http");
    const filename = `${RANDOM_STRING(30)}.${ext}`;
    const server = http.createServer((_req, res) => {
        res.writeHead(200, {
            "Content-Type": mimeGuess,
            "Content-Length": buffer.length,
        });
        res.end(buffer);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port: realPort } = server.address();
    try {
        const url = `http://127.0.0.1:${realPort}/${filename}`;
        return await downloadAndUploadProfileDocument(url, categoryFolder);
    } finally {
        server.close();
    }
}

async function main() {
    const args = parseArgs(process.argv);
    const localMap = args.fromDir ? walkFiles(args.fromDir) : new Map();
    console.log(
        `\nRe-uploading pending docs for branch ${BRANCH_ID}` +
            (args.fromDir ? ` from dir ${args.fromDir} (${localMap.size} files indexed)` : " from source URLs") +
            `\n`
    );

    const [rows] = await pool.query(
        `SELECT document_id, username, category_id, name, file, size, remark
         FROM documents
         WHERE CAST(branch_id AS CHAR) = ?
           AND username IN (?)
           AND is_deleted = '0'
           AND (remark LIKE 'Import pending%' OR IFNULL(size,0) = 0)
         ORDER BY id ASC`,
        [BRANCH_ID, args.usernames]
    );

    console.log(`Pending documents: ${rows.length}\n`);
    let ok = 0;
    let fail = 0;
    const failures = [];

    for (const row of rows) {
        const folder = folderForCategory(row.category_id);
        const originalName = String(row.file || "").trim();
        let uploaded = null;
        let method = "";

        try {
            const localPath =
                (originalName && (localMap.get(originalName) || localMap.get(originalName.toLowerCase()))) ||
                null;
            if (localPath) {
                method = "local";
                uploaded = await uploadLocalFile(localPath, folder);
            } else {
                const url = extractSourceUrl(row.remark);
                if (!url) throw new Error("No local file and no source URL in remark");
                method = "url";
                uploaded = await downloadAndUploadProfileDocument(url, folder);
            }

            await pool.query(
                `UPDATE documents
                 SET file = ?, size = ?, mime_type = ?, remark = NULL, modify_date = NOW()
                 WHERE document_id = ? AND CAST(branch_id AS CHAR) = ?`,
                [uploaded.filename, uploaded.size, uploaded.mimeType, row.document_id, BRANCH_ID]
            );
            ok += 1;
            console.log(`✅ ${row.document_id} [${folder}] via ${method} → ${uploaded.filename} (${uploaded.size} bytes)`);
        } catch (err) {
            fail += 1;
            failures.push({
                document_id: row.document_id,
                username: row.username,
                file: originalName,
                error: err.message,
            });
            console.log(`❌ ${row.document_id} ${originalName}: ${err.message}`);
        }
    }

    const reportPath = path.join(
        __dirname,
        "migrate-v3",
        "reports",
        `reupload-docs-b2-${BRANCH_ID}-${Date.now()}.json`
    );
    fs.writeFileSync(reportPath, JSON.stringify({ ok, fail, failures }, null, 2));
    console.log(`\nDone. ok=${ok} fail=${fail}`);
    console.log(`Report: ${reportPath}\n`);
    process.exit(fail && !ok ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
