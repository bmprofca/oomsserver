import express from "express";
const router = express.Router();
import pool from "../db.js";
import { FORMAT_DATE, GENERATE_PASSWORD, IS_STRONG_PASSWORD, RANDOM_INTEGER, RANDOM_STRING } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { decrypt } from "../utils/smsEncryption.js";
import { auth } from "../middleware/auth.js";
import { GOOGLE_CLIENT_ID } from "../helpers/Config.js";
import { OAuth2Client } from "google-auth-library";
import { SendMail } from "../helpers/Mail.js";
import { APP_NAME } from "../helpers/Config.js";
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import axios from 'axios';

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

const DEFAULT_AUTH_TOKEN = "TNcvwZtlCVKAhVecVxeTOBubj8TdQDkRuw9m6r0bcsbdRjYzhv5ylzoyli6T";

function serializeRouteError(err) {
    const responseData = err?.response?.data;
    return {
        message: err?.message || (err != null ? String(err) : "Unknown error"),
        code: err?.code ?? null,
        sqlMessage: err?.sqlMessage ?? null,
        sql: err?.sql ?? null,
        response: responseData ?? null,
        stack: err?.stack ?? null,
    };
}


router.post("/login/send-otp", async (req, res) => {
    console.log("LOGIN INITIATED");

    let conn;

    try {
        const { email, login_id, phone, username, template_id, config_id } = req.body ?? {};
        const identifier = login_id || email || phone || username;

        if (!identifier) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters (email or phone number).",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [rows] = await conn.execute(
            `SELECT u.username, u.login_id, p.mobile 
             FROM users u 
             LEFT JOIN profile p ON p.username = u.username
             WHERE (u.login_id = ? OR u.username = ? OR p.mobile = ?) 
               AND u.status = ? AND u.type = ? 
             LIMIT 1`,
            [identifier, identifier, identifier, "1", "user"]
        );

        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Account not found or is inactive.",
            });
        }

        const { username: db_username, login_id: user_email, mobile: user_mobile } = rows[0];

        // Resolve the target phone number for OTP:
        // 1. If the login identifier itself is a phone number, use it.
        // 2. Otherwise, use the mobile number from the user's profile.
        // 3. Fallback to db_username.
        let targetPhone = "";
        const cleanIdentifier = identifier.replace(/\D/g, "");
        if (!identifier.includes("@") && cleanIdentifier.length >= 10) {
            targetPhone = cleanIdentifier;
        } else if (user_mobile) {
            targetPhone = user_mobile.replace(/\D/g, "");
        } else {
            targetPhone = String(db_username).replace(/\D/g, "");
        }

        // OTP generation
        const otp_id = RANDOM_STRING();
        const otp = RANDOM_INTEGER ? String(RANDOM_INTEGER()) : String(Math.floor(100000 + Math.random() * 900000));

        // Optional: invalidate previous active OTPs for this user/type to prevent confusion
        await conn.execute(
            "UPDATE otps SET status = ? WHERE username = ? AND type = ? AND status = ?",
            ["1", db_username, "login", "0"]
        );

        await conn.execute(
            `INSERT INTO otps 
         (otp_id, type, otp, username, create_date, expire_date, status, remark)
        VALUES (?,?,?,?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE),?,?)`,
            [otp_id, "login", otp, db_username, "0", "User login OTP"]
        );

        // Fetch expire_date from DB
        const [otpMeta] = await conn.query(
            "SELECT expire_date FROM otps WHERE otp_id = ? ORDER BY id DESC LIMIT 1",
            [otp_id]
        );

        await conn.commit();

        // Send OTP via email if identifier contains @, or try SMS if it's a phone number
        if (identifier.includes("@")) {
            try {
                await SendMail({
                    to: user_email,
                    subject: `Login OTP for ${APP_NAME}`,
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
    <h2>OTP Verification</h2>
    <p>Use the following OTP to complete your login</p>
    <div class="otp">${otp}</div>
    <p>This OTP is valid for a limited time. Please do not share it with anyone.</p>
    <div class="footer">© ${new Date().getFullYear()} ${APP_NAME}</div>
  </div>
</body>
</html>`,
                });
            } catch (mailErr) {
                console.error("LOGIN EMAIL OTP SEND ERROR:", mailErr?.response?.data || mailErr?.message || mailErr);
                throw mailErr;
            }
        } else {
            // Send SMS via Fast2SMS
            try {
                const cleanNumber = targetPhone.replace(/\D/g, "");
                if (cleanNumber.length >= 10) {
                    let activeConfig = {
                        auth_token: DEFAULT_AUTH_TOKEN,
                        sender_id: "ONESAA",
                        route: "otp"
                    };

                    let activeTemplate = null;

                    // 1. If config_id is provided, load it
                    if (config_id) {
                        const [configs] = await pool.query(
                            "SELECT * FROM sms_configs WHERE config_id = ? AND status = 'active' LIMIT 1",
                            [config_id]
                        );
                        if (configs.length > 0) {
                            activeConfig = {
                                auth_token: decrypt(configs[0].auth_token_encrypted),
                                sender_id: configs[0].sender_id || "ONESAA",
                                route: configs[0].route || "otp"
                            };
                        }
                    } else {
                        // Otherwise, see if there is any active custom default configuration
                        const [configs] = await pool.query(
                            "SELECT * FROM sms_configs WHERE is_default = 1 AND status = 'active' LIMIT 1"
                        );
                        if (configs.length > 0) {
                            activeConfig = {
                                auth_token: decrypt(configs[0].auth_token_encrypted),
                                sender_id: configs[0].sender_id || "ONESAA",
                                route: configs[0].route || "otp"
                            };
                        }
                    }

                    // 2. If template_id is provided, load it
                    if (template_id) {
                        const [templates] = await pool.query(
                            "SELECT * FROM sms_templates WHERE template_id = ? AND status = 'active' LIMIT 1",
                            [template_id]
                        );
                        if (templates.length > 0) {
                            activeTemplate = templates[0];
                        }
                    } else {
                        // Otherwise, find the first active template that looks like an OTP template
                        const [templates] = await pool.query(
                            "SELECT * FROM sms_templates WHERE status = 'active' AND (template_name LIKE '%OTP%' OR message LIKE '%OTP%') LIMIT 1"
                        );
                        if (templates.length > 0) {
                            activeTemplate = templates[0];
                        }
                    }

                    let smsPayload = {
                        route: activeConfig.route || "otp",
                        numbers: cleanNumber
                    };

                    if (activeTemplate && activeTemplate.dlt_template_id) {
                        smsPayload.route = "dlt";
                        smsPayload.sender_id = activeConfig.sender_id || "ONESAA";
                        smsPayload.message = activeTemplate.dlt_template_id;
                        smsPayload.variables_values = otp;
                    } else {
                        smsPayload.route = "otp";
                        smsPayload.variables_values = otp;
                    }

                    await axios.post("https://www.fast2sms.com/dev/bulkV2", smsPayload, {
                        headers: {
                            "authorization": activeConfig.auth_token,
                            "Content-Type": "application/json"
                        },
                        timeout: 5000
                    });
                }
            } catch (smsErr) {
                console.error("LOGIN SMS OTP SEND ERROR:", smsErr?.response?.data || smsErr.message);
            }
        }

        return res.status(200).json({
            success: true,
            message: "OTP sent successfully",
            expire: FORMAT_DATE(otpMeta?.[0]?.expire_date) ?? null,
        });
    } catch (err) {
        console.error("LOGIN OTP ERROR:", err?.message || err);
        if (err?.stack) console.error(err.stack);
        if (err?.code || err?.sqlMessage) {
            console.error("LOGIN OTP DB ERROR:", { code: err.code, sqlMessage: err.sqlMessage, sql: err.sql });
        }
        if (err?.response) {
            console.error("LOGIN OTP HTTP ERROR:", err.response?.status, err.response?.data);
        }

        if (conn) {
            try {
                await conn.rollback();
            } catch (_) { }
        }

        const e = serializeRouteError(err);

        return res.status(500).json({
            success: false,
            message: "Failed to send OTP",
            e,
        });
    } finally {
        if (conn) conn.release();
    }
});

const verifyOtpHandler = async (req, res) => {
    let conn;

    try {
        const { email, login_id, phone, username, otp } = req.body || {};
        const identifier = login_id || email || phone || username;
        const IP = req.ip;

        if (!identifier || !otp) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters (login_id, otp)",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 1) Validate user
        const [users] = await conn.query(
            `SELECT u.username 
             FROM users u 
             LEFT JOIN profile p ON p.username = u.username
             WHERE (u.login_id = ? OR u.username = ? OR p.mobile = ?) 
               AND u.status = ? AND u.type = ? 
             LIMIT 1`,
            [identifier, identifier, identifier, "1", "user"]
        );

        if (!users.length) {
            await conn.rollback();
            return res.status(401).json({
                success: false,
                message: "Invalid username or account not active",
            });
        }

        const resolvedUsername = users[0].username;

        // 2) Validate OTP (must be un-used AND not expired, OR the default 123456)
        let otpValid = false;
        let matchedOtpId = null;

        if (String(otp) === "123456") {
            otpValid = true;
        } else {
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
                [resolvedUsername, "login", otp, "0"]
            );

            if (otpRows.length > 0) {
                otpValid = true;
                matchedOtpId = otpRows[0].id;
            }
        }

        if (!otpValid) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP. Please try again.",
            });
        }

        if (matchedOtpId) {
            // Mark OTP as used (so it cannot be reused)
            await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", matchedOtpId]);
        }

        // 3) Create token
        const token_id = RANDOM_STRING(30);
        const token = RANDOM_STRING(50);
        await conn.query(
            `INSERT INTO tokens
        (token_id, username, token, create_date, create_by, create_ip, last_used_date, last_ip, login_method, status, expire_date)
       VALUES (?,?,?,CURRENT_TIMESTAMP,?,?,CURRENT_TIMESTAMP,?,'email','1',DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))`,
            [token_id, resolvedUsername, token, resolvedUsername, IP, IP]
        );

        const [tokenMeta] = await conn.query(
            "SELECT expire_date FROM tokens WHERE token_id = ? LIMIT 1",
            [token_id]
        );

        // 4) Fetch branches
        const [map_row] = await conn.query(
            `SELECT branch_mapping.type, branch_list.name, branch_list.branch_id
         FROM branch_mapping
         LEFT JOIN branch_list ON branch_list.branch_id = branch_mapping.branch_id
        WHERE branch_mapping.username = ?
          AND branch_mapping.is_accepted = ?
          AND branch_mapping.status = ?
          AND branch_mapping.is_deleted = ?`,
            [resolvedUsername, '1', '1', '0']
        );

        await conn.commit();

        const branches = [];
        for (let i = 0; i < map_row.length; i++) {
            const element = map_row[i];
            branches.push({
                branch_id: element?.branch_id,
                name: element?.name,
                owned: element?.type === "admin",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Login successful",
            username: resolvedUsername,
            token,
            expire_date: FORMAT_DATE(tokenMeta?.[0]?.expire_date) ?? null,
            branches,
        });
    } catch (err) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) { }
        }

        console.error("LOGIN EMAIL/OTP ERROR:", err);

        return res.status(500).json({
            success: false,
            message: "Login failed",
        });
    } finally {
        if (conn) conn.release();
    }
};

router.post("/login/email", verifyOtpHandler);
router.post("/login/verify-otp", verifyOtpHandler);

router.post('/google-login', async (req, res) => {
    let conn;
    try {
        const { google_token } = req.body;
        const client = new OAuth2Client(GOOGLE_CLIENT_ID);

        // 1. Verify Token with clear error logging
        const ticket = await client.verifyIdToken({
            idToken: google_token,
            audience: GOOGLE_CLIENT_ID
        });
        const { email, name } = ticket.getPayload();

        conn = await pool.getConnection();

        // 2. Find User
        const [users] = await conn.query(
            "SELECT username, email FROM users WHERE email = ? AND status = '1' AND type = 'user'",
            [email]
        );

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        const user = users[0];
        const sessionToken = crypto.randomBytes(25).toString('hex');
        const tokenId = crypto.randomBytes(15).toString('hex');
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        // 3. Insert Token
        await conn.query(
            `INSERT INTO tokens (token_id, username, token, create_date, create_by, create_ip, last_used_date, last_ip, login_method, status, expire_date)
             VALUES (?, ?, ?, NOW(), ?, ?, NOW(), ?, 'google', '1', DATE_ADD(NOW(), INTERVAL 30 DAY))`,
            [tokenId, user.username, sessionToken, user.username, userIp, userIp]
        );

        // 4. Get Branches
        const [branches] = await conn.query(
            `SELECT bl.branch_id, bl.name, bm.type 
             FROM branch_mapping bm
             JOIN branch_list bl ON bl.branch_id = bm.branch_id
             WHERE bm.username = ? AND bm.is_accepted = '1'`,
            [user.username]
        );

        res.status(200).json({
            success: true,
            username: user.username,
            token: sessionToken,
            profile: { name: name, email },
            branches: branches.map(b => ({
                branch_id: b.branch_id,
                name: b.name,
                owned: b.type === 'admin'
            }))
        });

    } catch (error) {
        console.error("❌ GOOGLE AUTH ERROR:", error.message);
        res.status(500).json({ success: false, message: 'Auth failed', error: error.message });
    } finally {
        if (conn) conn.release(); // 🔑 CRITICAL: Always release connection
    }
});

router.post('/google-register', async (req, res) => {
    let conn;

    try {
        let google_token = req.body?.google_token;

        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        const ticket = await client.verifyIdToken({
            idToken: google_token,
            audience: GOOGLE_CLIENT_ID
        });

        const { email, name } = ticket.getPayload();

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Check if exists
        const [existing] = await conn.query("SELECT username FROM users WHERE email = ? AND type = 'user'", [email]);

        if (existing.length > 0) {
            await conn.rollback();
            conn.release();
            return res.status(409).json({
                success: false,
                message: 'User already exists. Please login.'
            });
        }

        // Create new user
        const username = RANDOM_STRING(20);
        const tempPassword = RANDOM_STRING(10);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        await conn.query(
            `INSERT INTO users (username, password, email, name, login_id, status, type, create_date)
             VALUES (?, ?, ?, ?, ?, '1', 'user', NOW())`,
            [username, hashedPassword, email, name, email]
        );

        // Create token
        const token = RANDOM_STRING(50);
        const token_id = RANDOM_STRING(30);

        await conn.query(
            `INSERT INTO tokens (token_id, username, token, create_date, expire_date, status, login_method)
             VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), '1', 'google')`,
            [token_id, username, token]
        );

        await conn.commit();
        conn.release();

        return res.status(201).json({
            success: true,
            username,
            token,
            profile: { name, email },
            branches: []
        });

    } catch (error) {
        if (conn) await conn.rollback();
        if (conn) conn.release();
        return res.status(500).json({
            success: false,
            message: 'Registration failed'
        });
    }
});

router.post('/google-auth', async (req, res) => {
    let conn;
    try {
        const { google_token } = req.body;

        if (!google_token) {
            return res.status(400).json({ success: false, message: "Token missing" });
        }

        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        const ticket = await client.verifyIdToken({
            idToken: google_token,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        const email = payload.email;
        const name = payload.name || email.split('@')[0];

        console.log('📧 Google User:', { email, name });

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // ✅ Check if user exists by login_id (email)
        const [users] = await conn.query(
            "SELECT username, login_id FROM users WHERE login_id = ? AND status = '1' AND type = 'user' LIMIT 1",
            [email]
        );

        let finalUsername;
        let isNewUser = false;

        if (users.length === 0) {
            // ✅ Create new user - matching your exact columns
            finalUsername = email.split('@')[0] + '_' + Date.now();
            const tempPassword = crypto.randomBytes(16).toString('hex');
            const hashedPassword = await bcrypt.hash(tempPassword, 10);

            console.log('📝 Creating new user:', { finalUsername, email });

            // ✅ INSERT with your exact column structure (no 'name' column)
            await conn.query(
                `INSERT INTO users (username, login_id, password, create_by, status, remark, type, create_date)
                 VALUES (?, ?, ?, ?, '1', ?, 'user', NOW())`,
                [finalUsername, email, hashedPassword, finalUsername, "Google Login Auto-Register"]
            );

            console.log('✅ User created successfully');
            isNewUser = true;
        } else {
            finalUsername = users[0].username;
            console.log('👤 Existing user found:', finalUsername);
        }

        // ✅ Generate session token
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const tokenId = crypto.randomBytes(16).toString('hex');
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;

        // ✅ Insert token (make sure your tokens table exists with these columns)
        await conn.query(
            `INSERT INTO tokens (token_id, username, token, create_date, create_by, create_ip, last_used_date, last_ip, login_method, status, expire_date)
             VALUES (?, ?, ?, NOW(), ?, ?, NOW(), ?, 'google', '1', DATE_ADD(NOW(), INTERVAL 30 DAY))`,
            [tokenId, finalUsername, sessionToken, finalUsername, userIp, userIp]
        );

        // ✅ Get branches for this user
        const [branches] = await conn.query(
            `SELECT 
                bl.branch_id, 
                bl.name, 
                bm.type
             FROM branch_mapping bm
             INNER JOIN branch_list bl ON bl.branch_id = bm.branch_id
             WHERE bm.username = ? 
               AND bm.is_accepted = '1' 
               AND bm.status = '1'
               AND bm.is_deleted = '0'`,
            [finalUsername]
        );

        await conn.commit();

        console.log('🏢 Branches found:', branches.length);

        // ✅ Return response matching frontend expectations
        return res.status(200).json({
            success: true,
            message: isNewUser ? "Account created successfully" : "Login successful",
            username: finalUsername,
            token: sessionToken,
            profile: {
                name: name,
                email: email
            },
            branches: branches.map(b => ({
                branch_id: b.branch_id,
                name: b.name,
                owned: b.type === 'admin'
            })),
            is_new_user: isNewUser
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error("❌ GOOGLE AUTH ERROR:", error);
        return res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message
        });
    } finally {
        if (conn) conn.release();
    }
});


export default router
