import express from "express";
import { poolQuery } from "../db.js";
import { readFileSync } from "fs";
import { auth, validateBranch } from "../middleware/auth.js";
import {
    SMS_CHANNEL_DISABLED,
    SMS_CHANNEL_FAST2SMS,
    normalizeSmsChannel,
    smsChannelLabel,
} from "../helpers/smsChannel.js";
import { emailTemplateTypeCandidates, formatEmailTemplateType } from "../helpers/emailStaticTemplateTypes.js";

const router = express.Router();
const statesAndDistricts = JSON.parse(
    readFileSync(new URL("../media/utils/states-and-districts.json", import.meta.url), "utf8")
);
const FIRM_TYPES = [
    { value: "individual", label: "Individual" },
    { value: "partnership firm", label: "Partnership Firm" },
    { value: "limited liability partnership", label: "Limited Liability Partnership (LLP)" },
    { value: "one person company", label: "One Person Company (OPC)" },
    { value: "private limited company", label: "Private Limited Company" },
    { value: "public limited company", label: "Public Limited Company" },
    { value: "section 8 company", label: "Section 8 Company" },
    { value: "hindu undivided family", label: "Hindu Undivided Family (HUF)" },
    { value: "trust", label: "Trust" },
    { value: "society", label: "Society" },
    { value: "cooperative society", label: "Cooperative Society" },
    { value: "producer company", label: "Producer Company" },
    { value: "government department", label: "Government Department" },
    { value: "public sector undertaking", label: "Public Sector Undertaking (PSU)" },
    { value: "statutory corporation", label: "Statutory Corporation" },
    { value: "local authority", label: "Local Authority" },
    { value: "foreign company", label: "Foreign Company" },
    { value: "branch office", label: "Branch Office" },
    { value: "liaison office", label: "Liaison Office" },
    { value: "joint venture", label: "Joint Venture (JV)" },
    { value: "artificial judicial person", label: "Artificial Judicial Person" },
    { value: "other", label: "Other" },
];

const WHATSAPP_CHANNELS = ["disabled", "ooms system", "ooms web", "onechatting"];

function normalizeNotificationType(typeRaw) {
    return formatEmailTemplateType(typeRaw).toLowerCase();
}

/** Alternate template names used across email / SMS / WhatsApp for the same intent. */
function notificationTypeCandidates(notificationType) {
    const emailCandidates = emailTemplateTypeCandidates(notificationType);
    if (emailCandidates.length) return emailCandidates;

    const primary = String(notificationType || "").trim().toLowerCase();
    if (!primary) return [];
    return [
        primary,
        primary.replace(/ /g, "_"),
        primary.replace(/ /g, "-"),
    ];
}

function channelResult(available, reason = "", extra = {}) {
    return {
        available: Boolean(available),
        reason: available ? "" : (reason || "Not available"),
        ...(extra && typeof extra === "object" ? extra : {}),
    };
}

const WHATSAPP_CHANNEL_LABELS = {
    onechatting: "OneChatting",
    "ooms web": "WhatsApp Web",
    "ooms system": "OOMS System",
};

function whatsappChannelLabel(channel) {
    const key = String(channel || "").trim().toLowerCase();
    return WHATSAPP_CHANNEL_LABELS[key] || key || "";
}

