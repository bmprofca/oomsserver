/**
 * Recipients for AI write actions. Only people of THIS branch can receive anything:
 * its clients (clients.user_type = 'client') and its active team members. Contact details
 * always come from their OOMS profile — the AI can never type in a phone number or email.
 */

const LATEST_PROFILE = "p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = %s)";

export async function resolveRecipient(db, branchId, { type, username }) {
    let row = null;
    if (type === "client") {
        const [rows] = await db.query(
            `SELECT c.username, p.name, p.mobile, p.country_code, p.email
             FROM clients c
             LEFT JOIN profile p ON p.username = c.username AND ${LATEST_PROFILE.replace("%s", "c.username")}
             WHERE c.branch_id = ? AND c.username = ? AND c.user_type = 'client' AND c.is_deleted = '0'
             LIMIT 1`,
            [branchId, username]
        );
        row = rows?.[0] || null;
    } else if (type === "staff") {
        const [rows] = await db.query(
            `SELECT bm.username, p.name, p.mobile, p.country_code, p.email
             FROM branch_mapping bm
             LEFT JOIN profile p ON p.username = bm.username AND ${LATEST_PROFILE.replace("%s", "bm.username")}
             WHERE bm.branch_id = ? AND bm.username = ? AND bm.type IN ('admin', 'staff')
               AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'
             LIMIT 1`,
            [branchId, username]
        );
        row = rows?.[0] || null;
    }
    if (!row) return null;
    return {
        type,
        username: row.username,
        name: row.name || (type === "client" ? "Client" : "Team member"),
        mobile: String(row.mobile || "").trim(),
        countryCode: String(row.country_code || "91").replace(/\D/g, "") || "91",
        email: String(row.email || "").trim(),
    };
}

/** Same format as helpers/whatsappNotification.js formatWhatsappNumber: country code + digits. */
export function whatsappNumber(recipient) {
    const cc = String(recipient.countryCode || "91").replace(/\D/g, "");
    const mob = String(recipient.mobile || "").replace(/\D/g, "");
    if (!mob) return null;
    return mob.startsWith(cc) ? mob : `${cc}${mob}`;
}

export function isValidEmail(email) {
    return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(String(email || ""));
}

/** Display form shown on the confirmation card. */
export function displayPhone(recipient) {
    const n = whatsappNumber(recipient);
    return n ? `+${n}` : null;
}
