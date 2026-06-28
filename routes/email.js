import express from "express";
import crypto from "crypto";
import nodemailer from "nodemailer";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";

const router = express.Router();

const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const BROADCAST_FINAL = ["completed", "partially_failed", "failed", "cancelled"];

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

function parseVariables(...parts) {
  const set = new Set();
  for (const part of parts) {
    const content = String(part || "");
    let match = VARIABLE_REGEX.exec(content);
    while (match) {
      if (match[1]) set.add(match[1]);
      match = VARIABLE_REGEX.exec(content);
    }
    VARIABLE_REGEX.lastIndex = 0;
  }
  return Array.from(set);
}

function renderTemplate(text, variables) {
  return String(text || "").replace(VARIABLE_REGEX, (_, key) => String(variables?.[key] ?? ""));
}
// ==================== NEW HELPER FUNCTIONS FOR FALLBACK & DAILY LIMITS ====================
// Paste this after the renderRecipientEmail function

/**
 * Check and reset daily email limit for a config
 */
async function checkAndResetDailyLimit(configId, branchId) {
    const today = new Date().toISOString().split('T')[0];
    
    // Get or create daily usage record
    let [usage] = await pool.query(
        `SELECT * FROM email_daily_usage 
         WHERE branch_id = ? AND config_id = ? AND usage_date = ?
         LIMIT 1`,
        [branchId, configId, today]
    );
    
    if (!usage.length) {
        // Create new daily usage record
        const [config] = await pool.query(
            `SELECT daily_limit FROM email_configs 
             WHERE branch_id = ? AND config_id = ? AND status = 'active'
             LIMIT 1`,
            [branchId, configId]
        );
        
        const dailyLimit = config.length ? config[0].daily_limit : 1000;
        
        await pool.query(
            `INSERT INTO email_daily_usage (branch_id, config_id, usage_date, emails_sent)
             VALUES (?, ?, ?, 0)`,
            [branchId, configId, today]
        );
        
        return { canSend: true, remaining: dailyLimit, sent: 0, limit: dailyLimit };
    }
    
    const usageRecord = usage[0];
    const [config] = await pool.query(
        `SELECT daily_limit FROM email_configs 
         WHERE branch_id = ? AND config_id = ?
         LIMIT 1`,
        [branchId, configId]
    );
    
    const dailyLimit = config.length ? config[0].daily_limit : 1000;
    const sent = usageRecord.emails_sent || 0;
    const remaining = dailyLimit - sent;
    
    return {
        canSend: remaining > 0,
        remaining: remaining,
        sent: sent,
        limit: dailyLimit
    };
}

/**
 * Increment daily email count for a config
 */
async function incrementDailyCount(configId, branchId) {
    const today = new Date().toISOString().split('T')[0];
    
    await pool.query(
        `INSERT INTO email_daily_usage (branch_id, config_id, usage_date, emails_sent)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE 
         emails_sent = emails_sent + 1,
         updated_at = NOW()`,
        [branchId, configId, today]
    );
    
    // Also update config table for quick access
    await pool.query(
        `UPDATE email_configs 
         SET sent_today = sent_today + 1,
             last_reset_date = ?
         WHERE branch_id = ? AND config_id = ?`,
        [today, branchId, configId]
    );
}

/**
 * Get available config IDs (primary and fallback) that are active and have daily limit remaining
 */
async function getAvailableConfigs(branchId, primaryConfigId, fallbackConfigId = null) {
    const availableConfigs = [];
    
    console.log(`Getting available configs - Primary: ${primaryConfigId}, Fallback: ${fallbackConfigId}`);
    
    // Check primary config
    if (primaryConfigId) {
        const [primary] = await pool.query(
            `SELECT * FROM email_configs 
             WHERE branch_id = ? AND config_id = ? AND status = 'active'
             LIMIT 1`,
            [branchId, primaryConfigId]
        );
        
        if (primary.length) {
            console.log(`Primary config found: ${primary[0].config_name}`);
            const limitCheck = await checkAndResetDailyLimit(primaryConfigId, branchId);
            console.log(`Primary daily limit - canSend: ${limitCheck.canSend}, remaining: ${limitCheck.remaining}`);
            if (limitCheck.canSend) {
                availableConfigs.push({
                    config: primary[0],
                    type: 'primary',
                    priority: 1,
                    remaining: limitCheck.remaining
                });
            }
        } else {
            console.log(`Primary config NOT found or inactive: ${primaryConfigId}`);
        }
    }
    
    // Check fallback config
    if (fallbackConfigId && fallbackConfigId !== primaryConfigId) {
        const [fallback] = await pool.query(
            `SELECT * FROM email_configs 
             WHERE branch_id = ? AND config_id = ? AND status = 'active'
             LIMIT 1`,
            [branchId, fallbackConfigId]
        );
        
        if (fallback.length) {
            console.log(`Fallback config found: ${fallback[0].config_name}`);
            const limitCheck = await checkAndResetDailyLimit(fallbackConfigId, branchId);
            console.log(`Fallback daily limit - canSend: ${limitCheck.canSend}, remaining: ${limitCheck.remaining}`);
            if (limitCheck.canSend) {
                availableConfigs.push({
                    config: fallback[0],
                    type: 'fallback',
                    priority: 2,
                    remaining: limitCheck.remaining
                });
            }
        } else {
            console.log(`Fallback config NOT found or inactive: ${fallbackConfigId}`);
        }
    }
    
    console.log(`Total available configs: ${availableConfigs.length}`);
    return availableConfigs.sort((a, b) => a.priority - b.priority);
}

/**
 * Log email send attempt
 */
