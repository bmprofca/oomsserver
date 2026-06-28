import express from "express";
import pool from "../db.js";
import { FORMAT_DATE, RANDOM_STRING } from "../helpers/function.js";
import { SendMail } from "../helpers/Mail.js";
import { APP_NAME } from "../helpers/Config.js";
import { authAdmin } from "../middleware/authAdmin.js";

const router = express.Router();

router.post("/login/send-otp", async (req, res) => {
    let conn;

    try {
        const { email, password } = req.body ?? {};

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters (email, password).",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [rows] = await conn.execute(
            "SELECT username, login_id FROM users WHERE login_id = ? AND password = ? AND status = ? AND type = ? LIMIT 1",
            [email, password, "1", "admin"]
        );

        if (rows.length === 0) {
            await conn.rollback();
            return res.status(401).json({
                success: false,
                message: "Invalid username or password.",
            });
        }

        const { username, login_id } = rows[0];

        const otp_id = RANDOM_STRING();
        const otp = "123456";

        await conn.execute(
            "UPDATE otps SET status = ? WHERE username = ? AND type = ? AND status = ?",
            ["1", username, "login", "0"]
        );

        await conn.execute(
            `INSERT INTO otps
        (otp_id, type, otp, username, create_date, expire_date, status, remark)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 3 MINUTE),?,?)`,
            [otp_id, "login", otp, username, "0", "Admin email login OTP"]
        );

        const [otpMeta] = await conn.query(
            "SELECT expire_date FROM otps WHERE otp_id = ? ORDER BY id DESC LIMIT 1",
            [otp_id]
        );

        await conn.commit();

        await SendMail({
            to: login_id,
            subject: `Admin Login OTP for ${APP_NAME}`,
            html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { margin:0; padding:0; background:#f3f4f6; font-family: Arial, sans-serif; }
    .container { max-width:420px; margin:40px auto; background:#fff; border-radius:10px; padding:24px; text-align:center; box-shadow:0 10px 25px rgba(0,0,0,.1); }
    h2 { color:#111827; margin-bottom:8px; }
    p { color:#6b7280; font-size:14px; }
    .otp { margin:20px 0; font-size:28px; font-weight:700; letter-spacing:8px; color:#4f46e5; }
    .footer { font-size:12px; color:#9ca3af; margin-top:24px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Admin OTP Verification</h2>
    <p>Use the following OTP to complete your admin login</p>
    <div class="otp">${otp}</div>
    <p>This OTP is valid for a limited time. Please do not share it with anyone.</p>
    <div class="footer">© ${new Date().getFullYear()} ${APP_NAME}</div>
  </div>
</body>
</html>`,
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
        const { email, password, otp } = req.body || {};
        const IP = req.ip;

        if (!email || !password || !otp) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters (email, password, otp)",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [users] = await conn.query(
            "SELECT username FROM users WHERE login_id = ? AND password = ? AND status = ? AND type = ? LIMIT 1",
            [email, password, "1", "admin"]
        );

        if (!users.length) {
            await conn.rollback();
            return res.status(401).json({
                success: false,
                message: "Invalid username or password",
            });
        }

        const username = users[0].username;

        const [otpRows] = await conn.query(
            `SELECT id, otp, expire_date, status
         FROM otps
        WHERE username = ?
          AND type = ?
          AND otp = ?
          AND status = ?
          AND expire_date >= CURRENT_TIMESTAMP
        ORDER BY id DESC
        LIMIT 1`,
            [username, "login", otp, "0"]
        );

        if (!otpRows.length) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP. Please try again.",
            });
        }

        await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", otpRows[0].id]);

        const token_id = RANDOM_STRING(30);
        const token = RANDOM_STRING(50);
        await conn.query(
            `INSERT INTO tokens
        (token_id, username, token, create_date, create_by, create_ip, last_used_date, last_ip, login_method, status, expire_date)
       VALUES (?,?,?,CURRENT_TIMESTAMP,?,?,CURRENT_TIMESTAMP,?,'email','1',DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))`,
            [token_id, username, token, username, IP, IP]
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

        console.error("ADMIN LOGIN EMAIL ERROR:", err);

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
