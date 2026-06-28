import express from "express";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { RANDOM_STRING, TODAY_DATE } from "../helpers/function.js";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MEDIA_DIR = path.resolve(__dirname, "../media");

const getExtensionFromContentType = (contentType = "") => {
    const normalized = String(contentType).toLowerCase();
    if (normalized.includes("image/jpeg")) return ".jpg";
    if (normalized.includes("image/png")) return ".png";
    if (normalized.includes("image/webp")) return ".webp";
    if (normalized.includes("image/gif")) return ".gif";
    if (normalized.includes("image/svg+xml")) return ".svg";
    return "";
};

const getExtensionFromUrl = (url = "") => {
    try {
        const pathname = new URL(url).pathname;
        const ext = path.extname(pathname || "").toLowerCase();
        if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(ext)) {
            return ext === ".jpeg" ? ".jpg" : ext;
        }
        return "";
    } catch {
        return "";
    }
};

const downloadAndSaveImageFromUrl = async (imageUrl, subFolder) => {
    if (!imageUrl || typeof imageUrl !== "string") {
        throw new Error("A valid image URL is required");
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(imageUrl);
    } catch {
        throw new Error("Invalid image URL");
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only http/https image URLs are allowed");
    }

    const response = await fetch(parsedUrl.toString());
    if (!response.ok) {
        throw new Error(`Unable to fetch image. Status: ${response.status}`);
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (!contentType.toLowerCase().startsWith("image/")) {
        throw new Error("Provided URL does not point to an image");
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer || buffer.length === 0) {
        throw new Error("Fetched image is empty");
    }

    const ext = getExtensionFromContentType(contentType) || getExtensionFromUrl(parsedUrl.toString()) || ".jpg";
    const fileName = `${RANDOM_STRING(30)}.${ext}`;
    const targetDir = path.join(MEDIA_DIR, subFolder);
    const targetPath = path.join(targetDir, fileName);

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, buffer);

    return fileName;
};


router.get("/branch/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");


        const [branch_list_row] = await pool.query("SELECT * FROM `branch_list` WHERE `branch_id` = ? AND `is_deleted` = '0'", [branch_id]);
        if (!branch_list_row || branch_list_row.length === 0) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        const branch_list_data = branch_list_row[0];

        const { name, address_line_1, address_line_2, city, state, country, pincode, mobile_1, mobile_2, email_1, email_2, invoice_address, pan, gst, logo, sign, gst_rate, is_pan_verified, is_gst_verified } = branch_list_data;

        const logo_url = logo ? `${BASE_DOMAIN}/media/logo/${logo}` : null;
        const sign_url = sign ? `${BASE_DOMAIN}/media/sign/${sign}` : null;

        return res.status(200).json({
            success: true,
            message: "Branch details retrieved successfully",
            data: {
                basic: {
                    name,
                    address: {
                        address_line_1,
                        address_line_2,
                        city,
                        state,
                        pincode,
                        country,
                    },
                    mobile: {
                        mobile_1,
                        mobile_2,
                    },
                    email: {
                        email_1,
                        email_2,
                    },
                    pan: {
                        is_pan_verified: is_pan_verified === '1' ? true : false,
                        pan,
                    },
                    gst: {
                        gst,
                        gst_rate,
                        is_gst_verified: is_gst_verified === '1' ? true : false,
                    }
                },
                image: {
                    logo: logo_url,
                    sign: sign_url,
                },
                invoice: {
                    address: invoice_address,
                }
            }
        });
    } catch (error) {
        console.error("Branch details GET error:", error);
        return res.status(500).json({ success: false, message: "Failed to retrieve branch details", error: error.message });
    }
});