async function logSendAttempt(branchId, broadcastId, recipientId, configId, attemptNumber, errorMessage = null) {
    const attemptId = newId('att');
    
    await pool.query(
        `INSERT INTO email_send_attempts 
         (attempt_id, branch_id, broadcast_id, recipient_id, config_id, attempt_number, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [attemptId, branchId, broadcastId, recipientId, configId, attemptNumber, errorMessage]
    );
    
    return attemptId;
}

/**
 * Send email with fallback mechanism and retry logic
 */
async function sendEmailWithFallback(mailOptions, branchId, broadcastId, recipientId, availableConfigs, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Try each available config in priority order
        for (const configInfo of availableConfigs) {
            try {
                // Check if config still has daily limit remaining
                const limitCheck = await checkAndResetDailyLimit(configInfo.config.config_id, branchId);
                if (!limitCheck.canSend) {
                    continue; // Skip this config, try next
                }
                
                // Create transporter for this config
                const fallbackTransporter = nodemailer.createTransport({
                    host: configInfo.config.host,
                    port: Number(configInfo.config.port),
                    secure: Number(configInfo.config.secure) === 1 || Number(configInfo.config.port) === 465,
                    auth: {
                        user: configInfo.config.username,
                        pass: decrypt(configInfo.config.password_encrypted)
                    },
                    from: configInfo.config.from_name ? 
                        `${configInfo.config.from_name} <${configInfo.config.from_email}>` : 
                        configInfo.config.from_email
                });
                
                // Set from address
                mailOptions.from = configInfo.config.from_name ? 
                    `${configInfo.config.from_name} <${configInfo.config.from_email}>` : 
                    configInfo.config.from_email;
                
                // Send email
                const sent = await fallbackTransporter.sendMail(mailOptions);
                
                // Increment daily count for successful send
                await incrementDailyCount(configInfo.config.config_id, branchId);
                
                // Log successful attempt
                await logSendAttempt(branchId, broadcastId, recipientId, configInfo.config.config_id, attempt);
                
                return {
                    success: true,
                    configId: configInfo.config.config_id,
                    configType: configInfo.type,
                    attempt: attempt,
                    messageId: sent.messageId
                };
                
            } catch (error) {
                lastError = error;
                // Log failed attempt
                await logSendAttempt(branchId, broadcastId, recipientId, configInfo.config.config_id, attempt, error.message);
                
                console.log(`Attempt ${attempt} with ${configInfo.type} config ${configInfo.config.config_name} failed:`, error.message);
                continue; // Try next config
            }
        }
        
        // If we exhausted all configs for this attempt, wait before retry (exponential backoff)
        if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
            console.log(`Retrying in ${delay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    // All attempts failed
    return {
        success: false,
        error: lastError ? lastError.message : 'All email sending attempts failed',
        attempts: maxRetries
    };
}

function renderRecipientEmail({ subject, htmlBody, textBody, variables }) {
  return {
    subject: renderTemplate(subject, variables),
    htmlBody: renderTemplate(htmlBody, variables),
    textBody: renderTemplate(textBody, variables)
  };
}

async function getActiveConfig(branch_id, config_id) {
  const [rows] = await pool.query(
    "SELECT * FROM email_configs WHERE branch_id = ? AND config_id = ? AND status = 'active' LIMIT 1",
    [branch_id, config_id]
  );
  if (!rows.length) throw new Error("Active SMTP config not found");
  return rows[0];
}

async function updateBroadcastStatusAndCounts(branch_id, broadcast_id) {
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total_recipients,
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS total_pending,
                SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS total_sent,
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS total_failed,
                SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS total_skipped
         FROM email_broadcast_recipients WHERE branch_id = ? AND broadcast_id = ?`,
    [branch_id, broadcast_id]
  );
  const c = countRows[0];
  const total_recipients = Number(c.total_recipients || 0);
  const total_pending = Number(c.total_pending || 0);
  const total_sent = Number(c.total_sent || 0);
  const total_failed = Number(c.total_failed || 0);
  const total_skipped = Number(c.total_skipped || 0);

  let status = "processing";
  if (total_pending === 0) {
    if (total_sent === total_recipients) status = "completed";
    else if (total_sent > 0 && (total_failed > 0 || total_skipped > 0)) status = "partially_failed";
    else status = "failed";
  }

  await pool.query(
    `UPDATE email_broadcasts
         SET total_recipients=?, total_pending=?, total_sent=?, total_failed=?, total_skipped=?,
             status=?, completed_at=CASE WHEN ? IN ('completed','partially_failed','failed') THEN NOW() ELSE completed_at END,
             modify_date=NOW()
         WHERE branch_id=? AND broadcast_id=?`,
    [total_recipients, total_pending, total_sent, total_failed, total_skipped, status, status, branch_id, broadcast_id]
  );
}

async function processBroadcastRecipients(branch_id, broadcast_id, chunkSize = 5) {  // Changed to 5 emails per batch
    const [broadcastRows] = await pool.query(
        "SELECT * FROM email_broadcasts WHERE branch_id = ? AND broadcast_id = ? LIMIT 1", 
        [branch_id, broadcast_id]
    );
    
    if (!broadcastRows.length) return;
    const broadcast = broadcastRows[0];
    
    if (BROADCAST_FINAL.includes(broadcast.status) || broadcast.status === "paused") return;

    // Get available configs
    const availableConfigs = await getAvailableConfigs(
        branch_id, 
        broadcast.config_id, 
        broadcast.fallback_config_id
    );
    
    if (availableConfigs.length === 0) {
        console.error(`No available configs for broadcast ${broadcast_id}`);
        await pool.query(
            "UPDATE email_broadcasts SET status='failed', modify_date=NOW() WHERE branch_id=? AND broadcast_id=?",
            [branch_id, broadcast_id]
        );
        return;
    }

    // Check daily limit
    const broadcastLimit = broadcast.daily_limit || 1000;
    const todayDate = new Date().toISOString().split('T')[0];
    
    const [todaySent] = await pool.query(
        `SELECT COUNT(*) as sent_today 
         FROM email_broadcast_recipients 
         WHERE branch_id = ? AND broadcast_id = ? 
         AND status = 'sent' AND DATE(sent_at) = ?`,
        [branch_id, broadcast_id, todayDate]
    );
    
    let remainingForToday = broadcastLimit - (todaySent[0]?.sent_today || 0);
    
    if (remainingForToday <= 0) {
        console.log(`Daily limit reached for broadcast ${broadcast_id}. Pausing.`);
        await pool.query(
            "UPDATE email_broadcasts SET status='paused' WHERE branch_id=? AND broadcast_id=?",
            [branch_id, broadcast_id]
        );
        return;
    }

    let processedCount = 0;
    
    while (true) {
        if (remainingForToday <= 0) {
            console.log(`Daily limit reached. Pausing broadcast ${broadcast_id}`);
            await pool.query(
                "UPDATE email_broadcasts SET status='paused' WHERE branch_id=? AND broadcast_id=?",
                [branch_id, broadcast_id]
            );
            break;
        }
        
        const [stateRows] = await pool.query(
            "SELECT status FROM email_broadcasts WHERE branch_id = ? AND broadcast_id = ? LIMIT 1", 
            [branch_id, broadcast_id]
        );
        
        if (!stateRows.length || ["paused", "cancelled"].includes(stateRows[0].status)) break;

        const batchSize = Math.min(chunkSize, remainingForToday);
        
        const [recipients] = await pool.query(
            `SELECT * FROM email_broadcast_recipients 
             WHERE branch_id = ? AND broadcast_id = ? AND status='pending' 
             ORDER BY id ASC LIMIT ?`,
            [branch_id, broadcast_id, batchSize]
        );
        
        if (!recipients.length) break;

        console.log(`📧 Sending batch of ${recipients.length} emails for broadcast ${broadcast_id}`);
        
        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i];
            
            // Add delay between emails (2 seconds between each email)
            if (i > 0) {
                console.log(`   ⏳ Waiting 2 seconds before next email...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            await pool.query(
                `UPDATE email_broadcast_recipients 
                 SET status='processing', last_attempt_at=NOW(), modify_date=NOW() 
                 WHERE branch_id=? AND broadcast_id=? AND recipient_id=? AND status='pending'`,
                [branch_id, broadcast_id, recipient.recipient_id]
            );

            const [unsub] = await pool.query(
                "SELECT id FROM email_unsubscribes WHERE branch_id = ? AND email = ? AND status = 'active' LIMIT 1",
                [branch_id, recipient.recipient_email]
            );
            
            if (unsub.length) {
                await pool.query(
                    `UPDATE email_broadcast_recipients 
                     SET status='skipped', error_message='Recipient unsubscribed' 
                     WHERE branch_id=? AND broadcast_id=? AND recipient_id=?`,
                    [branch_id, broadcast_id, recipient.recipient_id]
                );
                continue;
            }

            const finalVariables = {
                ...parseJSON(broadcast.global_variables_json, {}),
                ...parseJSON(recipient.variable_values_json, {})
            };
            
            const rendered = renderRecipientEmail({
                subject: broadcast.subject_snapshot,
                htmlBody: broadcast.html_body_snapshot,
                textBody: broadcast.text_body_snapshot,
                variables: finalVariables
            });

            const mailOptions = {
                to: recipient.recipient_email,
                subject: rendered.subject,
                html: rendered.htmlBody,
                text: rendered.textBody || undefined
            };

            const sendResult = await sendEmailWithFallback(
                mailOptions,
                branch_id,
                broadcast_id,
                recipient.recipient_id,
                availableConfigs,
                3
            );

            if (sendResult.success) {
                await pool.query(
                    `UPDATE email_broadcast_recipients 
                     SET status='sent', provider_message_id=?, sent_at=NOW(), error_message=NULL,
                         attempt_count=attempt_count+1, last_attempt_at=NOW(), 
                         used_config_id=?, modify_date=NOW()
                     WHERE branch_id=? AND broadcast_id=? AND recipient_id=?`,
                    [sendResult.messageId, sendResult.configId, branch_id, broadcast_id, recipient.recipient_id]
                );
                remainingForToday--;
                processedCount++;
                console.log(`   ✅ Email ${processedCount} sent to ${recipient.recipient_email} via ${sendResult.configType}`);
            } else {
                await pool.query(
                    `UPDATE email_broadcast_recipients 
                     SET status='failed', error_message=?, attempt_count=attempt_count+1, 
                         last_attempt_at=NOW(), modify_date=NOW()
                     WHERE branch_id=? AND broadcast_id=? AND recipient_id=?`,
                    [sendResult.error, branch_id, broadcast_id, recipient.recipient_id]
                );
                console.log(`   ❌ Email failed for ${recipient.recipient_email}: ${sendResult.error}`);
            }
        }
        
        // Update status after each batch
        await updateBroadcastStatusAndCounts(branch_id, broadcast_id);
        
        // Wait between batches
        if (remainingForToday > 0) {
            console.log(`⏳ Waiting 5 seconds before next batch...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    await updateBroadcastStatusAndCounts(branch_id, broadcast_id);
    console.log(`📊 Broadcast ${broadcast_id} completed. Total sent: ${processedCount}`);
}
async function processDueBroadcasts() {
    try {
        // Get current time
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const currentIST = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        
        // Get scheduled broadcasts that are due
        const [rows] = await pool.query(
            `SELECT branch_id, broadcast_id, scheduled_at, broadcast_name, daily_limit
             FROM email_broadcasts 
             WHERE status = 'scheduled' 
               AND scheduled_at IS NOT NULL 
               AND scheduled_at <= ?
             ORDER BY scheduled_at ASC 
             LIMIT 10`,
            [currentIST]
        );
        
        if (rows.length === 0) {
            return;
        }
        
        console.log(`📧 Found ${rows.length} due broadcast(s) at ${currentIST}`);
        
        for (const row of rows) {
            console.log(`   📨 Processing: ${row.broadcast_name} (${row.broadcast_id})`);
            console.log(`      Scheduled at: ${row.scheduled_at}`);
            
            const [lock] = await pool.query(
                `UPDATE email_broadcasts 
                 SET status = 'processing', 
                     started_at = ?,
                     modify_date = NOW() 
                 WHERE branch_id = ? 
                   AND broadcast_id = ? 
                   AND status = 'scheduled'`,
                [currentIST, row.branch_id, row.broadcast_id]
            );
            
            if (lock.affectedRows > 0) {
                console.log(`      ✅ Processing started`);
                processBroadcastRecipients(row.branch_id, row.broadcast_id).catch(err => {
                    console.error(`Error processing broadcast ${row.broadcast_id}:`, err);
                });
            }
        }
    } catch (error) {
        console.error("Error in processDueBroadcasts:", error);
    }
}

/**
 * Convert date to MySQL DATETIME format with timezone handling
 */
function formatScheduledTime(scheduledAt, timezone) {
    if (!scheduledAt) return null;
    
    // If it's already in YYYY-MM-DD HH:MM:SS format, return as is
    if (typeof scheduledAt === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(scheduledAt)) {
        return scheduledAt;
    }
    
    try {
        const date = new Date(scheduledAt);
        if (isNaN(date.getTime())) return null;
        
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } catch (error) {
        console.error("Date conversion error:", error);
        return null;
    }
}

// SMTP CONFIG
router.post("/config/create", auth, validateBranch, async (req, res) => {
  try {
    const branch_id = req.branch_id;
    const username = userFromReq(req);
    const { config_name, host, port, secure = 0, username: smtpUsername, password, from_email, from_name = null, reply_to = null, is_default = 0, status = "active" } = req.body || {};
    if (!config_name || !host || !port || !smtpUsername || !password || !from_email) return fail(res, "Missing required fields");
    if (!isValidEmail(from_email) || (reply_to && !isValidEmail(reply_to))) return fail(res, "Invalid email format");
    if (!["active", "inactive"].includes(status)) return fail(res, "Invalid status value");

    const config_id = newId("cfg");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (Number(is_default) === 1) {
        await conn.query("UPDATE email_configs SET is_default = 0, modify_by=?, modify_date=NOW() WHERE branch_id=?", [username, branch_id]);
      }
      await conn.query(
        `INSERT INTO email_configs
                 (config_id, branch_id, config_name, host, port, secure, username, password_encrypted, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [config_id, branch_id, config_name, host, Number(port), Number(secure) ? 1 : 0, smtpUsername, encrypt(password), from_email, from_name, reply_to, Number(is_default) ? 1 : 0, status, username, username]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    const [rows] = await pool.query("SELECT config_id, branch_id, config_name, host, port, secure, username, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date FROM email_configs WHERE branch_id=? AND config_id=? LIMIT 1", [branch_id, config_id]);
    return ok(res, "SMTP config created successfully", rows[0]);
  } catch (error) {
    return fail(res, error.message);
  }
});

router.put("/config/update", auth, validateBranch, async (req, res) => {
  try {
    const branch_id = req.branch_id;
    const username = userFromReq(req);
    const { config_id, config_name, host, port, secure, smtp_username, password, from_email, from_name, reply_to } = req.body || {};
    if (!config_id) return fail(res, "config_id is required");
    if (from_email && !isValidEmail(from_email)) return fail(res, "Invalid from_email");
    if (reply_to && !isValidEmail(reply_to)) return fail(res, "Invalid reply_to");
    const [rows] = await pool.query("SELECT * FROM email_configs WHERE branch_id=? AND config_id=? LIMIT 1", [branch_id, config_id]);
    if (!rows.length) return fail(res, "SMTP config not found", 404);
    const old = rows[0];
    await pool.query(
      `UPDATE email_configs SET config_name=?, host=?, port=?, secure=?, username=?, password_encrypted=?, from_email=?, from_name=?, reply_to=?, modify_by=?, modify_date=NOW()
             WHERE branch_id=? AND config_id=?`,
      [config_name ?? old.config_name, host ?? old.host, Number(port ?? old.port), Number(secure ?? old.secure) ? 1 : 0, smtp_username ?? old.username, password ? encrypt(password) : old.password_encrypted, from_email ?? old.from_email, from_name ?? old.from_name, reply_to ?? old.reply_to, username, branch_id, config_id]
    );
    const [fresh] = await pool.query("SELECT config_id, branch_id, config_name, host, port, secure, username, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date FROM email_configs WHERE branch_id=? AND config_id=? LIMIT 1", [branch_id, config_id]);
    return ok(res, "SMTP config updated successfully", fresh[0]);
  } catch (error) {
    return fail(res, error.message);
  }
});

router.get("/config/list", auth, validateBranch, async (req, res) => {
  try {
    const branch_id = req.branch_id;
    const page_no = Math.max(Number(req.query.page_no || 1), 1);
    const limit = Math.max(Number(req.query.limit || 10), 1);
    const offset = (page_no - 1) * limit;
    const [rows] = await pool.query("SELECT config_id, branch_id, config_name, host, port, secure, username, password_encrypted, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date FROM email_configs WHERE branch_id=? ORDER BY is_default DESC, id DESC LIMIT ? OFFSET ?", [branch_id, limit, offset]);
    const data = rows.map((row) => {
      let password = "";
      try {
        password = decrypt(row.password_encrypted);
      } catch {
        password = "";
      }
      const { password_encrypted, ...rest } = row;
      return { ...rest, password };
    });
    const [count] = await pool.query("SELECT COUNT(*) AS total FROM email_configs WHERE branch_id=?", [branch_id]);
    const total = Number(count[0].total || 0);
    return ok(res, "List fetched successfully", data, { page_no, limit, total, total_pages: Math.ceil(total / limit) || 1, has_more: page_no * limit < total });
  } catch (error) {
    return fail(res, error.message, 500);
  }
});

router.get("/config/details/:config_id", auth, validateBranch, async (req, res) => {
  const [rows] = await pool.query("SELECT config_id, branch_id, config_name, host, port, secure, username, password_encrypted, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date FROM email_configs WHERE branch_id=? AND config_id=? LIMIT 1", [req.branch_id, req.params.config_id]);
  if (!rows.length) return fail(res, "SMTP config not found", 404);
  let password = "";
  try {
    password = decrypt(rows[0].password_encrypted);
  } catch {
    password = "";
  }
  const { password_encrypted, ...config } = rows[0];
  return ok(res, "Config details fetched successfully", { ...config, password });
});

router.post("/config/test", auth, validateBranch, async (req, res) => {
  try {
    const { host, port, secure = 0, username, password } = req.body || {};
    if (!host || !port || !username || !password) return fail(res, "host, port, username and password are required");
    const transporter = nodemailer.createTransport({ host, port: Number(port), secure: Number(secure) === 1 || Number(port) === 465, auth: { user: username, pass: password } });
    await transporter.verify();
    return ok(res, "SMTP config verified successfully", { verified: true });
  } catch (error) {
    return fail(res, error.message);
  }
});

router.put("/config/set-default", auth, validateBranch, async (req, res) => {
  const { config_id } = req.body || {};
  if (!config_id) return fail(res, "config_id is required");
  const username = userFromReq(req);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [exists] = await conn.query("SELECT config_id FROM email_configs WHERE branch_id=? AND config_id=? LIMIT 1", [req.branch_id, config_id]);
    if (!exists.length) throw new Error("SMTP config not found");
    await conn.query("UPDATE email_configs SET is_default=0, modify_by=?, modify_date=NOW() WHERE branch_id=?", [username, req.branch_id]);
    await conn.query("UPDATE email_configs SET is_default=1, modify_by=?, modify_date=NOW() WHERE branch_id=? AND config_id=?", [username, req.branch_id, config_id]);
    await conn.commit();
    const [rows] = await pool.query("SELECT config_id, branch_id, config_name, host, port, secure, username, from_email, from_name, reply_to, is_default, status, create_by, modify_by, create_date, modify_date FROM email_configs WHERE branch_id=? AND config_id=? LIMIT 1", [req.branch_id, config_id]);
    return ok(res, "Default SMTP config updated successfully", rows[0]);
  } catch (error) {
    await conn.rollback();
    return fail(res, error.message);
  } finally {
    conn.release();
  }
});

router.put("/config/change-status", auth, validateBranch, async (req, res) => {
  const { config_id, status } = req.body || {};
  if (!config_id || !status) return fail(res, "config_id and status are required");
  if (!["active", "inactive"].includes(status)) return fail(res, "Invalid status value");
  const [result] = await pool.query("UPDATE email_configs SET status=?, modify_by=?, modify_date=NOW() WHERE branch_id=? AND config_id=?", [status, userFromReq(req), req.branch_id, config_id]);
  if (!result.affectedRows) return fail(res, "SMTP config not found", 404);
  return ok(res, "SMTP config status updated successfully", {});
});

// TEMPLATE APIs
router.post("/template/create", auth, validateBranch, async (req, res) => {
  const { template_name, subject, html_body, text_body = null, status = "active" } = req.body || {};
  if (!template_name || !subject || !html_body) return fail(res, "template_name, subject and html_body are required");
  if (!["active", "inactive"].includes(status)) return fail(res, "Invalid status value");
  const template_id = newId("tpl");
  const variables = parseVariables(subject, html_body, text_body);
  await pool.query(
    `INSERT INTO email_templates
         (template_id, branch_id, template_name, subject, html_body, text_body, variables_json, status, create_by, modify_by, create_date, modify_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [template_id, req.branch_id, template_name, subject, html_body, text_body, JSON.stringify(variables), status, userFromReq(req), userFromReq(req)]
  );
  const [rows] = await pool.query("SELECT template_id, branch_id, template_name, subject, html_body, text_body, variables_json, status, create_by, modify_by, create_date, modify_date FROM email_templates WHERE branch_id=? AND template_id=? LIMIT 1", [req.branch_id, template_id]);
  return ok(res, "Template created successfully", { ...rows[0], variables_json: parseJSON(rows[0].variables_json, []) });
});

router.put("/template/update", auth, validateBranch, async (req, res) => {
  const { template_id, template_name, subject, html_body, text_body, status } = req.body || {};
  if (!template_id) return fail(res, "template_id is required");
  const [rows] = await pool.query("SELECT * FROM email_templates WHERE branch_id=? AND template_id=? LIMIT 1", [req.branch_id, template_id]);
  if (!rows.length) return fail(res, "Template not found", 404);
  const old = rows[0];
  const nextStatus = status ?? old.status;
  if (!["active", "inactive"].includes(nextStatus)) return fail(res, "Invalid status value");
  const nextSubject = subject ?? old.subject;
  const nextHtml = html_body ?? old.html_body;
  const nextText = text_body ?? old.text_body;
  const variables = parseVariables(nextSubject, nextHtml, nextText);
  await pool.query(
    `UPDATE email_templates SET template_name=?, subject=?, html_body=?, text_body=?, variables_json=?, status=?, modify_by=?, modify_date=NOW()
         WHERE branch_id=? AND template_id=?`,
    [template_name ?? old.template_name, nextSubject, nextHtml, nextText, JSON.stringify(variables), nextStatus, userFromReq(req), req.branch_id, template_id]
  );
  return ok(res, "Template updated successfully", {});
});

router.get("/template/list", auth, validateBranch, async (req, res) => {
  const page_no = Math.max(Number(req.query.page_no || 1), 1);
  const limit = Math.max(Number(req.query.limit || 10), 1);
  const offset = (page_no - 1) * limit;
  const [rows] = await pool.query("SELECT template_id, branch_id, template_name, subject, html_body, text_body, variables_json, status, create_by, modify_by, create_date, modify_date FROM email_templates WHERE branch_id=? ORDER BY id DESC LIMIT ? OFFSET ?", [req.branch_id, limit, offset]);
  const [count] = await pool.query("SELECT COUNT(*) AS total FROM email_templates WHERE branch_id=?", [req.branch_id]);
  const total = Number(count[0].total || 0);
  const data = rows.map((row) => ({ ...row, variables_json: parseJSON(row.variables_json, []) }));
  return ok(res, "List fetched successfully", data, { page_no, limit, total, total_pages: Math.ceil(total / limit) || 1, has_more: page_no * limit < total });
});

router.get("/template/details/:template_id", auth, validateBranch, async (req, res) => {
  const [rows] = await pool.query("SELECT template_id, branch_id, template_name, subject, html_body, text_body, variables_json, status, create_by, modify_by, create_date, modify_date FROM email_templates WHERE branch_id=? AND template_id=? LIMIT 1", [req.branch_id, req.params.template_id]);
  if (!rows.length) return fail(res, "Template not found", 404);
  return ok(res, "Template details fetched successfully", { ...rows[0], variables_json: parseJSON(rows[0].variables_json, []) });
});

router.post("/template/preview", auth, validateBranch, async (req, res) => {
  const { subject = "", html_body = "", text_body = "", variables = {} } = req.body || {};
  const rendered = renderRecipientEmail({ subject, htmlBody: html_body, textBody: text_body, variables });
  return ok(res, "Template preview generated successfully", rendered);
});

router.put("/template/change-status", auth, validateBranch, async (req, res) => {
  const { template_id, status } = req.body || {};
  if (!template_id || !status) return fail(res, "template_id and status are required");
  if (!["active", "inactive"].includes(status)) return fail(res, "Invalid status value");
  const [result] = await pool.query("UPDATE email_templates SET status=?, modify_by=?, modify_date=NOW() WHERE branch_id=? AND template_id=?", [status, userFromReq(req), req.branch_id, template_id]);
  if (!result.affectedRows) return fail(res, "Template not found", 404);
  return ok(res, "Template status updated successfully", {});
});

// BROADCAST APIs
router.post("/broadcast/create", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { 
            config_id, 
            fallback_config_id,
            template_id, 
            broadcast_name, 
            schedule_type = "now", 
            scheduled_at = null, 
            timezone = "Asia/Kolkata", 
            global_variables_json = {}, 
            recipients,
            daily_limit = 1000
        } = req.body || {};
        
        if (!config_id || !template_id || !broadcast_name) {
            return fail(res, "config_id, template_id and broadcast_name are required");
        }
        
        if (!["now", "scheduled"].includes(schedule_type)) {
            return fail(res, "Invalid schedule_type");
        }
        
        if (schedule_type === "scheduled" && !scheduled_at) {
            return fail(res, "scheduled_at required when schedule_type is scheduled");
        }
        
        if (!Array.isArray(recipients) || !recipients.length) {
            return fail(res, "recipients must be non-empty array");
        }
        
        for (const recipient of recipients) {
            if (!recipient?.recipient_email || !isValidEmail(recipient.recipient_email)) {
                return fail(res, "recipient_email required for every recipient");
            }
        }

        // Check if config exists and is active
        const [cfg] = await pool.query(
            "SELECT config_id, daily_limit, username, password_encrypted, host, port, secure, from_email, from_name FROM email_configs WHERE branch_id=? AND config_id=? AND status='active' LIMIT 1", 
            [branch_id, config_id]
        );
        if (!cfg.length) {
            return fail(res, "Active SMTP config not found");
        }
        
        // Check fallback config if provided
        if (fallback_config_id) {
            const [fallbackCfg] = await pool.query(
                "SELECT config_id FROM email_configs WHERE branch_id=? AND config_id=? AND status='active' LIMIT 1", 
                [branch_id, fallback_config_id]
            );
            if (!fallbackCfg.length) {
                return fail(res, "Fallback SMTP config not found or inactive");
            }
        }
        
        const [tpl] = await pool.query(
            "SELECT * FROM email_templates WHERE branch_id=? AND template_id=? AND status='active' LIMIT 1", 
            [branch_id, template_id]
        );
        if (!tpl.length) {
            return fail(res, "Active template not found");
        }

        const broadcast_id = newId("brd");
        const template = tpl[0];
        
        const finalDailyLimit = daily_limit || cfg[0].daily_limit || 1000;
        
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            
            await conn.query(
                `INSERT INTO email_broadcasts
                 (broadcast_id, branch_id, config_id, fallback_config_id, template_id, broadcast_name, 
                  subject_snapshot, html_body_snapshot, text_body_snapshot, template_variables_json,
                  global_variables_json, schedule_type, scheduled_at, timezone, status, 
                  total_recipients, total_pending, total_sent, total_failed, total_skipped, daily_limit,
                  create_by, modify_by, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 
                         ?, ?, 0, 0, 0, ?, ?, ?, NOW(), NOW())`,
                [
                    broadcast_id, branch_id, config_id, fallback_config_id || null, template_id, broadcast_name, 
                    template.subject, template.html_body, template.text_body,
                    template.variables_json, JSON.stringify(global_variables_json || {}), schedule_type,
                   schedule_type === "scheduled" ? formatScheduledTime(scheduled_at, timezone) : null, timezone, 
                    recipients.length, recipients.length, finalDailyLimit,
                    username, username
                ]
            );
            
            // Insert recipients
            for (const recipient of recipients) {
                await conn.query(
                    `INSERT INTO email_broadcast_recipients
                     (recipient_id, broadcast_id, branch_id, recipient_name, recipient_email, 
                      variable_values_json, status, attempt_count, create_date, modify_date)
                     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NOW(), NOW())`,
                    [newId("rcp"), broadcast_id, branch_id, recipient.recipient_name || null, 
                     recipient.recipient_email, JSON.stringify(recipient.variable_values_json || {})]
                );
            }
            
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
        
        // 🔥 FIX: Process immediately if schedule_type is "now"
        if (schedule_type === "now") {
            // Don't await - process in background to avoid timeout
            processBroadcastRecipients(branch_id, broadcast_id).catch(err => {
                console.error(`Error processing broadcast ${broadcast_id}:`, err);
            });
        }
        
        return ok(res, "Broadcast created successfully", { broadcast_id });
        
    } catch (error) {
        console.error("Broadcast creation error:", error);
        return fail(res, error.message);
    }
});


router.get("/broadcast/list", auth, validateBranch, async (req, res) => {
  const page_no = Math.max(Number(req.query.page_no || 1), 1);
  const limit = Math.max(Number(req.query.limit || 10), 1);
  const offset = (page_no - 1) * limit;
  const [rows] = await pool.query("SELECT broadcast_id, branch_id, config_id, template_id, broadcast_name, schedule_type, scheduled_at, timezone, status, total_recipients, total_pending, total_sent, total_failed, total_skipped, started_at, completed_at, create_by, modify_by, create_date, modify_date FROM email_broadcasts WHERE branch_id=? ORDER BY id DESC LIMIT ? OFFSET ?", [req.branch_id, limit, offset]);
  const [count] = await pool.query("SELECT COUNT(*) AS total FROM email_broadcasts WHERE branch_id=?", [req.branch_id]);
  const total = Number(count[0].total || 0);
  return ok(res, "List fetched successfully", rows, { page_no, limit, total, total_pages: Math.ceil(total / limit) || 1, has_more: page_no * limit < total });
});

router.get("/broadcast/details/:broadcast_id", auth, validateBranch, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM email_broadcasts WHERE branch_id=? AND broadcast_id=? LIMIT 1", [req.branch_id, req.params.broadcast_id]);
  if (!rows.length) return fail(res, "Broadcast not found", 404);
  const row = rows[0];
  return ok(res, "Broadcast details fetched successfully", { ...row, template_variables_json: parseJSON(row.template_variables_json, []), global_variables_json: parseJSON(row.global_variables_json, {}) });
});

router.get("/broadcast/recipient-list/:broadcast_id", auth, validateBranch, async (req, res) => {
    const page_no = Math.max(Number(req.query.page_no || 1), 1);
    const limit = Math.max(Number(req.query.limit || 50), 1);
    const offset = (page_no - 1) * limit;
    
    // ADDED used_config_id to SELECT query
    const [rows] = await pool.query(
        `SELECT recipient_id, recipient_name, recipient_email, variable_values_json, status, 
                used_config_id, attempt_count, error_message, provider_message_id, 
                sent_at, last_attempt_at, create_date, modify_date 
         FROM email_broadcast_recipients 
         WHERE branch_id=? AND broadcast_id=? 
         ORDER BY id ASC LIMIT ? OFFSET ?`,
        [req.branch_id, req.params.broadcast_id, limit, offset]
    );
    
    const [count] = await pool.query(
        "SELECT COUNT(*) AS total FROM email_broadcast_recipients WHERE branch_id=? AND broadcast_id=?", 
        [req.branch_id, req.params.broadcast_id]
    );
    const total = Number(count[0].total || 0);
    
    // Get broadcast details to know primary vs fallback
    const [broadcast] = await pool.query(
        "SELECT config_id, fallback_config_id FROM email_broadcasts WHERE broadcast_id=? AND branch_id=?",
        [req.params.broadcast_id, req.branch_id]
    );
    
    const primaryConfigId = broadcast[0]?.config_id;
    const fallbackConfigId = broadcast[0]?.fallback_config_id;
    
    const data = rows.map((r) => ({ 
        ...r, 
        variable_values_json: parseJSON(r.variable_values_json, {}),
        config_type: r.used_config_id === primaryConfigId ? 'primary' : (r.used_config_id === fallbackConfigId ? 'fallback' : (r.used_config_id ? 'other' : 'pending'))
    }));
    
    return ok(res, "List fetched successfully", data, { 
        page_no, limit, total, 
        total_pages: Math.ceil(total / limit) || 1, 
        has_more: page_no * limit < total 
    });
});

async function changeBroadcastState(req, res, target) {
  const { broadcast_id } = req.body || {};
  if (!broadcast_id) return fail(res, "broadcast_id is required");
  const [rows] = await pool.query("SELECT status FROM email_broadcasts WHERE branch_id=? AND broadcast_id=? LIMIT 1", [req.branch_id, broadcast_id]);
  if (!rows.length) return fail(res, "Broadcast not found", 404);
  const current = rows[0].status;
  const allowed = {
    paused: ["processing", "scheduled"],
    scheduled: ["paused"],
    cancelled: ["scheduled", "paused", "processing"]
  };
  if (!allowed[target].includes(current)) return fail(res, `Cannot change broadcast from ${current} to ${target}`);
  await pool.query("UPDATE email_broadcasts SET status=?, modify_by=?, modify_date=NOW() WHERE branch_id=? AND broadcast_id=?", [target, userFromReq(req), req.branch_id, broadcast_id]);
  return ok(res, `Broadcast ${target} successfully`, {});
}

router.post("/broadcast/pause", auth, validateBranch, async (req, res) => changeBroadcastState(req, res, "paused"));
router.post("/broadcast/resume", auth, validateBranch, async (req, res) => changeBroadcastState(req, res, "scheduled"));
router.post("/broadcast/cancel", auth, validateBranch, async (req, res) => changeBroadcastState(req, res, "cancelled"));

router.post("/broadcast/retry-failed", auth, validateBranch, async (req, res) => {
  const { broadcast_id } = req.body || {};

  if (!broadcast_id) return fail(res, "broadcast_id is required");

  const [rows] = await pool.query("SELECT status FROM email_broadcasts WHERE branch_id=? AND broadcast_id=? LIMIT 1", [req.branch_id, broadcast_id]);

  if (!rows.length) return fail(res, "Broadcast not found", 404);

  if (["cancelled", "completed"].includes(rows[0].status)) return fail(res, "Cannot retry on cancelled/completed broadcast");

  const [result] = await pool.query("UPDATE email_broadcast_recipients SET status='pending', error_message=NULL, modify_date=NOW() WHERE branch_id=? AND broadcast_id=? AND status='failed'", [req.branch_id, broadcast_id]);

  await pool.query("UPDATE email_broadcasts SET status='scheduled', modify_by=?, modify_date=NOW() WHERE branch_id=? AND broadcast_id=?", [userFromReq(req), req.branch_id, broadcast_id]);

  return ok(res, "Failed recipients retried successfully", { retried_count: result.affectedRows });
});

// internal worker trigger (optional manual trigger)
router.post("/broadcast/process-due", auth, validateBranch, async (req, res) => {
  try {
    await processDueBroadcasts();
    return ok(res, "Due broadcasts processed successfully", {});
  } catch (error) {
    return fail(res, error.message);
  }
});


// ==================== STATIC TEMPLATE APIs (email_static_templates) ====================

/**
 * Create a new static template
 * POST /api/email/static-template/create
 * Body: { template_type, template_name, subject, html_body, text_body, status, is_default }
 */
router.post("/static-template/create", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { 
            template_type, 
            template_name, 
            subject, 
            html_body, 
            text_body = null, 
            status = "active",
            is_default = 0
        } = req.body || {};

        // Validation
        if (!template_type || template_type.trim() === "") {
            return fail(res, "template_type is required (e.g., task_create, task_complete, payment_receipt)");
        }
        if (!template_name || template_name.trim() === "") {
            return fail(res, "template_name is required");
        }
        if (!subject || subject.trim() === "") {
            return fail(res, "subject is required");
        }
        if (!html_body || html_body.trim() === "") {
            return fail(res, "html_body is required");
        }
        if (!["active", "inactive"].includes(status)) {
            return fail(res, "status must be 'active' or 'inactive'");
        }

        // Generate unique template_id
        const template_id = newId("stpl");

        // Parse variables from template
        const variables = parseVariables(subject, html_body, text_body);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // If is_default = 1, remove default from other templates of same type
            if (Number(is_default) === 1) {
                await conn.query(
                    `UPDATE email_static_templates 
                     SET is_default = 0, modify_by = ?, modify_date = NOW() 
                     WHERE branch_id = ? AND template_type = ?`,
                    [username, branch_id, template_type]
                );
            }

            // Insert new template
            await conn.query(
                `INSERT INTO email_static_templates (
                    template_id, branch_id, template_type, template_name, 
                    subject, html_body, text_body, variables_json, 
                    status, is_default, create_by, modify_by, create_date, modify_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [
                    template_id, branch_id, template_type, template_name.trim(),
                    subject.trim(), html_body, text_body, JSON.stringify(variables),
                    status, Number(is_default), username, username
                ]
            );

            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        // Fetch created template
        const [rows] = await pool.query(
            `SELECT template_id, branch_id, template_type, template_name, subject, 
                    html_body, text_body, variables_json, status, is_default, 
                    create_by, modify_by, create_date, modify_date 
             FROM email_static_templates 
             WHERE branch_id = ? AND template_id = ? LIMIT 1`,
            [branch_id, template_id]
        );

        return ok(res, "Static template created successfully", {
            ...rows[0],
            variables_json: parseJSON(rows[0].variables_json, [])
        });

    } catch (error) {
        console.error("Create static template error:", error);
        return fail(res, error.message || "Failed to create template");
    }
});

