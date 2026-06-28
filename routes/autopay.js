import express from "express";
import cron from 'node-cron';
import crypto from "crypto";
import nodemailer from "nodemailer";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE } from "../helpers/function.js";

const router = express.Router();

const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
let schedulerInitialized = false;

function ok(res, message, data = {}, pagination) {
    return res.json({ success: true, message, data, ...(pagination ? { pagination } : {}) });
}

function fail(res, message, code = 400) {
    return res.status(code).json({ success: false, message });
}

function userFromReq(req) {
    return req.headers.username || req.headers.Username || null;
}

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function parseJSON(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function getEncKey() {
    const base = process.env.SMTP_ENCRYPTION_KEY || "ooms-default-smtp-encryption-key-change-me";
    return crypto.createHash("sha256").update(base).digest();
}

function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getEncKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(text || ""), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(payload) {
    if (!payload) return "";
    const buf = Buffer.from(String(payload), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function renderTemplate(text, variables) {
    return String(text || "").replace(VARIABLE_REGEX, (_, key) => String(variables?.[key] ?? ""));
}

// ==================== HELPER FUNCTIONS ====================

async function getUserByUsername(branch_id, username) {
    const [rows] = await pool.query(
        `SELECT username, name, email, mobile, status FROM profile WHERE username = ? AND status = 1`,
        [username]
    );
    
    if (!rows.length) {
        throw new Error(`User not found with username: ${username}`);
    }
    return rows[0];
}

async function getUserBalance(branch_id, username) {
    try {
        const balanceData = await GET_BALANCE({
            branch_id: branch_id,
            party_id: username,
            party_type: "client"
        });
        return balanceData;
    } catch (error) {
        console.error("Error getting balance:", error);
        return { balance: 0, debit: 0, credit: 0 };
    }
}

async function getActivePaymentTemplate(branch_id) {
    const [rows] = await pool.query(
        `SELECT template_id, template_type, template_name, subject, html_body, text_body, is_default
         FROM email_static_templates 
         WHERE branch_id = ? AND template_type = 'payment_reminder' AND status = 'active'
         ORDER BY is_default DESC, create_date DESC
         LIMIT 1`,
        [branch_id]
    );
    
    if (!rows.length) {
        throw new Error(`No active payment reminder template found`);
    }
    
    return rows[0];
}

async function getActiveSmtpConfig(branch_id, config_id = null) {
    let query = `SELECT * FROM email_configs WHERE branch_id = ? AND status = 'active'`;
    let params = [branch_id];
    
    if (config_id) {
        query += ` AND config_id = ?`;
        params.push(config_id);
    } else {
        query += ` ORDER BY is_default DESC LIMIT 1`;
    }
    
    const [rows] = await pool.query(query, params);
    
    if (!rows.length) {
        throw new Error("No active SMTP config found");
    }
    
    const config = rows[0];
    config.password = decrypt(config.password_encrypted);
    return config;
}

async function sendEmail(smtpConfig, to, subject, html, text = null) {
    const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: Number(smtpConfig.port),
        secure: Number(smtpConfig.secure) === 1 || Number(smtpConfig.port) === 465,
        auth: {
            user: smtpConfig.username,
            pass: smtpConfig.password
        }
    });
    
    const from = smtpConfig.from_name 
        ? `${smtpConfig.from_name} <${smtpConfig.from_email}>`
        : smtpConfig.from_email;
    
    const mailOptions = { from, to, subject, html, ...(text && { text }) };
    return await transporter.sendMail(mailOptions);
}

async function preparePaymentReminderVariables(branch_id, username, user, balanceData) {
    const [firm] = await pool.query(
        `SELECT firm_name FROM firms WHERE username = ? AND branch_id = ? AND status = '1' LIMIT 1`,
        [username, branch_id]
    );
    
    const hasDebitBalance = balanceData.debit > 0;
    const formattedBalance = `₹${Math.abs(balanceData.balance).toLocaleString('en-IN')}`;
    
    return {
        name: user.name || username,
        username: user.username,
        email: user.email,
        mobile: user.mobile,
        balance: formattedBalance,
        balance_amount: Math.abs(balanceData.balance),
        debit_amount: `₹${balanceData.debit.toLocaleString('en-IN')}`,
        credit_amount: `₹${balanceData.credit.toLocaleString('en-IN')}`,
        has_debit: hasDebitBalance,
        firm_name: firm.length ? firm[0].firm_name : 'Your Firm',
        current_date: new Date().toLocaleDateString('en-GB'),
        current_year: new Date().getFullYear(),
        payment_link: `${process.env.APP_URL || 'https://yourdomain.com'}/payment/${username}`,
        support_email: process.env.SUPPORT_EMAIL || 'support@yourdomain.com',
        support_phone: process.env.SUPPORT_PHONE || '+91-XXXXXXXXXX'
    };
}

// ==================== SCHEDULER FUNCTIONS ====================

/**
 * Check if group should run at the current time based on schedule config
 */
function shouldRunNow(schedule_type, scheduleConfig) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const currentDayOfMonth = now.getDate();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    
    // Check time first
    const scheduledTime = scheduleConfig.time;
    if (scheduledTime) {
        const [hour, minute] = scheduledTime.split(':').map(Number);
        if (currentHour !== hour || currentMinute !== minute) {
            return false;
        }
    }
    
    switch (schedule_type) {
        case 'daily':
            // Check specific days of week (if provided)
            if (scheduleConfig.days && Array.isArray(scheduleConfig.days) && scheduleConfig.days.length > 0) {
                // Convert day numbers (Monday=1 to Sunday=0 or 7)
                const normalizedDays = scheduleConfig.days.map(d => {
                    if (d === 0 || d === 7) return 0; // Sunday
                    return d;
                });
                return normalizedDays.includes(currentDayOfWeek);
            }
            return true; // Every day
            
        case 'weekly':
            // Check specific day of week
            const scheduledDay = scheduleConfig.day_of_week;
            if (scheduledDay !== undefined) {
                const normalizedScheduledDay = scheduledDay === 7 ? 0 : scheduledDay;
                return currentDayOfWeek === normalizedScheduledDay;
            }
            return false;
            
        case 'monthly':
            // Check specific date or pattern
            if (scheduleConfig.day_of_month && scheduleConfig.day_of_month > 0) {
                return currentDayOfMonth === scheduleConfig.day_of_month;
            }
            if (scheduleConfig.week_of_month && scheduleConfig.day_of_week) {
                // e.g., "first Monday", "second Tuesday", "last Friday"
                return isMatchingWeekdayOfMonth(currentYear, currentMonth, currentDayOfMonth, scheduleConfig);
            }
            if (scheduleConfig.last_day_of_month) {
                const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
                return currentDayOfMonth === lastDay;
            }
            return false;
            
        default:
            return false;
    }
}