router.put("/branch/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");
        const body = req.body || {};
        const address = body.address || {};
        const mobile = body.mobile || {};
        const email = body.email || {};
        const panData = body.pan || {};
        const gstData = body.gst || {};
        const invoice = body.invoice || {};

        const [branch_list_row] = await pool.query(
            "SELECT * FROM `branch_list` WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [branch_id]
        );
        if (!branch_list_row || branch_list_row.length === 0) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        await pool.query(
            `UPDATE \`branch_list\`
             SET
                \`name\` = ?,
                \`address_line_1\` = ?,
                \`address_line_2\` = ?,
                \`city\` = ?,
                \`state\` = ?,
                \`country\` = ?,
                \`pincode\` = ?,
                \`mobile_1\` = ?,
                \`mobile_2\` = ?,
                \`email_1\` = ?,
                \`email_2\` = ?,
                \`pan\` = ?,
                \`gst\` = ?,
                \`gst_rate\` = ?,
                \`invoice_address\` = ?,
                \`modify_by\` = ?,
                \`modify_date\` = ?
             WHERE \`branch_id\` = ? AND \`is_deleted\` = '0'`,
            [
                body.name ?? null,
                address.address_line_1 ?? null,
                address.address_line_2 ?? null,
                address.city ?? null,
                address.state ?? null,
                address.country ?? null,
                address.pincode ?? null,
                mobile.mobile_1 ?? null,
                mobile.mobile_2 ?? null,
                email.email_1 ?? null,
                email.email_2 ?? null,
                panData.pan ?? null,
                gstData.gst ?? null,
                gstData.gst_rate ?? 0,
                invoice.address ?? null,
                caller || null,
                TODAY_DATE(),
                branch_id
            ]
        );

        const [updated_branch_list_row] = await pool.query(
            "SELECT * FROM `branch_list` WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [branch_id]
        );

        const branch_list_data = updated_branch_list_row[0];
        const {
            name,
            address_line_1,
            address_line_2,
            city,
            state,
            country,
            pincode,
            mobile_1,
            mobile_2,
            email_1,
            email_2,
            invoice_address,
            pan,
            gst,
            logo,
            sign,
            gst_rate,
            is_pan_verified,
            is_gst_verified
        } = branch_list_data;

        const logo_url = logo ? `${BASE_DOMAIN}/media/logo/${logo}` : null;
        const sign_url = sign ? `${BASE_DOMAIN}/media/sign/${sign}` : null;

        return res.status(200).json({
            success: true,
            message: "Branch details updated successfully",
            data: {
                basic: {
                    name,
                    address: {
                        address_line_1,
                        address_line_2,
                        city,
                        state,
                        pincode,
                        country,
                    },
                    mobile: {
                        mobile_1,
                        mobile_2,
                    },
                    email: {
                        email_1,
                        email_2,
                    },
                    pan: {
                        is_pan_verified: is_pan_verified === '1' ? true : false,
                        pan,
                    },
                    gst: {
                        gst,
                        gst_rate,
                        is_gst_verified: is_gst_verified === '1' ? true : false,
                    }
                },
                image: {
                    logo: logo_url,
                    sign: sign_url,
                },
                invoice: {
                    address: invoice_address,
                }
            }
        });

    } catch (error) {
        console.error("Branch details UPDATE error:", error);
        return res.status(500).json({ success: false, message: "Failed to update branch details", error: error.message });
    }
});

router.post("/branch/logo", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");
        const body = req.body || {};
        const logoUrl = body.logo;

        const [branch_list_row] = await pool.query(
            "SELECT `branch_id` FROM `branch_list` WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [branch_id]
        );
        if (!branch_list_row || branch_list_row.length === 0) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        const fileName = await downloadAndSaveImageFromUrl(logoUrl, "logo");

        await pool.query(
            "UPDATE `branch_list` SET `logo` = ?, `modify_by` = ?, `modify_date` = ? WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [fileName, caller || null, TODAY_DATE(), branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Branch logo updated successfully",
            data: {
                logo: `${BASE_DOMAIN}/media/logo/${fileName}`,
            },
        });
    } catch (error) {
        console.error("Branch logo POST error:", error);
        return res.status(500).json({ success: false, message: "Failed to upload branch logo", error: error.message });
    }
});

router.post("/branch/sign", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");
        const body = req.body || {};
        const signUrl = body.sign;

        const [branch_list_row] = await pool.query(
            "SELECT `branch_id` FROM `branch_list` WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [branch_id]
        );
        if (!branch_list_row || branch_list_row.length === 0) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        const fileName = await downloadAndSaveImageFromUrl(signUrl, "sign");

        await pool.query(
            "UPDATE `branch_list` SET `sign` = ?, `modify_by` = ?, `modify_date` = ? WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [fileName, caller || null, TODAY_DATE(), branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Branch sign updated successfully",
            data: {
                sign: `${BASE_DOMAIN}/media/sign/${fileName}`,
            },
        });
    } catch (error) {
        console.error("Branch sign POST error:", error);
        return res.status(500).json({ success: false, message: "Failed to upload branch sign", error: error.message });
    }
});

router.post("/branch/invoice-address", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");
        const body = req.body || {};
        const address = body.address;

        const [branch_list_row] = await pool.query(
            "SELECT `branch_id` FROM `branch_list` WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [branch_id]
        );
        if (!branch_list_row || branch_list_row.length === 0) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        await pool.query(
            "UPDATE `branch_list` SET `invoice_address` = ?, `modify_by` = ?, `modify_date` = ? WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [address, caller || null, TODAY_DATE(), branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Branch invoice address updated successfully",
            data: {
                address: address,
            },
        });
    } catch (error) {
        console.error("Branch invoice address POST error:", error);
        return res.status(500).json({ success: false, message: "Failed to upload branch invoice address", error: error.message });
    }
});

export default router;