/**
 * Get all active static templates
 * GET /api/email/static-template/active-list
 * Query: template_type (optional), page_no, limit, search
 */
router.get("/static-template/active-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(Number(req.query.page_no || 1), 1);
        const limit = Math.min(100, Math.max(Number(req.query.limit || 20), 1));
        const offset = (page_no - 1) * limit;
        const template_type = req.query.template_type ? String(req.query.template_type).trim() : null;
        const search = req.query.search ? String(req.query.search).trim() : "";

        let query = `
            SELECT 
                template_id,
                template_type,
                template_name,
                subject,
                status,
                is_default,
                variables_json,
                create_date,
                modify_date
            FROM email_static_templates 
            WHERE branch_id = ? AND status = 'active'
        `;
        
        const params = [branch_id];

        if (template_type) {
            query += ` AND template_type = ?`;
            params.push(template_type);
        }

        if (search) {
            query += ` AND (template_name LIKE ? OR subject LIKE ? OR template_type LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ` ORDER BY is_default DESC, create_date DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [rows] = await pool.query(query, params);

        // Get total count
        let countQuery = `SELECT COUNT(*) as total FROM email_static_templates WHERE branch_id = ? AND status = 'active'`;
        const countParams = [branch_id];
        
        if (template_type) {
            countQuery += ` AND template_type = ?`;
            countParams.push(template_type);
        }
        
        if (search) {
            countQuery += ` AND (template_name LIKE ? OR subject LIKE ? OR template_type LIKE ?)`;
            countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        
        const [countRows] = await pool.query(countQuery, countParams);
        const total = countRows[0]?.total || 0;

        const data = rows.map(row => ({
            ...row,
            variables_json: parseJSON(row.variables_json, []),
            total_variables: parseJSON(row.variables_json, []).length
        }));

        return ok(res, "Active static templates retrieved successfully", data, {
            page_no,
            limit,
            total,
            total_pages: Math.ceil(total / limit),
            has_more: page_no * limit < total
        });

    } catch (error) {
        console.error("Get active static templates error:", error);
        return fail(res, error.message || "Failed to fetch templates");
    }
});

