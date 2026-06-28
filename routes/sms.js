import express from "express";
import multer from "multer";
import { auth, validateBranch } from "../middleware/auth.js";
import smsBroadcastController from "../controllers/smsBroadcastController.js";

const router = express.Router();

// Configure multer
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.includes('csv') || 
            file.mimetype.includes('spreadsheet') ||
            file.originalname.match(/\.(csv|xls|xlsx)$/i)) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV and Excel files allowed'));
        }
    }
}).any();

// Config APIs
router.post("/config/create", auth, validateBranch, smsBroadcastController.createConfig);
router.put("/config/update", auth, validateBranch, smsBroadcastController.updateConfig);
router.get("/config/list", auth, validateBranch, smsBroadcastController.listConfigs);
router.get("/config/details/:config_id", auth, validateBranch, smsBroadcastController.getConfigDetails);
router.post("/config/test", auth, validateBranch, smsBroadcastController.testConfig);
router.put("/config/set-default", auth, validateBranch, smsBroadcastController.setDefaultConfig);
router.put("/config/change-status", auth, validateBranch, smsBroadcastController.changeConfigStatus);

// Template APIs
router.post("/template/create", auth, validateBranch, smsBroadcastController.createTemplate);
router.put("/template/update", auth, validateBranch, smsBroadcastController.updateTemplate);
router.get("/template/list", auth, validateBranch, smsBroadcastController.listTemplates);
router.get("/template/details/:template_id", auth, validateBranch, smsBroadcastController.getTemplateDetails);
router.post("/template/preview", auth, validateBranch, smsBroadcastController.previewTemplate);
router.get("/template/preview/:template_id", auth, validateBranch, smsBroadcastController.previewTemplateGet);
router.put("/template/change-status", auth, validateBranch, smsBroadcastController.changeTemplateStatus);

// Broadcast APIs
router.post("/broadcast/create", auth, validateBranch, smsBroadcastController.createBroadcast);
router.get("/broadcast/list", auth, validateBranch, smsBroadcastController.listBroadcasts);
router.get("/broadcast/details/:broadcast_id", auth, validateBranch, smsBroadcastController.getBroadcastDetails);
router.get("/broadcast/recipient-list/:broadcast_id", auth, validateBranch, smsBroadcastController.listRecipients);
router.post("/broadcast/pause", auth, validateBranch, smsBroadcastController.pauseBroadcast);
router.post("/broadcast/resume", auth, validateBranch, smsBroadcastController.resumeBroadcast);
router.post("/broadcast/cancel", auth, validateBranch, smsBroadcastController.cancelBroadcast);
router.post("/broadcast/retry-failed", auth, validateBranch, smsBroadcastController.retryFailed);

// Bulk / Import APIs
router.post("/upload-recipients", auth, validateBranch, (req, res, next) => {
    upload(req, res, (err) => {
        if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        next();
    });
}, smsBroadcastController.uploadRecipients);
router.post("/broadcast/create-from-upload", auth, validateBranch, smsBroadcastController.createBroadcastFromUpload);
router.get("/uploaded-recipients-info", auth, validateBranch, smsBroadcastController.getUploadedRecipientsInfo);
router.post("/clear-uploaded-recipients", auth, validateBranch, smsBroadcastController.clearUploadedRecipients);

// Dynamic Variables APIs
router.get("/dynamic-variables/:type/:identifier", auth, validateBranch, smsBroadcastController.getDynamicVariables);
router.get("/variable-keys/:type", auth, validateBranch, smsBroadcastController.getVariableKeys);

export default router;