async function checkSmsAvailability(branch_id) {
    try {
        const [[branchRow]] = await poolQuery(
            `SELECT sms_channel
             FROM branch_list
             WHERE branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [branch_id]
        );
        if (!branchRow) {
            return channelResult(false, "Branch not found");
        }

        const channel = normalizeSmsChannel(branchRow.sms_channel);
        if (channel === SMS_CHANNEL_DISABLED) {
            return channelResult(false, "SMS channel is disabled");
        }

        if (channel === SMS_CHANNEL_FAST2SMS) {
            const [[config]] = await poolQuery(
                `SELECT config_id
                 FROM sms_fast2sms_configs
                 WHERE branch_id = ?
                   AND status = 'active'
                   AND auth_token_encrypted IS NOT NULL
                   AND TRIM(auth_token_encrypted) <> ''
                 LIMIT 1`,
                [branch_id]
            );
            if (!config?.config_id) {
                return channelResult(false, "Fast2SMS is not configured");
            }
            return channelResult(true, "", {
                channel,
                channel_label: smsChannelLabel(channel),
                detail: smsChannelLabel(channel),
            });
        }

        return channelResult(false, "Invalid SMS channel configuration");
    } catch (error) {
        console.error("SMS availability check error:", error);
        return channelResult(false, "Unable to validate SMS availability");
    }
}

async function checkEmailAvailability(branch_id, notificationType) {
    try {
        const [[activeConfig]] = await poolQuery(
            `SELECT config_id, config_name
             FROM email_configs
             WHERE branch_id = ? AND status = 'active'
             ORDER BY id DESC
             LIMIT 1`,
            [branch_id]
        );
        if (!activeConfig?.config_id) {
            return channelResult(false, "Email config is not active");
        }

        const typeCandidates = notificationTypeCandidates(notificationType);
        const [[activeTemplate]] = await poolQuery(
            `SELECT template_id
             FROM email_static_templates
             WHERE branch_id = ?
               AND status = 'active'
               AND LOWER(TRIM(template_type)) IN (${typeCandidates.map(() => "?").join(", ")})
             ORDER BY id DESC
             LIMIT 1`,
            [branch_id, ...typeCandidates]
        );

        const hasTemplate = Boolean(activeTemplate?.template_id);

        if (!hasTemplate) {
            return channelResult(false, `Email template is not configured for type '${notificationType}'`);
        }

        const smtpName = String(activeConfig.config_name || "").trim();
        return channelResult(true, "", {
            smtp_name: smtpName,
            config_name: smtpName,
            detail: smtpName || "SMTP",
        });
    } catch (error) {
        console.error("Email availability check error:", error);
        return channelResult(false, "Unable to validate email availability");
    }
}

async function checkWhatsappAvailability(branch_id, notificationType) {
    try {
        const [[branchRow]] = await poolQuery(
            `SELECT whatsapp_channel, onechatting_developer_token
             FROM branch_list
             WHERE branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [branch_id]
        );

        if (!branchRow) {
            return channelResult(false, "Branch not found");
        }

        const channel = String(branchRow.whatsapp_channel || "disabled").trim().toLowerCase();
        if (!WHATSAPP_CHANNELS.includes(channel)) {
            return channelResult(false, "Invalid WhatsApp channel configuration");
        }
        if (channel === "disabled") {
            return channelResult(false, "WhatsApp channel is disabled");
        }

        const channelMeta = {
            channel,
            channel_label: whatsappChannelLabel(channel),
            detail: whatsappChannelLabel(channel),
        };

        if (channel === "onechatting") {
            const developerToken = String(branchRow.onechatting_developer_token || "").trim();
            if (!developerToken) {
                return channelResult(false, "OneChatting developer token is not configured");
            }

            const [[userTokenRow]] = await poolQuery(
                `SELECT map_id
                 FROM branch_mapping
                 WHERE branch_id = ?
                   AND is_deleted = '0'
                   AND onechatting_enabled = '1'
                   AND onechatting_token IS NOT NULL
                   AND TRIM(onechatting_token) <> ''
                 LIMIT 1`,
                [branch_id]
            );
            if (!userTokenRow?.map_id) {
                return channelResult(false, "No enabled OneChatting user token found");
            }

            const typeCandidates = notificationTypeCandidates(notificationType);
            const [[mapping]] = await poolQuery(
                `SELECT map_id
                 FROM onechatting_template_mapping
                 WHERE branch_id = ?
                   AND status = 1
                   AND LOWER(TRIM(template)) IN (${typeCandidates.map(() => "?").join(", ")})
                   AND onechatting_template_name IS NOT NULL
                   AND TRIM(onechatting_template_name) <> ''
                 LIMIT 1`,
                [branch_id, ...typeCandidates]
            );
            if (!mapping?.map_id) {
                return channelResult(false, `OneChatting template mapping missing for type '${notificationType}'`);
            }
            return channelResult(true, "", channelMeta);
        }

        if (channel === "ooms web") {
            const typeCandidates = notificationTypeCandidates(notificationType);
            const [[templateRow]] = await poolQuery(
                `SELECT template_id
                 FROM whatsappweb_template_mapping
                 WHERE branch_id = ?
                   AND status = 'active'
                   AND LOWER(TRIM(template_name)) IN (${typeCandidates.map(() => "?").join(", ")})
                   AND content_json IS NOT NULL
                   AND TRIM(content_json) <> ''
                 LIMIT 1`,
                [branch_id, ...typeCandidates]
            );
            if (!templateRow?.template_id) {
                return channelResult(false, `WhatsApp Web template mapping missing for type '${notificationType}'`);
            }
            return channelResult(true, "", channelMeta);
        }

        if (channel === "ooms system") {
            const typeCandidates = notificationTypeCandidates(notificationType);
            const [[mapping]] = await poolQuery(
                `SELECT map_id
                 FROM wp_system_template_mapping
                 WHERE branch_id = ?
                   AND status = 1
                   AND LOWER(TRIM(type)) IN (${typeCandidates.map(() => "?").join(", ")})
                 LIMIT 1`,
                [branch_id, ...typeCandidates]
            );
            if (!mapping?.map_id) {
                return channelResult(false, `OOMS system template mapping missing for type '${notificationType}'`);
            }
            return channelResult(true, "", channelMeta);
        }

        return channelResult(false, "Unsupported WhatsApp channel");
    } catch (error) {
        console.error("WhatsApp availability check error:", error);
        return channelResult(false, "Unable to validate WhatsApp availability");
    }
}