/**
 * Get all static templates by type (for a specific purpose)
 * GET /api/email/static-template/by-type/:template_type
 */
router.get("/static-template/by-type/:template_type", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const template_type = req.params.template_type;

        const [rows] = await pool.query(
            `SELECT 
                template_id,
                template_type,
                template_name,
                subject,
                html_body,
                text_body,
                variables_json,
                status,
                is_default,
                create_date
            FROM email_static_templates 
            WHERE branch_id = ? AND template_type = ? AND status = 'active'
            ORDER BY is_default DESC, create_date DESC`,
            [branch_id, template_type]
        );

        const data = rows.map(row => ({
            ...row,
            variables_json: parseJSON(row.variables_json, [])
        }));

        return ok(res, `Templates for type '${template_type}' retrieved successfully`, data);

    } catch (error) {
        console.error("Get templates by type error:", error);
        return fail(res, error.message || "Failed to fetch templates");
    }
});

/**
 * Get single static template details - FIXED with debug
 * GET /api/email/static-template/details/:template_id
 */
router.get("/static-template/details/:template_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const template_id = req.params.template_id;

        console.log("=== FETCHING TEMPLATE DETAILS ===");
        console.log("Branch ID:", branch_id);
        console.log("Template ID:", template_id);

        const [rows] = await pool.query(
            `SELECT 
                template_id, 
                branch_id, 
                template_type, 
                template_name, 
                subject, 
                html_body, 
                text_body, 
                variables_json, 
                status, 
                is_default, 
                create_by, 
                modify_by, 
                create_date, 
                modify_date
            FROM email_static_templates 
            WHERE branch_id = ? AND template_id = ?
            LIMIT 1`,
            [branch_id, template_id]
        );

        console.log("Query result rows:", rows.length);
        
        if (!rows.length) {
            return fail(res, "Template not found", 404);
        }

        const template = rows[0];
        
        // Parse variables_json safely
        let parsedVariables = [];
        try {
            parsedVariables = JSON.parse(template.variables_json || '[]');
        } catch (e) {
            console.error("Error parsing variables_json:", e);
            parsedVariables = [];
        }

        console.log("HTML Body length:", template.html_body?.length || 0);
        console.log("HTML Body preview:", template.html_body?.substring(0, 100));

        const responseData = {
            template_id: template.template_id,
            branch_id: template.branch_id,
            template_type: template.template_type,
            template_name: template.template_name,
            subject: template.subject,
            html_body: template.html_body || "",  // Ensure it's never null
            text_body: template.text_body || "",
            variables_json: parsedVariables,
            status: template.status,
            is_default: template.is_default,
            create_by: template.create_by,
            modify_by: template.modify_by,
            create_date: template.create_date,
            modify_date: template.modify_date
        };

        console.log("Response data keys:", Object.keys(responseData));
        
        return ok(res, "Template details retrieved successfully", responseData);

    } catch (error) {
        console.error("Get template details error:", error);
        return fail(res, error.message || "Failed to fetch template");
    }
});
/**
 * Update static template
 * PUT /api/email/static-template/update
 */