/**
 * Check if current day matches a specific weekday pattern in month (e.g., "first Monday")
 */
function isMatchingWeekdayOfMonth(year, month, day, scheduleConfig) {
    const date = new Date(year, month, day);
    const currentDayOfWeek = date.getDay();
    const weekOfMonth = Math.ceil(day / 7);
    const isLastWeek = day > new Date(year, month + 1, 0).getDate() - 7;
    
    const scheduledDayOfWeek = scheduleConfig.day_of_week;
    const scheduledWeekOfMonth = scheduleConfig.week_of_month;
    
    if (scheduledDayOfWeek !== currentDayOfWeek) return false;
    
    if (scheduledWeekOfMonth === 'last') {
        return isLastWeek;
    }
    return weekOfMonth === scheduledWeekOfMonth;
}

/**
 * Process all groups that are scheduled to run at current time
 */
async function processScheduledGroups() {
    const now = new Date();
    console.log(`[Scheduler] Running at ${now.toLocaleString()}`);
    
    try {
        // Get all active groups
        const [groups] = await pool.query(
            `SELECT group_id, branch_id, schedule_type, schedule_config 
             FROM autopay_groups 
             WHERE is_active = 1`
        );
        
        console.log(`[Scheduler] Found ${groups.length} active groups`);
        
        for (const group of groups) {
            const scheduleConfig = parseJSON(group.schedule_config, {});
            
            // Check if this group should run now
            if (shouldRunNow(group.schedule_type, scheduleConfig)) {
                console.log(`[Scheduler] Processing group: ${group.group_id} (${group.schedule_type})`);
                
                // Process in background without waiting
                processAutopayGroup(group.group_id, group.branch_id).catch(err => {
                    console.error(`[Scheduler] Error processing group ${group.group_id}:`, err);
                });
            }
        }
    } catch (error) {
        console.error("[Scheduler] Error:", error);
    }
}

