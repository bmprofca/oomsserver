import {
    deleteProfileDocument,
    downloadAndUploadProfileDocument,
    getProfileDocumentAccessUrl,
} from "./b2Storage.js";

export const ONECHATTING_TEMPLATE_MEDIA_CATEGORY = "onechatting_template";

const MEDIA_PARAM_TYPES = new Set(["image", "video", "document"]);

export function isHttpUrl(value) {
    if (value == null) return false;
    const s = String(value).trim();
    return /^https?:\/\//i.test(s);
}

export function isStoredB2Filename(value) {
    if (value == null) return false;
    const s = String(value).trim();
    if (!s || isHttpUrl(s)) return false;
    // Stored filenames are random tokens with an extension (e.g. abc...xyz.jpeg)
    return /^[\w.-]+$/.test(s) && s.includes(".");
}

function cloneComponent(component) {
    if (component == null) return component;
    return JSON.parse(JSON.stringify(component));
}

/**
 * Walk template component JSON and yield header media link refs.
 * Returns { mediaType, link, setLink(next) } for each image/video/document parameter.
 */
export function walkMediaLinks(component, onEach) {
    if (component == null) return;

    const list = Array.isArray(component) ? component : [component];
    for (const part of list) {
        if (!part || typeof part !== "object") continue;
        const type = String(part.type || "").toLowerCase();
        if (type !== "header") continue;

        const parameters = Array.isArray(part.parameters) ? part.parameters : [];
        for (const param of parameters) {
            if (!param || typeof param !== "object") continue;
            const mediaType = String(param.type || "").toLowerCase();
            if (!MEDIA_PARAM_TYPES.has(mediaType)) continue;

            const mediaObj = param[mediaType];
            if (!mediaObj || typeof mediaObj !== "object") continue;

            const link = mediaObj.link != null ? String(mediaObj.link).trim() : "";
            onEach({
                mediaType,
                link,
                setLink(next) {
                    mediaObj.link = next;
                },
            });
        }
    }
}

export function collectMediaFilenames(component) {
    const filenames = new Set();
    walkMediaLinks(component, ({ link }) => {
        if (isStoredB2Filename(link)) {
            filenames.add(link);
        }
    });
    return filenames;
}

/**
 * Download any http(s) media links and re-upload to B2.
 * Replaces each link with the B2 filename. Returns a deep-cloned component.
 */
export async function persistComponentMedia(component) {
    const next = cloneComponent(component);
    const errors = [];

    const jobs = [];
    walkMediaLinks(next, ({ mediaType, link, setLink }) => {
        if (!isHttpUrl(link)) return;
        jobs.push(
            (async () => {
                try {
                    const uploaded = await downloadAndUploadProfileDocument(
                        link,
                        ONECHATTING_TEMPLATE_MEDIA_CATEGORY
                    );
                    if (!uploaded?.filename) {
                        throw new Error(`Failed to store ${mediaType} media`);
                    }
                    setLink(uploaded.filename);
                } catch (error) {
                    errors.push({
                        mediaType,
                        link,
                        message: error?.message || String(error),
                    });
                }
            })()
        );
    });

    await Promise.all(jobs);

    if (errors.length) {
        const err = new Error(
            errors[0].message || "Failed to persist template media to storage"
        );
        err.code = "ONECHATTING_MEDIA_PERSIST_FAILED";
        err.details = errors;
        throw err;
    }

    return next;
}

/**
 * Resolve stored B2 filenames to signed access URLs (in place on a clone).
 */
export async function resolveComponentMedia(component) {
    if (component == null) return null;
    const next = cloneComponent(component);

    const jobs = [];
    walkMediaLinks(next, ({ link, setLink }) => {
        if (!isStoredB2Filename(link)) return;
        jobs.push(
            (async () => {
                const url = await getProfileDocumentAccessUrl(
                    ONECHATTING_TEMPLATE_MEDIA_CATEGORY,
                    link
                );
                if (url) {
                    setLink(url);
                }
            })()
        );
    });

    await Promise.all(jobs);
    return next;
}

/**
 * Delete B2 files that were in the old component but not kept in the new one.
 */
export async function cleanupPreviousMedia(oldComponent, newComponent) {
    const oldNames = collectMediaFilenames(oldComponent);
    const newNames = collectMediaFilenames(newComponent);

    const toDelete = [...oldNames].filter((name) => !newNames.has(name));
    await Promise.all(
        toDelete.map(async (filename) => {
            try {
                await deleteProfileDocument(
                    ONECHATTING_TEMPLATE_MEDIA_CATEGORY,
                    filename
                );
            } catch (error) {
                console.warn(
                    "Failed to delete previous OneChatting template media:",
                    filename,
                    error?.message || error
                );
            }
        })
    );
}
