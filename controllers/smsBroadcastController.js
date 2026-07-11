import pool from "../db.js";
import xlsx from "xlsx";
import { buildProfileImageUrl } from "../helpers/mediaUrl.js";
import {
    createConfig,
    updateConfig,
    listConfigs,
    getConfigDetails,
    changeStatus,
    setDefaultConfig,
    testConfig
} from "../services/smsConfigService.js";
import {
    createTemplate,
    updateTemplate,
    listTemplates,
    getTemplateDetails,
    previewTemplate,
    changeTemplateStatus
} from "../services/smsTemplateService.js";
import {
    createBroadcast,
    listBroadcasts,
    getBroadcastDetails,
    listRecipients,
    updateBroadcastStatus,
    retryFailedRecipients
} from "../services/smsBroadcastService.js";

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

async function resolveDynamicVariables(branch_id, type, identifier) {
    let variables = {};
    if (!type || !identifier) return variables;

    const getProfileData = async (username) => {
        const [profile] = await pool.query(
            `SELECT username, name, email, mobile, country_code, pan_number, 
                    gender, date_of_birth, user_type, city, state, 
                    address_line_1, pincode, image, create_date
             FROM profile 
             WHERE username = ? AND status = 'active'`,
            [username]
        );
        return profile[0] || {};
    };
    
    const getFirmData = async (username) => {
        const [firms] = await pool.query(
            `SELECT firm_id, firm_name, firm_type, gst_no, pan_no, tan_no, 
                    vat_no, cin_no, file_no, address_line_1, address_line_2,
                    city, district, state, country, pincode
             FROM firms 
             WHERE username = ? AND status = '1' AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [username]
        );
        return firms[0] || {};
    };

    switch (type) {
        case "client": {
            const clientProfile = await getProfileData(identifier);
            const clientFirm = await getFirmData(identifier);
            
            variables = {
                type: "client",
                name: clientProfile.name || identifier,
                username: clientProfile.username,
                email: clientProfile.email,
                mobile: clientProfile.mobile,
                phone: clientProfile.mobile,
                pan_number: clientProfile.pan_number,
                pan_no: clientProfile.pan_number,
                gender: clientProfile.gender,
                date_of_birth: clientProfile.date_of_birth,
                user_type: clientProfile.user_type,
                city: clientProfile.city,
                state: clientProfile.state,
                address: clientProfile.address_line_1,
                pincode: clientProfile.pincode,
                profile_image: buildProfileImageUrl(clientProfile.image),
                registered_date: clientProfile.create_date,
                firm_name: clientFirm.firm_name,
                firm_type: clientFirm.firm_type,
                gst_no: clientFirm.gst_no,
                gst: clientFirm.gst_no,
                tan_no: clientFirm.tan_no,
                vat_no: clientFirm.vat_no,
                cin_no: clientFirm.cin_no,
                file_no: clientFirm.file_no,
                firm_address: clientFirm.address_line_1,
                firm_city: clientFirm.city,
                firm_state: clientFirm.state,
                firm_pincode: clientFirm.pincode
            };
            break;
        }
        case "task": {
            const [task] = await pool.query(
                `SELECT t.*, s.name as service_name, s.sac_code, s.type as service_type,
                        f.firm_name, f.firm_type, f.gst_no as firm_gst, f.pan_no as firm_pan
                 FROM tasks t
                 LEFT JOIN services s ON s.service_id = t.service_id
                 LEFT JOIN firms f ON f.firm_id = t.firm_id
                 WHERE t.task_id = ? AND t.branch_id = ?`,
                [identifier, branch_id]
            );
            
            if (task.length) {
                const taskData = task[0];
                const taskProfile = await getProfileData(taskData.username);
                const taskFirm = await getFirmData(taskData.username);
                
                variables = {
                    type: "task",
                    task_id: taskData.task_id,
                    task_status: taskData.status,
                    task_billing: taskData.billing_status == "0" ? "Pending" : (taskData.billing_status == "1" ? "Completed" : "Non Billable"),
                    fees: taskData.fees,
                    tax_rate: taskData.tax_rate,
                    tax_value: taskData.tax_value,
                    total: taskData.total,
                    due_date: taskData.due_date,
                    target_date: taskData.target_date,
                    created_date: taskData.create_date,
                    completed_date: taskData.complete_date,
                    is_recurring: taskData.is_recurring == "1" ? "Yes" : "No",
                    service_name: taskData.service_name,
                    service_sac_code: taskData.sac_code,
                    service_type: taskData.service_type,
                    client_name: taskProfile.name,
                    client_email: taskProfile.email,
                    client_mobile: taskProfile.mobile,
                    client_username: taskProfile.username,
                    firm_name: taskFirm.firm_name,
                    firm_type: taskFirm.firm_type,
                    firm_gst: taskFirm.gst_no,
                    firm_pan: taskFirm.pan_no
                };
            }
            break;
        }
        case "firm": {
            const [firm] = await pool.query(
                `SELECT f.*, p.name as client_name, p.email, p.mobile, p.username
                 FROM firms f
                 LEFT JOIN profile p ON p.username = f.username
                 WHERE f.firm_id = ? AND f.branch_id = ? AND (f.is_deleted = '0' OR f.is_deleted = 0)`,
                [identifier, branch_id]
            );
            
            if (firm.length) {
                const firmData = firm[0];
                variables = {
                    type: "firm",
                    firm_id: firmData.firm_id,
                    firm_name: firmData.firm_name,
                    firm_type: firmData.firm_type,
                    gst_no: firmData.gst_no,
                    pan_no: firmData.pan_no,
                    tan_no: firmData.tan_no,
                    vat_no: firmData.vat_no,
                    cin_no: firmData.cin_no,
                    file_no: firmData.file_no,
                    firm_address: firmData.address_line_1,
                    firm_city: firmData.city,
                    firm_state: firmData.state,
                    firm_pincode: firmData.pincode,
                    client_name: firmData.client_name,
                    client_email: firmData.email,
                    client_mobile: firmData.mobile,
                    client_username: firmData.username
                };
            }
            break;
        }
        case "invoice": {
            const [invoice] = await pool.query(
                `SELECT i.*, t.party1_id, t.party1_type, t.party2_id, t.party2_type
                 FROM invoice i
                 LEFT JOIN transactions t ON t.transaction_id = i.transaction_id
                 WHERE i.invoice_id = ? AND i.branch_id = ?`,
                [identifier, branch_id]
            );
            
            if (invoice.length) {
                const inv = invoice[0];
                const counterpartyId = inv.type === "sale" ? inv.party2_id : inv.party1_id;
                const counterpartyProfile = counterpartyId ? await getProfileData(counterpartyId) : {};
                const counterpartyFirm = counterpartyId ? await getFirmData(counterpartyId) : {};

                variables = {
                    type: "invoice",
                    invoice_id: inv.invoice_id,
                    invoice_no: inv.invoice_no,
                    invoice_date: inv.create_date,
                    subtotal: inv.subtotal,
                    discount_type: inv.discount_type,
                    discount_perc: inv.discount_perc_rate,
                    discount_value: inv.discount_value,
                    tax_rate: inv.tax_rate,
                    tax_value: inv.tax_value,
                    additional_charge: inv.additional_charge,
                    total: inv.total,
                    round_off: inv.round_off,
                    grand_total: inv.grand_total,
                    firm_name: counterpartyFirm.firm_name,
                    client_name: counterpartyProfile.name,
                    client_email: counterpartyProfile.email,
                    client_mobile: counterpartyProfile.mobile
                };
            }
            break;
        }
        case "transaction": {
            const [transaction] = await pool.query(
                `SELECT t.*, 
                        CASE 
                            WHEN t.party1_type = 'firm' THEN (SELECT firm_name FROM firms WHERE firm_id = t.party1_id)
                            WHEN t.party1_type = 'profile' THEN (SELECT name FROM profile WHERE username = t.party1_id)
                            ELSE t.party1_id
                        END as party1_name,
                        CASE 
                            WHEN t.party2_type = 'firm' THEN (SELECT firm_name FROM firms WHERE firm_id = t.party2_id)
                            WHEN t.party2_type = 'profile' THEN (SELECT name FROM profile WHERE username = t.party2_id)
                            ELSE t.party2_id
                        END as party2_name
                 FROM transactions t
                 WHERE t.transaction_id = ? AND t.branch_id = ?`,
                [identifier, branch_id]
            );
            
            if (transaction.length) {
                const trans = transaction[0];
                variables = {
                    type: "transaction",
                    transaction_id: trans.transaction_id,
                    transaction_date: trans.transaction_date,
                    transaction_type: trans.transaction_type,
                    amount: trans.amount,
                    party1_type: trans.party1_type,
                    party1_name: trans.party1_name,
                    party2_type: trans.party2_type,
                    party2_name: trans.party2_name,
                    remark: trans.remark,
                    invoice_no: trans.invoice_no
                };
            }
            break;
        }
        case "general": {
            const generalProfile = await getProfileData(identifier);
            const generalFirm = await getFirmData(identifier);
            
            const [taskCount] = await pool.query(
                `SELECT COUNT(*) as count FROM tasks WHERE username = ? AND branch_id = ?`,
                [identifier, branch_id]
            );
            
            const [invoiceTotal] = await pool.query(
                `SELECT SUM(i.grand_total) as total FROM invoice i
                 JOIN transactions t ON t.transaction_id = i.transaction_id
                 WHERE (t.party1_id = ? OR t.party2_id = ?) AND i.branch_id = ?`,
                [identifier, identifier, branch_id]
            );
            
            variables = {
                type: "general",
                name: generalProfile.name || identifier,
                username: generalProfile.username,
                email: generalProfile.email,
                mobile: generalProfile.mobile,
                pan_number: generalProfile.pan_number,
                city: generalProfile.city,
                state: generalProfile.state,
                firm_name: generalFirm.firm_name,
                firm_type: generalFirm.firm_type,
                gst_no: generalFirm.gst_no,
                total_tasks: taskCount[0]?.count || 0,
                total_invoice_value: invoiceTotal[0]?.total || 0,
                welcome_message: `Welcome ${generalProfile.name || identifier} to our platform!`,
                current_date: new Date().toISOString().split("T")[0],
                current_year: new Date().getFullYear(),
                current_time: new Date().toLocaleTimeString()
            };
            break;
        }
    }
    return variables;
}

const smsBroadcastController = {
    async createConfig(req, res) {
        try {
            const data = await createConfig({ branch_id: req.branch_id, username: getUsername(req), payload: req.body || {} });
            return sendSuccess(res, "SMS config created successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async updateConfig(req, res) {
        try {
            const data = await updateConfig({ branch_id: req.branch_id, username: getUsername(req), payload: req.body || {} });
            return sendSuccess(res, "SMS config updated successfully", data);
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
            return sendSuccess(res, "SMS config verified successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async setDefaultConfig(req, res) {
        try {
            const { config_id } = req.body || {};
            if (!config_id) throw new Error("config_id is required");
            const data = await setDefaultConfig({ branch_id: req.branch_id, config_id, username: getUsername(req) });
            return sendSuccess(res, "Default SMS config updated successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },
    async changeConfigStatus(req, res) {
        try {
            const { config_id, status } = req.body || {};
            if (!config_id || !status) throw new Error("config_id and status are required");
            const data = await changeStatus({ branch_id: req.branch_id, config_id, status, username: getUsername(req) });
            return sendSuccess(res, "SMS config status updated successfully", data);
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
    async previewTemplateGet(req, res) {
        try {
            const branch_id = req.branch_id;
            const { template_id } = req.params;
            const { type, identifier, ...queryParams } = req.query;

            const template = await getTemplateDetails({ branch_id, template_id });

            let dynamicVars = {};
            if (type && identifier) {
                dynamicVars = await resolveDynamicVariables(branch_id, type, identifier);
            }

            const mergedVars = {
                ...dynamicVars,
                ...queryParams
            };

            const rendered = template.message.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
                return mergedVars[key] !== undefined ? String(mergedVars[key]) : `{{${key}}}`;
            });

            return sendSuccess(res, "Template preview generated successfully", {
                template_id: template.template_id,
                template_name: template.template_name,
                message_snapshot: template.message,
                dlt_template_id: template.dlt_template_id,
                rendered: rendered,
                variables_used: mergedVars
            });
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
    },
    async getDynamicVariables(req, res) {
        try {
            const branch_id = req.branch_id;
            const { type, identifier } = req.params;
            const variables = await resolveDynamicVariables(branch_id, type, identifier);
            
            return sendSuccess(res, "Dynamic variables retrieved", {
                type: type,
                identifier: identifier,
                variables: variables,
                available_keys: Object.keys(variables)
            });
        } catch (error) {
            console.error("Dynamic variables error:", error);
            return sendError(res, error, 500);
        }
    },
    async getVariableKeys(req, res) {
        try {
            const { type } = req.params;
            
            const variableKeys = {
                general: ["name", "email", "mobile", "firm_name", "current_date", "current_year", "company", "support_email"],
                welcome: ["name", "email", "firm_name", "company", "welcome_message", "getting_started_link", "support_email"],
                birthday: ["name", "email", "birthday_date", "age", "offer", "coupon_code", "company"],
                sale: ["name", "discount", "coupon_code", "offer_end_date", "product_name", "original_price", "sale_price", "company"],
                invoice: ["name", "invoice_no", "invoice_date", "due_date", "amount", "payment_link", "company"],
                reminder: ["name", "task_name", "due_date", "days_left", "company"],
                payment_receipt: ["name", "receipt_no", "payment_date", "amount", "payment_method", "transaction_id", "company"],
                newsletter: ["name", "unsubscribe_link", "company", "newsletter_title", "featured_article"]
            };
            
            const keys = variableKeys[type] || variableKeys.general;
            
            return sendSuccess(res, "Variable keys retrieved", {
                template_type: type,
                keys: keys,
                usage: "Use {{variable_name}} in your template"
            });
        } catch (error) {
            return sendError(res, error, 500);
        }
    },
    async uploadRecipients(req, res) {
        const file = req.file || (req.files && req.files[0]);
        if (!file) {
            return sendError(res, new Error("Please upload a file"));
        }
        try {
            const branch_id = req.branch_id;
            const fileBuffer = file.buffer;
            const originalName = file.originalname;
            const isCSV = originalName.toLowerCase().endsWith('.csv');
            
            let headers = [];
            let rows = [];
            
            if (isCSV) {
                const content = fileBuffer.toString('utf-8');
                const lines = content.split(/\r?\n/);
                if (lines.length === 0) {
                    throw new Error("Empty CSV file");
                }
                
                const parseCSVLine = (line) => {
                    const result = [];
                    let inQuote = false;
                    let currentValue = '';
                    for (let i = 0; i < line.length; i++) {
                        const char = line[i];
                        if (char === '"') {
                            inQuote = !inQuote;
                        } else if (char === ',' && !inQuote) {
                            result.push(currentValue.trim().replace(/^"|"$/g, ''));
                            currentValue = '';
                        } else {
                            currentValue += char;
                        }
                    }
                    result.push(currentValue.trim().replace(/^"|"$/g, ''));
                    return result;
                };

                headers = parseCSVLine(lines[0]).filter(h => h !== "");
                for (let i = 1; i < lines.length; i++) {
                    if (!lines[i].trim()) continue;
                    const values = parseCSVLine(lines[i]);
                    const row = {};
                    headers.forEach((h, idx) => {
                        row[h] = values[idx] !== undefined ? values[idx].trim() : '';
                    });
                    rows.push(row);
                }
            } else {
                const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(sheet, { defval: "" });
                rows = data;
                if (rows.length > 0) {
                    headers = Object.keys(rows[0]);
                }
            }
            
            if (headers.length === 0) {
                throw new Error("Could not find any columns/headers in the file");
            }
            
            // Auto-detect columns (suggested mappings)
            const detectedMappings = { mobile: null, name: null };
            const mobilePatterns = ['mobile', 'phone', 'contact', 'mobile_number', 'phone_number', 'mobile number', 'phone number', 'recipient_mobile', 'recipient_phone'];
            const namePatterns = ['name', 'full name', 'fullname', 'client name', 'customer name', 'person name', 'first_name', 'last_name', 'recipient_name'];
            
            for (const header of headers) {
                const lowerHeader = String(header || '').toLowerCase().trim();
                if (!detectedMappings.mobile && mobilePatterns.some(p => lowerHeader === p || lowerHeader.includes(p))) {
                    detectedMappings.mobile = header;
                } else if (!detectedMappings.name && namePatterns.some(p => lowerHeader === p || lowerHeader.includes(p))) {
                    detectedMappings.name = header;
                }
            }
            
            if (!global.uploadedSmsRows) global.uploadedSmsRows = new Map();
            global.uploadedSmsRows.set(branch_id, {
                headers,
                rows,
                detectedMappings,
                uploaded_at: Date.now()
            });
            
            return sendSuccess(res, "File uploaded and parsed successfully", {
                headers,
                total_rows: rows.length,
                detected_mappings: detectedMappings,
                sample_rows: rows.slice(0, 5)
            });
        } catch (error) {
            console.error("SMS uploadRecipients error:", error);
            return sendError(res, error);
        }
    },
    async createBroadcastFromUpload(req, res) {
        try {
            const branch_id = req.branch_id;
            const username = getUsername(req);
            const {
                config_id,
                template_id,
                broadcast_name,
                schedule_type = "now",
                scheduled_at = null,
                timezone = "Asia/Kolkata",
                global_variables_json = {},
                daily_limit = 1000,
                column_mappings
            } = req.body || {};

            if (!template_id || !broadcast_name) {
                throw new Error("template_id and broadcast_name are required");
            }
            if (!column_mappings || !column_mappings.recipient_mobile) {
                throw new Error("column_mappings.recipient_mobile is required to map phone numbers");
            }

            if (!global.uploadedSmsRows || !global.uploadedSmsRows.has(branch_id)) {
                throw new Error("No uploaded file found. Please upload a CSV or Excel file first.");
            }

            const { rows, headers } = global.uploadedSmsRows.get(branch_id);

            if (!headers.includes(column_mappings.recipient_mobile)) {
                throw new Error(`Mobile column "${column_mappings.recipient_mobile}" not found in uploaded file headers: ${headers.join(', ')}`);
            }
            if (column_mappings.recipient_name && !headers.includes(column_mappings.recipient_name)) {
                throw new Error(`Name column "${column_mappings.recipient_name}" not found in uploaded file headers: ${headers.join(', ')}`);
            }

            const template = await getTemplateDetails({ branch_id, template_id });
            const templateVars = Array.isArray(template.variables_json)
                ? template.variables_json
                : (typeof template.variables_json === 'string' ? JSON.parse(template.variables_json) : []);

            // Validate that all template variables (not globally defined) are mapped to valid columns in the upload
            let globals = global_variables_json || {};
            if (typeof globals === 'string') {
                try {
                    globals = JSON.parse(globals);
                } catch {
                    globals = {};
                }
            }
            const variableMappings = column_mappings.variables || {};
            for (const varName of templateVars) {
                if (globals[varName] === undefined) {
                    const fileColumn = variableMappings[varName];
                    if (!fileColumn) {
                        throw new Error(`Template variable "${varName}" must be mapped to a column in your file or defined in global_variables_json`);
                    }
                    if (!headers.includes(fileColumn)) {
                        throw new Error(`Mapped column "${fileColumn}" for template variable "${varName}" not found in uploaded file headers: ${headers.join(', ')}`);
                    }
                }
            }

            const mappedRecipients = [];
            const errors = [];

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const mobileRaw = row[column_mappings.recipient_mobile];
                const mobile = String(mobileRaw || '').trim();

                if (!mobile) {
                    errors.push({ row: i + 2, error: "Mobile number is empty" });
                    continue;
                }

                const isValidMobile = (num) => /^\+?[0-9]{10,15}$/.test(String(num).trim());
                if (!isValidMobile(mobile)) {
                    errors.push({ row: i + 2, mobile, error: "Invalid mobile number format" });
                    continue;
                }

                const nameCol = column_mappings.recipient_name;
                const name = nameCol && row[nameCol] ? String(row[nameCol]).trim() : null;

                const variableValues = {};
                if (column_mappings.variables) {
                    for (const varName of templateVars) {
                        const fileColumn = column_mappings.variables[varName];
                        if (fileColumn && row[fileColumn] !== undefined) {
                            variableValues[varName] = String(row[fileColumn]).trim();
                        } else {
                            variableValues[varName] = "";
                        }
                    }
                }

                mappedRecipients.push({
                    recipient_name: name,
                    recipient_mobile: mobile,
                    variable_values_json: variableValues
                });
            }

            if (mappedRecipients.length === 0) {
                throw new Error("No valid recipients could be mapped from the uploaded file");
            }

            const broadcastPayload = {
                config_id,
                template_id,
                broadcast_name,
                schedule_type,
                scheduled_at,
                timezone,
                global_variables_json,
                daily_limit,
                recipients: mappedRecipients
            };

            const data = await createBroadcast({
                branch_id,
                username,
                payload: broadcastPayload
            });

            global.uploadedSmsRows.delete(branch_id);

            return sendSuccess(res, "Broadcast created successfully from uploaded file", {
                broadcast: data,
                total_rows: rows.length,
                valid_recipients: mappedRecipients.length,
                invalid_entries: errors.length,
                errors: errors.slice(0, 50)
            });

        } catch (error) {
            console.error("SMS createBroadcastFromUpload error:", error);
            return sendError(res, error);
        }
    },
    async getUploadedRecipientsInfo(req, res) {
        try {
            const branch_id = req.branch_id;
            if (!global.uploadedSmsRows || !global.uploadedSmsRows.has(branch_id)) {
                return sendSuccess(res, "No uploaded recipients found", { has_upload: false });
            }
            const info = global.uploadedSmsRows.get(branch_id);
            return sendSuccess(res, "Uploaded recipients details retrieved", {
                has_upload: true,
                headers: info.headers,
                detected_mappings: info.detectedMappings,
                total_rows: info.rows.length,
                uploaded_at: new Date(info.uploaded_at).toISOString()
            });
        } catch (error) {
            return sendError(res, error);
        }
    },
    async clearUploadedRecipients(req, res) {
        try {
            const branch_id = req.branch_id;
            if (global.uploadedSmsRows && global.uploadedSmsRows.has(branch_id)) {
                global.uploadedSmsRows.delete(branch_id);
            }
            return sendSuccess(res, "Uploaded recipients cleared successfully");
        } catch (error) {
            return sendError(res, error);
        }
    }
};

export default smsBroadcastController;
