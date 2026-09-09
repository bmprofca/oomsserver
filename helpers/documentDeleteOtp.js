import crypto from "crypto";
import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";
import { DOCUMENT_DELETE_OTP_TYPE } from "./authProfile.js";
import { normalizeCountryCode, normalizeMobileDigits } from "./clientPhone.js";
import { sendSmsOtp } from "./smsOtp.js";
import { generateOtp } from "./otp.js";

const MOBILE_REGEX = /^\d{10}$/;

export function normalizeDocumentIds(documentIds) {
    return [
        ...new Set(
            (Array.isArray(documentIds) ? documentIds : [])
                .map((id) => String(id).trim())
                .filter(Boolean)
        ),
    ].sort();
}

export function documentDeleteIdsHash(documentIds) {
    const ids = normalizeDocumentIds(documentIds);
    return crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 24);
}

/**
 * Remark binds OTP to a specific delete selection.
 * scope: "client" | "task"
 * ownerKey: client username (client) or branch_id (task)
 */
export function documentDeleteOtpRemark(scope, ownerKey, documentIds) {
    return `doc_delete:${scope}:${String(ownerKey || "").trim()}:${documentDeleteIdsHash(documentIds)}`;
}

export function maskMobileNumber(mobile) {
    const digits = normalizeMobileDigits(mobile);
    if (!digits || digits.length < 4) return "";
    return `******${digits.slice(-4)}`;
}

/**
 * Resolve the branch admin who should receive the document-delete OTP.
 * Uses the earliest active admin mapping + latest active profile row.
 */
export async function resolveBranchAdminForOtp(branch_id, executor = pool) {
    const [rows] = await executor.query(
        `SELECT
            bm.username,
            p.mobile,
            p.country_code,
            p.name,
            p.email
         FROM branch_mapping bm
         INNER JOIN profile p
           ON p.username = bm.username
          AND p.status = '1'
          AND p.id = (
                SELECT MAX(p2.id)
                FROM profile p2
                WHERE p2.username = bm.username
                  AND p2.status = '1'
          )
         WHERE bm.branch_id = ?
           AND bm.type = 'admin'
           AND bm.is_deleted = '0'
           AND (bm.status = '1' OR bm.status = 1)
         ORDER BY bm.id ASC
         LIMIT 1`,
        [branch_id]
    );
    return rows[0] || null;
}

/**
 * Create OTP for document delete and SMS it to the branch admin.
 * Returns { destination_masked, expire_date, admin_username, document_ids }.
 */
export async function issueDocumentDeleteOtp({
    branch_id,
    scope,
    ownerKey,
    documentIds,
}) {
    const ids = normalizeDocumentIds(documentIds);
    if (!ids.length) {
        const err = new Error("document_ids must be a non-empty array");
        err.statusCode = 400;
        throw err;
    }

    const admin = await resolveBranchAdminForOtp(branch_id);
    if (!admin?.username) {
        const err = new Error("No active branch admin found to receive the OTP");
        err.statusCode = 400;
        throw err;
    }

    const otpCountryCode = normalizeCountryCode(admin.country_code);
    const otpMobile = normalizeMobileDigits(admin.mobile);
    if (!otpMobile || !MOBILE_REGEX.test(otpMobile)) {
        const err = new Error(
            "Branch admin does not have a registered mobile number to receive the OTP"
        );
        err.statusCode = 400;
        throw err;
    }

    const remark = documentDeleteOtpRemark(scope, ownerKey, ids);
    const conn = await pool.getConnection();
    let otp_id;
    let expire_date = null;
    const otp = generateOtp(6);

    try {
        await conn.beginTransaction();

        await conn.execute(
            `UPDATE otps
             SET status = ?
             WHERE username = ?
               AND type = ?
               AND status = ?`,
            ["1", admin.username, DOCUMENT_DELETE_OTP_TYPE, "0"]
        );

        otp_id = await UNIQUE_RANDOM_STRING("otps", "otp_id", { conn });
        await conn.execute(
            `INSERT INTO otps
             (otp_id, type, otp, username, country_code, mobile, create_date, expire_date, status, remark)
             VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE),?,?)`,
            [
                otp_id,
                DOCUMENT_DELETE_OTP_TYPE,
                otp,
                admin.username,
                otpCountryCode,
                otpMobile,
                "0",
                remark,
            ]
        );

        const [otpMeta] = await conn.query(
            "SELECT expire_date FROM otps WHERE otp_id = ? ORDER BY id DESC LIMIT 1",
            [otp_id]
        );
        expire_date = otpMeta[0]?.expire_date || null;

        await conn.commit();
    } catch (error) {
        try {
            await conn.rollback();
        } catch {
            /* ignore */
        }
        throw error;
    } finally {
        conn.release();
    }

    try {
        await sendSmsOtp({
            country_code: otpCountryCode,
            mobile: otpMobile,
            otp,
        });
    } catch (sendError) {
        const err = new Error(
            sendError?.message || "Failed to send OTP SMS. Please try again in a moment."
        );
        err.statusCode = 502;
        throw err;
    }

    return {
        destination_masked: maskMobileNumber(otpMobile),
        expire_date,
        admin_username: admin.username,
        document_ids: ids,
        document_count: ids.length,
    };
}

/**
 * Verify and consume a document-delete OTP inside an existing transaction.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export async function consumeDocumentDeleteOtp(conn, {
    otp,
    scope,
    ownerKey,
    documentIds,
}) {
    const otpValue = String(otp || "").trim();
    if (!/^\d{6}$/.test(otpValue)) {
        return { ok: false, message: "A valid 6-digit OTP is required" };
    }

    const ids = normalizeDocumentIds(documentIds);
    const remark = documentDeleteOtpRemark(scope, ownerKey, ids);

    const [otpRows] = await conn.query(
        `SELECT id, username
         FROM otps
         WHERE type = ?
           AND otp = ?
           AND status = ?
           AND remark = ?
           AND expire_date >= CURRENT_TIMESTAMP
         ORDER BY id DESC
         LIMIT 1`,
        [DOCUMENT_DELETE_OTP_TYPE, otpValue, "0", remark]
    );

    if (!otpRows.length) {
        return { ok: false, message: "Invalid or expired OTP. Please try again." };
    }

    await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", otpRows[0].id]);
    return { ok: true, admin_username: otpRows[0].username };
}
