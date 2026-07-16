import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import mime from "mime";
import { downloadB2Object } from "../helpers/b2Storage.js";
import { isValidMediaObjectKey, objectKeyFromProxyRequestPath } from "../helpers/mediaUrl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MEDIA_ROOT_DIR = path.join(__dirname, "..", "media");
const MEDIA_FALLBACK_ORIGIN = String(
    process.env.MEDIA_FALLBACK_ORIGIN || "https://server.ooms.in"
).replace(/\/$/, "");

function resolveLocalMediaPath(objectKey) {
    if (!isValidMediaObjectKey(objectKey)) return null;

    const relativePath = objectKey.replace(/^media\//, "");
    const absolutePath = path.normalize(path.join(MEDIA_ROOT_DIR, relativePath));
    const mediaRoot = path.normalize(MEDIA_ROOT_DIR);

    if (!absolutePath.startsWith(mediaRoot)) return null;
    return absolutePath;
}

/**
 * New branch assets live under media/branch/{logo|sign}/.
 * Older rows still store files under media/logo and media/sign.
 */
function candidateObjectKeys(objectKey) {
    const keys = [objectKey];
    if (objectKey.startsWith("media/branch/logo/")) {
        keys.push(objectKey.replace(/^media\/branch\/logo\//, "media/logo/"));
    } else if (objectKey.startsWith("media/branch/sign/")) {
        keys.push(objectKey.replace(/^media\/branch\/sign\//, "media/sign/"));
    }
    return keys;
}

function streamLocalMediaFile(objectKey) {
    for (const key of candidateObjectKeys(objectKey)) {
        const absolutePath = resolveLocalMediaPath(key);
        if (!absolutePath || !fs.existsSync(absolutePath)) continue;

        const stats = fs.statSync(absolutePath);
        if (!stats.isFile()) continue;

        return {
            stream: fs.createReadStream(absolutePath),
            mimeType: mime.getType(absolutePath) || "application/octet-stream",
            size: stats.size,
        };
    }

    return null;
}

/**
 * When developing locally against a remote DB, legacy logo/sign files often
 * still only exist on the hosted SERVER/media disk (served via /media/logo|sign).
 */
async function fetchLegacyHostedMedia(objectKey) {
    const legacyKeys = candidateObjectKeys(objectKey).filter((key) => key !== objectKey);
    if (!legacyKeys.length || !MEDIA_FALLBACK_ORIGIN) return null;

    for (const key of legacyKeys) {
        const relative = key.replace(/^media\//, "");
        const url = `${MEDIA_FALLBACK_ORIGIN}/media/${relative}`;
        try {
            const response = await axios.get(url, {
                responseType: "stream",
                timeout: 30000,
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
        } catch (_) {
            // try next candidate
        }
    }

    return null;
}

async function resolveMediaFile(objectKey) {
    let lastError = null;

    for (const key of candidateObjectKeys(objectKey)) {
        try {
            return await downloadB2Object(key);
        } catch (error) {
            lastError = error;
        }
    }

    const local = streamLocalMediaFile(objectKey);
    if (local) return local;

    const hosted = await fetchLegacyHostedMedia(objectKey);
    if (hosted) return hosted;

    if (lastError) throw lastError;
    return null;
}

function pipeMediaStream(res, file, { downloadName } = {}) {
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    if (file.size) {
        res.setHeader("Content-Length", String(file.size));
    }
    res.setHeader("Cache-Control", "public, max-age=86400");

    if (downloadName) {
        res.setHeader(
            "Content-Disposition",
            `inline; filename="${String(downloadName).replace(/"/g, "")}"`
        );
    }

    file.stream.on("error", (error) => {
        console.error("MEDIA PROXY STREAM ERROR:", error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: "Failed to stream media file",
            });
        } else {
            res.end();
        }
    });

    file.stream.pipe(res);
}

/**
 * GET /proxy/media/{...path}
 * Example: /proxy/media/profile/image/abc.png -> B2 key media/profile/image/abc.png
 */
export default async function mediaProxyHandler(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        return next();
    }

    if (req.method === "HEAD") {
        return res.status(200).end();
    }

    try {
        const requestPath = req.originalUrl || req.url || req.path || "";
        const objectKey = objectKeyFromProxyRequestPath(requestPath);
        if (!objectKey) {
            return res.status(400).json({
                success: false,
                message: "Invalid media path",
            });
        }

        let file = null;
        let resolveError = null;

        try {
            file = await resolveMediaFile(objectKey);
        } catch (error) {
            resolveError = error;
            file = null;
        }

        if (!file) {
            const status = resolveError?.response?.status;
            console.error("MEDIA PROXY NOT FOUND:", {
                objectKey,
                requestPath,
                triedKeys: candidateObjectKeys(objectKey),
                b2Status: status,
                b2Message:
                    typeof resolveError?.response?.data === "string"
                        ? resolveError.response.data
                        : resolveError?.response?.data?.message || resolveError?.message,
            });
            return res.status(404).json({
                success: false,
                message: "Media file not found",
            });
        }

        const filename = objectKey.split("/").pop();
        return pipeMediaStream(res, file, { downloadName: filename });
    } catch (error) {
        console.error("MEDIA PROXY ERROR:", error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch media file",
            });
        }
        return res.end();
    }
}
