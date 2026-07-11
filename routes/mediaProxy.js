import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mime from "mime";
import { downloadB2Object } from "../helpers/b2Storage.js";
import { isValidMediaObjectKey, objectKeyFromProxyRequestPath } from "../helpers/mediaUrl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MEDIA_ROOT_DIR = path.join(__dirname, "..", "media");

function resolveLocalMediaPath(objectKey) {
    if (!isValidMediaObjectKey(objectKey)) return null;

    const relativePath = objectKey.replace(/^media\//, "");
    const absolutePath = path.normalize(path.join(MEDIA_ROOT_DIR, relativePath));
    const mediaRoot = path.normalize(MEDIA_ROOT_DIR);

    if (!absolutePath.startsWith(mediaRoot)) return null;
    return absolutePath;
}

function streamLocalMediaFile(objectKey) {
    const absolutePath = resolveLocalMediaPath(objectKey);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
        return null;
    }

    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) return null;

    return {
        stream: fs.createReadStream(absolutePath),
        mimeType: mime.getType(absolutePath) || "application/octet-stream",
        size: stats.size,
    };
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
        let b2Error = null;

        try {
            file = await downloadB2Object(objectKey);
        } catch (error) {
            b2Error = error;
            file = streamLocalMediaFile(objectKey);
        }

        if (!file) {
            const status = b2Error?.response?.status;
            console.error("MEDIA PROXY NOT FOUND:", {
                objectKey,
                requestPath,
                b2Status: status,
                b2Message: b2Error?.response?.data || b2Error?.message,
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
