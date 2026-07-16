import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";
import { downloadAndUploadProfileImage } from "../helpers/b2Storage.js";
import { buildProfileImageUrl } from "../helpers/mediaUrl.js";
import { FORMAT_DATE, UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import { generateOtp, sendSmsOtp } from "../helpers/smsOtp.js";
import { SendMail } from "../helpers/Mail.js";
import { APP_NAME } from "../helpers/Config.js";
import {
    CONTACT_CHANGE_OTP_TYPE,
    findSoftwareUserByEmail,
    findSoftwareUserByMobile,
} from "../helpers/authProfile.js";
import { normalizeCountryCode, normalizeMobileDigits } from "../helpers/clientPhone.js";

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_REGEX = /^\d{10}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const GENDERS = new Set(["male", "female", "other"]);

function getSessionUsername(req) {
    return String(req.headers["username"] || req.headers["Username"] || "").trim();
}

function toDateOnly(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, "0");
        const d = String(value.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
}

function trimOrNull(value) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed === "" ? null : trimmed;
}

function normalizeMobile(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return null;
    return digits.slice(-10);
}

function normalizeEmail(value) {
    const trimmed = trimOrNull(value);
    return trimmed ? trimmed.toLowerCase() : null;
}

function formatProfilePayload(row) {
    return {
        profile_id: row.profile_id ?? null,
        username: row.username ?? null,
        user_type: row.user_type ?? null,
        name: row.name ?? null,
        care_of: row.care_of ?? null,
        guardian_name: row.guardian_name ?? null,
        date_of_birth: toDateOnly(row.date_of_birth),
        gender: row.gender ?? null,
        country_code: row.country_code ?? "+91",
        mobile: row.mobile ?? null,
        email: row.email ?? null,
        pan_number: row.pan_number ?? null,
        country: row.country ?? "India",
        state: row.state ?? null,
        city: row.city ?? null,
        district: row.district ?? null,
        village_town: row.village_town ?? null,
        address_line_1: row.address_line_1 ?? null,
        address_line_2: row.address_line_2 ?? null,
        pincode: row.pincode ?? null,
        image: buildProfileImageUrl(row.image),
        image_filename: row.image ?? null,
        status: row.status ?? null,
        create_date: row.create_date ?? null,
    };
}

async function getActiveProfileRow(username) {
    const [rows] = await pool.query(
        `SELECT *
         FROM profile
         WHERE username = ?
           AND status = '1'
         ORDER BY id DESC
         LIMIT 1`,
        [username]
    );
    return rows?.[0] || null;
}

function resolveContactChangeField(existing, nextEmail, nextMobile) {
    const emailChanged =
        normalizeEmail(existing.email) !== normalizeEmail(nextEmail);
    const mobileChanged =
        normalizeMobile(existing.mobile) !== normalizeMobile(nextMobile);

    if (emailChanged && mobileChanged) return "both";
    if (emailChanged) return "email";
    if (mobileChanged) return "mobile";
    return null;
}

function contactChangeRemark(field) {
    if (field === "email") return "email_change";
    if (field === "mobile") return "mobile_change";
    if (field === "both") return "email_mobile_change";
    return "contact_change";
}

async function invalidateContactChangeOtps(conn, username) {
    await conn.execute(
        `UPDATE otps
         SET status = ?
         WHERE username = ?
           AND type = ?
           AND status = ?`,
        ["1", username, CONTACT_CHANGE_OTP_TYPE, "0"]
    );
}

async function checkContactChangeOtp(conn, { username, otp, field }) {
    const remark = contactChangeRemark(field);
    const [otpRows] = await conn.query(
        `SELECT id
         FROM otps
         WHERE type = ?
           AND otp = ?
           AND status = ?
           AND username = ?
           AND remark = ?
           AND expire_date >= CURRENT_TIMESTAMP
         ORDER BY id DESC
         LIMIT 1`,
        [CONTACT_CHANGE_OTP_TYPE, String(otp), "0", username, remark]
    );
    return otpRows[0]?.id || null;
}

