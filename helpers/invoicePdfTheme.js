export function pdfTheme(formatKey) {
    // Existing themes
    if (formatKey === "minimal") {
        return {
            primary: "#2f2f2f",
            accent: "#5a5a5a",
            soft: "#f4f4f4",
            border: "#dddddd",
            titleSize: 18,
            line: 12,
            tableHead: 9,
        };
    }
    if (formatKey === "compact") {
        return {
            primary: "#0f5fa8",
            accent: "#2b7fc9",
            soft: "#eef5fc",
            border: "#d8e4f2",
            titleSize: 16,
            line: 10,
            tableHead: 8,
        };
    }
    
    // NEW PREMIUM TEMPLATE THEMES
    if (formatKey === "premium_modern") {
        return {
            primary: "#1a73e8",
            accent: "#4285f4",
            soft: "#e8f0fe",
            border: "#dadce0",
            titleSize: 22,
            line: 12,
            tableHead: 9,
            headerBg: "#1a73e8",
            headerText: "#ffffff",
            accentGradient: true,
            borderRadius: 12,
        };
    }
    
    if (formatKey === "premium_elegant") {
        return {
            primary: "#8b7355",
            accent: "#a0845c",
            soft: "#f5f0e8",
            border: "#d4c5b0",
            titleSize: 24,
            line: 12,
            tableHead: 9,
            headerBg: "#8b7355",
            headerText: "#ffffff",
            fontFamily: "Helvetica",
            borderRadius: 4,
        };
    }
    
    if (formatKey === "premium_corporate") {
        return {
            primary: "#0f2b3d",
            accent: "#1a4a6f",
            soft: "#f0f4f8",
            border: "#cbd5e1",
            titleSize: 20,
            line: 12,
            tableHead: 9,
            headerBg: "#0f2b3d",
            headerText: "#ffffff",
            showBorderLines: true,
        };
    }
    
    if (formatKey === "premium_creative") {
        return {
            primary: "#ff6b35",
            accent: "#ff8c42",
            soft: "#fff5f0",
            border: "#ffd6c4",
            titleSize: 20,
            line: 12,
            tableHead: 9,
            headerBg: "#ff6b35",
            headerText: "#ffffff",
            accentColor: "#ff8c42",
        };
    }
    
    if (formatKey === "premium_luxury") {
        return {
            primary: "#1a1a1a",
            accent: "#c9a96e",
            soft: "#faf9f7",
            border: "#e5d5b8",
            titleSize: 26,
            line: 12,
            tableHead: 9,
            headerBg: "#1a1a1a",
            headerText: "#c9a96e",
            goldAccent: true,
        };
    }
    
    // Default classic
    return {
        primary: "#1e3c72",
        accent: "#2f5ca8",
        soft: "#eef2fb",
        border: "#d7deee",
        titleSize: 20,
        line: 12,
        tableHead: 9,
    };
}