router.get("/assisment-years", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: [
            "2026-2027",
            "2025-2026",
            "2024-2025",
            "2023-2024",
            "2022-2023",
            "2021-2022",
            "2020-2021",
            "2019-2020",
            "2018-2019",
            "2017-2018",
            "2016-2017"
        ]
    });
});

router.get("/financial-years", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: [
            "2025-2026",
            "2024-2025",
            "2023-2024",
            "2022-2023",
            "2021-2022",
            "2020-2021",
            "2019-2020",
            "2018-2019",
            "2017-2018",
            "2016-2017"
        ]
    });
});

router.get("/states-and-districts", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: statesAndDistricts
    });
});

router.get("/firm-types", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: FIRM_TYPES,
    });
});

router.get("/care-of-types", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: [
            "S/O",
            "W/O",
            "D/O",
            "C/O",
            "H/O"
        ]
    });
});

router.get("/notification-availability", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const typeRaw = req.query?.type;
        const notificationType = normalizeNotificationType(typeRaw);

        if (!notificationType) {
            return res.status(400).json({
                success: false,
                message: "type is required",
            });
        }

        const sms = await checkSmsAvailability(branch_id, notificationType);
        const whatsapp = await checkWhatsappAvailability(branch_id, notificationType);
        const email = await checkEmailAvailability(branch_id, notificationType);

        const channels = { sms, whatsapp, email };
        const available = sms.available || whatsapp.available || email.available;
        const reasons = Object.entries(channels)
            .filter(([, result]) => !result.available && result.reason)
            .map(([channel, result]) => `${channel}: ${result.reason}`);

        return res.status(200).json({
            success: true,
            data: {
                type: notificationType,
                available,
                reason: available ? "" : (reasons.join(" | ") || "No channel is available"),
                channels,
            },
        });
    } catch (error) {
        console.error("Notification availability check error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to check notification availability",
            error: error.message,
        });
    }
});

export default router;