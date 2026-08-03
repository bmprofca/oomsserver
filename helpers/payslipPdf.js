import PDFDocument from "pdfkit";

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/**
 * Print-friendly palette:
 * - Body text stays dark for B&W clarity
 * - Accents used on labels/titles only (no colored backgrounds)
 */
const C = {
    ink: "#111111",
    body: "#1f2937",
    muted: "#4b5563",
    line: "#374151",
    hair: "#9ca3af",
    soft: "#f3f4f6",
    accent: "#0f766e", // teal — section titles / net label
    accentDark: "#115e59",
    amount: "#1d4ed8", // blue — money figures
};

/** Absolute text — never wraps / never triggers PDFKit auto page-break. */
function absText(doc, str, x, y, opts = {}) {
    const {
        width = 100,
        align = "left",
        font = "Helvetica",
        size = 10,
        color = C.body,
    } = opts;
    doc.save();
    doc.font(font).fontSize(size).fillColor(color);
    doc.text(String(str ?? ""), x, y, {
        width,
        align,
        lineBreak: false,
        ellipsis: true,
        continued: false,
    });
    doc.restore();
    doc.x = 40;
    doc.y = 40;
}

/**
 * Multi-line absolute text (for address). Returns y after last line.
 * Caps at maxLines to avoid runaway height.
 */