router.put("/static-template/update", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { template_id, template_name, subject, html_body, text_body, status, is_default } = req.body || {};

        if (!template_id) {
            return fail(res, "template_id is required");
        }

        // Check if template exists and get current values
        const [existing] = await pool.query(
            `SELECT * FROM email_static_templates WHERE branch_id = ? AND template_id = ? LIMIT 1`,
            [branch_id, template_id]
        );

        if (!existing.length) {
            return fail(res, "Template not found", 404);
        }

        const old = existing[0];
        
        // Prepare update fields
        const updates = [];
        const values = [];

        if (template_name !== undefined && template_name !== old.template_name) {
            updates.push("template_name = ?");
            values.push(template_name.trim());
        }
        if (subject !== undefined && subject !== old.subject) {
            updates.push("subject = ?");
            values.push(subject.trim());
        }
        if (html_body !== undefined && html_body !== old.html_body) {
            updates.push("html_body = ?");
            values.push(html_body);
        }
        if (text_body !== undefined && text_body !== old.text_body) {
            updates.push("text_body = ?");
            values.push(text_body);
        }
        if (status !== undefined && status !== old.status) {
            if (!["active", "inactive"].includes(status)) {
                return fail(res, "status must be 'active' or 'inactive'");
            }
            updates.push("status = ?");
            values.push(status);
        }

        // If template content changed, re-parse variables
        if (subject !== undefined || html_body !== undefined || text_body !== undefined) {
            const finalSubject = subject !== undefined ? subject : old.subject;
            const finalHtml = html_body !== undefined ? html_body : old.html_body;
            const finalText = text_body !== undefined ? text_body : old.text_body;
            const newVariables = parseVariables(finalSubject, finalHtml, finalText);
            updates.push("variables_json = ?");
            values.push(JSON.stringify(newVariables));
        }

        updates.push("modify_by = ?");
        values.push(username);
        updates.push("modify_date = NOW()");

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Handle is_default change
            if (is_default !== undefined && Number(is_default) === 1 && Number(old.is_default) !== 1) {
                // Remove default from other templates of same type
                await conn.query(
                    `UPDATE email_static_templates 
                     SET is_default = 0, modify_by = ?, modify_date = NOW() 
                     WHERE branch_id = ? AND template_type = ? AND template_id != ?`,
                    [username, branch_id, old.template_type, template_id]
                );
                updates.push("is_default = ?");
                values.push(1);
            } else if (is_default !== undefined && Number(is_default) === 0) {
                updates.push("is_default = ?");
                values.push(0);
            }

            if (updates.length > 0) {
                values.push(template_id, branch_id);
                await conn.query(
                    `UPDATE email_static_templates SET ${updates.join(", ")} WHERE template_id = ? AND branch_id = ?`,
                    values
                );
            }

            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        return ok(res, "Static template updated successfully");

    } catch (error) {
        console.error("Update static template error:", error);
        return fail(res, error.message || "Failed to update template");
    }
});

