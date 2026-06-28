import path from "path";
import fs from "fs";
import axios from "axios";
import { RANDOM_STRING } from "./function.js";

export const NOTE_FILE_DIR = path.join(process.cwd(), "media", "note", "file");
export const NOTE_VOICE_DIR = path.join(process.cwd(), "media", "note", "voice");
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_VOICE_SIZE = 50 * 1024 * 1024; // 50 MB

const ALLOWED_FILE_EXTENSIONS = [
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
    "mp4", "avi", "mov", "wmv", "flv", "webm", "mkv", "m4v",
    "zip", "rar", "7z", "tar", "gz"
];

const ALLOWED_AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "aac", "flac", "m4a", "wma", "opus"];
const ALLOWED_AUDIO_MIME_TYPES = [
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav",
    "audio/ogg", "audio/vorbis", "audio/aac", "audio/flac", "audio/x-flac",
    "audio/mp4", "audio/x-m4a", "audio/x-ms-wma", "audio/opus", "audio/webm"
];

function validateAudioFile(buffer, ext) {
    if (buffer.length < 4) return false;
    const signatures = {
        mp3: [[0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0x49, 0x44, 0x33]],
        wav: [0x52, 0x49, 0x46, 0x46],
        ogg: [0x4f, 0x67, 0x67, 0x53],
        webm: [0x1a, 0x45, 0xdf, 0xa3],
        aac: [[0xff, 0xf1], [0xff, 0xf9]],
        flac: [0x66, 0x4c, 0x61, 0x43],
        m4a: [[0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]]
    };
    const signature = signatures[ext.toLowerCase()];
    if (!signature) return false;
    if (Array.isArray(signature[0])) {
        return signature.some(sig => {
            if (sig.length > buffer.length) return false;
            for (let i = 0; i < sig.length; i++) if (buffer[i] !== sig[i]) return false;
            return true;
        });
    }
    if (signature.length > buffer.length) return false;
    for (let i = 0; i < signature.length; i++) if (buffer[i] !== signature[i]) return false;
    if (ext.toLowerCase() === "wav") {
        if (buffer.length < 12) return false;
        const waveString = buffer.toString("ascii", 8, 12);
        if (waveString !== "WAVE") return false;
    }
    if (ext.toLowerCase() === "flac") {
        const flacString = buffer.toString("ascii", 4, 8);
        if (flacString !== "fLaC") return false;
    }
    return true;
}

function ensureNoteDirs() {
    if (!fs.existsSync(NOTE_FILE_DIR)) fs.mkdirSync(NOTE_FILE_DIR, { recursive: true });
    if (!fs.existsSync(NOTE_VOICE_DIR)) fs.mkdirSync(NOTE_VOICE_DIR, { recursive: true });
}

export async function downloadAndSaveNoteFile(fileUrl) {
    ensureNoteDirs();
    if (!fileUrl || typeof fileUrl !== "string" || !fileUrl.trim()) throw new Error("Invalid file URL");
    const response = await axios({
        method: "GET",
        url: fileUrl,
        responseType: "arraybuffer",
        maxContentLength: MAX_FILE_SIZE,
        timeout: 60000,
        validateStatus: status => status === 200
    }).catch(err => {
        if (err.response) throw new Error(`Failed to download file: HTTP ${err.response.status}`);
        if (err.code === "ECONNABORTED") throw new Error("File download timeout");
        if (err.message && err.message.includes("maxContentLength")) throw new Error("File size exceeds maximum allowed size of 100MB");
        throw new Error(`Failed to download file: ${err.message}`);
    });
    const buffer = Buffer.from(response.data);
    const contentType = response.headers["content-type"] || "";
    if (buffer.length > MAX_FILE_SIZE) throw new Error("File size exceeds maximum allowed size of 100MB");
    let ext = "bin";
    const urlExt = fileUrl.split(".").pop()?.toLowerCase().split("?")[0];
    if (urlExt && ALLOWED_FILE_EXTENSIONS.includes(urlExt)) ext = urlExt;
    else if (contentType) {
        const mimeToExt = {
            "application/pdf": "pdf", "application/msword": "doc",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
            "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
            "text/plain": "txt", "text/csv": "csv", "video/mp4": "mp4", "video/webm": "webm", "application/zip": "zip"
        };
        if (mimeToExt[contentType]) ext = mimeToExt[contentType];
    }
    const filename = `${RANDOM_STRING(30)}.${ext}`;
    fs.writeFileSync(path.join(NOTE_FILE_DIR, filename), buffer);
    return filename;
}

export async function downloadAndSaveVoiceFile(voiceUrl) {
    ensureNoteDirs();
    if (!voiceUrl || typeof voiceUrl !== "string" || !voiceUrl.trim()) throw new Error("Invalid voice file URL");
    const response = await axios({
        method: "GET",
        url: voiceUrl,
        responseType: "arraybuffer",
        maxContentLength: MAX_VOICE_SIZE,
        timeout: 60000,
        validateStatus: status => status === 200
    }).catch(err => {
        if (err.response) throw new Error(`Failed to download voice file: HTTP ${err.response.status}`);
        if (err.code === "ECONNABORTED") throw new Error("Voice file download timeout");
        if (err.message && err.message.includes("maxContentLength")) throw new Error("Voice file size exceeds maximum allowed size of 50MB");
        throw new Error(`Failed to download voice file: ${err.message}`);
    });
    const buffer = Buffer.from(response.data);
    const contentType = response.headers["content-type"] || "";
    if (buffer.length > MAX_VOICE_SIZE) throw new Error("Voice file size exceeds maximum allowed size of 50MB");
    if (contentType) {
        const ct = contentType.toLowerCase();
        const ok = ALLOWED_AUDIO_MIME_TYPES.some(m => m.toLowerCase() === ct) || ct.startsWith("audio/");
        if (!ok) throw new Error(`Invalid voice file MIME type: ${contentType}`);
    }
    let ext = "mp3";
    const urlExt = voiceUrl.split(".").pop()?.toLowerCase().split("?")[0];
    if (urlExt && ALLOWED_AUDIO_EXTENSIONS.includes(urlExt)) ext = urlExt;
    else if (urlExt === "wa") ext = "wav"; // .wa often used as shorthand or truncation for .wav
    else if (contentType) {
        const ct = contentType.toLowerCase();
        if (ct.includes("wav") || ct.includes("wave")) ext = "wav";
        else if (ct.includes("mpeg") || ct.includes("mp3")) ext = "mp3";
        else if (ct.includes("ogg")) ext = "ogg";
        else if (ct.includes("aac")) ext = "aac";
        else if (ct.includes("flac")) ext = "flac";
        else if (ct.includes("m4a") || ct.includes("mp4")) ext = "m4a";
        else if (ct.includes("wma")) ext = "wma";
        else if (ct.includes("opus")) ext = "opus";
    }
    // Rely on size + Content-Type; skip strict byte-signature validation so browser-valid audio (e.g. .wa/.wav) is accepted
    const filename = `${RANDOM_STRING(30)}.${ext}`;
    fs.writeFileSync(path.join(NOTE_VOICE_DIR, filename), buffer);
    return filename;
}