function absMultiline(doc, str, x, y, opts = {}) {
    const {
        width = 200,
        font = "Helvetica",
        size = 9,
        color = C.muted,
        lineHeight = 13,
        maxLines = 3,
    } = opts;
    const raw = String(str || "").trim();
    if (!raw) return y;

    doc.save();
    doc.font(font).fontSize(size);
    // Split on commas / newlines into readable chunks, then wrap by width
    const parts = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const lines = [];
    let current = "";
    parts.forEach((part, idx) => {
        const candidate = current ? `${current}, ${part}` : part;
        if (doc.widthOfString(candidate) <= width) {
            current = candidate;
        } else {
            if (current) lines.push(current);
            current = part;
        }
        if (idx === parts.length - 1 && current) lines.push(current);
    });
    doc.restore();

    const use = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
        use[maxLines - 1] = `${use[maxLines - 1].replace(/\.*$/, "")}…`;
    }

    use.forEach((line, i) => {
        absText(doc, line, x, y + i * lineHeight, {
            width,
            font,
            size,
            color,
        });
    });
    return y + use.length * lineHeight;
}

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    const abs = Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${x < 0 ? "-" : ""}Rs. ${abs}`;
}

function formatDateDisplay(value) {
    if (!value) return "—";
    const raw = String(value);
    let d;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const [y, m, day] = raw.slice(0, 10).split("-").map(Number);
        d = new Date(y, m - 1, day);
    } else {
        d = new Date(value);
    }
    if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

function titleCaseStatus(status) {
    const s = String(status || "").trim().toLowerCase();
    if (s === "half day") return "Half day";
    if (!s) return "—";
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function hLine(doc, x1, x2, y, color = C.line, width = 0.8) {
    doc.moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(width).stroke();
}

function drawAmountColumn(doc, x, y, w, title, rows) {
    absText(doc, title, x, y, {
        width: w,
        font: "Helvetica-Bold",
        size: 10,
        color: C.accent,
    });
    hLine(doc, x, x + w, y + 14, C.line, 0.9);
    let rowY = y + 22;
    rows.forEach((row) => {
        absText(doc, row.label, x, rowY, {
            width: w * 0.6,
            font: "Helvetica",
            size: 9,
            color: C.body,
        });
        absText(doc, money(row.value), x + w * 0.52, rowY, {
            width: w * 0.48,
            align: "right",
            font: "Helvetica-Bold",
            size: 9,
            color: C.amount,
        });
        rowY += 18;
    });
    const total = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
    hLine(doc, x, x + w, rowY, C.hair, 0.6);
    rowY += 8;
    absText(doc, "Subtotal", x, rowY, {
        width: w * 0.4,
        font: "Helvetica-Bold",
        size: 9,
        color: C.ink,
    });
    absText(doc, money(total), x + w * 0.42, rowY, {
        width: w * 0.58,
        align: "right",
        font: "Helvetica-Bold",
        size: 10,
        color: C.amount,
    });
    return rowY + 20;
}

function drawTableHeader(doc, left, y, cols, headerH = 16) {
    const contentW = cols.reduce((s, c) => s + c.w, 0);
    doc.rect(left, y, contentW, headerH).fill(C.soft);
    hLine(doc, left, left + contentW, y, C.line, 0.8);
    hLine(doc, left, left + contentW, y + headerH, C.line, 0.8);
    let x = left;
    cols.forEach((c) => {
        absText(doc, c.label.toUpperCase(), x + 4, y + 4, {
            width: c.w - 8,
            align: c.align || "left",
            font: "Helvetica-Bold",
            size: 8,
            color: C.accentDark,
        });
        x += c.w;
    });
    return y + headerH;
}

/**
 * Print-friendly payslip PDF — spaced layout, accent text colors, no username.
 */
export function buildPayslipPdfBuffer(data) {
    const {
        branch = {},
        staff = {},
        payslip = {},
        summary = {},
        days = [],
        bonus_fine = {},
    } = data;

    const monthName =
        payslip.month_name ||
        MONTH_NAMES[Number(payslip.month) - 1] ||
        String(payslip.month || "");
    const periodLabel = `${monthName} ${payslip.year || ""}`.trim();

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: "A4",
                margin: 0,
                autoFirstPage: true,
                bufferPages: false,
                info: {
                    Title: `Payslip - ${staff.name || "Staff"} - ${periodLabel}`,
                    Author: branch.name || "OOMS",
                    Subject: "Staff Payslip",
                },
            });

            const chunks = [];
            doc.on("data", (c) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            const pageW = doc.page.width;
            const pageH = doc.page.height;
            const left = 40;
            const right = pageW - 40;
            const contentW = right - left;
            const maxContentY = pageH - 28;
            const rightColX = left + contentW * 0.58;
            const rightColW = contentW * 0.42;

            doc.x = left;
            doc.y = 40;

            // ── Letterhead ───────────────────────────────────────────────
            absText(doc, branch.name || "Organization", left, 36, {
                width: contentW * 0.55,
                font: "Helvetica-Bold",
                size: 16,
                color: C.ink,
            });
            absText(doc, "PAYSLIP", rightColX, 36, {
                width: rightColW,
                align: "right",
                font: "Helvetica-Bold",
                size: 16,
                color: C.accent,
            });

            // Left: address + contact (multi-line, reserved width)
            // Right: period only — no overlap with address
            let yLeft = 58;
            yLeft = absMultiline(doc, branch.address || "", left, yLeft, {
                width: contentW * 0.55,
                font: "Helvetica",
                size: 9,
                color: C.muted,
                lineHeight: 13,
                maxLines: 3,
            });
            const contact = [branch.mobile, branch.email].filter(Boolean).join("  ·  ");
            if (contact) {
                absText(doc, contact, left, yLeft + 2, {
                    width: contentW * 0.55,
                    font: "Helvetica",
                    size: 9,
                    color: C.muted,
                });
                yLeft += 15;
            }

            absText(doc, periodLabel, rightColX, 58, {
                width: rightColW,
                align: "right",
                font: "Helvetica-Bold",
                size: 11,
                color: C.body,
            });

            let y = Math.max(yLeft + 8, 88);
            hLine(doc, left, right, y, C.ink, 1.5);
            y += 14;

            // ── Meta ─────────────────────────────────────────────────────
            const meta = [
                ["Invoice", payslip.invoice_no || "—"],
                ["Payslip date", formatDateDisplay(payslip.payslip_date)],
                ["Payslip ID", payslip.payslip_id || "—"],
            ];
            const metaW = contentW / 3;
            meta.forEach(([label, value], i) => {
                const x = left + i * metaW;
                absText(doc, label.toUpperCase(), x, y, {
                    width: metaW - 10,
                    font: "Helvetica",
                    size: 8,
                    color: C.accent,
                });
                absText(doc, value, x, y + 14, {
                    width: metaW - 10,
                    font: "Helvetica-Bold",
                    size: 10,
                    color: C.ink,
                });
            });
            y += 40;
            hLine(doc, left, right, y, C.hair, 0.7);
            y += 16;

            // ── Employee (no username) ───────────────────────────────────
            absText(doc, "EMPLOYEE", left, y, {
                width: contentW * 0.5,
                font: "Helvetica",
                size: 8,
                color: C.accent,
            });
            absText(doc, "PAY PERIOD", rightColX, y, {
                width: rightColW,
                align: "right",
                font: "Helvetica",
                size: 8,
                color: C.accent,
            });
            y += 15;
            absText(doc, staff.name || "Staff", left, y, {
                width: contentW * 0.55,
                font: "Helvetica-Bold",
                size: 13,
                color: C.ink,
            });
            absText(doc, periodLabel, rightColX, y, {
                width: rightColW,
                align: "right",
                font: "Helvetica-Bold",
                size: 12,
                color: C.ink,
            });
            y += 18;

            const staffBits = [
                staff.designation ? `Designation: ${staff.designation}` : null,
                staff.mobile
                    ? `Mobile: ${staff.country_code ? `+${staff.country_code} ` : ""}${staff.mobile}`
                    : null,
                staff.email ? `Email: ${staff.email}` : null,
            ].filter(Boolean);
            if (staffBits.length) {
                absText(doc, staffBits.join("   ·   "), left, y, {
                    width: contentW,
                    font: "Helvetica",
                    size: 9,
                    color: C.muted,
                });
                y += 16;
            }
            y += 4;
            hLine(doc, left, right, y, C.hair, 0.7);
            y += 16;

            // ── Earnings / deductions ────────────────────────────────────
            const monthBonus = Number(summary.total_bonus ?? bonus_fine?.total_bonus) || 0;
            const monthFine = Number(summary.month_fine ?? bonus_fine?.total_fine) || 0;
            const attendanceFine = Number(summary.total_fine) || 0;

            const earnings = [
                {
                    label: `Attendance wage (${summary.present_days || 0}P / ${summary.half_days || 0}H / ${summary.leave_days || 0}L)`,
                    value: Number(summary.total_daily_wage) || 0,
                },
                {
                    label: "Overtime",
                    value: Number(summary.total_overtime) || 0,
                },
                {
                    label: "Bonus",
                    value: monthBonus,
                },
            ];
            const deductions = [
                {
                    label: "Attendance fine",
                    value: attendanceFine,
                },
                {
                    label: "Fine (manual)",
                    value: monthFine,
                },
                {
                    label: `Absent days (${summary.absent_days || 0})`,
                    value: 0,
                },
            ];

            const colGap = 28;
            const colW = (contentW - colGap) / 2;
            const topY = y;
            const yAfterLeft = drawAmountColumn(doc, left, topY, colW, "EARNINGS", earnings);
            const yAfterRight = drawAmountColumn(
                doc,
                left + colW + colGap,
                topY,
                colW,
                "DEDUCTIONS",
                deductions
            );
            y = Math.max(yAfterLeft, yAfterRight) + 6;

            // ── Net payable ──────────────────────────────────────────────
            hLine(doc, left, right, y, C.ink, 1.3);
            y += 12;
            absText(doc, "NET PAYABLE", left, y, {
                width: contentW * 0.45,
                font: "Helvetica-Bold",
                size: 12,
                color: C.accentDark,
            });
            absText(doc, money(netAmount(payslip)), left + contentW * 0.4, y - 2, {
                width: contentW * 0.6,
                align: "right",
                font: "Helvetica-Bold",
                size: 16,
                color: C.amount,
            });
            y += 20;
            absText(
                doc,
                `${summary.marked_days || 0} days marked  ·  Gross ${money(summary.total_daily_wage)} + OT ${money(summary.total_overtime)} + Bonus ${money(monthBonus)} - Att.fine ${money(attendanceFine)} - Fine ${money(monthFine)}`,
                left,
                y,
                {
                    width: contentW,
                    font: "Helvetica",
                    size: 8.5,
                    color: C.muted,
                }
            );
            y += 16;
            hLine(doc, left, right, y, C.ink, 1.3);
            y += 16;

            // ── Attendance detail ────────────────────────────────────────
            if (days.length > 0) {
                absText(doc, "ATTENDANCE DETAIL", left, y, {
                    width: contentW,
                    font: "Helvetica-Bold",
                    size: 10,
                    color: C.accent,
                });
                y += 14;

                const cols = [
                    { key: "date", label: "Date", w: 72 },
                    { key: "status", label: "Status", w: 68 },
                    { key: "wage", label: "Day wage", w: 74, align: "right" },
                    { key: "ot", label: "OT", w: 58, align: "right" },
                    { key: "fine", label: "Fine", w: 58, align: "right" },
                    {
                        key: "net",
                        label: "Net",
                        w: contentW - 72 - 68 - 74 - 58 - 58,
                        align: "right",
                    },
                ];

                // Compact rows so a full month still fits after larger fonts/spacing above
                const rowH = 11;
                y = drawTableHeader(doc, left, y, cols, 16);

                days.forEach((day, idx) => {
                    if (y + rowH > maxContentY) {
                        doc.addPage({ size: "A4", margin: 0 });
                        doc.x = left;
                        doc.y = 36;
                        y = 36;
                        absText(doc, `ATTENDANCE DETAIL (contd.) — ${periodLabel}`, left, y, {
                            width: contentW,
                            font: "Helvetica-Bold",
                            size: 10,
                            color: C.accent,
                        });
                        y += 14;
                        y = drawTableHeader(doc, left, y, cols, 16);
                    }

                    if (idx % 2 === 0) {
                        doc.rect(left, y, contentW, rowH).fill(C.soft);
                    }

                    let x = left;
                    const cells = {
                        date: formatDateDisplay(day.date),
                        status: titleCaseStatus(day.status),
                        wage: money(day.daily_wage),
                        ot: money(day.overtime_amount),
                        fine: money(day.fine_amount),
                        net: money(day.net_day_amount),
                    };
                    cols.forEach((c) => {
                        absText(doc, cells[c.key], x + 4, y + 2, {
                            width: c.w - 8,
                            align: c.align || "left",
                            font: "Helvetica",
                            size: 8,
                            color: c.key === "net" || c.key === "wage" ? C.amount : C.body,
                        });
                        x += c.w;
                    });
                    y += rowH;
                });

                hLine(doc, left, right, y, C.line, 0.7);
                y += 10;
            }

            if (payslip.remark && y + 14 <= maxContentY) {
                absText(doc, `Remark: ${payslip.remark}`, left, y, {
                    width: contentW,
                    font: "Helvetica",
                    size: 9,
                    color: C.muted,
                });
            }

            doc.x = left;
            doc.y = 40;
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

function netAmount(payslip) {
    return Number(payslip?.amount) || 0;
}

export default buildPayslipPdfBuffer;
