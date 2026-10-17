// utils/pdfTable.js
// Renders a list export (tasks, clients, ...) as a clean, paginated table PDF.
//
// Why this exists: the old generator used fixed 30pt rows and squeezed every
// column into the page, so long values wrapped mid-word and spilled over the
// next rows, the header label ran off the right edge, and the footer was drawn
// below the bottom margin (which made pdfkit add blank pages). This version
// measures text, sizes columns from their content, never breaks inside a word
// when it can avoid it, grows each row to fit its content and paginates
// with a repeated table header.

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "../assets/fonts");
const FONT_REGULAR = path.join(FONT_DIR, "DejaVuSansCondensed.ttf");
const FONT_BOLD = path.join(FONT_DIR, "DejaVuSansCondensed-Bold.ttf");
const FONT_INDIC = path.join(FONT_DIR, "FreeSans.ttf"); // Bengali/Assamese + Devanagari fallback
const HAS_UNICODE_FONTS = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);
const HAS_INDIC_FONT = HAS_UNICODE_FONTS && fs.existsSync(FONT_INDIC);
const INDIC_TEXT = /[\u0900-\u0DFF]/;

const PAGE_SIZES = {
    A4: [841.89, 595.28], // landscape
    A3: [1190.55, 841.89], // landscape
};

const MARGIN = 28;
const PAD_X = 4;
const PAD_Y = 3.5;
const MAX_LINES_PER_CELL = 12;
const SAMPLE_ROWS = 400;
const FONT_STEPS = [8, 7.5, 7, 6.5];

const COLORS = {
    ink: "#0F172A",
    text: "#1E293B",
    muted: "#64748B",
    brand: "#1A73E8",
    headBg: "#EAF1FE",
    headText: "#1E3A8A",
    zebra: "#F8FAFC",
    rule: "#E2E8F0",
    ruleStrong: "#CBD5E1",
    totalBg: "#F1F5F9",
};

// Columns that only make sense on screen.
const SKIP_KEYS = new Set(["menu", "action", "actions", "select", "checkbox", "row_actions"]);
const SKIP_HEADERS = /^(actions?|menu|select)$/i;

// Columns that look numeric but are identifiers, not amounts.
const IDENTIFIER_HEADER = /(mobile|phone|contact|pan|gst|aadhaar|aadhar|tan|cin|pin|zip|code|\bid\b|_id|^#$|\bno\.?$|number|year|period|file)/i;
const AMOUNT_HEADER = /(fee|amount|balance|total|paid|charge|price|value|outstanding|receivable|payable|due amt|tax|revenue|cost)/i;
const NUMERIC_VALUE = /^[-+]?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?$/;

const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""));

function sanitize(text) {
    let s = String(text).replace(/\s+/g, " ").trim();
    if (HAS_UNICODE_FONTS) return s;
    // Built-in Helvetica only covers WinAnsi; keep the PDF readable without it.
    s = s.replace(/₹/g, "Rs.");
    return Array.from(s)
        .map((ch) => {
            const code = ch.codePointAt(0);
            return code < 256 || WIN_ANSI_EXTRA.has(ch) ? ch : "?";
        })
        .join("");
}

function toText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") {
        if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(", ");
        return value.name || value.label || value.title || value.value || "";
    }
    return sanitize(value);
}

function prettifyTitle(title) {
    const t = String(title || "Report").trim();
    if (/^[a-z0-9_]+$/.test(t)) {
        return t
            .split("_")
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");
    }
    return t;
}

function formatIstNow() {
    try {
        return new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
        }).format(new Date());
    } catch {
        return new Date().toLocaleString();
    }
}

