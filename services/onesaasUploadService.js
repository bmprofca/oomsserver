import { getPlatformSetting } from "../helpers/platformSettings.js";

/** OneSaaS public upload. URL and key come from platform settings (ADMIN → Platform Settings). */
function getUploadUrl() {
    return String(getPlatformSetting("ONESAAS_UPLOAD_URL") || "").trim();
}

function getUploadKey() {
    return String(getPlatformSetting("ONESAAS_UPLOAD_KEY") || "").trim();
}

export async function uploadBufferToOneSaas({ buffer, filename, mimeType = "application/pdf" }) {
    if (!buffer?.length) {
        throw new Error("No file buffer to upload");
    }

    const uploadUrl = getUploadUrl();
    const uploadKey = getUploadKey();
    if (!uploadUrl) {
        throw new Error("OneSaaS upload URL is not configured (Admin → Platform Settings)");
    }
    if (!uploadKey) {
        throw new Error("OneSaaS upload key is not configured (Admin → Platform Settings)");
    }

    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append("file", blob, filename);

    const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
            key: uploadKey,
        },
        body: formData,
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result?.success || !result?.url) {
        throw new Error(result?.message || "Upload to OneSaaS failed");
    }

    return {
        url: result.url,
        meta: result.meta || null,
    };
}
