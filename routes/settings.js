import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { TODAY_DATE } from "../helpers/function.js";
import {
    deleteBranchAsset,
    downloadAndUploadBranchLogo,
    downloadAndUploadBranchSign,
} from "../helpers/b2Storage.js";
import { buildBranchLogoUrl, buildBranchSignUrl } from "../helpers/mediaUrl.js";

const router = express.Router();

const isVerifiedFlag = (value) => value === "1" || value === 1 || value === true;

function formatBranchDetailsPayload(row) {
    const {
        name,
        legal_name,
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
        is_pan_verified,
        is_gst_verified,
    } = row;

    return {
        basic: {
            name,
            legal_name: legal_name || null,
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
                is_pan_verified: isVerifiedFlag(is_pan_verified),
                pan,
            },
            gst: {
                gst,
                is_gst_verified: isVerifiedFlag(is_gst_verified),
            },
        },
        image: {
            logo: buildBranchLogoUrl(logo),
            sign: buildBranchSignUrl(sign),
        },
        invoice: {
            address: invoice_address,
        },
    };
}

async function getBranchRow(branch_id) {
    const [rows] = await pool.query(
        "SELECT * FROM `branch_list` WHERE `branch_id` = ? AND `is_deleted` = '0'",
        [branch_id]
    );
    return rows?.[0] || null;
}

router.get("/branch/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const branch = await getBranchRow(branch_id);
        if (!branch) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        return res.status(200).json({
            success: true,
            message: "Branch details retrieved successfully",
            data: formatBranchDetailsPayload(branch),
        });
    } catch (error) {
        console.error("Branch details GET error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve branch details",
            error: error.message,
        });
    }
});

async function updateBranchDetailsHandler(req, res) {
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

        const existing = await getBranchRow(branch_id);
        if (!existing) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        const panVerified = isVerifiedFlag(existing.is_pan_verified);
        const gstVerified = isVerifiedFlag(existing.is_gst_verified);

        if (panVerified && panData.pan !== undefined && String(panData.pan || "") !== String(existing.pan || "")) {
            return res.status(400).json({
                success: false,
                message: "PAN is verified and cannot be updated",
            });
        }

        if (gstVerified && gstData.gst !== undefined && String(gstData.gst || "") !== String(existing.gst || "")) {
            return res.status(400).json({
                success: false,
                message: "GST is verified and cannot be updated",
            });
        }

        const nextPan = panVerified ? existing.pan : (panData.pan ?? existing.pan ?? null);
        const nextGst = gstVerified ? existing.gst : (gstData.gst ?? existing.gst ?? null);

        await pool.query(
            `UPDATE \`branch_list\`
             SET
                \`name\` = ?,
                \`legal_name\` = ?,
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
                \`invoice_address\` = ?,
                \`modify_by\` = ?,
                \`modify_date\` = ?
             WHERE \`branch_id\` = ? AND \`is_deleted\` = '0'`,
            [
                body.name ?? existing.name ?? null,
                body.legal_name ?? existing.legal_name ?? null,
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
                nextPan,
                nextGst,
                invoice.address ?? existing.invoice_address ?? null,
                caller || null,
                TODAY_DATE(),
                branch_id,
            ]
        );

        const updated = await getBranchRow(branch_id);

        return res.status(200).json({
            success: true,
            message: "Branch details updated successfully",
            data: formatBranchDetailsPayload(updated),
        });
    } catch (error) {
        console.error("Branch details UPDATE error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update branch details",
            error: error.message,
        });
    }
}

router.put("/branch/details", auth, validateBranch, updateBranchDetailsHandler);
router.put("/branch/update", auth, validateBranch, updateBranchDetailsHandler);

router.post("/branch/logo", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");
        const logoUrl = req.body?.logo;

        const existing = await getBranchRow(branch_id);
        if (!existing) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        const uploaded = await downloadAndUploadBranchLogo(logoUrl, branch_id);

        await pool.query(
            "UPDATE `branch_list` SET `logo` = ?, `modify_by` = ?, `modify_date` = ? WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [uploaded.filename, caller || null, TODAY_DATE(), branch_id]
        );

        // Clean up any legacy random filename that is no longer used.
        if (existing.logo && existing.logo !== uploaded.filename) {
            try {
                await deleteBranchAsset("logo", existing.logo);
            } catch (cleanupError) {
                console.warn("Failed to delete previous branch logo from B2:", cleanupError?.message || cleanupError);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Branch logo updated successfully",
            data: {
                logo: buildBranchLogoUrl(uploaded.filename),
            },
        });
    } catch (error) {
        console.error("Branch logo POST error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to upload branch logo",
            error: error.message,
        });
    }
});

router.post("/branch/sign", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");
        const signUrl = req.body?.sign;

        const existing = await getBranchRow(branch_id);
        if (!existing) {
            return res.status(404).json({ success: false, message: "Branch not found" });
        }

        const uploaded = await downloadAndUploadBranchSign(signUrl, branch_id);

        await pool.query(
            "UPDATE `branch_list` SET `sign` = ?, `modify_by` = ?, `modify_date` = ? WHERE `branch_id` = ? AND `is_deleted` = '0'",
            [uploaded.filename, caller || null, TODAY_DATE(), branch_id]
        );

        if (existing.sign && existing.sign !== uploaded.filename) {
            try {
                await deleteBranchAsset("sign", existing.sign);
            } catch (cleanupError) {
                console.warn("Failed to delete previous branch sign from B2:", cleanupError?.message || cleanupError);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Branch sign updated successfully",
            data: {
                sign: buildBranchSignUrl(uploaded.filename),
            },
        });
    } catch (error) {
        console.error("Branch sign POST error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to upload branch sign",
            error: error.message,
        });
    }
});

router.post("/branch/invoice-address", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "");
        const address = req.body?.address;

        const existing = await getBranchRow(branch_id);
        if (!existing) {
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
                address,
            },
        });
    } catch (error) {
        console.error("Branch invoice address POST error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to upload branch invoice address",
            error: error.message,
        });
    }
});

export default router;
