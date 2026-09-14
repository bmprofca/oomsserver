import pool from "../db.js";

/**
 * Branch SMS channel (client notifications + campaigns).
 *
 * - disabled     → no branch SMS notifications
 * - fast2sms     → branch-owned `sms_fast2sms_configs` + templates
 * - ooms system  → platform `sms_system_fast2sms_config` + `sms_system_templates`
 *
 * Login / register / portal OTP use company SMS (`smsOtp.js`), not this channel.
 */
export const SMS_CHANNELS = ["disabled", "fast2sms", "ooms system"];
export const SMS_CHANNEL_DISABLED = "disabled";
export const SMS_CHANNEL_FAST2SMS = "fast2sms";
export const SMS_CHANNEL_OOMS_SYSTEM = "ooms system";

export function normalizeSmsChannel(channel) {
    const key = String(channel || "").trim().toLowerCase();
    if (key === "fast2sms" || key === "fast 2 sms" || key === "fast2 sms") {
        return SMS_CHANNEL_FAST2SMS;
    }
    if (
        key === "ooms system" ||
        key === "ooms_system" ||
        key === "oomssystem" ||
        key === "system"
    ) {
        return SMS_CHANNEL_OOMS_SYSTEM;
    }
    if (SMS_CHANNELS.includes(key)) return key;
    return SMS_CHANNEL_DISABLED;
}

export function smsChannelLabel(channel) {
    const key = normalizeSmsChannel(channel);
    if (key === SMS_CHANNEL_FAST2SMS) return "Fast2SMS";
    if (key === SMS_CHANNEL_OOMS_SYSTEM) return "OOMS System";
    return "Disabled";
}

export async function getBranchSmsChannel(branch_id) {
    if (!branch_id) return SMS_CHANNEL_DISABLED;
    const [rows] = await pool.query(
        `SELECT sms_channel
         FROM branch_list
         WHERE branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id]
    );
    return normalizeSmsChannel(rows[0]?.sms_channel);
}
