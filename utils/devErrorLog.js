// Development-only: mirror console.error / console.warn into logs/dev-errors.log
// so errors can be inspected without scrolling the terminal. Disabled in production
// and when DEV_ERROR_LOG=0.
import fs from "fs";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";

const enabled =
    process.env.NODE_ENV !== "production" && process.env.DEV_ERROR_LOG !== "0";

if (enabled) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.join(__dirname, "..", "logs");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
    const file = path.join(dir, "dev-errors.log");
    const stream = fs.createWriteStream(file, { flags: "a" });
    const wrap = (level, original) => (...args) => {
        try {
            stream.write(`[${new Date().toISOString()}] ${level} ${util.format(...args)}\n`);
        } catch (_) { /* ignore */ }
        original(...args);
    };
    console.error = wrap("ERROR", console.error.bind(console));
    console.warn = wrap("WARN", console.warn.bind(console));
}
