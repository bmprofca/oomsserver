export function pdfTheme(formatKey) {

    // ── Minimal: clean monochrome with slate accents ──
    if (formatKey === "minimal") {
        return {
            primary:     "#1e293b",   // slate-800
            primaryEnd:  "#334155",   // slate-700
            accent:      "#475569",   // slate-600
            accentEnd:   "#64748b",   // slate-500
            soft:        "#f8fafc",
            softEnd:     "#f1f5f9",
            border:      "#e2e8f0",
            rowAlt:      "#f1f5f9",
            titleSize:   18,
            line:        12,
            tableHead:   9,
        };
    }

    // ── Compact: professional teal-blue ──
    if (formatKey === "compact") {
        return {
            primary:     "#0e7490",   // cyan-700
            primaryEnd:  "#0891b2",   // cyan-600
            accent:      "#06b6d4",   // cyan-500
            accentEnd:   "#22d3ee",   // cyan-400
            soft:        "#ecfeff",
            softEnd:     "#cffafe",
            border:      "#a5f3fc",
            rowAlt:      "#f0fdfe",
            titleSize:   16,
            line:        10,
            tableHead:   8,
        };
    }

    // ── Classic: deep navy ──
    // (default, also returned at bottom)

    // ──────── PREMIUM THEMES ────────

    // Premium Modern: vibrant indigo-violet — gradient from indigo to violet
    if (formatKey === "premium_modern") {
        return {
            primary:     "#4f46e5",   // indigo-600
            primaryEnd:  "#7c3aed",   // violet-600
            accent:      "#818cf8",   // indigo-400
            accentEnd:   "#a78bfa",   // violet-400
            soft:        "#eef2ff",   // indigo-50
            softEnd:     "#ede9fe",   // violet-50
            border:      "#c7d2fe",   // indigo-200
            rowAlt:      "#f5f3ff",
            titleSize:   22,
            line:        12,
            tableHead:   9,
            headerText:  "#ffffff",
            borderRadius: 12,
        };
    }

    // Premium Elegant: warm gold & champagne — gradient from amber to rose
    if (formatKey === "premium_elegant") {
        return {
            primary:     "#b45309",   // amber-700
            primaryEnd:  "#c2410c",   // orange-700
            accent:      "#f59e0b",   // amber-500
            accentEnd:   "#f97316",   // orange-500
            soft:        "#fffbeb",   // amber-50
            softEnd:     "#fff7ed",   // orange-50
            border:      "#fde68a",   // amber-200
            rowAlt:      "#fef3c7",
            titleSize:   24,
            line:        12,
            tableHead:   9,
            headerText:  "#ffffff",
            fontFamily:  "Helvetica",
            borderRadius: 4,
        };
    }

    // Premium Corporate: royal blue & deep teal — gradient from navy-blue to teal
    if (formatKey === "premium_corporate") {
        return {
            primary:     "#1d4ed8",   // blue-700
            primaryEnd:  "#0f766e",   // teal-700
            accent:      "#3b82f6",   // blue-500
            accentEnd:   "#14b8a6",   // teal-500
            soft:        "#eff6ff",   // blue-50
            softEnd:     "#f0fdfa",   // teal-50
            border:      "#bfdbfe",   // blue-200
            rowAlt:      "#e0f2fe",
            titleSize:   20,
            line:        12,
            tableHead:   9,
            headerText:  "#ffffff",
            showBorderLines: true,
        };
    }

    // Premium Creative: sunset fire — gradient from crimson to orange
    if (formatKey === "premium_creative") {
        return {
            primary:     "#e11d48",   // rose-600
            primaryEnd:  "#ea580c",   // orange-600
            accent:      "#f43f5e",   // rose-500
            accentEnd:   "#f97316",   // orange-500
            soft:        "#fff1f2",   // rose-50
            softEnd:     "#fff7ed",   // orange-50
            border:      "#fecdd3",   // rose-200
            rowAlt:      "#ffe4e6",
            titleSize:   20,
            line:        12,
            tableHead:   9,
            headerText:  "#ffffff",
            accentColor: "#f97316",
        };
    }

    // Premium Luxury: deep purple & gold — gradient from deep purple to gold
    if (formatKey === "premium_luxury") {
        return {
            primary:     "#6d28d9",   // violet-700
            primaryEnd:  "#a16207",   // yellow-700
            accent:      "#f59e0b",   // amber-500 (bright gold)
            accentEnd:   "#d97706",   // amber-600
            soft:        "#faf5ff",   // violet-50
            softEnd:     "#fffbeb",   // amber-50
            border:      "#ddd6fe",   // violet-200
            rowAlt:      "#f5f3ff",
            titleSize:   26,
            line:        12,
            tableHead:   9,
            headerText:  "#ffffff",
            goldAccent:  true,
        };
    }

    // ── Default Classic: deep royal navy ──
    return {
        primary:     "#1e3a5f",   // deep navy
        primaryEnd:  "#284b7a",
        accent:      "#2563eb",   // blue-600
        accentEnd:   "#3b82f6",   // blue-500
        soft:        "#eff6ff",   // blue-50
        softEnd:     "#dbeafe",
        border:      "#bfdbfe",   // blue-200
        rowAlt:      "#dbeafe",
        titleSize:   20,
        line:        12,
        tableHead:   9,
    };
}