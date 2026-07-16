import "dotenv/config";
import axios from "axios";
import crypto from "crypto";
import { RANDOM_STRING } from "./function.js";

const B2_BUCKET = process.env.B2_BUCKET || "OOMS-CRM";
const B2_ACCESS_KEY = process.env.B2_ACCESS_KEY || "";
const B2_SECRET_KEY = process.env.B2_SECRET_KEY || "";
const B2_DOWNLOAD_AUTH_TTL_SECONDS = Number(process.env.B2_DOWNLOAD_AUTH_TTL_SECONDS || 86400);

const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024;
const MAX_PROFILE_IMAGE_SIZE = 5 * 1024 * 1024;
const DOCUMENT_BASE_PREFIX = "media/profile/document";
const PROFILE_IMAGE_BASE_PREFIX = "media/profile/image";
const BRANCH_LOGO_BASE_PREFIX = "media/branch/logo";
const BRANCH_SIGN_BASE_PREFIX = "media/branch/sign";
const ALLOWED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
const ALLOWED_IMAGE_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
];
const B2_AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";

const ALLOWED_FILE_EXTENSIONS = [
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
    "mp4", "avi", "mov", "wmv", "flv", "webm", "mkv", "m4v",
    "zip", "rar", "7z", "tar", "gz",
];

const MIME_TO_EXT = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/zip": "zip",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
};

let authCache = null;
let bucketIdCache = null;

function assertB2Credentials() {
    if (!B2_ACCESS_KEY || !B2_SECRET_KEY) {
        throw new Error("B2 storage credentials are not configured");
    }
}

function clearB2Cache() {
    authCache = null;
    bucketIdCache = null;
}

async function b2Post(path, payload, retryOnAuth = true) {
    const auth = await authorizeB2();
    try {
        const response = await axios.post(`${auth.apiUrl}${path}`, payload, {
            headers: { Authorization: auth.authorizationToken },
            timeout: 60000,
        });
        return response.data;
    } catch (error) {
        if (retryOnAuth && error.response?.status === 401) {
            clearB2Cache();
            return b2Post(path, payload, false);
        }
        throw error;
    }
}

async function authorizeB2() {
    assertB2Credentials();

    if (authCache && authCache.expiresAt > Date.now()) {
        return authCache;
    }

    const credentials = Buffer.from(`${B2_ACCESS_KEY}:${B2_SECRET_KEY}`).toString("base64");
    const response = await axios.get(B2_AUTHORIZE_URL, {
        headers: { Authorization: `Basic ${credentials}` },
        timeout: 15000,
    });

    authCache = {
        apiUrl: response.data.apiUrl,
        authorizationToken: response.data.authorizationToken,
        downloadUrl: response.data.downloadUrl,
        accountId: response.data.accountId,
        expiresAt: Date.now() + 22 * 60 * 60 * 1000,
    };
    bucketIdCache = null;

    return authCache;
}

async function getBucketId() {
    if (bucketIdCache) {
        return bucketIdCache;
    }

    const auth = await authorizeB2();
    const response = await axios.post(
        `${auth.apiUrl}/b2api/v2/b2_list_buckets`,
        {
            accountId: auth.accountId,
            bucketName: B2_BUCKET,
        },
        {
            headers: { Authorization: auth.authorizationToken },
            timeout: 15000,
        }
    );

    const bucket = response.data.buckets?.[0];
    if (!bucket?.bucketId) {
        throw new Error(`B2 bucket not found: ${B2_BUCKET}`);
    }

    bucketIdCache = bucket.bucketId;
    return bucketIdCache;
}

async function getUploadUrl() {
    const bucketId = await getBucketId();
    return b2Post("/b2api/v2/b2_get_upload_url", { bucketId });
}

function getProfileDocumentObjectKey(categoryFolder, filename) {
    return `${DOCUMENT_BASE_PREFIX}/${categoryFolder}/${filename}`;
}