async function consumeContactChangeOtp(conn, { username, otp, field }) {
    const otpId = await checkContactChangeOtp(conn, { username, otp, field });
    if (!otpId) {
        return false;
    }
    await conn.query("UPDATE otps SET status = ? WHERE id = ?", ["1", otpId]);
    return true;
}

async function assertContactAvailable(conn, { username, email, mobile, countryCode }) {
    if (email) {
        const existingEmail = await findSoftwareUserByEmail(conn, email);
        if (existingEmail && existingEmail.username !== username) {
            return { ok: false, message: "This email is already registered to another account." };
        }
    }

    if (mobile) {
        const existingMobile = await findSoftwareUserByMobile(conn, countryCode, mobile);
        if (existingMobile && existingMobile.username !== username) {
            return { ok: false, message: "This mobile number is already registered to another account." };
        }
    }

    return { ok: true };
}

router.get("/profile", auth, async (req, res) => {
    try {
        const username = getSessionUsername(req);

        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Session expired",
            });
        }

        const profile = await getActiveProfileRow(username);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: "Profile not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Profile retrieved successfully",
            data: formatProfilePayload(profile),
        });
    } catch (error) {
        console.error("ACCOUNT PROFILE GET error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve profile",
            error: error.message,
        });
    }
});

router.post("/profile/contact/send-otp", auth, async (req, res) => {
    let conn;

    try {
        const username = getSessionUsername(req);
        const field = String(req.body?.field || "").trim().toLowerCase();

        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Session expired",
            });
        }

        if (!["email", "mobile", "both"].includes(field)) {
            return res.status(400).json({
                success: false,
                message: "field must be one of: email, mobile, both",
            });
        }

        const profile = await getActiveProfileRow(username);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: "Profile not found",
            });
        }

        const countryCode = normalizeCountryCode(profile.country_code || "+91");
        const currentMobile = normalizeMobileDigits(profile.mobile);
        const currentEmail = normalizeEmail(profile.email);

        if ((field === "email" || field === "both") && (!currentMobile || !MOBILE_REGEX.test(currentMobile))) {
            return res.status(400).json({
                success: false,
                message: "A registered mobile number is required to verify email changes.",
            });
        }

        if ((field === "mobile" || field === "both") && (!currentEmail || !EMAIL_REGEX.test(currentEmail))) {
            return res.status(400).json({
                success: false,
                message: "A registered email address is required to verify mobile changes.",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        await invalidateContactChangeOtps(conn, username);

        const otp_id = await UNIQUE_RANDOM_STRING("otps", "otp_id", { conn });
        const otp = generateOtp(6);
        const remark = contactChangeRemark(field);

        await conn.execute(
            `INSERT INTO otps
             (otp_id, type, otp, username, country_code, mobile, create_date, expire_date, status, remark)
             VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE),?,?)`,
            [
                otp_id,
                CONTACT_CHANGE_OTP_TYPE,
                otp,
                username,
                countryCode,
                currentMobile,
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
            if (field === "mobile") {
                await SendMail({
                    to: currentEmail,
                    subject: `${APP_NAME} — verify mobile change`,
                    html: `<p>Your OTP to change your mobile number is <strong>${otp}</strong>.</p><p>This code expires in 5 minutes.</p>`,
                });
            } else {
                await sendSmsOtp(currentMobile, otp);
            }
        } catch (deliveryError) {
            console.error("CONTACT CHANGE OTP SEND ERROR:", deliveryError?.message || deliveryError);
            return res.status(500).json({
                success: false,
                message:
                    field === "mobile"
                        ? "Failed to send OTP to your registered email. Please try again."
                        : "Failed to send OTP to your registered mobile number. Please try again.",
            });
        }

        return res.status(200).json({
            success: true,
            message:
                field === "mobile"
                    ? "OTP sent to your registered email address."
                    : "OTP sent to your registered mobile number.",
            channel: field === "mobile" ? "email" : "mobile",
            destination_masked:
                field === "mobile"
                    ? maskEmail(currentEmail)
                    : `******${currentMobile.slice(-4)}`,
            expire: FORMAT_DATE(otpMeta?.[0]?.expire_date) ?? null,
        });
    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {}
        }
        console.error("ACCOUNT CONTACT SEND OTP error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to send OTP",
            error: error.message,
        });
    } finally {
        if (conn) conn.release();
    }
});

