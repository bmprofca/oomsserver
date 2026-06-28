import {
    createConfig,
    updateConfig,
    listConfigs,
    getConfigDetails,
    changeStatus,
    setDefaultConfig,
    testConfig
} from "../services/emailConfigService.js";
import {
    createTemplate,
    updateTemplate,
    listTemplates,
    getTemplateDetails,
    previewTemplate,
    changeTemplateStatus
} from "../services/emailTemplateService.js";
import {
    createBroadcast,
    listBroadcasts,
    getBroadcastDetails,
    listRecipients,
    updateBroadcastStatus,
    retryFailedRecipients
} from "../services/emailBroadcastService.js";

function getUsername(req) {
    return req.headers.username || req.headers.Username || null;
}

function sendSuccess(res, message, data = {}, extra = {}) {
    return res.json({ success: true, message, data, ...extra });
}

function sendError(res, error, code = 400) {
    return res.status(code).json({
        success: false,
        message: error?.message || "Request failed"
    });
}

const emailBroadcastController = {
    async createConfig(req, res) {
        try {
            const data = await createConfig({ branch_id: req.branch_id, username: getUsername(req), payload: req.body || {} });
            return sendSuccess(res, "SMTP config created successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async updateConfig(req, res) {
        try {
            const data = await updateConfig({ branch_id: req.branch_id, username: getUsername(req), payload: req.body || {} });
            return sendSuccess(res, "SMTP config updated successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async listConfigs(req, res) {
        try {
            const { page_no = 1, limit = 10 } = req.query;
            const result = await listConfigs({ branch_id: req.branch_id, page_no, limit });
            return sendSuccess(res, "List fetched successfully", result.data, { pagination: result.pagination });
        } catch (error) {
            return sendError(res, error, 500);
        }
    },
    async getConfigDetails(req, res) {
        try {
            const data = await getConfigDetails({ branch_id: req.branch_id, config_id: req.params.config_id });
            return sendSuccess(res, "Config details fetched successfully", data);
        } catch (error) {
            return sendError(res, error, 404);
        }
    },
    async testConfig(req, res) {
        try {
            const data = await testConfig({ payload: req.body || {} });
            return sendSuccess(res, "SMTP config verified successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async setDefaultConfig(req, res) {
        try {
            const { config_id } = req.body || {};
            if (!config_id) throw new Error("config_id is required");
            const data = await setDefaultConfig({ branch_id: req.branch_id, config_id, username: getUsername(req) });
            return sendSuccess(res, "Default SMTP config updated successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async changeConfigStatus(req, res) {
        try {
            const { config_id, status } = req.body || {};
            if (!config_id || !status) throw new Error("config_id and status are required");
            const data = await changeStatus({ branch_id: req.branch_id, config_id, status, username: getUsername(req) });
            return sendSuccess(res, "SMTP config status updated successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },

    async createTemplate(req, res) {
        try {
            const data = await createTemplate({ branch_id: req.branch_id, username: getUsername(req), payload: req.body || {} });
            return sendSuccess(res, "Template created successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async updateTemplate(req, res) {
        try {
            const data = await updateTemplate({ branch_id: req.branch_id, username: getUsername(req), payload: req.body || {} });
            return sendSuccess(res, "Template updated successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async listTemplates(req, res) {
        try {
            const { page_no = 1, limit = 10 } = req.query;
            const result = await listTemplates({ branch_id: req.branch_id, page_no, limit });
            return sendSuccess(res, "List fetched successfully", result.data, { pagination: result.pagination });
        } catch (error) {
            return sendError(res, error, 500);
        }
    },
    async getTemplateDetails(req, res) {
        try {
            const data = await getTemplateDetails({ branch_id: req.branch_id, template_id: req.params.template_id });
            return sendSuccess(res, "Template details fetched successfully", data);
        } catch (error) {
            return sendError(res, error, 404);
        }
    },
    async previewTemplate(req, res) {
        try {
            const data = await previewTemplate(req.body || {});
            return sendSuccess(res, "Template preview generated successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async changeTemplateStatus(req, res) {
        try {
            const { template_id, status } = req.body || {};
            if (!template_id || !status) throw new Error("template_id and status are required");
            const data = await changeTemplateStatus({ branch_id: req.branch_id, template_id, status, username: getUsername(req) });
            return sendSuccess(res, "Template status updated successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },

    async createBroadcast(req, res) {
        try {
            const data = await createBroadcast({ branch_id: req.branch_id, username: getUsername(req), payload: req.body || {} });
            return sendSuccess(res, "Broadcast created successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async listBroadcasts(req, res) {
        try {
            const { page_no = 1, limit = 10 } = req.query;
            const result = await listBroadcasts({ branch_id: req.branch_id, page_no, limit });
            return sendSuccess(res, "List fetched successfully", result.data, { pagination: result.pagination });
        } catch (error) {
            return sendError(res, error, 500);
        }
    },
    async getBroadcastDetails(req, res) {
        try {
            const data = await getBroadcastDetails({ branch_id: req.branch_id, broadcast_id: req.params.broadcast_id });
            return sendSuccess(res, "Broadcast details fetched successfully", data);
        } catch (error) {
            return sendError(res, error, 404);
        }
    },
    async listRecipients(req, res) {
        try {
            const { page_no = 1, limit = 50 } = req.query;
            const result = await listRecipients({ branch_id: req.branch_id, broadcast_id: req.params.broadcast_id, page_no, limit });
            return sendSuccess(res, "List fetched successfully", result.data, { pagination: result.pagination });
        } catch (error) {
            return sendError(res, error, 500);
        }
    },
    async pauseBroadcast(req, res) {
        try {
            const { broadcast_id } = req.body || {};
            if (!broadcast_id) throw new Error("broadcast_id is required");
            const data = await updateBroadcastStatus({ branch_id: req.branch_id, broadcast_id, nextStatus: "paused", username: getUsername(req) });
            return sendSuccess(res, "Broadcast paused successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async resumeBroadcast(req, res) {
        try {
            const { broadcast_id } = req.body || {};
            if (!broadcast_id) throw new Error("broadcast_id is required");
            const data = await updateBroadcastStatus({ branch_id: req.branch_id, broadcast_id, nextStatus: "scheduled", username: getUsername(req) });
            return sendSuccess(res, "Broadcast resumed successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async cancelBroadcast(req, res) {
        try {
            const { broadcast_id } = req.body || {};
            if (!broadcast_id) throw new Error("broadcast_id is required");
            const data = await updateBroadcastStatus({ branch_id: req.branch_id, broadcast_id, nextStatus: "cancelled", username: getUsername(req) });
            return sendSuccess(res, "Broadcast cancelled successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async retryFailed(req, res) {
        try {
            const { broadcast_id } = req.body || {};
            if (!broadcast_id) throw new Error("broadcast_id is required");
            const data = await retryFailedRecipients({ branch_id: req.branch_id, broadcast_id, username: getUsername(req) });
            return sendSuccess(res, "Failed recipients retried successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    }
};

export default emailBroadcastController;
