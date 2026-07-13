import express from "express";
const router = express.Router();
import pool from "../db.js";
import { FORMAT_DATE, RANDOM_STRING, UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";
import { GOOGLE_CLIENT_ID } from "../helpers/Config.js";
import { OAuth2Client } from "google-auth-library";
import { generateOtp, sendSmsOtp } from "../helpers/smsOtp.js";
import {
    findSoftwareUserByEmail,
    findSoftwareUserByMobile,
    resolveSoftwareUserByContact,
    REGISTER_OTP_TYPE,
    USER_OTP_TYPE,
} from "../helpers/authProfile.js";
import {
    normalizeCountryCode,
    normalizeMobileDigits,
} from "../helpers/clientPhone.js";
import { buildProfileImageUrl } from "../helpers/mediaUrl.js";

async function fetchActiveProfilePayload(conn, username) {
    const [rows] = await conn.query(
        `SELECT
            profile_id,
            username,
            user_type,
            name,
            email,
            mobile,
            country_code,
            image,
            pan_number,
            city,
            state,
            gender,
            date_of_birth
         FROM profile
         WHERE username = ?
           AND status = '1'
         ORDER BY id DESC
         LIMIT 1`,
        [username]
    );

    const row = rows[0];
    if (!row) {
        return null;
    }

    return {
        profile_id: row.profile_id,
        username: row.username,
        user_type: row.user_type,
        name: row.name,
        email: row.email,
        mobile: row.mobile,
        country_code: row.country_code,
        image: buildProfileImageUrl(row.image),
        pan_number: row.pan_number,
        city: row.city,
        state: row.state,
        gender: row.gender,
        date_of_birth: row.date_of_birth,
    };
}

function buildProfilePayloadFromContact({ username, name, email, mobile, countryCode = "+91" }) {
    return {
        profile_id: null,
        username,
        user_type: "user",
        name,
        email: email || null,
        mobile: mobile || null,
        country_code: countryCode,
        image: null,
        pan_number: null,
        city: null,
        state: null,
        gender: null,
        date_of_birth: null,
    };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_REGEX = /^\d{10}$/;

function normalizeMobile(mobile) {
    return String(mobile || "").replace(/\D/g, "").slice(-10);
}

function validateRegistrationContact({ email, mobile }) {
    const trimmedEmail = String(email || "").trim().toLowerCase();
    const normalizedMobile = normalizeMobile(mobile);

    if (!normalizedMobile) {
        return { ok: false, message: "Mobile number is required." };
    }
    if (!MOBILE_REGEX.test(normalizedMobile)) {
        return { ok: false, message: "Mobile number must be a valid 10-digit Indian number." };
    }
    if (trimmedEmail && !EMAIL_REGEX.test(trimmedEmail)) {
        return { ok: false, message: "Please enter a valid email address." };
    }

    return {
        ok: true,
        email: trimmedEmail || null,
        mobile: normalizedMobile,
        otpKey: normalizedMobile,
        otpChannel: "mobile",
    };
}

function resolveLoginIdentifier(body = {}) {
    const { email, login_id, phone, mobile, country_code } = body;
    const normalizedCountryCode = normalizeCountryCode(country_code || "+91");
    const directMobile = normalizeMobileDigits(mobile || phone);
    const identifier = String(login_id || email || "").trim();
    let lookupEmail = email ? String(email).trim().toLowerCase() : null;
    let lookupMobile = directMobile;

    if (!lookupMobile && identifier) {
        if (identifier.includes("@")) {
            lookupEmail = identifier.toLowerCase();
        } else {
            lookupMobile = normalizeMobileDigits(identifier);
        }
    }

    return {
        normalizedCountryCode,
        lookupEmail,
        lookupMobile,
        identifier,
    };
}

async function findLoginUserAccount(conn, { normalizedCountryCode, lookupEmail, lookupMobile, identifier }) {
    if (lookupMobile) {
        const byMobile = await findSoftwareUserByMobile(conn, normalizedCountryCode, lookupMobile);
        if (byMobile) return byMobile;
    }

    if (lookupEmail) {
        const byEmail = await findSoftwareUserByEmail(conn, lookupEmail);
        if (byEmail) return byEmail;
    }

    if (identifier) {
        return resolveSoftwareUserByContact(conn, identifier);
    }

    return null;
}

async function findExistingUser(conn, { email, mobile }) {
    if (mobile) {
        const byMobile = await findSoftwareUserByMobile(conn, "+91", mobile);
        if (byMobile) {
            return { username: byMobile.username };
        }
    }

    if (email) {
        const byEmail = await findSoftwareUserByEmail(conn, email);
        if (byEmail) {
            return { username: byEmail.username };
        }
    }

    return null;
}

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
    let conn;

    try {
        const { template_id, config_id } = req.body ?? {};
        const loginLookup = resolveLoginIdentifier(req.body);

        if (!loginLookup.lookupMobile && !loginLookup.lookupEmail && !loginLookup.identifier) {
            return res.status(400).json({
                success: false,
                message: "Mobile number or email is required.",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const userAccount = await findLoginUserAccount(conn, loginLookup);

        if (!userAccount) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Account not found or is inactive.",
            });
        }

        const db_username = userAccount.username;
        const otpCountryCode = normalizeCountryCode(userAccount.country_code || loginLookup.normalizedCountryCode);
        const otpMobile = normalizeMobileDigits(userAccount.mobile || loginLookup.lookupMobile);

        if (!otpMobile || !MOBILE_REGEX.test(otpMobile)) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "A registered mobile number is required for OTP login. Please contact support.",
            });
        }

        const otp_id = await UNIQUE_RANDOM_STRING("otps", "otp_id", { conn });
        const otp = generateOtp(6);

        await conn.execute(
            `UPDATE otps
             SET status = ?
             WHERE (
                    (username = ? AND type = ?)
                 OR (country_code = ? AND mobile = ? AND type = ?)
               )
               AND status = ?`,
            ["1", db_username, USER_OTP_TYPE, otpCountryCode, otpMobile, USER_OTP_TYPE, "0"]
        );

        await conn.execute(
            `INSERT INTO otps
         (otp_id, type, otp, username, country_code, mobile, create_date, expire_date, status, remark)
        VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE),?,?)`,
            [otp_id, USER_OTP_TYPE, otp, db_username, otpCountryCode, otpMobile, "0", "User login OTP"]
        );

        const [otpMeta] = await conn.query(
            "SELECT expire_date FROM otps WHERE otp_id = ? ORDER BY id DESC LIMIT 1",
            [otp_id]
        );

        await conn.commit();

        try {
            await sendSmsOtp(otpMobile, otp, { template_id, config_id });
        } catch (smsErr) {
            console.error("LOGIN SMS OTP SEND ERROR:", smsErr?.response?.data || smsErr.message);
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP to your registered mobile number. Please try again.",
            });
        }

        return res.status(200).json({
            success: true,
            message: "OTP sent to your registered mobile number.",
            channel: "mobile",
            mobile_masked: `******${otpMobile.slice(-4)}`,
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
        const { otp, country_code } = req.body || {};
        const loginLookup = resolveLoginIdentifier(req.body);
        const IP = req.ip;

        if (!otp) {
            return res.status(400).json({
                success: false,
                message: "OTP is required.",
            });
        }

        if (!loginLookup.lookupMobile && !loginLookup.lookupEmail && !loginLookup.identifier) {
            return res.status(400).json({
                success: false,
                message: "Mobile number or email is required.",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const userAccount = await findLoginUserAccount(conn, loginLookup);

        if (!userAccount) {
            await conn.rollback();
            return res.status(401).json({
                success: false,
                message: "Invalid credentials or account not active.",
            });
        }

        const resolvedUsername = userAccount.username;
        const otpCountryCode = normalizeCountryCode(userAccount.country_code || loginLookup.normalizedCountryCode || country_code);
        const otpMobile = normalizeMobileDigits(userAccount.mobile || loginLookup.lookupMobile);

        if (!otpMobile) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "A registered mobile number is required for OTP login.",
            });
        }

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
            [USER_OTP_TYPE, String(otp), "0", resolvedUsername, otpCountryCode, otpMobile]
        );

        if (!otpRows.length) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP. Please try again.",
            });
        }

        await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", otpRows[0].id]);

        const token_id = await UNIQUE_RANDOM_STRING("tokens", "token_id", { conn });
        const token = RANDOM_STRING(50);
        await conn.query(
            `INSERT INTO tokens
        (token_id, username, token, country_code, mobile, create_date, create_by, create_ip, last_used_date, last_ip, login_method, status, expire_date)
       VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,?,?,CURRENT_TIMESTAMP,?,'mobile','1',DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))`,
            [token_id, resolvedUsername, token, otpCountryCode, otpMobile, resolvedUsername, IP, IP]
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

        const profile = await fetchActiveProfilePayload(conn, resolvedUsername);

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
            profile,
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

router.post("/login/verify-otp", verifyOtpHandler);
router.post("/login/verify", verifyOtpHandler);
router.post("/login/email", verifyOtpHandler);

router.post("/register/send-otp", async (req, res) => {
    let conn;

    try {
        const { name, email, mobile, template_id, config_id } = req.body ?? {};
        const trimmedName = String(name || "").trim();

        if (!trimmedName) {
            return res.status(400).json({
                success: false,
                message: "Full name is required.",
            });
        }

        const contact = validateRegistrationContact({ email, mobile });
        if (!contact.ok) {
            return res.status(400).json({
                success: false,
                message: contact.message,
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const existingUser = await findExistingUser(conn, {
            email: contact.email,
            mobile: contact.mobile,
        });

        if (existingUser) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: "An account with this email or mobile already exists. Please login instead.",
            });
        }

        const otp_id = await UNIQUE_RANDOM_STRING("otps", "otp_id", { conn });
        const otp = generateOtp(6);
        const remark = JSON.stringify({
            name: trimmedName,
            email: contact.email,
            mobile: contact.mobile,
        });

        await conn.execute(
            "UPDATE otps SET status = ? WHERE username = ? AND type = ? AND status = ?",
            ["1", contact.otpKey, REGISTER_OTP_TYPE, "0"]
        );

        await conn.execute(
            `INSERT INTO otps
         (otp_id, type, otp, username, country_code, mobile, create_date, expire_date, status, remark)
        VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE),?,?)`,
            [
                otp_id,
                REGISTER_OTP_TYPE,
                otp,
                contact.otpKey,
                contact.mobile ? normalizeCountryCode("+91") : null,
                contact.mobile || null,
                "0",
                remark,
            ]
        );

        const [otpMeta] = await conn.query(
            "SELECT expire_date FROM otps WHERE otp_id = ? ORDER BY id DESC LIMIT 1",
            [otp_id]
        );

        await conn.commit();

        try {
            await sendSmsOtp(contact.mobile, otp, { template_id, config_id });
        } catch (deliveryErr) {
            console.error("REGISTER OTP SEND ERROR:", deliveryErr?.response?.data || deliveryErr?.message || deliveryErr);
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP to your mobile number. Please try again.",
            });
        }

        return res.status(200).json({
            success: true,
            message: "OTP sent successfully to your mobile number.",
            expire: FORMAT_DATE(otpMeta?.[0]?.expire_date) ?? null,
            channel: "mobile",
        });
    } catch (err) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) { }
        }

        console.error("REGISTER SEND OTP ERROR:", err?.message || err);
        return res.status(500).json({
            success: false,
            message: "Failed to send OTP",
        });
    } finally {
        if (conn) conn.release();
    }
});