/**
 * Delete (soft delete) static template - change status to inactive
 * PUT /api/email/static-template/delete
 */
router.put("/static-template/delete", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { template_id } = req.body || {};

        if (!template_id) {
            return fail(res, "template_id is required");
        }

        const [result] = await pool.query(
            `UPDATE email_static_templates 
             SET status = 'inactive', modify_by = ?, modify_date = NOW() 
             WHERE branch_id = ? AND template_id = ?`,
            [username, branch_id, template_id]
        );

        if (!result.affectedRows) {
            return fail(res, "Template not found", 404);
        }

        return ok(res, "Static template deleted successfully");

    } catch (error) {
        console.error("Delete static template error:", error);
        return fail(res, error.message || "Failed to delete template");
    }
});

/**
 * Set template as default for its type
 * PUT /api/email/static-template/set-default
 */
router.put("/static-template/set-default", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { template_id } = req.body || {};

        if (!template_id) {
            return fail(res, "template_id is required");
        }

        // Get template type
        const [templateRows] = await pool.query(
            `SELECT template_type FROM email_static_templates WHERE branch_id = ? AND template_id = ? LIMIT 1`,
            [branch_id, template_id]
        );

        if (!templateRows.length) {
            return fail(res, "Template not found", 404);
        }

        const template_type = templateRows[0].template_type;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Remove default from all templates of this type
            await conn.query(
                `UPDATE email_static_templates 
                 SET is_default = 0, modify_by = ?, modify_date = NOW() 
                 WHERE branch_id = ? AND template_type = ?`,
                [username, branch_id, template_type]
            );

            // Set this template as default
            await conn.query(
                `UPDATE email_static_templates 
                 SET is_default = 1, modify_by = ?, modify_date = NOW() 
                 WHERE branch_id = ? AND template_id = ?`,
                [username, branch_id, template_id]
            );

            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        return ok(res, "Default template set successfully");

    } catch (error) {
        console.error("Set default template error:", error);
        return fail(res, error.message || "Failed to set default template");
    }
});

router.get("/variables/:template_type", auth, validateBranch, async (req, res) => {
    const { template_type } = req.params;
    
    const [rows] = await pool.query(
        `SELECT template_id, template_name, variables_json 
         FROM email_static_templates 
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC`,
        [req.branch_id, template_type]
    );
    
    return res.json({
        success: true,
        template_type: template_type,
        templates: rows.map(r => ({
            ...r,
            variables_json: JSON.parse(r.variables_json || '[]')
        }))
    });
});

/**
 * Get Broadcast Report with pagination and filters
 * GET /api/email/report-list
 * Query params: page_no, limit, start_date, end_date, template_type, status
 */
router.get("/email/report-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;
        
        // Date filters
        const start_date = req.query.start_date ? new Date(req.query.start_date) : null;
        const end_date = req.query.end_date ? new Date(req.query.end_date) : null;
        if (end_date) end_date.setHours(23, 59, 59, 999);
        
        // Status filter
        const status_filter = req.query.status ? String(req.query.status).trim() : null;
        
        // Search filter
        const search = req.query.search ? String(req.query.search).trim() : null;

        // Build main query - FIXED: Use LEFT JOINs to get template names
        let baseQuery = `
            FROM email_broadcasts b
            LEFT JOIN email_templates dt ON dt.template_id = b.template_id AND dt.branch_id = b.branch_id
            LEFT JOIN email_static_templates st ON st.template_id = b.template_id AND st.branch_id = b.branch_id
            WHERE b.branch_id = ?
        `;
        const queryParams = [branch_id];

        // Apply date filter
        if (start_date) {
            baseQuery += ` AND DATE(b.create_date) >= ?`;
            queryParams.push(start_date.toISOString().split('T')[0]);
        }
        if (end_date) {
            baseQuery += ` AND DATE(b.create_date) <= ?`;
            queryParams.push(end_date.toISOString().split('T')[0]);
        }

        // Apply status filter
        if (status_filter && ['scheduled', 'processing', 'completed', 'partially_failed', 'failed', 'cancelled', 'paused'].includes(status_filter)) {
            baseQuery += ` AND b.status = ?`;
            queryParams.push(status_filter);
        }

        // Apply search filter (search by broadcast name or template name)
        if (search) {
            baseQuery += ` AND (b.broadcast_name LIKE ? OR dt.template_name LIKE ? OR st.template_name LIKE ?)`;
            const searchPattern = `%${search}%`;
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        // Get total count
        const [countRows] = await pool.query(`SELECT COUNT(*) as total ${baseQuery}`, queryParams);
        const total = countRows[0]?.total || 0;

        // Get paginated broadcast list with template names
        const [broadcasts] = await pool.query(
            `SELECT 
                b.broadcast_id,
                b.broadcast_name,
                b.template_id,
                b.status as broadcast_status,
                b.schedule_type,
                b.scheduled_at,
                b.create_date,
                b.total_recipients,
                b.total_pending,
                b.total_sent,
                b.total_failed,
                b.total_skipped,
                b.started_at,
                b.completed_at,
                COALESCE(dt.template_name, st.template_name, b.broadcast_name) as template_name,
                CASE 
                    WHEN dt.template_id IS NOT NULL THEN 'dynamic'
                    WHEN st.template_id IS NOT NULL THEN 'static'
                    ELSE 'unknown'
                END as template_type
            ${baseQuery}
            ORDER BY b.create_date DESC, b.id DESC
            LIMIT ? OFFSET ?`,
            [...queryParams, limit, offset]
        );

        // Format the data for the report table
        const reportData = broadcasts.map((broadcast, index) => {
            // Calculate paused = total - (sent + pending + failed + skipped)
            const totalProcessed = (broadcast.total_sent || 0) + 
                                  (broadcast.total_failed || 0) + 
                                  (broadcast.total_skipped || 0);
            const paused = (broadcast.total_recipients || 0) - 
                          (broadcast.total_pending || 0) - totalProcessed;
            
            // Determine select status
            let selectStatus = '';
            if (broadcast.broadcast_status === 'completed') {
                selectStatus = 'completed';
            } else if (broadcast.broadcast_status === 'processing') {
                selectStatus = 'processing';
            } else if (broadcast.broadcast_status === 'scheduled') {
                selectStatus = 'scheduled';
            } else if (broadcast.broadcast_status === 'paused') {
                selectStatus = 'paused';
            } else if (broadcast.broadcast_status === 'partially_failed') {
                selectStatus = 'partial';
            } else if (broadcast.broadcast_status === 'failed') {
                selectStatus = 'failed';
            } else if (broadcast.broadcast_status === 'cancelled') {
                selectStatus = 'cancelled';
            }

            return {
                sl_no: offset + index + 1,
                date: broadcast.create_date ? 
                    new Date(broadcast.create_date).toLocaleDateString('en-GB') : '-',
                template: broadcast.template_name ? broadcast.template_name.toUpperCase() : broadcast.broadcast_name,
                total: broadcast.total_recipients || 0,
                pending: broadcast.total_pending || 0,
                send: broadcast.total_sent || 0,
                failed: broadcast.total_failed || 0,
                paused: paused > 0 ? paused : 0,
                select: selectStatus,
                broadcast_id: broadcast.broadcast_id,
                broadcast_status: broadcast.broadcast_status,
                template_type: broadcast.template_type,
                schedule_type: broadcast.schedule_type,
                scheduled_at: broadcast.scheduled_at,
                started_at: broadcast.started_at,
                completed_at: broadcast.completed_at,
                success_rate: broadcast.total_recipients > 0 ?
                    ((broadcast.total_sent / broadcast.total_recipients) * 100).toFixed(2) : 0
            };
        });

        // Get summary statistics
        let summaryQuery = `
            SELECT 
                COUNT(DISTINCT b.broadcast_id) as total_broadcasts,
                SUM(b.total_recipients) as total_emails,
                SUM(b.total_sent) as total_sent,
                SUM(b.total_pending) as total_pending,
                SUM(b.total_failed) as total_failed,
                SUM(b.total_skipped) as total_skipped,
                ROUND(AVG(CASE WHEN b.total_recipients > 0 THEN (b.total_sent * 100.0 / b.total_recipients) ELSE 0 END), 2) as avg_success_rate
            FROM email_broadcasts b
            WHERE b.branch_id = ?
        `;
        const summaryParams = [branch_id];

        if (start_date) {
            summaryQuery += ` AND DATE(b.create_date) >= ?`;
            summaryParams.push(start_date.toISOString().split('T')[0]);
        }
        if (end_date) {
            summaryQuery += ` AND DATE(b.create_date) <= ?`;
            summaryParams.push(end_date.toISOString().split('T')[0]);
        }
        if (status_filter) {
            summaryQuery += ` AND b.status = ?`;
            summaryParams.push(status_filter);
        }
        if (search) {
            summaryQuery += ` AND b.broadcast_name LIKE ?`;
            summaryParams.push(`%${search}%`);
        }

        const [summaryRows] = await pool.query(summaryQuery, summaryParams);

        return ok(res, "Broadcast report retrieved successfully", {
            filters: {
                start_date: start_date ? start_date.toISOString().split('T')[0] : null,
                end_date: end_date ? end_date.toISOString().split('T')[0] : null,
                status: status_filter,
                search: search
            },
            summary: {
                total_broadcasts: summaryRows[0]?.total_broadcasts || 0,
                total_emails: summaryRows[0]?.total_emails || 0,
                total_sent: summaryRows[0]?.total_sent || 0,
                total_pending: summaryRows[0]?.total_pending || 0,
                total_failed: summaryRows[0]?.total_failed || 0,
                total_skipped: summaryRows[0]?.total_skipped || 0,
                avg_success_rate: summaryRows[0]?.avg_success_rate || 0
            },
            data: reportData,
            pagination: {
                page_no,
                limit,
                total,
                total_pages: Math.ceil(total / limit),
                has_next: offset + broadcasts.length < total,
                has_prev: page_no > 1
            }
        });

    } catch (error) {
        console.error("Broadcast report error:", error);
        return fail(res, error.message || "Failed to fetch broadcast report");
    }
});

