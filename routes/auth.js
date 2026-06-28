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




router.post("/login/send-otp", async (req, res) => {
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
        });;
    } catch (err) {
        console.error("LOGIN OTP ERROR:", err);

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

// ==================== BRANCH MANAGEMENT APIs ====================

// CREATE BRANCH API
// router.post("/branch/create", auth, async (req, res) => {
//     let conn;

//     try {
//         const { 
//             branch_name, branch_code, address_line_1, address_line_2, city, state, 
//             country, pincode, invoice_address, pan, gst, gst_rate, mobile_1, 
//             mobile_2, email_1, email_2, is_head_office 
//         } = req.body;

//         const username = req.username; // From auth middleware

//         // Validate required fields
//         if (!branch_name || !branch_code || !address_line_1 || !city || !state) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Missing required fields: branch_name, branch_code, address_line_1, city, state"
//             });
//         }

//         conn = await pool.getConnection();
//         await conn.beginTransaction();

//         // Check if branch_code already exists
//         const [existingBranch] = await conn.query(
//             "SELECT branch_id FROM branch_list WHERE branch_code = ? AND is_deleted = '0'",
//             [branch_code]
//         );

//         if (existingBranch.length > 0) {
//             await conn.rollback();
//             return res.status(409).json({
//                 success: false,
//                 message: "Branch code already exists"
//             });
//         }

//         // Generate unique branch_id
//         const branch_id = `BR_${Date.now()}_${RANDOM_STRING(6)}`;
//         const currentTime = new Date();

//         // Insert branch
//         await conn.query(
//             `INSERT INTO branch_list (
//                 branch_id, name, branch_code, username, address_line_1, address_line_2,
//                 city, state, country, pincode, invoice_address, pan, gst, gst_rate,
//                 mobile_1, mobile_2, email_1, email_2, create_by, create_date, status, is_deleted
//             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', '0')`,
//             [
//                 branch_id, branch_name, branch_code, username, address_line_1, address_line_2 || null,
//                 city, state, country || 'India', pincode || null, invoice_address || null, pan || null,
//                 gst || null, gst_rate || 0, mobile_1, mobile_2 || null, email_1 || null, email_2 || null,
//                 username, currentTime
//             ]
//         );

//         // If this is head office, create admin mapping
//         if (is_head_office) {
//             await conn.query(
//                 `INSERT INTO branch_mapping (
//                     branch_id, username, type, is_accepted, status, create_date, create_by
//                 ) VALUES (?, ?, 'admin', '1', '1', ?, ?)`,
//                 [branch_id, username, currentTime, username]
//             );
//         }

//         await conn.commit();

//         // Fetch created branch
//         const [newBranch] = await conn.query(
//             `SELECT * FROM branch_list WHERE branch_id = ? AND is_deleted = '0'`,
//             [branch_id]
//         );

//         return res.status(201).json({
//             success: true,
//             message: "Branch created successfully",
//             data: newBranch[0]
//         });

//     } catch (err) {
//         if (conn) await conn.rollback();
//         console.error("CREATE BRANCH ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to create branch",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // GET BRANCH BY ID API
// router.get("/branch/:branch_id", auth, async (req, res) => {
//     let conn;

//     try {
//         const { branch_id } = req.params;
//         const username = req.username;

//         if (!branch_id) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Branch ID is required"
//             });
//         }

//         conn = await pool.getConnection();

//         // Check if user has access to this branch
//         const [access] = await conn.query(
//             `SELECT * FROM branch_mapping 
//              WHERE branch_id = ? AND username = ? AND is_accepted = '1' AND status = '1' AND is_deleted = '0'`,
//             [branch_id, username]
//         );

//         if (access.length === 0) {
//             return res.status(403).json({
//                 success: false,
//                 message: "You don't have access to this branch"
//             });
//         }

//         // Fetch branch details
//         const [branches] = await conn.query(
//             `SELECT 
//                 id, branch_id, name as branch_name, branch_code, username as owner_username,
//                 address_line_1, address_line_2, city, state, country, pincode,
//                 invoice_address, pan, is_pan_verified, gst, gst_rate, is_gst_verified,
//                 mobile_1, mobile_2, email_1, email_2, logo, sign,
//                 status, create_date, modify_date, create_by, modify_by
//              FROM branch_list 
//              WHERE branch_id = ? AND is_deleted = '0'`,
//             [branch_id]
//         );

//         if (branches.length === 0) {
//             return res.status(404).json({
//                 success: false,
//                 message: "Branch not found"
//             });
//         }

//         // Get branch members
//         const [members] = await conn.query(
//             `SELECT username, type, is_accepted, create_date 
//              FROM branch_mapping 
//              WHERE branch_id = ? AND status = '1' AND is_deleted = '0'`,
//             [branch_id]
//         );

//         return res.status(200).json({
//             success: true,
//             data: {
//                 ...branches[0],
//                 members
//             }
//         });

//     } catch (err) {
//         console.error("GET BRANCH ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to fetch branch",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // GET ALL BRANCHES FOR USER
// router.get("/branches", auth, async (req, res) => {
//     let conn;

//     try {
//         const username = req.username;

//         conn = await pool.getConnection();

//         const [branches] = await conn.query(
//             `SELECT 
//                 bl.branch_id, bl.name as branch_name, bl.branch_code, bl.address_line_1,
//                 bl.city, bl.state, bl.country, bl.mobile_1, bl.email_1,
//                 bm.type, bm.is_accepted, bm.create_date as joined_date
//              FROM branch_list bl
//              INNER JOIN branch_mapping bm ON bl.branch_id = bm.branch_id
//              WHERE bm.username = ? 
//                AND bm.is_accepted = '1' 
//                AND bm.status = '1' 
//                AND bm.is_deleted = '0'
//                AND bl.is_deleted = '0'
//              ORDER BY bm.create_date DESC`,
//             [username]
//         );

//         return res.status(200).json({
//             success: true,
//             data: branches
//         });

//     } catch (err) {
//         console.error("GET BRANCHES ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to fetch branches",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // UPDATE BRANCH API
// router.put("/branch/:branch_id", auth, async (req, res) => {
//     let conn;

//     try {
//         const { branch_id } = req.params;
//         const username = req.username;
//         const {
//             branch_name, branch_code, address_line_1, address_line_2, city, state,
//             country, pincode, invoice_address, pan, gst, gst_rate,
//             mobile_1, mobile_2, email_1, email_2, status
//         } = req.body;

//         if (!branch_id) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Branch ID is required"
//             });
//         }

//         conn = await pool.getConnection();
//         await conn.beginTransaction();

//         // Check if user has admin access to this branch
//         const [access] = await conn.query(
//             `SELECT * FROM branch_mapping 
//              WHERE branch_id = ? AND username = ? AND type = 'admin' 
//                AND is_accepted = '1' AND status = '1' AND is_deleted = '0'`,
//             [branch_id, username]
//         );

//         if (access.length === 0) {
//             await conn.rollback();
//             return res.status(403).json({
//                 success: false,
//                 message: "You don't have permission to update this branch"
//             });
//         }

//         // Check if branch exists
//         const [existingBranch] = await conn.query(
//             "SELECT branch_id FROM branch_list WHERE branch_id = ? AND is_deleted = '0'",
//             [branch_id]
//         );

//         if (existingBranch.length === 0) {
//             await conn.rollback();
//             return res.status(404).json({
//                 success: false,
//                 message: "Branch not found"
//             });
//         }

//         // Check if branch_code is unique (excluding current branch)
//         if (branch_code) {
//             const [duplicateCode] = await conn.query(
//                 "SELECT branch_id FROM branch_list WHERE branch_code = ? AND branch_id != ? AND is_deleted = '0'",
//                 [branch_code, branch_id]
//             );

//             if (duplicateCode.length > 0) {
//                 await conn.rollback();
//                 return res.status(409).json({
//                     success: false,
//                     message: "Branch code already exists"
//                 });
//             }
//         }

//         // Build update query dynamically
//         const updateFields = [];
//         const updateValues = [];

//         if (branch_name) {
//             updateFields.push("name = ?");
//             updateValues.push(branch_name);
//         }
//         if (branch_code) {
//             updateFields.push("branch_code = ?");
//             updateValues.push(branch_code);
//         }
//         if (address_line_1) {
//             updateFields.push("address_line_1 = ?");
//             updateValues.push(address_line_1);
//         }
//         if (address_line_2 !== undefined) {
//             updateFields.push("address_line_2 = ?");
//             updateValues.push(address_line_2);
//         }
//         if (city) {
//             updateFields.push("city = ?");
//             updateValues.push(city);
//         }
//         if (state) {
//             updateFields.push("state = ?");
//             updateValues.push(state);
//         }
//         if (country) {
//             updateFields.push("country = ?");
//             updateValues.push(country);
//         }
//         if (pincode !== undefined) {
//             updateFields.push("pincode = ?");
//             updateValues.push(pincode);
//         }
//         if (invoice_address !== undefined) {
//             updateFields.push("invoice_address = ?");
//             updateValues.push(invoice_address);
//         }
//         if (pan !== undefined) {
//             updateFields.push("pan = ?");
//             updateValues.push(pan);
//         }
//         if (gst !== undefined) {
//             updateFields.push("gst = ?");
//             updateValues.push(gst);
//         }
//         if (gst_rate !== undefined) {
//             updateFields.push("gst_rate = ?");
//             updateValues.push(gst_rate);
//         }
//         if (mobile_1) {
//             updateFields.push("mobile_1 = ?");
//             updateValues.push(mobile_1);
//         }
//         if (mobile_2 !== undefined) {
//             updateFields.push("mobile_2 = ?");
//             updateValues.push(mobile_2);
//         }
//         if (email_1 !== undefined) {
//             updateFields.push("email_1 = ?");
//             updateValues.push(email_1);
//         }
//         if (email_2 !== undefined) {
//             updateFields.push("email_2 = ?");
//             updateValues.push(email_2);
//         }
//         if (status) {
//             updateFields.push("status = ?");
//             updateValues.push(status);
//         }

//         updateFields.push("modify_by = ?");
//         updateValues.push(username);

//         updateFields.push("modify_date = CURRENT_TIMESTAMP");

//         if (updateFields.length > 2) {
//             const updateQuery = `UPDATE branch_list SET ${updateFields.join(", ")} WHERE branch_id = ? AND is_deleted = '0'`;
//             updateValues.push(branch_id);

//             await conn.query(updateQuery, updateValues);
//         }

//         await conn.commit();

//         // Fetch updated branch
//         const [updatedBranch] = await conn.query(
//             `SELECT * FROM branch_list WHERE branch_id = ? AND is_deleted = '0'`,
//             [branch_id]
//         );

//         return res.status(200).json({
//             success: true,
//             message: "Branch updated successfully",
//             data: updatedBranch[0]
//         });

//     } catch (err) {
//         if (conn) await conn.rollback();
//         console.error("UPDATE BRANCH ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to update branch",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // DELETE BRANCH (Soft Delete) API
// router.delete("/branch/:branch_id", auth, async (req, res) => {
//     let conn;

//     try {
//         const { branch_id } = req.params;
//         const username = req.username;

//         if (!branch_id) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Branch ID is required"
//             });
//         }

//         conn = await pool.getConnection();
//         await conn.beginTransaction();

//         // Check if user has admin access
//         const [access] = await conn.query(
//             `SELECT * FROM branch_mapping 
//              WHERE branch_id = ? AND username = ? AND type = 'admin' 
//                AND is_accepted = '1' AND status = '1' AND is_deleted = '0'`,
//             [branch_id, username]
//         );

//         if (access.length === 0) {
//             await conn.rollback();
//             return res.status(403).json({
//                 success: false,
//                 message: "You don't have permission to delete this branch"
//             });
//         }

//         // Soft delete branch
//         await conn.query(
//             `UPDATE branch_list SET is_deleted = '1', deleted_by = ?, modify_date = CURRENT_TIMESTAMP 
//              WHERE branch_id = ?`,
//             [username, branch_id]
//         );

//         // Soft delete all mappings for this branch
//         await conn.query(
//             `UPDATE branch_mapping SET is_deleted = '1', deleted_by = ?, modify_date = CURRENT_TIMESTAMP 
//              WHERE branch_id = ?`,
//             [username, branch_id]
//         );

//         await conn.commit();

//         return res.status(200).json({
//             success: true,
//             message: "Branch deleted successfully"
//         });

//     } catch (err) {
//         if (conn) await conn.rollback();
//         console.error("DELETE BRANCH ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to delete branch",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // INVITE USER TO BRANCH API
// router.post("/branch/:branch_id/invite", auth, async (req, res) => {
//     let conn;

//     try {
//         const { branch_id } = req.params;
//         const { email, role } = req.body;
//         const username = req.username;

//         if (!branch_id || !email) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Branch ID and email are required"
//             });
//         }

//         conn = await pool.getConnection();
//         await conn.beginTransaction();

//         // Check if user has admin access
//         const [access] = await conn.query(
//             `SELECT * FROM branch_mapping 
//              WHERE branch_id = ? AND username = ? AND type = 'admin' 
//                AND is_accepted = '1' AND status = '1' AND is_deleted = '0'`,
//             [branch_id, username]
//         );

//         if (access.length === 0) {
//             await conn.rollback();
//             return res.status(403).json({
//                 success: false,
//                 message: "You don't have permission to invite users"
//             });
//         }

//         // Check if user exists
//         const [user] = await conn.query(
//             "SELECT username, login_id, name FROM users WHERE login_id = ? AND status = '1'",
//             [email]
//         );

//         if (user.length === 0) {
//             await conn.rollback();
//             return res.status(404).json({
//                 success: false,
//                 message: "User not found with this email"
//             });
//         }

//         const invitedUsername = user[0].username;

//         // Check if already mapped
//         const [existingMapping] = await conn.query(
//             `SELECT * FROM branch_mapping 
//              WHERE branch_id = ? AND username = ? AND is_deleted = '0'`,
//             [branch_id, invitedUsername]
//         );

//         if (existingMapping.length > 0) {
//             await conn.rollback();
//             return res.status(409).json({
//                 success: false,
//                 message: "User already has access to this branch"
//             });
//         }

//         // Generate invitation token
//         const invitationToken = RANDOM_STRING(50);
//         const currentTime = new Date();

//         // Create invitation
//         await conn.query(
//             `INSERT INTO branch_invitations (
//                 token, branch_id, invited_email, invited_username, invited_by, role, 
//                 status, create_date, expire_date
//             ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, DATE_ADD(?, INTERVAL 7 DAY))`,
//             [
//                 invitationToken, branch_id, email, invitedUsername, username, 
//                 role || 'staff', currentTime, currentTime
//             ]
//         );

//         // Send invitation email
//         const branchInfo = await conn.query(
//             "SELECT name as branch_name FROM branch_list WHERE branch_id = ?",
//             [branch_id]
//         );

//         const inviteLink = `${process.env.FRONTEND_URL}/accept-invitation?token=${invitationToken}`;

//         await SendMail({
//             to: email,
//             subject: `Invitation to join ${branchInfo[0]?.branch_name} on ${APP_NAME}`,
//             html: `
//                 <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
//                     <h2>Branch Invitation</h2>
//                     <p>You have been invited to join <strong>${branchInfo[0]?.branch_name}</strong> as a ${role}.</p>
//                     <p>Click the button below to accept the invitation:</p>
//                     <a href="${inviteLink}" style="display: inline-block; padding: 10px 20px; background-color: #4f46e5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">Accept Invitation</a>
//                     <p>This invitation will expire in 7 days.</p>
//                 </div>
//             `
//         });

//         await conn.commit();

//         return res.status(200).json({
//             success: true,
//             message: "Invitation sent successfully",
//             invitation_token: invitationToken
//         });

//     } catch (err) {
//         if (conn) await conn.rollback();
//         console.error("INVITE USER ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to send invitation",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // ACCEPT BRANCH INVITATION API
// router.post("/branch/invitations/accept/:token", async (req, res) => {
//     let conn;

//     try {
//         const { token } = req.params;
//         const { user_id } = req.body;

//         if (!token) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Invitation token is required"
//             });
//         }

//         conn = await pool.getConnection();
//         await conn.beginTransaction();

//         // Get invitation
//         const [invitations] = await conn.query(
//             `SELECT * FROM branch_invitations 
//              WHERE token = ? AND status = 'pending' AND expire_date > CURRENT_TIMESTAMP`,
//             [token]
//         );

//         if (invitations.length === 0) {
//             await conn.rollback();
//             return res.status(404).json({
//                 success: false,
//                 message: "Invalid or expired invitation"
//             });
//         }

//         const invitation = invitations[0];

//         // Get branch details
//         const [branches] = await conn.query(
//             "SELECT branch_id, name as branch_name, branch_code FROM branch_list WHERE branch_id = ? AND is_deleted = '0'",
//             [invitation.branch_id]
//         );

//         if (branches.length === 0) {
//             await conn.rollback();
//             return res.status(404).json({
//                 success: false,
//                 message: "Branch not found"
//             });
//         }

//         // Add user to branch mapping
//         const currentTime = new Date();
//         await conn.query(
//             `INSERT INTO branch_mapping (
//                 branch_id, username, type, is_accepted, status, create_date, create_by
//             ) VALUES (?, ?, ?, '1', '1', ?, ?)`,
//             [invitation.branch_id, invitation.invited_username, invitation.role, currentTime, invitation.invited_by]
//         );

//         // Update invitation status
//         await conn.query(
//             "UPDATE branch_invitations SET status = 'accepted', accepted_date = CURRENT_TIMESTAMP WHERE token = ?",
//             [token]
//         );

//         await conn.commit();

//         return res.status(200).json({
//             success: true,
//             message: "Invitation accepted successfully",
//             data: {
//                 branch_id: branches[0].branch_id,
//                 branch_name: branches[0].branch_name,
//                 branch_code: branches[0].branch_code,
//                 role: invitation.role
//             }
//         });

//     } catch (err) {
//         if (conn) await conn.rollback();
//         console.error("ACCEPT INVITATION ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to accept invitation",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // VERIFY INVITATION API
// router.get("/branch/invitations/verify/:token", async (req, res) => {
//     let conn;

//     try {
//         const { token } = req.params;

//         if (!token) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Invitation token is required"
//             });
//         }

//         conn = await pool.getConnection();

//         const [invitations] = await conn.query(
//             `SELECT i.*, bl.name as branch_name, bl.branch_code, u.name as invited_by_name
//              FROM branch_invitations i
//              LEFT JOIN branch_list bl ON bl.branch_id = i.branch_id
//              LEFT JOIN users u ON u.username = i.invited_by
//              WHERE i.token = ? AND i.status = 'pending' AND i.expire_date > CURRENT_TIMESTAMP`,
//             [token]
//         );

//         if (invitations.length === 0) {
//             return res.status(404).json({
//                 success: false,
//                 message: "Invalid or expired invitation"
//             });
//         }

//         const invitation = invitations[0];

//         return res.status(200).json({
//             success: true,
//             data: {
//                 branch_id: invitation.branch_id,
//                 branch_name: invitation.branch_name,
//                 branch_code: invitation.branch_code,
//                 invited_by_name: invitation.invited_by_name,
//                 role: invitation.role,
//                 invited_email: invitation.invited_email
//             }
//         });

//     } catch (err) {
//         console.error("VERIFY INVITATION ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to verify invitation",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });

// // REMOVE USER FROM BRANCH API
// router.delete("/branch/:branch_id/users/:username", auth, async (req, res) => {
//     let conn;

//     try {
//         const { branch_id, username: userToRemove } = req.params;
//         const adminUsername = req.username;

//         conn = await pool.getConnection();
//         await conn.beginTransaction();

//         // Check if admin has access
//         const [adminAccess] = await conn.query(
//             `SELECT * FROM branch_mapping 
//              WHERE branch_id = ? AND username = ? AND type = 'admin' 
//                AND is_accepted = '1' AND status = '1' AND is_deleted = '0'`,
//             [branch_id, adminUsername]
//         );

//         if (adminAccess.length === 0) {
//             await conn.rollback();
//             return res.status(403).json({
//                 success: false,
//                 message: "You don't have permission to remove users"
//             });
//         }

//         // Can't remove yourself
//         if (adminUsername === userToRemove) {
//             await conn.rollback();
//             return res.status(400).json({
//                 success: false,
//                 message: "Cannot remove yourself from branch"
//             });
//         }

//         // Remove user from branch
//         await conn.query(
//             `UPDATE branch_mapping 
//              SET is_deleted = '1', deleted_by = ?, modify_date = CURRENT_TIMESTAMP 
//              WHERE branch_id = ? AND username = ? AND is_deleted = '0'`,
//             [adminUsername, branch_id, userToRemove]
//         );

//         await conn.commit();

//         return res.status(200).json({
//             success: true,
//             message: "User removed from branch successfully"
//         });

//     } catch (err) {
//         if (conn) await conn.rollback();
//         console.error("REMOVE USER ERROR:", err);
//         return res.status(500).json({
//             success: false,
//             message: "Failed to remove user",
//             error: err.message
//         });
//     } finally {
//         if (conn) conn.release();
//     }
// });



export default router