function formatAmount(n) {
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
    return sorted[idx];
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {Array<object>} opts.data
 * @param {Array<{header:string,key:string}>} opts.columns
 * @returns {Promise<Buffer>}
 */
export function buildTablePdf({ title, subtitle = "", data = [], columns = [] }) {
    return new Promise((resolve, reject) => {
        try {
            const reportTitle = prettifyTitle(title);

            // ---- columns & cell text -------------------------------------------------
            const cols = columns
                .filter((c) => c && c.key != null)
                .filter((c) => !SKIP_KEYS.has(String(c.key).toLowerCase()) && !SKIP_HEADERS.test(String(c.header || "").trim()))
                .map((c) => ({ key: c.key, header: sanitize(c.header ?? c.key) }));
            if (!cols.length) cols.push({ key: "__empty", header: "Data" });

            const rows = data.map((row) => cols.map((c) => toText(row?.[c.key])));

            // Numeric / amount detection (sampled).
            const sample = rows.length > SAMPLE_ROWS ? rows.slice(0, SAMPLE_ROWS) : rows;
            cols.forEach((c, ci) => {
                const filled = sample.map((r) => r[ci]).filter((v) => v !== "" && v !== "-" && v !== "—");
                const numeric = filled.length > 0 && filled.filter((v) => NUMERIC_VALUE.test(v)).length / filled.length >= 0.8;
                c.numeric = numeric && !IDENTIFIER_HEADER.test(c.header);
                c.amount = c.numeric && AMOUNT_HEADER.test(c.header);
            });
            cols.forEach((c) => {
                if (!c.amount) return;
                const sum = data.reduce((acc, row) => {
                    const n = parseFloat(String(row?.[c.key] ?? "").replace(/,/g, ""));
                    return Number.isFinite(n) ? acc + n : acc;
                }, 0);
                c.totalText = formatAmount(sum);
            });
            rows.forEach((r) => {
                cols.forEach((c, ci) => {
                    if (c.amount && NUMERIC_VALUE.test(r[ci])) r[ci] = formatAmount(r[ci].replace(/,/g, ""));
                    if (r[ci] === "") r[ci] = "—";
                });
            });

            // ---- document ------------------------------------------------------------
            const doc = new PDFDocument({
                size: PAGE_SIZES.A4,
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                bufferPages: true,
                autoFirstPage: false,
                info: { Title: reportTitle, Author: "OOMS", Creator: "OOMS" },
            });
            const chunks = [];
            doc.on("data", (c) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            if (HAS_UNICODE_FONTS) {
                doc.registerFont("Body", FONT_REGULAR);
                doc.registerFont("Bold", FONT_BOLD);
                if (HAS_INDIC_FONT) doc.registerFont("Indic", FONT_INDIC);
            } else {
                doc.registerFont("Body", "Helvetica");
                doc.registerFont("Bold", "Helvetica-Bold");
            }

            // ---- column sizing -------------------------------------------------------
            const longestWord = (s) => s.split(" ").reduce((m, w) => Math.max(m, doc.widthOfString(w)), 0);

            const measure = (fontSize) => {
                return cols.map((c, ci) => {
                    doc.font("Bold").fontSize(fontSize);
                    const headFull = doc.widthOfString(c.header);
                    const headWord = longestWord(c.header);
                    doc.font("Body").fontSize(fontSize);
                    const widths = [];
                    let word = 0;
                    for (const r of sample) {
                        const v = r[ci];
                        const indic = HAS_INDIC_FONT && INDIC_TEXT.test(v);
                        if (indic) doc.font("Indic");
                        widths.push(doc.widthOfString(v));
                        word = Math.max(word, longestWord(v));
                        if (indic) doc.font("Body");
                    }
                    let content = Math.min(percentile(widths, 0.9), fontSize * 30);
                    if (c.totalText) {
                        doc.font("Bold").fontSize(fontSize);
                        const tw = doc.widthOfString(c.totalText);
                        doc.font("Body").fontSize(fontSize);
                        content = Math.max(content, tw);
                        word = Math.max(word, tw);
                    }
                    const mean = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
                    const min = Math.min(Math.max(word, headWord), fontSize * 16) + PAD_X * 2 + 2;
                    const natural = Math.max(content, Math.min(headFull, Math.max(content, headWord * 1.6)), headWord) + PAD_X * 2;
                    return { min, natural: Math.max(natural, min), mean: Math.max(mean, 1), widths: widths.slice(0, 150) };
                });
            };

            const fit = (pageWidth) => {
                const tableW = pageWidth - MARGIN * 2;
                for (const fontSize of FONT_STEPS) {
                    const m = measure(fontSize);
                    const sumNat = m.reduce((s, x) => s + x.natural, 0);
                    const sumMin = m.reduce((s, x) => s + x.min, 0);
                    if (sumNat <= tableW) {
                        const k = tableW / sumNat;
                        return { fontSize, widths: m.map((x) => x.natural * k), tableW };
                    }
                    if (sumMin <= tableW) {
                        // Short columns (dates, amounts, status) keep their natural width so
                        // they stay on one line; the rest of the width is shared by the long
                        // text columns in proportion to how much text they carry.
                        const fixed = m.map((x) => x.natural - x.min < 14 || x.natural <= fontSize * 9);
                        const w = m.map((x, i) => (fixed[i] ? x.natural : x.min));
                        let free = tableW - w.reduce((s, x) => s + x, 0);
                        if (free < 0) {
                            // Not enough room even so: shrink everything proportionally.
                            const k = (tableW - sumMin) / (sumNat - sumMin || 1);
                            return { fontSize, widths: m.map((x) => x.min + (x.natural - x.min) * k), tableW };
                        }
                        // Greedy: hand out the spare width in small steps to whichever
                        // column reduces the estimated total row height the most.
                        const flex = m.map((x, i) => !fixed[i]);
                        const nRows = m[0].widths.length;
                        const linesOf = (ci, width, ri) => {
                            const inner = Math.max(1, width - PAD_X * 2);
                            return Math.max(1, Math.ceil((m[ci].widths[ri] * 1.08) / inner));
                        };
                        const score = (ws) => {
                            let rowsTotal = 0;
                            let cellsTotal = 0;
                            for (let ri = 0; ri < nRows; ri++) {
                                let mx = 1;
                                for (let ci = 0; ci < m.length; ci++) {
                                    if (!flex[ci]) continue;
                                    const l = linesOf(ci, ws[ci], ri);
                                    cellsTotal += l;
                                    if (l > mx) mx = l;
                                }
                                rowsTotal += mx;
                            }
                            return rowsTotal * 1000 + cellsTotal;
                        };
                        const step = Math.max(2, free / 120);
                        let current = score(w);
                        for (let guard = 0; guard < 400 && free >= 1; guard++) {
                            let best = -1;
                            let bestDelta = 0;
                            let bestScore = current;
                            let bestRatio = 0;
                            for (let ci = 0; ci < m.length; ci++) {
                                if (!flex[ci]) continue;
                                const room = Math.min(free, m[ci].natural - w[ci]);
                                if (room <= 0.01) continue;
                                // Line counts change in jumps, so look ahead several step sizes.
                                for (const mult of [1, 2, 4, 8, 16, 32, 64]) {
                                    const delta = Math.min(room, step * mult);
                                    w[ci] += delta;
                                    const sc = score(w);
                                    w[ci] -= delta;
                                    const ratio = (current - sc) / delta;
                                    if (ratio > bestRatio) {
                                        bestRatio = ratio;
                                        best = ci;
                                        bestDelta = delta;
                                        bestScore = sc;
                                    }
                                    if (delta >= room) break;
                                }
                            }
                            if (best < 0) break;
                            w[best] += bestDelta;
                            free -= bestDelta;
                            current = bestScore;
                        }
                        if (free > 0.5) {
                            // Everything fits at natural width: spread the slack evenly.
                            const k = tableW / w.reduce((s, x) => s + x, 0);
                            return { fontSize, widths: w.map((x) => x * k), tableW };
                        }
                        return { fontSize, widths: w, tableW };
                    }
                }
                return null;
            };

            let pageSize = PAGE_SIZES.A4;
            let layout = fit(pageSize[0]);
            if (!layout) {
                pageSize = PAGE_SIZES.A3;
                layout = fit(pageSize[0]);
            }
            if (!layout) {
                // Extremely wide export: scale minimum widths down; long words may wrap.
                const fontSize = FONT_STEPS[FONT_STEPS.length - 1];
                const m = measure(fontSize);
                const tableW = pageSize[0] - MARGIN * 2;
                const sumMin = m.reduce((s, x) => s + x.min, 0);
                layout = { fontSize, widths: m.map((x) => (x.min / sumMin) * tableW), tableW };
            }

            const { fontSize, widths, tableW } = layout;
            const [pageW, pageH] = pageSize;
            const lineH = fontSize * 1.28;
            const bottomLimit = pageH - MARGIN - 14; // room for footer
            const xs = [];
            widths.reduce((x, w) => (xs.push(x), x + w), MARGIN);

            // Own word-wrapping: lines break only at spaces (a word is split only when
            // it is wider than the whole column), there are no stray leading spaces,
            // and the row height is known exactly before anything is drawn.
            // Names written in Assamese/Bengali or Hindi need a font with those glyphs.
            const resolveFont = (text, font) => (HAS_INDIC_FONT && INDIC_TEXT.test(text) ? "Indic" : font);

            const wrap = (text, w, baseFont) => {
                const font = resolveFont(text, baseFont);
                doc.font(font).fontSize(fontSize);
                const max = Math.max(4, w - PAD_X * 2);
                const lines = [];
                let cur = "";
                for (const word of String(text).split(" ")) {
                    if (!word) continue;
                    const cand = cur ? `${cur} ${word}` : word;
                    if (doc.widthOfString(cand) <= max) {
                        cur = cand;
                        continue;
                    }
                    if (cur) lines.push(cur);
                    if (doc.widthOfString(word) <= max) {
                        cur = word;
                        continue;
                    }
                    let piece = "";
                    for (const ch of Array.from(word)) {
                        if (piece && doc.widthOfString(piece + ch) > max) {
                            lines.push(piece);
                            piece = ch;
                        } else {
                            piece += ch;
                        }
                    }
                    cur = piece;
                }
                if (cur) lines.push(cur);
                if (!lines.length) lines.push("");
                if (lines.length > MAX_LINES_PER_CELL) {
                    lines.length = MAX_LINES_PER_CELL;
                    let last = lines[MAX_LINES_PER_CELL - 1];
                    while (last && doc.widthOfString(`${last}…`) > max) last = last.slice(0, -1);
                    lines[MAX_LINES_PER_CELL - 1] = `${last}…`;
                }
                return lines;
            };

            const drawLines = (lines, i, y, align) => {
                // Alignment is done by hand: pdfkit ignores `align` when lineBreak is off.
                lines.forEach((line, li) => {
                    const x = align === "right" ? xs[i] + widths[i] - PAD_X - doc.widthOfString(line) : xs[i] + PAD_X;
                    doc.text(line, x, y + PAD_Y + li * lineH, { lineBreak: false });
                });
            };

            const cellHeight = (text, w, font) => wrap(text, w, font).length * lineH;

            // ---- drawing helpers -----------------------------------------------------
            const drawPageTitle = (first) => {
                let y = MARGIN;
                if (first) {
                    doc.font("Bold").fontSize(16).fillColor(COLORS.ink).text(reportTitle, MARGIN, y, { width: pageW * 0.6, lineBreak: false, ellipsis: true });
                    doc.font("Bold").fontSize(10).fillColor(COLORS.brand);
                    doc.text("OOMS", pageW - MARGIN - doc.widthOfString("OOMS"), y + 2, { lineBreak: false });
                    y += 22;
                    const meta = sanitize(subtitle || `${rows.length} records`);
                    doc.font("Body").fontSize(8.5).fillColor(COLORS.muted).text(meta, MARGIN, y, { width: pageW * 0.6, lineBreak: false, ellipsis: true });
                    const generated = `Generated ${formatIstNow()} IST`;
                    doc.text(generated, pageW - MARGIN - doc.widthOfString(generated), y, { lineBreak: false });
                    y += 16;
                } else {
                    doc.font("Bold").fontSize(9).fillColor(COLORS.ink).text(`${reportTitle} (continued)`, MARGIN, y, { width: pageW * 0.6, lineBreak: false, ellipsis: true });
                    y += 14;
                }
                doc.moveTo(MARGIN, y).lineTo(MARGIN + tableW, y).lineWidth(first ? 1.2 : 0.8).strokeColor(COLORS.brand).stroke();
                return y + 8;
            };

            const headerHeight = Math.max(...cols.map((c, i) => cellHeight(c.header, widths[i], "Bold"))) + PAD_Y * 2;

            const drawVerticals = (y, h) => {
                doc.lineWidth(0.4).strokeColor(COLORS.rule);
                for (let i = 1; i < xs.length; i++) doc.moveTo(xs[i], y).lineTo(xs[i], y + h).stroke();
            };

            const drawTableHeader = (y) => {
                doc.rect(MARGIN, y, tableW, headerHeight).fill(COLORS.headBg);
                cols.forEach((c, i) => {
                    const lines = wrap(c.header, widths[i], "Bold");
                    doc.font(resolveFont(c.header, "Bold")).fontSize(fontSize).fillColor(COLORS.headText);
                    drawLines(lines, i, y, c.numeric ? "right" : "left");
                });
                drawVerticals(y, headerHeight);
                doc.moveTo(MARGIN, y + headerHeight).lineTo(MARGIN + tableW, y + headerHeight).lineWidth(0.8).strokeColor(COLORS.ruleStrong).stroke();
                return y + headerHeight;
            };

            const drawRow = (cellLines, y, h, { zebra = false } = {}) => {
                if (zebra) doc.rect(MARGIN, y, tableW, h).fill(COLORS.zebra);
                cellLines.forEach((lines, i) => {
                    doc.font(resolveFont(lines.join(" "), "Body")).fontSize(fontSize).fillColor(COLORS.text);
                    drawLines(lines, i, y, cols[i].numeric ? "right" : "left");
                });
                drawVerticals(y, h);
                doc.moveTo(MARGIN, y + h).lineTo(MARGIN + tableW, y + h).lineWidth(0.4).strokeColor(COLORS.rule).stroke();
                return y + h;
            };

            const newPage = (first) => {
                doc.addPage({ size: pageSize, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
                const y = drawPageTitle(first);
                return drawTableHeader(y);
            };

            // ---- body ----------------------------------------------------------------
            let y = newPage(true);
            if (!rows.length) {
                doc.font("Body").fontSize(9).fillColor(COLORS.muted).text("No records to show.", MARGIN, y + 12, { width: tableW, align: "center" });
            }
            rows.forEach((cells, ri) => {
                const cellLines = cells.map((t, i) => wrap(t, widths[i], "Body"));
                const h = Math.max(...cellLines.map((l) => l.length)) * lineH + PAD_Y * 2;
                if (y + h > bottomLimit) y = newPage(false);
                y = drawRow(cellLines, y, h, { zebra: ri % 2 === 1 });
            });

            // Totals row for amount columns: the label spans every column before the
            // first amount column so it never gets squeezed into a narrow "#" cell.
            if (rows.length && cols.some((c) => c.amount)) {
                const firstAmount = cols.findIndex((c) => c.amount);
                const sums = cols.map((c) => c.totalText || "");
                const label = `Total · ${rows.length.toLocaleString("en-IN")} records`;
                const labelW = firstAmount > 0 ? xs[firstAmount] - MARGIN : 0;
                const h = Math.max(lineH, ...sums.map((t, i) => (t ? cellHeight(t, widths[i], "Bold") : 0))) + PAD_Y * 2;
                if (y + h > bottomLimit) y = newPage(false);
                doc.rect(MARGIN, y, tableW, h).fill(COLORS.totalBg);
                doc.font("Bold").fontSize(fontSize).fillColor(COLORS.ink);
                if (labelW > PAD_X * 2 + 4) {
                    const fitsFull = doc.widthOfString(label) <= labelW - PAD_X * 2;
                    const text = fitsFull ? label : doc.widthOfString("Total") <= labelW - PAD_X * 2 ? "Total" : "";
                    if (text) doc.text(text, MARGIN + PAD_X, y + PAD_Y, { lineBreak: false });
                }
                cols.forEach((c, i) => {
                    if (i < firstAmount) return;
                    if (sums[i]) {
                        drawLines([sums[i]], i, y, "right");
                    }
                });
                doc.lineWidth(0.4).strokeColor(COLORS.rule);
                for (let i = Math.max(1, firstAmount); i < xs.length; i++) doc.moveTo(xs[i], y).lineTo(xs[i], y + h).stroke();
                doc.moveTo(MARGIN, y + h).lineTo(MARGIN + tableW, y + h).lineWidth(0.8).strokeColor(COLORS.ruleStrong).stroke();
                y += h;
            }

            // ---- footer on every page -----------------------------------------------
            const range = doc.bufferedPageRange();
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                const fy = doc.page.height - MARGIN + 4;
                doc.moveTo(MARGIN, fy - 6).lineTo(doc.page.width - MARGIN, fy - 6).lineWidth(0.4).strokeColor(COLORS.rule).stroke();
                doc.font("Body").fontSize(7).fillColor(COLORS.muted);
                doc.text(`OOMS · ${reportTitle}`, MARGIN, fy, { width: 300, lineBreak: false });
                const pageLabel = `Page ${i - range.start + 1} of ${range.count}`;
                doc.text(pageLabel, doc.page.width - MARGIN - doc.widthOfString(pageLabel), fy, { lineBreak: false });
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

export default buildTablePdf;