/**
 * Get detailed report for a single broadcast
 * GET /api/email/broadcast/report-details/:broadcast_id
 */
router.get("/broadcast/report-details/:broadcast_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const broadcast_id = req.params.broadcast_id;

        // Get broadcast header
        const [broadcastRows] = await pool.query(
            `SELECT 
                b.*,
                COALESCE(dt.template_name, st.template_name, b.broadcast_name) as template_name,
                CASE 
                    WHEN dt.template_id IS NOT NULL THEN 'dynamic'
                    WHEN st.template_id IS NOT NULL THEN 'static'
                    ELSE 'unknown'
                END as template_type,
                c.config_name,
                c.from_email,
                c.from_name
            FROM email_broadcasts b
            LEFT JOIN email_configs c ON c.config_id = b.config_id AND c.branch_id = b.branch_id
            LEFT JOIN email_templates dt ON dt.template_id = b.template_id AND dt.branch_id = b.branch_id
            LEFT JOIN email_static_templates st ON st.template_id = b.template_id AND st.branch_id = b.branch_id
            WHERE b.broadcast_id = ? AND b.branch_id = ?`,
            [broadcast_id, branch_id]
        );

        if (!broadcastRows.length) {
            return fail(res, "Broadcast not found", 404);
        }

        const broadcast = broadcastRows[0];

        // Calculate paused
        const totalProcessed = (broadcast.total_sent || 0) + (broadcast.total_failed || 0) + (broadcast.total_skipped || 0);
        const paused = (broadcast.total_recipients || 0) - (broadcast.total_pending || 0) - totalProcessed;

        // Get recipient details with pagination
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;
        const recipient_status = req.query.status;

        let recipientQuery = `
            SELECT 
                recipient_id,
                recipient_email,
                recipient_name,
                status,
                attempt_count,
                error_message,
                create_date as queued_at,
                sent_at,
                last_attempt_at
            FROM email_broadcast_recipients
            WHERE broadcast_id = ? AND branch_id = ?
        `;
        const recipientParams = [broadcast_id, branch_id];

        if (recipient_status && ['sent', 'pending', 'failed', 'skipped'].includes(recipient_status)) {
            recipientQuery += ` AND status = ?`;
            recipientParams.push(recipient_status);
        }

        recipientQuery += ` ORDER BY create_date DESC LIMIT ? OFFSET ?`;
        recipientParams.push(limit, offset);

        const [recipients] = await pool.query(recipientQuery, recipientParams);

        // Get total recipients count
        let countQuery = `SELECT COUNT(*) as total FROM email_broadcast_recipients WHERE broadcast_id = ? AND branch_id = ?`;
        const countParams = [broadcast_id, branch_id];
        
        if (recipient_status && ['sent', 'pending', 'failed', 'skipped'].includes(recipient_status)) {
            countQuery += ` AND status = ?`;
            countParams.push(recipient_status);
        }
        
        const [countRows] = await pool.query(countQuery, countParams);
        const total_recipients_count = countRows[0]?.total || 0;

        // Get failure breakdown
        const [failures] = await pool.query(
            `SELECT 
                error_message,
                COUNT(*) as count
            FROM email_broadcast_recipients
            WHERE broadcast_id = ? AND branch_id = ? AND status = 'failed' AND error_message IS NOT NULL
            GROUP BY error_message
            ORDER BY count DESC
            LIMIT 10`,
            [broadcast_id, branch_id]
        );

        // Get hourly delivery breakdown (if sent)
        const [hourlyDelivery] = await pool.query(
            `SELECT 
                HOUR(sent_at) as hour,
                COUNT(*) as deliveries
            FROM email_broadcast_recipients
            WHERE broadcast_id = ? AND branch_id = ? AND status = 'sent' AND sent_at IS NOT NULL
            GROUP BY HOUR(sent_at)
            ORDER BY hour ASC`,
            [broadcast_id, branch_id]
        );

        return ok(res, "Broadcast details retrieved successfully", {
            broadcast_info: {
                broadcast_id: broadcast.broadcast_id,
                broadcast_name: broadcast.broadcast_name,
                template_name: broadcast.template_name,
                template_type: broadcast.template_type,
                schedule_type: broadcast.schedule_type,
                scheduled_at: broadcast.scheduled_at,
                status: broadcast.status,
                created_at: broadcast.create_date,
                started_at: broadcast.started_at,
                completed_at: broadcast.completed_at,
                smtp_config: {
                    config_name: broadcast.config_name,
                    from_email: broadcast.from_email,
                    from_name: broadcast.from_name
                }
            },
            statistics: {
                total_recipients: broadcast.total_recipients || 0,
                sent: broadcast.total_sent || 0,
                pending: broadcast.total_pending || 0,
                failed: broadcast.total_failed || 0,
                skipped: broadcast.total_skipped || 0,
                paused: paused,
                success_rate: broadcast.total_recipients > 0 ?
                    ((broadcast.total_sent / broadcast.total_recipients) * 100).toFixed(2) : 0,
                failure_rate: broadcast.total_recipients > 0 ?
                    ((broadcast.total_failed / broadcast.total_recipients) * 100).toFixed(2) : 0,
                avg_delivery_time: broadcast.total_sent > 0 ? await getAvgDeliveryTime(broadcast_id, branch_id) : 'N/A'
            },
            recipients: recipients.map(r => ({
                recipient_id: r.recipient_id,
                email: r.recipient_email,
                name: r.recipient_name,
                status: r.status,
                attempts: r.attempt_count,
                error: r.error_message,
                queued_at: r.queued_at,
                sent_at: r.sent_at,
                last_attempt: r.last_attempt_at
            })),
            failure_breakdown: failures,
            hourly_delivery: hourlyDelivery,
            pagination: {
                page_no,
                limit,
                total: total_recipients_count,
                total_pages: Math.ceil(total_recipients_count / limit),
                has_next: offset + recipients.length < total_recipients_count,
                has_prev: page_no > 1
            }
        });

    } catch (error) {
        console.error("Broadcast details error:", error);
        return fail(res, error.message || "Failed to fetch broadcast details");
    }
});


// ==================== NEW ENDPOINTS FOR FALLBACK & DAILY LIMITS ====================

/**
 * Update daily limit for a broadcast
 * PUT /api/email/broadcast/update-daily-limit
 */
