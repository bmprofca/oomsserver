import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportsDir = path.join(__dirname, "..", "reports");

export function createLogger({ dryRun = false } = {}) {
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportsDir, `migrate-v3-${stamp}.log`);
    const lines = [];

    function write(level, message, meta) {
        const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
        const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}`;
        lines.push(line);
        console.log(line);
    }

    return {
        dryRun,
        info: (msg, meta) => write("INFO", msg, meta),
        warn: (msg, meta) => write("WARN", msg, meta),
        error: (msg, meta) => write("ERROR", msg, meta),
        stat: (key, value) => write("STAT", `${key}=${value}`),
        flush() {
            fs.writeFileSync(reportPath, lines.join("\n"), "utf8");
            return reportPath;
        },
    };
}
