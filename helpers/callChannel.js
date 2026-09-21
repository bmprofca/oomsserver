export const CALL_CHANNELS = ["disabled", "ooms system"];

export function normalizeCallChannel(value) {
    const raw = String(value || "")
        .trim()
        .toLowerCase();
    if (raw === "ooms system" || raw === "ooms_system" || raw === "oomssystem") {
        return "ooms system";
    }
    return "disabled";
}

export function callChannelLabel(channel) {
    const normalized = normalizeCallChannel(channel);
    if (normalized === "ooms system") return "OOMS System";
    return "Disabled";
}