router.put("/broadcast/update-daily-limit", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { broadcast_id, daily_limit } = req.body || {};
        
        if (!broadcast_id || !daily_limit) {
            return fail(res, "broadcast_id and daily_limit are required");
        }
        
        if (daily_limit < 1 || daily_limit > 100000) {
            return fail(res, "daily_limit must be between 1 and 100000");
        }
        
        const [result] = await pool.query(
            "UPDATE email_broadcasts SET daily_limit = ? WHERE branch_id = ? AND broadcast_id = ?",
            [daily_limit, branch_id, broadcast_id]
        );
        
        if (!result.affectedRows) {
            return fail(res, "Broadcast not found", 404);
        }
        
        return ok(res, "Daily limit updated successfully", { broadcast_id, daily_limit });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

/**
 * Update daily limit for an email config
 * PUT /api/email/config/update-daily-limit
 */
router.put("/config/update-daily-limit", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { config_id, daily_limit } = req.body || {};
        
        if (!config_id || !daily_limit) {
            return fail(res, "config_id and daily_limit are required");
        }
        
        if (daily_limit < 1 || daily_limit > 100000) {
            return fail(res, "daily_limit must be between 1 and 100000");
        }
        
        const [result] = await pool.query(
            "UPDATE email_configs SET daily_limit = ? WHERE branch_id = ? AND config_id = ?",
            [daily_limit, branch_id, config_id]
        );
        
        if (!result.affectedRows) {
            return fail(res, "Config not found", 404);
        }
        
        return ok(res, "Config daily limit updated successfully", { config_id, daily_limit });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

/**
 * Get daily usage statistics for a broadcast
 * GET /api/email/broadcast/daily-usage/:broadcast_id
 */
router.get("/broadcast/daily-usage/:broadcast_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const broadcast_id = req.params.broadcast_id;
        const days = Math.min(Number(req.query.days || 7), 30);
        
        const [usage] = await pool.query(
            `SELECT 
                DATE(sent_at) as send_date,
                COUNT(*) as emails_sent,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as emails_failed,
                COUNT(CASE WHEN status = 'skipped' THEN 1 END) as emails_skipped,
                COUNT(CASE WHEN used_config_id IS NOT NULL THEN 1 END) as used_fallback
             FROM email_broadcast_recipients
             WHERE branch_id = ? AND broadcast_id = ? AND status IN ('sent', 'failed', 'skipped')
               AND sent_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
             GROUP BY DATE(sent_at)
             ORDER BY send_date DESC`,
            [branch_id, broadcast_id, days]
        );
        
        return ok(res, "Daily usage retrieved successfully", {
            broadcast_id,
            daily_stats: usage,
            period_days: days
        });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

/**
 * Get config usage summary
 * GET /api/email/config/usage-summary
 */
router.get("/config/usage-summary", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const date = req.query.date || new Date().toISOString().split('T')[0];
        
        const [usage] = await pool.query(
            `SELECT 
                c.config_id,
                c.config_name,
                c.daily_limit,
                COALESCE(du.emails_sent, 0) as emails_sent_today,
                ROUND((COALESCE(du.emails_sent, 0) * 100.0 / NULLIF(c.daily_limit, 0)), 2) as usage_percentage,
                du.usage_date,
                c.status
             FROM email_configs c
             LEFT JOIN email_daily_usage du ON du.config_id = c.config_id 
                 AND du.branch_id = c.branch_id 
                 AND du.usage_date = ?
             WHERE c.branch_id = ? AND c.status = 'active'
             ORDER BY c.is_default DESC, c.config_name`,
            [date, branch_id]
        );
        
        return ok(res, "Config usage summary retrieved successfully", {
            date,
            configs: usage
        });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

/**
 * Get send attempts for a recipient
 * GET /api/email/recipient/attempts/:recipient_id
 */
router.get("/recipient/attempts/:recipient_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const recipient_id = req.params.recipient_id;
        
        const [attempts] = await pool.query(
            `SELECT 
                attempt_id,
                broadcast_id,
                config_id,
                attempt_number,
                error_message,
                created_at
             FROM email_send_attempts
             WHERE branch_id = ? AND recipient_id = ?
             ORDER BY created_at DESC`,
            [branch_id, recipient_id]
        );
        
        return ok(res, "Send attempts retrieved successfully", {
            recipient_id,
            attempts: attempts
        });
        
    } catch (error) {
        return fail(res, error.message);
    }
});


/**
 * Manually process a specific broadcast
 * POST /api/email/broadcast/process/:broadcast_id
 */
router.post("/broadcast/process/:broadcast_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const broadcast_id = req.params.broadcast_id;
        
        // Check if broadcast exists
        const [broadcast] = await pool.query(
            "SELECT status FROM email_broadcasts WHERE branch_id = ? AND broadcast_id = ?",
            [branch_id, broadcast_id]
        );
        
        if (!broadcast.length) {
            return fail(res, "Broadcast not found", 404);
        }
        
        // Process in background
        processBroadcastRecipients(branch_id, broadcast_id).catch(err => {
            console.error(`Error processing broadcast ${broadcast_id}:`, err);
        });
        
        return ok(res, "Broadcast processing started", { broadcast_id });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

// Helper function to get average delivery time
async function getAvgDeliveryTime(broadcast_id, branch_id) {
    const [result] = await pool.query(
        `SELECT AVG(TIMESTAMPDIFF(SECOND, create_date, sent_at)) as avg_seconds
         FROM email_broadcast_recipients
         WHERE broadcast_id = ? AND branch_id = ? AND status = 'sent' AND sent_at IS NOT NULL`,
        [broadcast_id, branch_id]
    );
    
    const seconds = result[0]?.avg_seconds;
    if (!seconds) return 'N/A';
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    
    if (minutes > 0) {
        return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
}

// ==================== AUTOMATIC SCHEDULER FOR BROADCASTS ====================

let schedulerInterval = null;

/**
 * Start the automatic scheduler that processes due broadcasts every minute
 */
function startBroadcastScheduler() {
    // Run immediately on startup (after 5 seconds to ensure DB connection)
    setTimeout(async () => {
        try {
            await processDueBroadcasts();
        } catch (err) {
            console.error("Initial broadcast check error:", err);
        }
    }, 5000);
    
    // Clear existing interval if any
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
    }

    // In startBroadcastScheduler function, replace the setInterval with:
schedulerInterval = setInterval(async () => {
    try {
        await processDueBroadcasts();
    } catch (error) {
        console.error("Broadcast scheduler error:", error);
    }
}, 60000); }

// Start the scheduler
startBroadcastScheduler();

// Handle graceful shutdown
process.on('SIGTERM', () => {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
    }
    process.exit(0);
});

/**
 * Get dynamic variables based on type and identifier
 * GET /api/email/dynamic-variables/:type/:identifier
 * 
 * Types:
 * - client/:username - Get client profile + firm details
 * - task/:task_id - Get task details + client + firm
 * - firm/:firm_id - Get firm details + client profile
 * - invoice/:invoice_id - Get invoice details + client + firm
 * - transaction/:transaction_id - Get transaction details + parties
 * - general/:username - Get all available data for a user
 */
router.get("/dynamic-variables/:type/:identifier", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { type, identifier } = req.params;
        
        let variables = {};
        
        // Helper to get profile data
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
        
        // Helper to get firm data
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
        
        switch(type) {
            case 'client':
                // Get client by username
                const clientProfile = await getProfileData(identifier);
                const clientFirm = await getFirmData(identifier);
                
                variables = {
                    type: 'client',
                    // Profile variables
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
                    profile_image: clientProfile.image,
                    registered_date: clientProfile.create_date,
                    // Firm variables
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
                
            case 'task':
                // Get task details
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
                        type: 'task',
                        // Task variables
                        task_id: taskData.task_id,
                        task_status: taskData.status,
                        task_billing: taskData.billing_status == '0' ? 'Pending' : (taskData.billing_status == '1' ? 'Completed' : 'Non Billable'),
                        fees: taskData.fees,
                        tax_rate: taskData.tax_rate,
                        tax_value: taskData.tax_value,
                        total: taskData.total,
                        due_date: taskData.due_date,
                        target_date: taskData.target_date,
                        created_date: taskData.create_date,
                        completed_date: taskData.complete_date,
                        is_recurring: taskData.is_recurring == '1' ? 'Yes' : 'No',
                        // Service variables
                        service_name: taskData.service_name,
                        service_sac_code: taskData.sac_code,
                        service_type: taskData.service_type,
                        // Client variables
                        client_name: taskProfile.name,
                        client_email: taskProfile.email,
                        client_mobile: taskProfile.mobile,
                        client_username: taskProfile.username,
                        // Firm variables
                        firm_name: taskFirm.firm_name,
                        firm_type: taskFirm.firm_type,
                        firm_gst: taskFirm.gst_no,
                        firm_pan: taskFirm.pan_no
                    };
                }
                break;
                
            case 'firm':
                // Get firm by firm_id
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
                        type: 'firm',
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
                        // Client associated
                        client_name: firmData.client_name,
                        client_email: firmData.email,
                        client_mobile: firmData.mobile,
                        client_username: firmData.username
                    };
                }
                break;
                
            case 'invoice':
                // Get invoice details
                const [invoice] = await pool.query(
                    `SELECT i.*, f.firm_name, p.name as client_name, p.email, p.mobile
                     FROM invoice i
                     LEFT JOIN firms f ON f.firm_id = i.firm_id
                     LEFT JOIN profile p ON p.username = f.username
                     WHERE i.invoice_id = ? AND i.branch_id = ?`,
                    [identifier, branch_id]
                );
                
                if (invoice.length) {
                    const inv = invoice[0];
                    variables = {
                        type: 'invoice',
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
                        // Firm/Client
                        firm_name: inv.firm_name,
                        client_name: inv.client_name,
                        client_email: inv.email,
                        client_mobile: inv.mobile
                    };
                }
                break;
                
            case 'transaction':
                // Get transaction details
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
                        type: 'transaction',
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
                
            case 'general':
                // Get all available data for a user
                const generalProfile = await getProfileData(identifier);
                const generalFirm = await getFirmData(identifier);
                
                // Get task count
                const [taskCount] = await pool.query(
                    `SELECT COUNT(*) as count FROM tasks WHERE username = ? AND branch_id = ?`,
                    [identifier, branch_id]
                );
                
                // Get invoice total
                const [invoiceTotal] = await pool.query(
                    `SELECT SUM(grand_total) as total FROM invoice i
                     JOIN firms f ON f.firm_id = i.firm_id
                     WHERE f.username = ? AND i.branch_id = ?`,
                    [identifier, branch_id]
                );
                
                variables = {
                    type: 'general',
                    // Profile
                    name: generalProfile.name || identifier,
                    username: generalProfile.username,
                    email: generalProfile.email,
                    mobile: generalProfile.mobile,
                    pan_number: generalProfile.pan_number,
                    city: generalProfile.city,
                    state: generalProfile.state,
                    // Firm
                    firm_name: generalFirm.firm_name,
                    firm_type: generalFirm.firm_type,
                    gst_no: generalFirm.gst_no,
                    // Stats
                    total_tasks: taskCount[0]?.count || 0,
                    total_invoice_value: invoiceTotal[0]?.total || 0,
                    // Custom welcome message
                    welcome_message: `Welcome ${generalProfile.name || identifier} to our platform!`,
                    current_date: new Date().toISOString().split('T')[0],
                    current_year: new Date().getFullYear(),
                    current_time: new Date().toLocaleTimeString()
                };
                break;
        }
        
        return ok(res, "Dynamic variables retrieved", {
            type: type,
            identifier: identifier,
            variables: variables,
            available_keys: Object.keys(variables)
        });
        
    } catch (error) {
        console.error("Dynamic variables error:", error);
        return fail(res, error.message);
    }
});

/**
 * 1. Get variable keys by template type (for template creation)
 * GET /api/email/variable-keys/:type
 */
router.get("/variable-keys/:type", auth, validateBranch, async (req, res) => {
    try {
        const { type } = req.params;
        
        const variableKeys = {
            general: ['name', 'email', 'mobile', 'firm_name', 'current_date', 'current_year', 'company', 'support_email'],
            welcome: ['name', 'email', 'firm_name', 'company', 'welcome_message', 'getting_started_link', 'support_email'],
            birthday: ['name', 'email', 'birthday_date', 'age', 'offer', 'coupon_code', 'company'],
            sale: ['name', 'discount', 'coupon_code', 'offer_end_date', 'product_name', 'original_price', 'sale_price', 'company'],
            invoice: ['name', 'invoice_no', 'invoice_date', 'due_date', 'amount', 'payment_link', 'company'],
            reminder: ['name', 'task_name', 'due_date', 'days_left', 'company'],
            payment_receipt: ['name', 'receipt_no', 'payment_date', 'amount', 'payment_method', 'transaction_id', 'company'],
            newsletter: ['name', 'unsubscribe_link', 'company', 'newsletter_title', 'featured_article']
        };
        
        const keys = variableKeys[type] || variableKeys.general;
        
        return ok(res, "Variable keys retrieved", {
            template_type: type,
            keys: keys,
            usage: "Use {{variable_name}} in your template"
        });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

export default router;