// ==================== AUTO PAY GROUP CRUD ====================

/**
 * Create a new autopay group
 * POST /api/autopay/group/create
 * Body: { 
 *   group_name, description, schedule_type, schedule_config, is_active 
 * }
 * 
 * schedule_config examples:
 * Daily: { time: "09:00", days: [1,2,3,4,5] } // Monday-Friday at 9 AM
 * Daily: { time: "10:30" } // Every day at 10:30 AM
 * Weekly: { day_of_week: 1, time: "14:00" } // Every Monday at 2 PM
 * Monthly: { day_of_month: 15, time: "11:00" } // 15th of every month at 11 AM
 * Monthly: { week_of_month: 1, day_of_week: 1, time: "09:00" } // First Monday of month
 * Monthly: { last_day_of_month: true, time: "17:00" } // Last day of month at 5 PM
 */
router.post("/group/create", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { group_name, description, schedule_type, schedule_config, is_active = 1 } = req.body || {};

        if (!group_name || !schedule_type || !schedule_config) {
            return fail(res, "group_name, schedule_type and schedule_config are required");
        }

        const validScheduleTypes = ['daily', 'weekly', 'monthly'];
        if (!validScheduleTypes.includes(schedule_type)) {
            return fail(res, "schedule_type must be daily, weekly, or monthly");
        }

        // Validate schedule_config based on type
        if (schedule_type === 'daily') {
            if (!schedule_config.time) {
                return fail(res, "daily schedule requires time field");
            }
        } else if (schedule_type === 'weekly') {
            if (!schedule_config.day_of_week || !schedule_config.time) {
                return fail(res, "weekly schedule requires day_of_week and time fields");
            }
        } else if (schedule_type === 'monthly') {
            if (!schedule_config.time) {
                return fail(res, "monthly schedule requires time field");
            }
            if (!schedule_config.day_of_month && !schedule_config.week_of_month && !schedule_config.last_day_of_month) {
                return fail(res, "monthly schedule requires day_of_month, week_of_month, or last_day_of_month");
            }
        }

        const group_id = newId("apg");
        
        await pool.query(
            `INSERT INTO autopay_groups 
             (group_id, branch_id, group_name, description, schedule_type, schedule_config, is_active, create_by, create_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [group_id, branch_id, group_name, description, schedule_type, JSON.stringify(schedule_config), is_active, username]
        );

        return ok(res, "Autopay group created successfully", { group_id });
    } catch (error) {
        console.error("Create group error:", error);
        return fail(res, error.message);
    }
});

/**
 * Update autopay group
 * PUT /api/autopay/group/update
 */
router.put("/group/update", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { group_id, group_name, description, schedule_type, schedule_config, is_active } = req.body || {};

        if (!group_id) {
            return fail(res, "group_id is required");
        }

        const updates = [];
        const values = [];

        if (group_name) {
            updates.push("group_name = ?");
            values.push(group_name);
        }
        if (description !== undefined) {
            updates.push("description = ?");
            values.push(description);
        }
        if (schedule_type) {
            updates.push("schedule_type = ?");
            values.push(schedule_type);
        }
        if (schedule_config) {
            updates.push("schedule_config = ?");
            values.push(JSON.stringify(schedule_config));
        }
        if (is_active !== undefined) {
            updates.push("is_active = ?");
            values.push(is_active);
        }

        updates.push("modify_by = ?, modify_date = NOW()");
        values.push(username);
        values.push(group_id, branch_id);

        const [result] = await pool.query(
            `UPDATE autopay_groups SET ${updates.join(", ")} WHERE group_id = ? AND branch_id = ?`,
            values
        );

        if (!result.affectedRows) {
            return fail(res, "Group not found", 404);
        }

        return ok(res, "Autopay group updated successfully");
    } catch (error) {
        console.error("Update group error:", error);
        return fail(res, error.message);
    }
});

/**
 * Get all autopay groups with formatted schedule display
 * GET /api/autopay/group/list
 */
router.get("/group/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;

        const [groups] = await pool.query(
            `SELECT g.*, 
                    COUNT(DISTINCT gm.member_id) as member_count
             FROM autopay_groups g
             LEFT JOIN autopay_group_members gm ON gm.group_id = g.group_id AND gm.status = 'active'
             WHERE g.branch_id = ?
             GROUP BY g.group_id
             ORDER BY g.create_date DESC
             LIMIT ? OFFSET ?`,
            [branch_id, limit, offset]
        );

        const [totalRows] = await pool.query(
            "SELECT COUNT(*) as total FROM autopay_groups WHERE branch_id = ?",
            [branch_id]
        );

        // Format schedule display for each group
        const formattedGroups = groups.map(group => {
            const config = parseJSON(group.schedule_config, {});
            let scheduleDisplay = '';
            
            if (group.schedule_type === 'daily') {
                if (config.days && config.days.length > 0 && config.days.length < 7) {
                    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                    const days = config.days.map(d => dayNames[d === 7 ? 0 : d]);
                    scheduleDisplay = `Every ${days.join(', ')} at ${config.time}`;
                } else {
                    scheduleDisplay = `Every day at ${config.time}`;
                }
            } else if (group.schedule_type === 'weekly') {
                const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const day = dayNames[config.day_of_week === 7 ? 0 : config.day_of_week];
                scheduleDisplay = `Every ${day} at ${config.time}`;
            } else if (group.schedule_type === 'monthly') {
                if (config.day_of_month) {
                    scheduleDisplay = `Every ${config.day_of_month}${getOrdinalSuffix(config.day_of_month)} of month at ${config.time}`;
                } else if (config.week_of_month && config.day_of_week) {
                    const weekNames = ['first', 'second', 'third', 'fourth'];
                    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                    scheduleDisplay = `Every ${weekNames[config.week_of_month - 1]} ${dayNames[config.day_of_week]} of month at ${config.time}`;
                } else if (config.last_day_of_month) {
                    scheduleDisplay = `Every last day of month at ${config.time}`;
                }
            }
            
            return {
                ...group,
                schedule_config: config,
                schedule_display: scheduleDisplay
            };
        });

        return ok(res, "Groups retrieved successfully", formattedGroups, {
            page_no,
            limit,
            total: totalRows[0]?.total || 0,
            total_pages: Math.ceil((totalRows[0]?.total || 0) / limit)
        });
    } catch (error) {
        console.error("Get groups error:", error);
        return fail(res, error.message);
    }
});

function getOrdinalSuffix(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Get group details
 * GET /api/autopay/group/details/:group_id
 */
router.get("/group/details/:group_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { group_id } = req.params;

        const [groups] = await pool.query(
            `SELECT * FROM autopay_groups WHERE branch_id = ? AND group_id = ?`,
            [branch_id, group_id]
        );

        if (!groups.length) {
            return fail(res, "Group not found", 404);
        }

        groups[0].schedule_config = parseJSON(groups[0].schedule_config, {});

        return ok(res, "Group details retrieved successfully", groups[0]);
    } catch (error) {
        console.error("Get group details error:", error);
        return fail(res, error.message);
    }
});

/**
 * Delete autopay group (soft delete)
 * DELETE /api/autopay/group/delete/:group_id
 */
router.delete("/group/delete/:group_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { group_id } = req.params;

        const [result] = await pool.query(
            `UPDATE autopay_groups SET is_active = 0, modify_date = NOW() WHERE branch_id = ? AND group_id = ?`,
            [branch_id, group_id]
        );

        if (!result.affectedRows) {
            return fail(res, "Group not found", 404);
        }

        return ok(res, "Group deleted successfully");
    } catch (error) {
        console.error("Delete group error:", error);
        return fail(res, error.message);
    }
});

// ==================== GROUP MEMBERS (CLIENTS) ====================

/**
 * Add members to autopay group
 * POST /api/autopay/group/add-members
 */
router.post("/group/add-members", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { group_id, usernames } = req.body || {};

        if (!group_id || !usernames || !Array.isArray(usernames) || usernames.length === 0) {
            return fail(res, "group_id and usernames array are required");
        }

        const [groups] = await pool.query(
            `SELECT group_id FROM autopay_groups WHERE branch_id = ? AND group_id = ?`,
            [branch_id, group_id]
        );

        if (!groups.length) {
            return fail(res, "Group not found", 404);
        }

        let added = 0;
        let skipped = 0;

        for (const username of usernames) {
            const [users] = await pool.query(
                `SELECT username FROM profile WHERE username = ? AND status = 1`,
                [username]
            );

            if (!users.length) {
                skipped++;
                continue;
            }

            const [existing] = await pool.query(
                `SELECT member_id FROM autopay_group_members WHERE group_id = ? AND username = ?`,
                [group_id, username]
            );

            if (existing.length) {
                await pool.query(
                    `UPDATE autopay_group_members SET status = 'active', modify_date = NOW() WHERE group_id = ? AND username = ?`,
                    [group_id, username]
                );
            } else {
                await pool.query(
                    `INSERT INTO autopay_group_members (member_id, group_id, branch_id, username, status, added_by, added_date)
                     VALUES (?, ?, ?, ?, 'active', ?, NOW())`,
                    [newId("apm"), group_id, branch_id, username, userFromReq(req)]
                );
            }
            added++;
        }

        return ok(res, "Members added successfully", { added, skipped });
    } catch (error) {
        console.error("Add members error:", error);
        return fail(res, error.message);
    }
});

/**
 * Remove members from autopay group
 * POST /api/autopay/group/remove-members
 */
router.post("/group/remove-members", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { group_id, usernames } = req.body || {};

        if (!group_id || !usernames || !Array.isArray(usernames) || usernames.length === 0) {
            return fail(res, "group_id and usernames array are required");
        }

        const placeholders = usernames.map(() => '?').join(',');
        const [result] = await pool.query(
            `UPDATE autopay_group_members 
             SET status = 'inactive', modify_date = NOW() 
             WHERE group_id = ? AND username IN (${placeholders})`,
            [group_id, ...usernames]
        );

        return ok(res, "Members removed successfully", { removed: result.affectedRows });
    } catch (error) {
        console.error("Remove members error:", error);
        return fail(res, error.message);
    }
});

/**
 * Get group members with their debit status
 * GET /api/autopay/group/members/:group_id
 */
router.get("/group/members/:group_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { group_id } = req.params;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;

        const [members] = await pool.query(
            `SELECT gm.*, p.name, p.email, p.mobile
             FROM autopay_group_members gm
             JOIN profile p ON p.username = gm.username
             WHERE gm.group_id = ? AND gm.branch_id = ? AND gm.status = 'active'
             LIMIT ? OFFSET ?`,
            [group_id, branch_id, limit, offset]
        );

        for (const member of members) {
            const balanceData = await getUserBalance(branch_id, member.username);
            member.balance = balanceData.balance;
            member.debit = balanceData.debit;
            member.credit = balanceData.credit;
            member.has_debit = balanceData.debit > 0;
        }

        const [totalRows] = await pool.query(
            `SELECT COUNT(*) as total FROM autopay_group_members WHERE group_id = ? AND branch_id = ? AND status = 'active'`,
            [group_id, branch_id]
        );

        return ok(res, "Group members retrieved successfully", members, {
            page_no,
            limit,
            total: totalRows[0]?.total || 0,
            total_pages: Math.ceil((totalRows[0]?.total || 0) / limit)
        });
    } catch (error) {
        console.error("Get members error:", error);
        return fail(res, error.message);
    }
});

// ==================== AUTO PAY PROCESSING ====================

/**
 * Process autopay for a specific group (manual trigger)
 * POST /api/autopay/process/group/:group_id
 */
router.post("/process/group/:group_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { group_id } = req.params;

        const [groups] = await pool.query(
            `SELECT * FROM autopay_groups WHERE branch_id = ? AND group_id = ? AND is_active = 1`,
            [branch_id, group_id]
        );

        if (!groups.length) {
            return fail(res, "Active group not found", 404);
        }

        const result = await processAutopayGroup(group_id, branch_id);
        return ok(res, "Autopay processed successfully", result);
    } catch (error) {
        console.error("Process group error:", error);
        return fail(res, error.message);
    }
});

/**
 * Process all active autopay groups (for scheduler)
 * GET /api/autopay/process/all
 */
router.get("/process/all", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        
        const [groups] = await pool.query(
            `SELECT group_id FROM autopay_groups WHERE branch_id = ? AND is_active = 1`,
            [branch_id]
        );

        const results = [];
        for (const group of groups) {
            const result = await processAutopayGroup(group.group_id, branch_id);
            results.push({ group_id: group.group_id, ...result });
        }

        return ok(res, "All autopay groups processed", results);
    } catch (error) {
        console.error("Process all error:", error);
        return fail(res, error.message);
    }
});

/**
 * Core function to process autopay for a group
 */
async function processAutopayGroup(group_id, branch_id) {
    const log_id = newId("apl");
    
    try {
        const [groups] = await pool.query(
            `SELECT * FROM autopay_groups WHERE group_id = ?`,
            [group_id]
        );

        if (!groups.length) {
            throw new Error("Group not found");
        }

        const group = groups[0];
        const scheduleConfig = parseJSON(group.schedule_config, {});
        
        // Get active members
        const [members] = await pool.query(
            `SELECT username FROM autopay_group_members WHERE group_id = ? AND status = 'active'`,
            [group_id]
        );

        if (!members.length) {
            await pool.query(
                `INSERT INTO autopay_logs (log_id, group_id, branch_id, status, message, run_date, completed_at)
                 VALUES (?, ?, ?, 'failed', 'No active members in group', NOW(), NOW())`,
                [log_id, group_id, branch_id]
            );
            return { processed: 0, sent: 0, skipped: 0, failed: 0, status: "failed", reason: "No active members" };
        }

        // Get template and SMTP config
        const template = await getActivePaymentTemplate(branch_id);
        const smtpConfig = await getActiveSmtpConfig(branch_id);

        let sent = 0;
        let skipped = 0;
        let failed = 0;
        const details = [];

        for (const member of members) {
            try {
                const user = await getUserByUsername(branch_id, member.username);
                
                if (!user.email) {
                    skipped++;
                    details.push({ username: member.username, status: "skipped", reason: "No email address" });
                    continue;
                }

                const balanceData = await getUserBalance(branch_id, member.username);
                
                if (balanceData.debit <= 0) {
                    skipped++;
                    details.push({ username: member.username, status: "skipped", reason: "No debit balance", debit: balanceData.debit });
                    continue;
                }

                const variables = await preparePaymentReminderVariables(branch_id, member.username, user, balanceData);
                const subject = renderTemplate(template.subject, variables);
                const htmlBody = renderTemplate(template.html_body, variables);
                
                await sendEmail(smtpConfig, user.email, subject, htmlBody);
                sent++;
                details.push({ username: member.username, status: "sent", email: user.email, debit: balanceData.debit });

                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                failed++;
                details.push({ username: member.username, status: "failed", reason: error.message });
                console.error(`Error processing ${member.username}:`, error);
            }
        }

        await pool.query(
            `INSERT INTO autopay_logs (log_id, group_id, branch_id, status, message, details, sent_count, skipped_count, failed_count, run_date, completed_at)
             VALUES (?, ?, ?, 'completed', 'Autopay processed successfully', ?, ?, ?, ?, NOW(), NOW())`,
            [log_id, group_id, branch_id, JSON.stringify(details), sent, skipped, failed]
        );

        return { processed: members.length, sent, skipped, failed, status: "completed", details };
        
    } catch (error) {
        console.error("Process autopay error:", error);
        await pool.query(
            `INSERT INTO autopay_logs (log_id, group_id, branch_id, status, message, error_message, run_date, completed_at)
             VALUES (?, ?, ?, 'failed', 'Autopay processing failed', ?, NOW(), NOW())`,
            [log_id, group_id, branch_id, error.message]
        );
        return { processed: 0, sent: 0, skipped: 0, failed: 0, status: "failed", reason: error.message };
    }
}

// ==================== AUTO PAY LOGS ====================

/**
 * Get autopay logs
 * GET /api/autopay/logs
 */
router.get("/logs", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;
        const group_id = req.query.group_id;

        let query = `
            SELECT l.*, g.group_name
            FROM autopay_logs l
            JOIN autopay_groups g ON g.group_id = l.group_id
            WHERE l.branch_id = ?
        `;
        const params = [branch_id];

        if (group_id) {
            query += ` AND l.group_id = ?`;
            params.push(group_id);
        }

        query += ` ORDER BY l.run_date DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [logs] = await pool.query(query, params);

        logs.forEach(log => {
            log.details = parseJSON(log.details, []);
        });

        const [totalRows] = await pool.query(
            `SELECT COUNT(*) as total FROM autopay_logs WHERE branch_id = ?${group_id ? ' AND group_id = ?' : ''}`,
            group_id ? [branch_id, group_id] : [branch_id]
        );

        return ok(res, "Logs retrieved successfully", logs, {
            page_no,
            limit,
            total: totalRows[0]?.total || 0,
            total_pages: Math.ceil((totalRows[0]?.total || 0) / limit)
        });
    } catch (error) {
        console.error("Get logs error:", error);
        return fail(res, error.message);
    }
});

