import express from "express";
import pool from "../db.js";
import { FORMAT_DATE, RANDOM_STRING, UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";
import { generateClientOtp, sendClientOtp } from "../helpers/clientOtp.js";
import { authAgent } from "../middleware/authAgent.js";
import {
    normalizeCountryCode,
    normalizeMobileDigits,
    PROFILE_COUNTRY_CODE_SQL,
    PROFILE_MOBILE_SQL,
} from "../helpers/clientPhone.js";

const router = express.Router();
const AGENT_OTP_TYPE = "agent_login";

async function findActiveAgentProfile(country_code, mobile) {
    const cc = normalizeCountryCode(country_code);
    const mob = normalizeMobileDigits(mobile);

    if (!mob || mob.length < 10) {
        return null;
    }

    const [rows] = await pool.query(
        `SELECT p.username, p.name, p.mobile, p.country_code, p.email
         FROM profile p
         INNER JOIN clients c ON c.username = p.username
            AND c.user_type = 'agent'
            AND c.is_deleted = '0'
            AND c.status = '1'
         WHERE p.user_type = 'agent'
           AND p.status = '1'
           AND ${PROFILE_MOBILE_SQL} = ?
           AND ${PROFILE_COUNTRY_CODE_SQL} = ?
         LIMIT 1`,
        [mob, cc]
    );

    return rows[0] || null;
}

router.post("/login/send-otp", async (req, res) => {
    let conn;

    try {
        const { country_code, mobile } = req.body || {};

        if (!country_code || !mobile) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters (country_code, mobile).",
            });
        }

        const agentProfile = await findActiveAgentProfile(country_code, mobile);
        if (!agentProfile) {
            return res.status(404).json({
                success: false,
                message: "Agent not found or account is inactive.",
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
             WHERE country_code = ?
               AND mobile = ?
               AND type = ?
               AND status = ?`,
            ["1", normalizedCountryCode, normalizedMobile, AGENT_OTP_TYPE, "0"]
        );

        const otp_id = await UNIQUE_RANDOM_STRING("otps", "otp_id", { length: ID_LENGTH, conn });
        await conn.execute(
            `INSERT INTO otps
            (otp_id, type, otp, country_code, mobile, create_date, expire_date, status, remark)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE), ?, ?)`,
            [
                otp_id,
                AGENT_OTP_TYPE,
                otp,
                normalizedCountryCode,
                normalizedMobile,
                "0",
                "Agent mobile login OTP",
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
        console.error("AGENT LOGIN SEND OTP ERROR:", err);

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
                message: "Missing required parameters (country_code, mobile, otp).",
            });
        }

        const agentProfile = await findActiveAgentProfile(country_code, mobile);
        if (!agentProfile) {
            return res.status(404).json({
                success: false,
                message: "Agent not found or account is inactive.",
            });
        }

        const normalizedCountryCode = normalizeCountryCode(country_code);
        const normalizedMobile = normalizeMobileDigits(mobile);

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [otpRows] = await conn.query(
            `SELECT id
             FROM otps
             WHERE country_code = ?
               AND mobile = ?
               AND type = ?
               AND otp = ?
               AND status = ?
               AND expire_date >= CURRENT_TIMESTAMP
             ORDER BY id DESC
             LIMIT 1`,
            [normalizedCountryCode, normalizedMobile, AGENT_OTP_TYPE, String(otp), "0"]
        );

        if (!otpRows.length) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP. Please try again.",
            });
        }

        await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", otpRows[0].id]);

        const username = agentProfile.username;
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
            token,
            expire_date: FORMAT_DATE(tokenMeta?.[0]?.expire_date) ?? null,
        });
    } catch (err) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) { }
        }

        console.error("AGENT LOGIN ERROR:", err);

        return res.status(500).json({
            success: false,
            message: "Login failed",
        });
    } finally {
        if (conn) conn.release();
    }
});

router.post("/logout", authAgent, async (req, res) => {
    try {
        const token = req.headers["token"] || req.headers["Token"] || "";

        const [result] = await pool.query(
            "UPDATE tokens SET status = ? WHERE token = ? AND status = ?",
            ["0", token, "1"]
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
        console.error("AGENT LOGOUT ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Logout failed",
        });
    }
});

export default router;
