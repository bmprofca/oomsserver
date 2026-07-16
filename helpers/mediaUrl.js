import { BASE_DOMAIN } from "./Config.js";

const MEDIA_ROOT = "media";
const PROXY_PREFIX = "/proxy";

/**
 * Reject path traversal and invalid segments.
 */
function isSafePathSegment(segment) {
    const value = String(segment || "").trim();
    if (!value) return false;
    if (value === "." || value === "..") return false;
    if (value.includes("\\") || value.includes("/") || value.includes("\0")) return false;
    return true;
}

/**
 * Validate a B2/local object key under `media/`.
 */
export function isValidMediaObjectKey(objectKey) {
    if (!objectKey || typeof objectKey !== "string") return false;
    if (!objectKey.startsWith(`${MEDIA_ROOT}/`)) return false;
    if (objectKey.includes("..")) return false;

    const segments = objectKey.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== MEDIA_ROOT) return false;

    return segments.every(isSafePathSegment);
}

/**
 * Build a server-proxied media URL from folder segments + filename.
 * Example: buildMediaProxyUrl("profile", "image", "abc.png")
 *   -> https://server.example/proxy/media/profile/image/abc.png
 */
export function buildMediaProxyUrl(...segments) {
    const parts = segments
        .flat()
        .map((segment) => String(segment || "").trim())
        .filter(Boolean);

    if (!parts.length) return null;
    if (!parts.every(isSafePathSegment)) return null;

    const objectKey = [MEDIA_ROOT, ...parts].join("/");
    if (!isValidMediaObjectKey(objectKey)) return null;

    const encodedPath = parts.map((part) => encodeURIComponent(part)).join("/");
    const base = String(BASE_DOMAIN || "").replace(/\/$/, "");

    return `${base}${PROXY_PREFIX}/${MEDIA_ROOT}/${encodedPath}`;
}

/**
 * Profile image stored as filename in DB -> proxied URL.
 */
export function buildProfileImageUrl(filename) {
    const clean = String(filename || "").trim();
    if (!clean) return null;
    return buildMediaProxyUrl("profile", "image", clean);
}

/**
 * Branch logo stored as filename in DB -> proxied URL (B2: media/branch/logo/).
 */
export function buildBranchLogoUrl(filename) {
    const clean = String(filename || "").trim();
    if (!clean) return null;
    return buildMediaProxyUrl("branch", "logo", clean);
}

/**
 * Branch signature stored as filename in DB -> proxied URL (B2: media/branch/sign/).
 */
export function buildBranchSignUrl(filename) {
    const clean = String(filename || "").trim();
    if (!clean) return null;
    return buildMediaProxyUrl("branch", "sign", clean);
}

/**
 * Profile document stored under category folder + filename.
 */
export function buildProfileDocumentUrl(categoryFolder, filename) {
    const category = String(categoryFolder || "").trim();
    const clean = String(filename || "").trim();
    if (!category || !clean) return null;
    return buildMediaProxyUrl("profile", "document", category, clean);
}

/**
 * Parse request path into B2 object key under `media/`.
 * Accepts `/proxy/media/profile/image/x.png`, `profile/image/x.png`, etc.
 */
export function objectKeyFromProxyRequestPath(requestPath) {
    let pathOnly = String(requestPath || "").split("?")[0].replace(/\\/g, "/");
    while (pathOnly.startsWith("/")) {
        pathOnly = pathOnly.slice(1);
    }

    if (pathOnly.startsWith("proxy/media/")) {
        pathOnly = pathOnly.slice("proxy/media/".length);
    }

    if (!pathOnly.startsWith("media/")) {
        pathOnly = `media/${pathOnly}`;
    }

    const segments = pathOnly
        .split("/")
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .filter(Boolean);

    if (!segments.every(isSafePathSegment)) return null;

    const objectKey = segments.join("/");
    return isValidMediaObjectKey(objectKey) ? objectKey : null;
}

/** Drop-in replacement for async B2 signed URL resolvers. */
export function resolveProfileImageUrl(image) {
    return buildProfileImageUrl(image);
}

/** Drop-in replacement for async B2 signed document URL resolvers. */
export function resolveProfileDocumentUrl(categoryFolder, filename) {
    return buildProfileDocumentUrl(categoryFolder, filename);
}