router.post("/register/verify-otp", async (req, res) => {
    let conn;

    try {
        const { name, email, mobile, otp } = req.body ?? {};
        const trimmedName = String(name || "").trim();

        if (!trimmedName) {
            return res.status(400).json({
                success: false,
                message: "Full name is required.",
            });
        }

        if (!otp) {
            return res.status(400).json({
                success: false,
                message: "OTP is required.",
            });
        }

        const contact = validateRegistrationContact({ email, mobile });
        if (!contact.ok) {
            return res.status(400).json({
                success: false,
                message: contact.message,
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const existingUser = await findExistingUser(conn, {
            email: contact.email,
            mobile: contact.mobile,
        });

        if (existingUser) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: "An account with this email or mobile already exists. Please login instead.",
            });
        }

        const [otpRows] = await conn.query(
            `SELECT id, remark
             FROM otps
            WHERE username = ?
              AND type = ?
              AND otp = ?
              AND status = ?
              AND expire_date >= CURRENT_TIMESTAMP
            ORDER BY id DESC
            LIMIT 1`,
            [contact.otpKey, REGISTER_OTP_TYPE, String(otp), "0"]
        );

        if (!otpRows.length) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP. Please try again.",
            });
        }

        const matchedOtpId = otpRows[0].id;

        const username = await UNIQUE_RANDOM_STRING("users", "username", {
            conn,
            prefix: "usr_",
            length: ID_LENGTH,
        });
        const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", { conn });

        await conn.query(
            `INSERT INTO users (username, create_by, status, remark, create_date)
             VALUES (?, ?, '1', ?, NOW())`,
            [username, username, "Self registration"]
        );

        await conn.query(
            `INSERT INTO profile (profile_id, username, create_by, user_type, name, mobile, country_code, email, status, create_date)
             VALUES (?, ?, ?, 'user', ?, ?, '+91', ?, '1', NOW())`,
            [
                profile_id,
                username,
                username,
                trimmedName,
                contact.mobile,
                contact.email,
            ]
        );

        if (matchedOtpId) {
            await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", matchedOtpId]);
        }

        const IP = req.ip;
        const token_id = await UNIQUE_RANDOM_STRING("tokens", "token_id", { conn });
        const token = RANDOM_STRING(50);

        await conn.query(
            `INSERT INTO tokens
        (token_id, username, token, country_code, mobile, create_date, create_by, create_ip, last_used_date, last_ip, login_method, status, expire_date)
       VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,?,?,CURRENT_TIMESTAMP,?,'mobile','1',DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))`,
            [
                token_id,
                username,
                token,
                contact.mobile ? normalizeCountryCode("+91") : null,
                contact.mobile || null,
                username,
                IP,
                IP,
            ]
        );

        const [tokenMeta] = await conn.query(
            "SELECT expire_date FROM tokens WHERE token_id = ? LIMIT 1",
            [token_id]
        );

        await conn.commit();

        const profile =
            (await fetchActiveProfilePayload(conn, username)) ||
            buildProfilePayloadFromContact({
                username,
                name: trimmedName,
                email: contact.email,
                mobile: contact.mobile,
                countryCode: contact.mobile ? normalizeCountryCode("+91") : null,
            });

        return res.status(201).json({
            success: true,
            message: "Registration successful",
            username,
            token,
            expire_date: FORMAT_DATE(tokenMeta?.[0]?.expire_date) ?? null,
            branches: [],
            profile,
            is_new_user: true,
        });
    } catch (err) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) { }
        }

        console.error("REGISTER VERIFY OTP ERROR:", err?.message || err);
        return res.status(500).json({
            success: false,
            message: "Registration failed. Please try again.",
        });
    } finally {
        if (conn) conn.release();
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

        // Check if user exists by active profile email
        const existingUser = await findSoftwareUserByEmail(conn, email);

        let finalUsername;
        let isNewUser = false;

        if (!existingUser) {
            finalUsername = await UNIQUE_RANDOM_STRING("users", "username", {
                conn,
                prefix: "usr_",
                length: ID_LENGTH,
            });
            const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", { conn });

            console.log('📝 Creating new user:', { finalUsername, email });

            await conn.query(
                `INSERT INTO users (username, create_by, status, remark, create_date)
                 VALUES (?, ?, '1', ?, NOW())`,
                [finalUsername, finalUsername, "Google Login Auto-Register"]
            );

            await conn.query(
                `INSERT INTO profile (profile_id, username, create_by, user_type, name, email, status, create_date)
                 VALUES (?, ?, ?, 'user', ?, ?, '1', NOW())`,
                [profile_id, finalUsername, finalUsername, name, email]
            );

            console.log('✅ User created successfully');
            isNewUser = true;
        } else {
            finalUsername = existingUser.username;
            console.log('👤 Existing user found:', finalUsername);
        }

        // ✅ Generate session token
        const sessionToken = RANDOM_STRING(50);
        const tokenId = await UNIQUE_RANDOM_STRING("tokens", "token_id", { conn });
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

        const profile =
            (await fetchActiveProfilePayload(conn, finalUsername)) ||
            buildProfilePayloadFromContact({
                username: finalUsername,
                name,
                email,
            });

        console.log('🏢 Branches found:', branches.length);

        // ✅ Return response matching frontend expectations
        return res.status(200).json({
            success: true,
            message: isNewUser ? "Account created successfully" : "Login successful",
            username: finalUsername,
            token: sessionToken,
            profile,
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