async function uploadProfileDocumentBuffer(categoryFolder, filename, buffer, mimeType) {
    const key = getProfileDocumentObjectKey(categoryFolder, filename);
    const uploadUrlData = await getUploadUrl();
    const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");

    await axios.post(uploadUrlData.uploadUrl, buffer, {
        headers: {
            Authorization: uploadUrlData.authorizationToken,
            "X-Bz-File-Name": key,
            "X-Bz-Content-Sha1": sha1,
            "Content-Type": mimeType || "application/octet-stream",
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
    });

    return {
        filename,
        key,
        mimeType: mimeType || "application/octet-stream",
        size: buffer.length,
    };
}

async function deleteProfileDocument(categoryFolder, filename) {
    if (!filename) return;

    const key = getProfileDocumentObjectKey(categoryFolder, filename);
    const bucketId = await getBucketId();
    const listResponse = await b2Post("/b2api/v2/b2_list_file_names", {
        bucketId,
        startFileName: key,
        maxFileCount: 100,
        prefix: key,
    });

    const files = listResponse.files || [];
    for (const file of files) {
        if (file.fileName !== key) continue;

        await b2Post("/b2api/v2/b2_delete_file_version", {
            fileName: file.fileName,
            fileId: file.fileId,
        });
    }
}

function encodeB2ObjectPath(key) {
    return String(key)
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

async function getProfileDocumentAccessUrl(categoryFolder, filename) {
    if (!filename) return null;

    const key = getProfileDocumentObjectKey(categoryFolder, filename);
    const auth = await authorizeB2();
    const bucketId = await getBucketId();

    const downloadAuth = await b2Post("/b2api/v2/b2_get_download_authorization", {
        bucketId,
        fileNamePrefix: key,
        validDurationInSeconds: B2_DOWNLOAD_AUTH_TTL_SECONDS,
    });

    const encodedKey = encodeB2ObjectPath(key);
    const authorizationToken = encodeURIComponent(downloadAuth.authorizationToken);

    return `${auth.downloadUrl}/file/${encodeURIComponent(B2_BUCKET)}/${encodedKey}?Authorization=${authorizationToken}`;
}

async function downloadB2Object(objectKey, retryOnAuth = true) {
    if (!objectKey) {
        throw new Error("Object key is required");
    }

    const auth = await authorizeB2();
    const bucketId = await getBucketId();
    const encodedKey = encodeB2ObjectPath(objectKey);

    const downloadAuth = await b2Post("/b2api/v2/b2_get_download_authorization", {
        bucketId,
        fileNamePrefix: objectKey,
        validDurationInSeconds: Math.min(B2_DOWNLOAD_AUTH_TTL_SECONDS, 86400),
    });

    const authorizationToken = encodeURIComponent(downloadAuth.authorizationToken);
    const downloadUrl =
        `${auth.downloadUrl}/file/${encodeURIComponent(B2_BUCKET)}/${encodedKey}` +
        `?Authorization=${authorizationToken}`;

    try {
        const response = await axios.get(downloadUrl, {
            responseType: "stream",
            timeout: 120000,
            maxRedirects: 5,
            validateStatus: (status) => status === 200,
        });

        return {
            stream: response.data,
            mimeType: (response.headers["content-type"] || "application/octet-stream")
                .split(";")[0]
                .trim(),
            size: response.headers["content-length"]
                ? Number(response.headers["content-length"])
                : null,
        };
    } catch (error) {
        if (retryOnAuth && error.response?.status === 401) {
            clearB2Cache();
            return downloadB2Object(objectKey, false);
        }
        throw error;
    }
}

async function downloadProfileDocument(categoryFolder, filename) {
    if (!filename) {
        throw new Error("Filename is required");
    }

    return downloadB2Object(getProfileDocumentObjectKey(categoryFolder, filename));
}

async function downloadProfileImage(filename) {
    if (!filename) {
        throw new Error("Filename is required");
    }

    return downloadB2Object(getProfileImageObjectKey(filename));
}

function getProfileImageObjectKey(filename) {
    return `${PROFILE_IMAGE_BASE_PREFIX}/${filename}`;
}

function validateProfileImageFile(buffer, ext) {
    if (buffer.length < 4) return false;

    const signatures = {
        jpg: [0xff, 0xd8, 0xff],
        jpeg: [0xff, 0xd8, 0xff],
        png: [0x89, 0x50, 0x4e, 0x47],
        gif: [0x47, 0x49, 0x46, 0x38],
        webp: [0x52, 0x49, 0x46, 0x46],
        bmp: [0x42, 0x4d],
    };

    const signature = signatures[ext];
    if (!signature) return false;

    for (let i = 0; i < signature.length; i++) {
        if (buffer[i] !== signature[i]) return false;
    }

    if (ext === "webp" && buffer.toString("ascii", 8, 12) !== "WEBP") {
        return false;
    }

    return true;
}

async function uploadProfileImageBuffer(filename, buffer, mimeType) {
    const key = getProfileImageObjectKey(filename);
    const uploadUrlData = await getUploadUrl();
    const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");

    await axios.post(uploadUrlData.uploadUrl, buffer, {
        headers: {
            Authorization: uploadUrlData.authorizationToken,
            "X-Bz-File-Name": key,
            "X-Bz-Content-Sha1": sha1,
            "Content-Type": mimeType || "application/octet-stream",
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
    });

    return {
        filename,
        key,
        mimeType: mimeType || "application/octet-stream",
        size: buffer.length,
    };
}

async function deleteProfileImage(filename) {
    if (!filename) return;

    const key = getProfileImageObjectKey(filename);
    const bucketId = await getBucketId();
    const listResponse = await b2Post("/b2api/v2/b2_list_file_names", {
        bucketId,
        startFileName: key,
        maxFileCount: 100,
        prefix: key,
    });

    const files = listResponse.files || [];
    for (const file of files) {
        if (file.fileName !== key) continue;

        await b2Post("/b2api/v2/b2_delete_file_version", {
            fileName: file.fileName,
            fileId: file.fileId,
        });
    }
}

async function getProfileImageAccessUrl(filename) {
    if (!filename) return null;

    const key = getProfileImageObjectKey(filename);
    const auth = await authorizeB2();
    const bucketId = await getBucketId();

    const downloadAuth = await b2Post("/b2api/v2/b2_get_download_authorization", {
        bucketId,
        fileNamePrefix: key,
        validDurationInSeconds: B2_DOWNLOAD_AUTH_TTL_SECONDS,
    });

    const encodedKey = encodeB2ObjectPath(key);
    const authorizationToken = encodeURIComponent(downloadAuth.authorizationToken);

    return `${auth.downloadUrl}/file/${encodeURIComponent(B2_BUCKET)}/${encodedKey}?Authorization=${authorizationToken}`;
}

async function downloadAndUploadProfileImage(imageUrl) {
    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
        throw new Error("Invalid image URL");
    }

    let response;
    try {
        response = await axios({
            method: "GET",
            url: imageUrl,
            responseType: "arraybuffer",
            maxContentLength: MAX_PROFILE_IMAGE_SIZE,
            timeout: 30000,
            validateStatus: (status) => status === 200,
        });
    } catch (error) {
        if (error.response) {
            throw new Error(`Failed to download image: HTTP ${error.response.status}`);
        }
        if (error.code === "ECONNABORTED") {
            throw new Error("Image download timeout");
        }
        if (error.message?.includes("maxContentLength")) {
            throw new Error("Image size exceeds maximum allowed size of 5MB");
        }
        throw new Error(error.message || "Failed to download image");
    }

    const buffer = Buffer.from(response.data);
    const contentType = response.headers["content-type"] || "";
    const mimeType = contentType.split(";")[0].trim().toLowerCase();

    if (buffer.length > MAX_PROFILE_IMAGE_SIZE) {
        throw new Error("Image size exceeds maximum allowed size of 5MB");
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
        throw new Error(`Invalid image MIME type: ${contentType}`);
    }

    let ext = "jpg";
    if (mimeType.includes("jpeg")) ext = "jpg";
    else if (mimeType.includes("png")) ext = "png";
    else if (mimeType.includes("gif")) ext = "gif";
    else if (mimeType.includes("webp")) ext = "webp";
    else if (mimeType.includes("bmp")) ext = "bmp";
    else {
        const urlExt = imageUrl.split(".").pop()?.toLowerCase().split("?")[0];
        if (urlExt && ALLOWED_IMAGE_EXTENSIONS.includes(urlExt)) {
            ext = urlExt;
        }
    }

    if (!validateProfileImageFile(buffer, ext)) {
        throw new Error("Invalid image file. File content does not match the image type.");
    }

    const filename = `${RANDOM_STRING(30)}.${ext}`;

    try {
        const uploaded = await uploadProfileImageBuffer(filename, buffer, mimeType);
        return {
            filename: uploaded.filename,
            mimeType: uploaded.mimeType,
            size: uploaded.size,
            key: uploaded.key,
        };
    } catch (error) {
        const message = error.response?.data?.message || error.response?.data?.code || error.message;
        throw new Error(`Failed to upload to B2: ${message}`);
    }
}

function getBranchAssetObjectKey(kind, filename) {
    const prefix = kind === "sign" ? BRANCH_SIGN_BASE_PREFIX : BRANCH_LOGO_BASE_PREFIX;
    return `${prefix}/${filename}`;
}

function sanitizeBranchIdForFilename(branchId) {
    const clean = String(branchId || "").trim();
    if (!clean) {
        throw new Error("branch_id is required for branch media upload");
    }
    // Branch IDs are stable identifiers used as the reusable B2 object name.
    return clean.replace(/[^A-Za-z0-9_-]/g, "_");
}

function buildBranchAssetFilename(branchId, ext) {
    const safeBranchId = sanitizeBranchIdForFilename(branchId);
    const safeExt = String(ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    return `${safeBranchId}.${safeExt}`;
}

async function deleteB2ObjectVersions(objectKey) {
    if (!objectKey) return;

    const bucketId = await getBucketId();
    let startFileName = objectKey;
    let startFileId = null;

    // Delete every version of this exact object key.
    for (let page = 0; page < 20; page++) {
        const payload = {
            bucketId,
            startFileName,
            maxFileCount: 100,
            prefix: objectKey,
        };
        if (startFileId) {
            payload.startFileId = startFileId;
        }

        const listResponse = await b2Post("/b2api/v2/b2_list_file_versions", payload);
        const files = listResponse.files || [];
        if (!files.length) break;

        let matched = 0;
        for (const file of files) {
            if (file.fileName !== objectKey) continue;
            matched += 1;
            await b2Post("/b2api/v2/b2_delete_file_version", {
                fileName: file.fileName,
                fileId: file.fileId,
            });
        }

        if (!listResponse.nextFileName || matched === 0) break;
        startFileName = listResponse.nextFileName;
        startFileId = listResponse.nextFileId || null;
    }
}

async function deleteBranchAssetsForBranch(kind, branchId) {
    const safeBranchId = sanitizeBranchIdForFilename(branchId);
    const prefix = kind === "sign" ? BRANCH_SIGN_BASE_PREFIX : BRANCH_LOGO_BASE_PREFIX;
    const namePrefix = `${prefix}/${safeBranchId}.`;
    const bucketId = await getBucketId();

    const listResponse = await b2Post("/b2api/v2/b2_list_file_names", {
        bucketId,
        startFileName: namePrefix,
        maxFileCount: 100,
        prefix: namePrefix,
    });

    const files = listResponse.files || [];
    for (const file of files) {
        if (!String(file.fileName || "").startsWith(namePrefix)) continue;
        await deleteB2ObjectVersions(file.fileName);
    }
}

async function uploadBranchAssetBuffer(kind, filename, buffer, mimeType) {
    const key = getBranchAssetObjectKey(kind, filename);
    // Replace any existing object at this exact key before upload.
    await deleteB2ObjectVersions(key);

    const uploadUrlData = await getUploadUrl();
    const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");

    await axios.post(uploadUrlData.uploadUrl, buffer, {
        headers: {
            Authorization: uploadUrlData.authorizationToken,
            "X-Bz-File-Name": key.split("/").map(encodeURIComponent).join("/"),
            "X-Bz-Content-Sha1": sha1,
            "Content-Type": mimeType || "application/octet-stream",
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
    });

    return {
        filename,
        key,
        mimeType: mimeType || "application/octet-stream",
        size: buffer.length,
    };
}

async function deleteBranchAsset(kind, filename) {
    if (!filename) return;
    await deleteB2ObjectVersions(getBranchAssetObjectKey(kind, filename));
}

async function downloadAndUploadBranchAsset(imageUrl, kind = "logo", branchId) {
    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
        throw new Error("Invalid image URL");
    }
    if (!branchId) {
        throw new Error("branch_id is required for branch media upload");
    }

    const assetKind = kind === "sign" ? "sign" : "logo";

    let response;
    try {
        response = await axios({
            method: "GET",
            url: imageUrl,
            responseType: "arraybuffer",
            maxContentLength: MAX_PROFILE_IMAGE_SIZE,
            timeout: 30000,
            validateStatus: (status) => status === 200,
        });
    } catch (error) {
        if (error.response) {
            throw new Error(`Failed to download image: HTTP ${error.response.status}`);
        }
        if (error.code === "ECONNABORTED") {
            throw new Error("Image download timeout");
        }
        if (error.message?.includes("maxContentLength")) {
            throw new Error("Image size exceeds maximum allowed size of 5MB");
        }
        throw new Error(error.message || "Failed to download image");
    }

    const buffer = Buffer.from(response.data);
    const contentType = response.headers["content-type"] || "";
    const mimeType = contentType.split(";")[0].trim().toLowerCase();

    if (buffer.length > MAX_PROFILE_IMAGE_SIZE) {
        throw new Error("Image size exceeds maximum allowed size of 5MB");
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
        throw new Error(`Invalid image MIME type: ${contentType}`);
    }

    let ext = "jpg";
    if (mimeType.includes("jpeg")) ext = "jpg";
    else if (mimeType.includes("png")) ext = "png";
    else if (mimeType.includes("gif")) ext = "gif";
    else if (mimeType.includes("webp")) ext = "webp";
    else if (mimeType.includes("bmp")) ext = "bmp";
    else {
        const urlExt = imageUrl.split(".").pop()?.toLowerCase().split("?")[0];
        if (urlExt && ALLOWED_IMAGE_EXTENSIONS.includes(urlExt)) {
            ext = urlExt === "jpeg" ? "jpg" : urlExt;
        }
    }

    if (!validateProfileImageFile(buffer, ext)) {
        throw new Error("Invalid image file. File content does not match the image type.");
    }

    const filename = buildBranchAssetFilename(branchId, ext);

    // Remove all previous extensions for this branch (e.g. .png when uploading .jpg).
    try {
        await deleteBranchAssetsForBranch(assetKind, branchId);
    } catch (cleanupError) {
        console.warn(
            `Failed to clear previous branch ${assetKind} assets:`,
            cleanupError?.message || cleanupError
        );
    }

    try {
        const uploaded = await uploadBranchAssetBuffer(assetKind, filename, buffer, mimeType);
        return {
            filename: uploaded.filename,
            mimeType: uploaded.mimeType,
            size: uploaded.size,
            key: uploaded.key,
            kind: assetKind,
        };
    } catch (error) {
        const message = error.response?.data?.message || error.response?.data?.code || error.message;
        throw new Error(`Failed to upload to B2: ${message}`);
    }
}

async function downloadAndUploadBranchLogo(imageUrl, branchId) {
    return downloadAndUploadBranchAsset(imageUrl, "logo", branchId);
}

async function downloadAndUploadBranchSign(imageUrl, branchId) {
    return downloadAndUploadBranchAsset(imageUrl, "sign", branchId);
}

async function downloadAndUploadProfileDocument(fileUrl, categoryFolder) {
    if (!fileUrl || typeof fileUrl !== "string" || !fileUrl.trim()) {
        throw new Error("Invalid file URL");
    }

    let response;
    try {
        response = await axios({
            method: "GET",
            url: fileUrl,
            responseType: "arraybuffer",
            maxContentLength: MAX_DOCUMENT_SIZE,
            timeout: 60000,
            validateStatus: (status) => status === 200,
        });
    } catch (error) {
        if (error.response) {
            throw new Error(`Failed to download file: HTTP ${error.response.status}`);
        }
        if (error.code === "ECONNABORTED") {
            throw new Error("File download timeout");
        }
        throw new Error(error.message || "Failed to download file");
    }

    const buffer = Buffer.from(response.data);
    const contentType = response.headers["content-type"] || "";
    const mimeType = contentType.split(";")[0].trim() || "application/octet-stream";
    const size = buffer.length;

    if (size > MAX_DOCUMENT_SIZE) {
        throw new Error("File size exceeds maximum allowed size of 50MB");
    }

    let ext = "bin";
    const urlExt = fileUrl.split(".").pop()?.toLowerCase().split("?")[0];
    if (urlExt && ALLOWED_FILE_EXTENSIONS.includes(urlExt)) {
        ext = urlExt;
    } else if (MIME_TO_EXT[mimeType]) {
        ext = MIME_TO_EXT[mimeType];
    }

    const filename = `${RANDOM_STRING(30)}.${ext}`;

    try {
        const uploaded = await uploadProfileDocumentBuffer(categoryFolder, filename, buffer, mimeType);
        return {
            filename: uploaded.filename,
            mimeType: uploaded.mimeType,
            size: uploaded.size,
            key: uploaded.key,
        };
    } catch (error) {
        const message = error.response?.data?.message || error.response?.data?.code || error.message;
        throw new Error(`Failed to upload to B2: ${message}`);
    }
}

export {
    BRANCH_LOGO_BASE_PREFIX,
    BRANCH_SIGN_BASE_PREFIX,
    DOCUMENT_BASE_PREFIX,
    PROFILE_IMAGE_BASE_PREFIX,
    buildBranchAssetFilename,
    deleteBranchAsset,
    deleteBranchAssetsForBranch,
    deleteProfileDocument,
    deleteProfileImage,
    downloadAndUploadBranchAsset,
    downloadAndUploadBranchLogo,
    downloadAndUploadBranchSign,
    downloadAndUploadProfileDocument,
    downloadAndUploadProfileImage,
    downloadB2Object,
    downloadProfileDocument,
    downloadProfileImage,
    getBranchAssetObjectKey,
    getProfileDocumentAccessUrl,
    getProfileDocumentObjectKey,
    getProfileImageAccessUrl,
    getProfileImageObjectKey,
};
