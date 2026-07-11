const ONESAAS_UPLOAD_URL =
    process.env.ONESAAS_UPLOAD_URL || "https://upload.onesaas.in/api/upload";
const ONESAAS_UPLOAD_KEY = process.env.ONESAAS_UPLOAD_KEY || "onedevelopers";

export async function uploadBufferToOneSaas({ buffer, filename, mimeType = "application/pdf" }) {
    if (!buffer?.length) {
        throw new Error("No file buffer to upload");
    }

    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append("file", blob, filename);

    const response = await fetch(ONESAAS_UPLOAD_URL, {
        method: "POST",
        headers: {
            key: ONESAAS_UPLOAD_KEY,
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