/**
 * Get autopay log details
 * GET /api/autopay/logs/:log_id
 */
router.get("/logs/:log_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { log_id } = req.params;

        const [logs] = await pool.query(
            `SELECT l.*, g.group_name, g.schedule_type
             FROM autopay_logs l
             JOIN autopay_groups g ON g.group_id = l.group_id
             WHERE l.branch_id = ? AND l.log_id = ?`,
            [branch_id, log_id]
        );

        if (!logs.length) {
            return fail(res, "Log not found", 404);
        }

        logs[0].details = parseJSON(logs[0].details, []);

        return ok(res, "Log details retrieved successfully", logs[0]);
    } catch (error) {
        console.error("Get log details error:", error);
        return fail(res, error.message);
    }
});

// ==================== DASHBOARD STATS ====================

/**
 * Get autopay dashboard statistics
 * GET /api/autopay/stats
 */
router.get("/stats", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [groupStats] = await pool.query(
            `SELECT 
                COUNT(*) as total_groups,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_groups,
                SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive_groups
             FROM autopay_groups WHERE branch_id = ?`,
            [branch_id]
        );

        const [memberStats] = await pool.query(
            `SELECT 
                COUNT(*) as total_members,
                COUNT(DISTINCT group_id) as groups_with_members
             FROM autopay_group_members WHERE branch_id = ? AND status = 'active'`,
            [branch_id]
        );

        const [lastRun] = await pool.query(
            `SELECT 
                COUNT(*) as total_runs,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_runs,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
                SUM(sent_count) as total_sent,
                SUM(skipped_count) as total_skipped,
                SUM(failed_count) as total_failed
             FROM autopay_logs WHERE branch_id = ? AND DATE(run_date) = CURDATE()`,
            [branch_id]
        );

        return ok(res, "Autopay statistics", {
            groups: {
                total: groupStats[0]?.total_groups || 0,
                active: groupStats[0]?.active_groups || 0,
                inactive: groupStats[0]?.inactive_groups || 0
            },
            members: {
                total: memberStats[0]?.total_members || 0,
                groups_with_members: memberStats[0]?.groups_with_members || 0
            },
            today_runs: {
                total_runs: lastRun[0]?.total_runs || 0,
                successful: lastRun[0]?.successful_runs || 0,
                failed: lastRun[0]?.failed_runs || 0,
                total_sent: lastRun[0]?.total_sent || 0,
                total_skipped: lastRun[0]?.total_skipped || 0,
                total_failed: lastRun[0]?.total_failed || 0
            }
        });
    } catch (error) {
        console.error("Get stats error:", error);
        return fail(res, error.message);
    }
});

// ==================== INITIALIZE SCHEDULER ====================

/**
 * Initialize the autopay scheduler - runs every minute to check for due schedules
 */
function initScheduler() {
    if (schedulerInitialized) {
        console.log("[Scheduler] Already initialized, skipping...");
        return;
    }
    
    console.log("[Scheduler] Initializing autopay scheduler...");
    
    // Run every minute to check for schedules
    cron.schedule('* * * * *', async () => {
        await processScheduledGroups();
    });
    
    schedulerInitialized = true;
    console.log("[Scheduler] Autopay scheduler started successfully!");
    
    // Run once on startup to catch any missed schedules
    setTimeout(async () => {
        console.log("[Scheduler] Running initial check on startup...");
        await processScheduledGroups();
    }, 5000);
}

// Auto-initialize scheduler when the route is loaded
initScheduler();

export default router;