router.post("/profile/contact/verify-otp", auth, async (req, res) => {
    let conn;

    try {
        const username = getSessionUsername(req);
        const field = String(req.body?.field || "").trim().toLowerCase();
        const otp = String(req.body?.otp || "").trim();

        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Session expired",
            });
        }

        if (!["email", "mobile", "both"].includes(field)) {
            return res.status(400).json({
                success: false,
                message: "field must be one of: email, mobile, both",
            });
        }

        if (!otp) {
            return res.status(400).json({
                success: false,
                message: "OTP is required",
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const verified = await checkContactChangeOtp(conn, { username, otp, field });
        if (!verified) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP. Please try again.",
            });
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "OTP verified successfully",
            field,
        });
    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {}
        }
        console.error("ACCOUNT CONTACT VERIFY OTP error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to verify OTP",
            error: error.message,
        });
    } finally {
        if (conn) conn.release();
    }
});

function maskEmail(email) {
    const value = String(email || "");
    const [local, domain] = value.split("@");
    if (!local || !domain) return "******";
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}***@${domain}`;
}

router.put("/profile", auth, async (req, res) => {
    let conn;

    try {
        const username = getSessionUsername(req);
        const body = req.body || {};

        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Session expired",
            });
        }

        const existing = await getActiveProfileRow(username);
        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Profile not found",
            });
        }

        const next = {
            name: body.name !== undefined ? trimOrNull(body.name) : existing.name,
            care_of: body.care_of !== undefined ? trimOrNull(body.care_of) : existing.care_of,
            guardian_name:
                body.guardian_name !== undefined
                    ? trimOrNull(body.guardian_name)
                    : existing.guardian_name,
            date_of_birth:
                body.date_of_birth !== undefined
                    ? toDateOnly(body.date_of_birth)
                    : toDateOnly(existing.date_of_birth),
            gender:
                body.gender !== undefined
                    ? trimOrNull(body.gender)?.toLowerCase() || null
                    : existing.gender,
            country_code: existing.country_code || "+91",
            mobile:
                body.mobile !== undefined
                    ? normalizeMobile(body.mobile)
                    : normalizeMobile(existing.mobile),
            email:
                body.email !== undefined
                    ? normalizeEmail(body.email)
                    : normalizeEmail(existing.email),
            pan_number:
                body.pan_number !== undefined
                    ? trimOrNull(body.pan_number)?.toUpperCase() || null
                    : existing.pan_number,
            country:
                body.country !== undefined
                    ? trimOrNull(body.country) || "India"
                    : existing.country || "India",
            state: body.state !== undefined ? trimOrNull(body.state) : existing.state,
            city: body.city !== undefined ? trimOrNull(body.city) : existing.city,
            district:
                body.district !== undefined ? trimOrNull(body.district) : existing.district,
            village_town:
                body.village_town !== undefined
                    ? trimOrNull(body.village_town)
                    : existing.village_town,
            address_line_1:
                body.address_line_1 !== undefined
                    ? trimOrNull(body.address_line_1)
                    : existing.address_line_1,
            address_line_2:
                body.address_line_2 !== undefined
                    ? trimOrNull(body.address_line_2)
                    : existing.address_line_2,
            pincode:
                body.pincode !== undefined ? trimOrNull(body.pincode) : existing.pincode,
        };

        if (!next.name) {
            return res.status(400).json({
                success: false,
                message: "Name is required",
            });
        }

        if (next.email && !EMAIL_REGEX.test(next.email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format",
            });
        }

        if (next.mobile && !MOBILE_REGEX.test(next.mobile)) {
            return res.status(400).json({
                success: false,
                message: "Mobile number must be a valid 10-digit number",
            });
        }

        if (next.pan_number && !PAN_REGEX.test(next.pan_number)) {
            return res.status(400).json({
                success: false,
                message: "Invalid PAN number format",
            });
        }

        if (body.date_of_birth !== undefined && body.date_of_birth && !next.date_of_birth) {
            return res.status(400).json({
                success: false,
                message: "Invalid date_of_birth format. Expected YYYY-MM-DD",
            });
        }

        if (next.gender && !GENDERS.has(next.gender)) {
            return res.status(400).json({
                success: false,
                message: "Invalid gender. Must be one of: male, female, other",
            });
        }

        const contactField = resolveContactChangeField(existing, next.email, next.mobile);
        const contactOtp = String(body.contact_otp || "").trim();

        if (contactField && !contactOtp) {
            return res.status(400).json({
                success: false,
                message: "OTP verification is required to change email or mobile.",
                requires_otp: true,
                field: contactField,
            });
        }

        const availability = await assertContactAvailable(pool, {
            username,
            email: next.email,
            mobile: next.mobile,
            countryCode: next.country_code,
        });

        if (!availability.ok) {
            return res.status(400).json({
                success: false,
                message: availability.message,
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        if (contactField) {
            const verified = await consumeContactChangeOtp(conn, {
                username,
                otp: contactOtp,
                field: contactField,
            });

            if (!verified) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    message: "Invalid or expired OTP. Please verify again.",
                    requires_otp: true,
                    field: contactField,
                });
            }
        }

        await conn.query(
            `UPDATE profile
             SET name = ?,
                 care_of = ?,
                 guardian_name = ?,
                 date_of_birth = ?,
                 gender = ?,
                 country_code = ?,
                 mobile = ?,
                 email = ?,
                 pan_number = ?,
                 country = ?,
                 state = ?,
                 city = ?,
                 district = ?,
                 village_town = ?,
                 address_line_1 = ?,
                 address_line_2 = ?,
                 pincode = ?
             WHERE username = ?
               AND status = '1'`,
            [
                next.name,
                next.care_of,
                next.guardian_name,
                next.date_of_birth,
                next.gender,
                next.country_code,
                next.mobile,
                next.email,
                next.pan_number,
                next.country,
                next.state,
                next.city,
                next.district,
                next.village_town,
                next.address_line_1,
                next.address_line_2,
                next.pincode,
                username,
            ]
        );

        await conn.commit();

        const updated = await getActiveProfileRow(username);

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: formatProfilePayload(updated),
        });
    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {}
        }
        console.error("ACCOUNT PROFILE PUT error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update profile",
            error: error.message,
        });
    } finally {
        if (conn) conn.release();
    }
});

router.post("/profile/image", auth, async (req, res) => {
    try {
        const username = getSessionUsername(req);
        const imageUrl = trimOrNull(req.body?.image);

        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Session expired",
            });
        }

        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                message: "Image URL is required",
            });
        }

        const existing = await getActiveProfileRow(username);
        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Profile not found",
            });
        }

        let uploaded;
        try {
            uploaded = await downloadAndUploadProfileImage(imageUrl);
        } catch (imageError) {
            return res.status(400).json({
                success: false,
                message: imageError?.message || "Failed to process profile image",
            });
        }

        await pool.query(
            `UPDATE profile
             SET image = ?
             WHERE username = ?
               AND status = '1'`,
            [uploaded.filename, username]
        );

        const updated = await getActiveProfileRow(username);

        return res.status(200).json({
            success: true,
            message: "Profile image updated successfully",
            data: formatProfilePayload(updated),
        });
    } catch (error) {
        console.error("ACCOUNT PROFILE IMAGE POST error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update profile image",
            error: error.message,
        });
    }
});

export default router;
