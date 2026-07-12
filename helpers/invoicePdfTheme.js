// invoicePdfTheme.js
//
// Color palettes for every format variant.
//
// Fixes from the previous version:
//  - `premium_elegant` was documented as "Amber → Warm Rose" in the layout
//    file but its actual colors were two shades of rose with no amber at
//    all (primary/primaryEnd were both rose, so `t.accent || "#f59e0b"`
//    never fell back to the amber it was meant to show). It's now a real
//    amber → rose gradient, matching what the layout was designed for.
//  - `premium_creative` was documented as "Rose → Orange" but was actually
//    violet → pink. Kept the violet → pink direction (it reads better as a
//    "bold agency" template) and updated the comment to match reality —
//    but shifted the pink toward magenta so it doesn't collide visually
//    with premium_elegant's rose tones.
//  - `premium_luxury` used the same indigo/violet family as `premium_modern`
//    (just darker), so the two premium templates looked like recolors of
//    each other. Luxury now uses a deep plum/near-black indigo with gold,
//    clearly distinct from modern's brighter indigo → violet.
//  - classic/compact gradients were low-contrast (near-identical start/end
//    colors), which read as flat/dull rather than premium. Widened the
//    gradient spread on every theme.
//  - Added `onPrimary` / `onPrimarySubtle` so layout files stop hardcoding
//    "rgba(255,255,255,0.65)" inline — the subtle-text opacity is now
//    tuned per theme for readability against that theme's specific gradient.

export function pdfTheme(formatKey) {
    // ── Minimal: clean monochrome, slate accents ──
    if (formatKey === "minimal") {
        return {
            primary:     "#0f172a",   // slate-900
            primaryEnd:  "#334155",   // slate-700
            accent:      "#475569",   // slate-600
            accentEnd:   "#64748b",   // slate-500
            soft:        "#f8fafc",
            softEnd:     "#f1f5f9",
            border:      "#e2e8f0",
            rowAlt:      "#f1f5f9",
            onPrimary:       "#ffffff",
            onPrimarySubtle: "rgba(255,255,255,0.72)",
            titleSize:   18,
            line:        12,
            tableHead:   9,
        };
    }

    // ── Compact: crisp sky-to-cyan, dense layout ──
    if (formatKey === "compact") {
        return {
            primary:     "#075985",   // sky-800
            primaryEnd:  "#0891b2",   // cyan-600
            accent:      "#0e7490",   // cyan-700
            accentEnd:   "#22d3ee",   // cyan-400
            soft:        "#ecfeff",
            softEnd:     "#cffafe",
            border:      "#a5f3fc",
            rowAlt:      "#f0fdfe",
            onPrimary:       "#ffffff",
            onPrimarySubtle: "rgba(255,255,255,0.75)",
            titleSize:   16,
            line:        10,
            tableHead:   8,
        };
    }

    // ──────── PREMIUM THEMES ────────

    // Premium Modern: indigo → violet, bright and confident
    if (formatKey === "premium_modern") {
        return {
            primary:     "#4338ca",   // indigo-700
            primaryEnd:  "#7c3aed",   // violet-600
            accent:      "#818cf8",   // indigo-400
            accentEnd:   "#a78bfa",   // violet-400
            soft:        "#eef2ff",   // indigo-50
            softEnd:     "#f5f3ff",   // violet-50
            border:      "#c7d2fe",   // indigo-200
            rowAlt:      "#f5f3ff",
            onPrimary:       "#ffffff",
            onPrimarySubtle: "rgba(255,255,255,0.78)",
            titleSize:   22,
            line:        12,
            tableHead:   9,
        };
    }

    // Premium Elegant: amber/gold → deep rose — warm, ceremonial
    if (formatKey === "premium_elegant") {
        return {
            primary:     "#b45309",   // amber-700
            primaryEnd:  "#9f1239",   // rose-800
            accent:      "#f59e0b",   // amber-500 (gold accent line)
            accentEnd:   "#fb7185",   // rose-400
            soft:        "#fffbeb",   // amber-50
            softEnd:     "#fff1f2",   // rose-50
            border:      "#fde68a",   // amber-200
            rowAlt:      "#fef3c7",   // amber-100
            onPrimary:       "#ffffff",
            onPrimarySubtle: "rgba(255,255,255,0.78)",
            titleSize:   24,
            line:        12,
            tableHead:   9,
        };
    }

    // Premium Corporate: blue → teal, cool and structured
    if (formatKey === "premium_corporate") {
        return {
            primary:     "#1d4ed8",   // blue-700
            primaryEnd:  "#0f766e",   // teal-700
            accent:      "#3b82f6",   // blue-500
            accentEnd:   "#2dd4bf",   // teal-400
            soft:        "#eff6ff",   // blue-50
            softEnd:     "#f0fdfa",   // teal-50
            border:      "#bfdbfe",   // blue-200
            rowAlt:      "#e0f2fe",
            onPrimary:       "#ffffff",
            onPrimarySubtle: "rgba(255,255,255,0.78)",
            titleSize:   20,
            line:        12,
            tableHead:   9,
        };
    }

    // Premium Creative: violet → magenta, bold agency energy
    if (formatKey === "premium_creative") {
        return {
            primary:     "#7c3aed",   // violet-600
            primaryEnd:  "#db2777",   // pink-600 (leaning magenta)
            accent:      "#a855f7",   // purple-500
            accentEnd:   "#f472b6",   // pink-400
            soft:        "#fdf4ff",   // fuchsia-50
            softEnd:     "#fdf2f8",   // pink-50
            border:      "#f5d0fe",   // fuchsia-200
            rowAlt:      "#fce7f3",   // pink-100
            onPrimary:       "#ffffff",
            onPrimarySubtle: "rgba(255,255,255,0.78)",
            titleSize:   20,
            line:        12,
            tableHead:   9,
        };
    }

    // Premium Luxury: deep plum/near-black indigo → gold, jewel-box feel
    if (formatKey === "premium_luxury") {
        return {
            primary:     "#1e1b4b",   // indigo-950 (deep, not flat black)
            primaryEnd:  "#3b0764",   // purple-950
            accent:      "#fbbf24",   // amber-400 (bright gold)
            accentEnd:   "#f59e0b",   // amber-500
            soft:        "#faf5ff",   // purple-50
            softEnd:     "#fffbeb",   // amber-50
            border:      "#e9d5ff",   // purple-200
            rowAlt:      "#faf5ff",
            onPrimary:       "#fbbf24",   // headline text picks up the gold
            onPrimarySubtle: "rgba(255,255,255,0.6)",
            titleSize:   26,
            line:        12,
            tableHead:   9,
        };
    }

    // ── Default Classic: royal navy → blue, wider contrast than before ──
    return {
        primary:     "#1e3a8a",   // blue-900
        primaryEnd:  "#1d4ed8",   // blue-700
        accent:      "#2563eb",   // blue-600
        accentEnd:   "#3b82f6",   // blue-500
        soft:        "#eff6ff",   // blue-50
        softEnd:     "#dbeafe",
        border:      "#bfdbfe",   // blue-200
        rowAlt:      "#dbeafe",
        onPrimary:       "#ffffff",
        onPrimarySubtle: "rgba(255,255,255,0.78)",
        titleSize:   20,
        line:        12,
        tableHead:   9,
    };
}
