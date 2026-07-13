import express from "express";
import pool from "../db.js";
import { FORMAT_DATE, RANDOM_STRING, UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { generateClientOtp, sendClientOtp } from "../helpers/clientOtp.js";
import {
    ADMIN_OTP_TYPE,
    findAdminUserByMobile,
} from "../helpers/authProfile.js";
import {
    normalizeCountryCode,
    normalizeMobileDigits,
} from "../helpers/clientPhone.js";

const router = express.Router();

router.post("/login/send-otp", async (req, res) => {
    let conn;

    try {
        const { country_code, mobile } = req.body ?? {};

        if (!country_code || !mobile) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters (country_code, mobile).",
            });
        }

        const adminProfile = await findAdminUserByMobile(pool, country_code, mobile);
        if (!adminProfile) {
            return res.status(404).json({
                success: false,
                message: "Admin account not found or is inactive.",
            });
        }

        const normalizedCountryCode = normalizeCountryCode(country_code);
        const normalizedMobile = normalizeMobileDigits(mobile);
        const otp = await generateClientOtp();

        conn = await pool.getConnection();
        await conn.beginTransaction();

        await conn.execute(
            `UPDATE otps
             SET status = ?
             WHERE (
                    (username = ? AND type = ?)
                 OR (country_code = ? AND mobile = ? AND type = ?)
               )
               AND status = ?`,
            [
                "1",
                adminProfile.username,
                ADMIN_OTP_TYPE,
                normalizedCountryCode,
                normalizedMobile,
                ADMIN_OTP_TYPE,
                "0",
            ]
        );

        const otp_id = await UNIQUE_RANDOM_STRING("otps", "otp_id", { length: ID_LENGTH, conn });
        await conn.execute(
            `INSERT INTO otps
            (otp_id, type, otp, username, country_code, mobile, create_date, expire_date, status, remark)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE), ?, ?)`,
            [
                otp_id,
                ADMIN_OTP_TYPE,
                otp,
                adminProfile.username,
                normalizedCountryCode,
                normalizedMobile,
                "0",
                "Admin mobile login OTP",
            ]
        );

        const [otpMeta] = await conn.query(
            "SELECT expire_date FROM otps WHERE otp_id = ? ORDER BY id DESC LIMIT 1",
            [otp_id]
        );

        await conn.commit();

        await sendClientOtp({
            country_code: normalizedCountryCode,
            mobile: normalizedMobile,
            otp,
        });

        return res.status(200).json({
            success: true,
            message: "OTP sent successfully",
            expire: FORMAT_DATE(otpMeta?.[0]?.expire_date) ?? null,
        });
    } catch (err) {
        console.error("ADMIN LOGIN OTP ERROR:", err);

        if (conn) {
            try {
                await conn.rollback();
            } catch (_) { }
        }

        return res.status(500).json({
            success: false,
            message: "Failed to send OTP",
        });
    } finally {
        if (conn) conn.release();
    }
});

router.post("/login", async (req, res) => {
    let conn;

    try {
        const { country_code, mobile, otp } = req.body || {};
        const IP = req.ip;

        if (!country_code || !mobile || !otp) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters (country_code, mobile, otp)",
            });
        }

        const adminProfile = await findAdminUserByMobile(pool, country_code, mobile);
        if (!adminProfile) {
            return res.status(404).json({
                success: false,
                message: "Admin account not found or is inactive.",
            });
        }

        const normalizedCountryCode = normalizeCountryCode(country_code);
        const normalizedMobile = normalizeMobileDigits(mobile);

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [otpRows] = await conn.query(
            `SELECT id
             FROM otps
             WHERE type = ?
               AND otp = ?
               AND status = ?
               AND expire_date >= CURRENT_TIMESTAMP
               AND (
                    username = ?
                 OR (country_code = ? AND mobile = ?)
               )
             ORDER BY id DESC
             LIMIT 1`,
            [
                ADMIN_OTP_TYPE,
                String(otp),
                "0",
                adminProfile.username,
                normalizedCountryCode,
                normalizedMobile,
            ]
        );

        if (!otpRows.length) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP. Please try again.",
            });
        }

        await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", otpRows[0].id]);

        const username = adminProfile.username;
        const token_id = await UNIQUE_RANDOM_STRING("tokens", "token_id", { length: ID_LENGTH, conn });
        const token = RANDOM_STRING(50);
        await conn.query(
            `INSERT INTO tokens
            (token_id, username, token, country_code, mobile, create_date, create_by, create_ip, last_used_date, last_ip, login_method, status, expire_date)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, ?, 'mobile', '1', DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))`,
            [token_id, username, token, normalizedCountryCode, normalizedMobile, username, IP, IP]
        );

        const [tokenMeta] = await conn.query(
            "SELECT expire_date FROM tokens WHERE token_id = ? LIMIT 1",
            [token_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Login successful",
            username,
            token,
            expire_date: FORMAT_DATE(tokenMeta?.[0]?.expire_date) ?? null,
        });
    } catch (err) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) { }
        }

        console.error("ADMIN LOGIN ERROR:", err);

        return res.status(500).json({
            success: false,
            message: "Login failed",
        });
    } finally {
        if (conn) conn.release();
    }
});

router.post("/logout", authAdmin, async (req, res) => {
    try {
        const token = req.headers["token"] || req.headers["Token"] || "";
        const username = req.headers["username"] || req.headers["Username"] || "";

        const [result] = await pool.query(
            "UPDATE tokens SET status = ? WHERE username = ? AND token = ? AND status = ?",
            ["0", username, token, "1"]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Session not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Logged out successfully",
        });
    } catch (err) {
        console.error("ADMIN LOGOUT ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Logout failed",
        });
    }
});

export default router;
