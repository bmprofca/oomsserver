import express from "express";
import { auth } from "../middleware/auth.js";
import { RANDOM_STRING } from "../helpers/function.js";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { BASE_DOMAIN } from "../helpers/Config.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

const router = express.Router();

// Get current directory (where upload.js is located)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ALLOWED_EXTENSIONS = [
    // Images
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
    // Documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv',
    // Videos
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', 'm4v',
    // Audio
    'mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a',
    // Archives
    'zip', 'rar', '7z', 'tar', 'gz'
];

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB in bytes

// MIME type mapping for validation
const ALLOWED_MIME_TYPES = {
    // Images
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'image/svg+xml': ['svg'],
    'image/bmp': ['bmp'],
    'image/x-icon': ['ico'],
    // Documents
    'application/pdf': ['pdf'],
    'application/msword': ['doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.ms-excel': ['xls'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'application/vnd.ms-powerpoint': ['ppt'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
    'text/plain': ['txt'],
    'text/csv': ['csv'],
    // Videos
    'video/mp4': ['mp4'],
    'video/x-msvideo': ['avi'],
    'video/quicktime': ['mov'],
    'video/x-ms-wmv': ['wmv'],
    'video/x-flv': ['flv'],
    'video/webm': ['webm'],
    'video/x-matroska': ['mkv'],
    'video/x-m4v': ['m4v'],
    // Audio
    'audio/mpeg': ['mp3'],
    'audio/wav': ['wav'],
    'audio/ogg': ['ogg'],
    'audio/aac': ['aac'],
    'audio/flac': ['flac'],
    'audio/x-m4a': ['m4a'],
    // Archives
    'application/zip': ['zip'],
    'application/x-rar-compressed': ['rar'],
    'application/x-7z-compressed': ['7z'],
    'application/x-tar': ['tar'],
    'application/gzip': ['gz']
};

// Upload directory
const UPLOAD_DIR = path.join(__dirname, "..", 'media', 'upload', 'temp');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Get original extension
        const ext = path.extname(file.originalname).toLowerCase().substring(1);
        // Generate random filename
        const randomName = RANDOM_STRING(30);
        cb(null, `${randomName}.${ext}`);
    }
});

// File filter function
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().substring(1);

    // Check if extension is allowed
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return cb(new Error(`File type .${ext} is not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
    }

    // Check if MIME type matches extension
    const mimeType = file.mimetype.toLowerCase();
    if (ALLOWED_MIME_TYPES[mimeType]) {
        if (!ALLOWED_MIME_TYPES[mimeType].includes(ext)) {
            return cb(new Error(`File MIME type (${mimeType}) does not match file extension (.${ext})`), false);
        }
    } else {
        // Some MIME types might not be in our map, but we'll allow if extension is valid
        // This is a fallback for edge cases
    }

    cb(null, true);
};

// Configure multer
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1 // Only allow single file upload
    }
});

// Helper function to get file metadata
function getFileMetadata(filePath) {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase().substring(1);

    return {
        filename: path.basename(filePath),
        originalName: path.basename(filePath), // In this case, it's the same as filename since we rename
        extension: ext,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        mimeType: getMimeType(ext),
        uploadedAt: stats.birthtime,
        modifiedAt: stats.mtime
    };
}

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Helper function to get MIME type from extension
function getMimeType(ext) {
    for (const [mime, exts] of Object.entries(ALLOWED_MIME_TYPES)) {
        if (exts.includes(ext)) {
            return mime;
        }
    }
    return 'application/octet-stream';
}

router.post("/", auth, upload.single('file'), async (req, res) => {
    try {
        // Check if file was uploaded
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded. Please provide a file in the 'file' field."
            });
        }

        const filePath = req.file.path;
        const fileName = req.file.filename;

        // Additional security validation: Check file content (basic)
        // For images, we can do basic validation
        const ext = path.extname(fileName).toLowerCase().substring(1);
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);

        if (isImage) {
            // Basic image validation - check file header
            const fileBuffer = fs.readFileSync(filePath);
            const isValidImage = validateImageFile(fileBuffer, ext);

            if (!isValidImage) {
                // Delete the invalid file
                fs.unlinkSync(filePath);
                return res.status(400).json({
                    success: false,
                    message: "Invalid image file. File content does not match the file extension."
                });
            }
        }

        // Get file metadata
        const metadata = getFileMetadata(filePath);

        // Construct file URL
        const fileUrl = `${BASE_DOMAIN}/temp/${fileName}`;

        // Construct relative path
        const relativePath = `temp/${fileName}`;

        return res.status(200).json({
            success: true,
            message: "File uploaded successfully",
            data: {
                path: relativePath,
                url: fileUrl,
                metadata: metadata
            }
        });

    } catch (error) {
        // If file was uploaded but error occurred, delete it
        if (req.file && req.file.path) {
            try {
                if (fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
            } catch (unlinkError) {
                console.error('Error deleting file:', unlinkError);
            }
        }

        console.error('File upload error:', error);

        // Handle multer errors
        if (error instanceof multer.MulterError) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    success: false,
                    message: `File size exceeds maximum allowed size of ${formatFileSize(MAX_FILE_SIZE)}`
                });
            }
            if (error.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({
                    success: false,
                    message: "Too many files. Only one file is allowed per request."
                });
            }
        }

        return res.status(500).json({
            success: false,
            message: "Failed to upload file",
            error: error.message
        });
    }
});

// Helper function to validate image files by checking file headers
function validateImageFile(buffer, ext) {
    if (buffer.length < 4) return false;

    // Check file signatures (magic numbers)
    const signatures = {
        'jpg': [0xFF, 0xD8, 0xFF],
        'jpeg': [0xFF, 0xD8, 0xFF],
        'png': [0x89, 0x50, 0x4E, 0x47],
        'gif': [0x47, 0x49, 0x46, 0x38],
        'webp': [0x52, 0x49, 0x46, 0x46], // RIFF header, need to check more
        'bmp': [0x42, 0x4D] // BM
    };

    const signature = signatures[ext];
    if (!signature) return true; // If we don't have a signature for this type, allow it

    // Check if buffer starts with the signature
    for (let i = 0; i < signature.length; i++) {
        if (buffer[i] !== signature[i]) {
            return false;
        }
    }

    // Additional check for WebP (RIFF...WEBP)
    if (ext === 'webp') {
        const webpString = buffer.toString('ascii', 8, 12);
        if (webpString !== 'WEBP') {
            return false;
        }
    }

    return true;
}

export default router;
