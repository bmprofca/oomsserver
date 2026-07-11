import pool from "../db.js";
import crypto from "crypto";
import { getWalletBalance } from "../services/walletService.js";

const sessions = new Map();

// Helper to extract or initialize session
function getOrCreateSession(sessionId) {
    let id = sessionId;
    if (!id || !sessions.has(id)) {
        id = `bot_${crypto.randomBytes(16).toString("hex")}`;
        sessions.set(id, {
            state: "init",
            tempName: null,
            user: null,
            lastActive: Date.now()
        });
    }
    const session = sessions.get(id);
    session.lastActive = Date.now();
    return { id, session };
}

// Session cleaner (runs periodically to delete sessions inactive for > 1 hour)
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
        if (now - session.lastActive > 3600000) {
            sessions.delete(id);
        }
    }
}, 600000);

const botController = {
    async chat(req, res) {
        try {
            const { message, session_id } = req.body || {};
            const cleanMsg = String(message || "").trim();

            if (!cleanMsg) {
                return res.status(400).json({
                    success: false,
                    message: "Message is required"
                });
            }

            const { id: activeSessionId, session } = getOrCreateSession(session_id);

            // 1. Initial State: Ask for name
            if (session.state === "init") {
                const nameRegexes = [
                    /my name is\s+([a-zA-Z\s]+)/i,
                    /i am\s+([a-zA-Z\s]+)/i,
                    /this is\s+([a-zA-Z\s]+)/i,
                    /call me\s+([a-zA-Z\s]+)/i
                ];
                let extractedName = cleanMsg;
                for (const r of nameRegexes) {
                    const match = cleanMsg.match(r);
                    if (match && match[1]) {
                        extractedName = match[1].trim();
                        break;
                    }
                }

                if (extractedName.length > 50) {
                    extractedName = extractedName.substring(0, 50);
                }

                session.tempName = extractedName;
                session.state = "waiting_for_phone";

                return res.json({
                    success: true,
                    session_id: activeSessionId,
                    state: session.state,
                    reply: `Nice to meet you, **${extractedName}**! To verify your identity, please enter your 10-to-15 digit mobile number.`
                });
            }

            // 2. Verification State: Validate phone number and name
            if (session.state === "waiting_for_phone") {
                const phoneMatch = cleanMsg.match(/\b\d{10,15}\b/);
                if (!phoneMatch) {
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply: "Please provide a valid 10-to-15 digit mobile number so I can confirm your account details."
                    });
                }

                const mobile = phoneMatch[0];
                const namePattern = `%${session.tempName}%`;

                // Query database
                const [profiles] = await pool.query(
                    `SELECT p.username, p.name, p.mobile, bm.branch_id, bl.name AS branch_name
                     FROM profile p
                     INNER JOIN branch_mapping bm ON bm.username = p.username AND bm.is_accepted = '1' AND bm.status = '1' AND bm.is_deleted = '0'
                     INNER JOIN branch_list bl ON bl.branch_id = bm.branch_id
                     WHERE (p.status = '1' OR p.status = 'active')
                       AND (p.name LIKE ? OR p.username = ? OR ? LIKE CONCAT('%', p.name, '%'))
                       AND (p.mobile = ? OR p.mobile LIKE ?)
                     LIMIT 1`,
                    [namePattern, session.tempName, session.tempName, mobile, `%${mobile}`]
                ).catch(async () => {
                    // Fallback to simpler profile and mapping lookup if tables differ
                    const [simpleProfiles] = await pool.query(
                        `SELECT p.username, p.name, p.mobile
                         FROM profile p
                         WHERE (p.status = '1' OR p.status = 'active') AND (p.name LIKE ? OR p.mobile = ?)
                         LIMIT 1`,
                        [namePattern, mobile]
                    );
                    
                    if (simpleProfiles.length > 0) {
                        const user = simpleProfiles[0];
                        const [branchMapping] = await pool.query(
                            `SELECT branch_id FROM branch_mapping WHERE username = ? LIMIT 1`,
                            [user.username]
                        );
                        return [[{
                            username: user.username,
                            name: user.name,
                            mobile: user.mobile,
                            branch_id: branchMapping[0]?.branch_id || 1,
                            branch_name: "Branch 1"
                        }]];
                    }
                    return [[]];
                });

                if (!profiles || profiles.length === 0) {
                    const temp = session.tempName;
                    session.state = "init";
                    session.tempName = null;
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply: `Sorry, I couldn't find an active account matching the name **"${temp}"** and mobile number **"${mobile}"**. Let's start over. What is your name?`
                    });
                }

                const matchedUser = profiles[0];
                session.user = {
                    username: matchedUser.username,
                    name: matchedUser.name,
                    mobile: matchedUser.mobile,
                    branch_id: matchedUser.branch_id,
                    branch_name: matchedUser.branch_name
                };
                session.state = "verified";

                return res.json({
                    success: true,
                    session_id: activeSessionId,
                    state: session.state,
                    user: session.user,
                    reply: `Verification successful! Welcome back, **${session.user.name}** (Branch: *${session.user.branch_name}*).\n\nI have access to your database details. Ask me anything like:\n- *What is my wallet balance?*\n- *Show pending tasks*\n- *What is our total pending/outstanding fees?*\n- *How many active clients do we have?*`
                });
            }

            // 3. Verified State: Process questions
            if (session.state === "verified") {
                const branch_id = session.user.branch_id;
                const lowerMsg = cleanMsg.toLowerCase();

                // Check wallet balance
                if (lowerMsg.includes("balance") || lowerMsg.includes("wallet") || lowerMsg.includes("how much money")) {
                    const balance = (await getWalletBalance(branch_id)).toFixed(2);
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply: `💰 Your branch wallet balance is **₹${balance}**.`
                    });
                }

                // Check pending / outstanding fees
                if (lowerMsg.includes("pending") || lowerMsg.includes("outstanding") || lowerMsg.includes("due") || lowerMsg.includes("fees")) {
                    const [pendingRow] = await pool.query(
                        `SELECT SUM(total) AS total_pending FROM tasks WHERE branch_id = ? AND billing_status = '0' AND status = 'complete'`,
                        [branch_id]
                    );
                    const [incompleteRow] = await pool.query(
                        `SELECT SUM(total) AS total_incomplete FROM tasks WHERE branch_id = ? AND status NOT IN ('complete', 'cancel')`,
                        [branch_id]
                    );

                    const pending = Number(pendingRow[0]?.total_pending || 0).toFixed(2);
                    const incomplete = Number(incompleteRow[0]?.total_incomplete || 0).toFixed(2);

                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply: `📊 **Outstanding Fees Summary:**\n- Completed tasks pending billing: **₹${pending}**\n- In-progress tasks outstanding: **₹${incomplete}**`
                    });
                }

                // Pending / Incomplete Tasks
                if ((lowerMsg.includes("pending") || lowerMsg.includes("incomplete") || lowerMsg.includes("active")) && lowerMsg.includes("task")) {
                    const [countRow] = await pool.query(
                        `SELECT COUNT(*) AS total FROM tasks WHERE branch_id = ? AND status NOT IN ('complete', 'cancel')`,
                        [branch_id]
                    );
                    const [rows] = await pool.query(
                        `SELECT t.task_id, s.name AS service_name, t.due_date, t.status 
                         FROM tasks t
                         LEFT JOIN services s ON s.service_id = t.service_id
                         WHERE t.branch_id = ? AND t.status NOT IN ('complete', 'cancel')
                         ORDER BY t.due_date ASC
                         LIMIT 5`,
                        [branch_id]
                    );

                    let reply = `📋 You have **${countRow[0]?.total || 0}** pending/incomplete tasks in this branch.`;
                    if (rows.length > 0) {
                        reply += `\n\nHere are the top 5 next due:\n`;
                        rows.forEach((r, idx) => {
                            reply += `${idx + 1}. **${r.service_name || "General Service"}** (Due: *${r.due_date || "N/A"}*, Status: \`${r.status}\`)\n`;
                        });
                    }
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply
                    });
                }

                // Tasks breakdown
                if (lowerMsg.includes("task")) {
                    const [totalRow] = await pool.query(
                        `SELECT COUNT(*) AS total FROM tasks WHERE branch_id = ?`,
                        [branch_id]
                    );
                    const [rows] = await pool.query(
                        `SELECT status, COUNT(*) AS count FROM tasks WHERE branch_id = ? GROUP BY status`,
                        [branch_id]
                    );

                    let reply = `📋 Total tasks in branch: **${totalRow[0]?.total || 0}**.\n\nBreakdown by status:\n`;
                    rows.forEach((r) => {
                        reply += `- **${r.status}**: ${r.count} tasks\n`;
                    });
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply
                    });
                }

                // New Clients (recently registered)
                if (lowerMsg.includes("new client") || lowerMsg.includes("recent client") || lowerMsg.includes("recent registration")) {
                    const [rows] = await pool.query(
                        `SELECT p.name, p.email, p.mobile, p.create_date 
                         FROM clients c 
                         INNER JOIN profile p ON p.username = c.username
                         WHERE c.branch_id = ? AND c.is_deleted = '0'
                         ORDER BY p.id DESC
                         LIMIT 5`,
                        [branch_id]
                    );

                    let reply = `👥 **Recently registered clients:**\n\n`;
                    if (rows.length === 0) {
                        reply += "No recently registered clients found.";
                    } else {
                        rows.forEach((r, idx) => {
                            const dateStr = r.create_date ? new Date(r.create_date).toLocaleDateString() : "N/A";
                            reply += `${idx + 1}. **${r.name}** (Mobile: ${r.mobile || "N/A"}, Joined: *${dateStr}*)\n`;
                        });
                    }
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply
                    });
                }

                // Clients count
                if (lowerMsg.includes("client")) {
                    const [totalRow] = await pool.query(
                        `SELECT COUNT(*) AS total FROM clients WHERE branch_id = ? AND is_deleted = '0'`,
                        [branch_id]
                    );
                    const [activeRow] = await pool.query(
                        `SELECT COUNT(*) AS active FROM clients WHERE branch_id = ? AND is_deleted = '0' AND status = '1'`,
                        [branch_id]
                    );

                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply: `👥 **Client Stats:**\n- Total active profiles: **${totalRow[0]?.total || 0}**\n- Mapped active users: **${activeRow[0]?.active || 0}**`
                    });
                }

                // Firms count
                if (lowerMsg.includes("firm")) {
                    const [totalRow] = await pool.query(
                        `SELECT COUNT(*) AS total FROM firms WHERE branch_id = ? AND is_deleted = '0'`,
                        [branch_id]
                    );
                    const [activeRow] = await pool.query(
                        `SELECT COUNT(*) AS active FROM firms WHERE branch_id = ? AND is_deleted = '0' AND status = '1'`,
                        [branch_id]
                    );

                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply: `🏢 **Firm Stats:**\n- Total active firms: **${totalRow[0]?.total || 0}**\n- Mapped active status: **${activeRow[0]?.active || 0}**`
                    });
                }

                // Search client
                const searchClientMatch = cleanMsg.match(/(?:search client|find client|search for client|info on client)\s+([a-zA-Z0-9_\s]+)/i);
                if (searchClientMatch && searchClientMatch[1]) {
                    const searchName = `%${searchClientMatch[1].trim()}%`;
                    const [rows] = await pool.query(
                        `SELECT p.name, p.email, p.mobile, c.status 
                         FROM clients c 
                         INNER JOIN profile p ON p.username = c.username
                         WHERE c.branch_id = ? AND c.is_deleted = '0' AND (p.name LIKE ? OR p.username LIKE ?)
                         LIMIT 3`,
                        [branch_id, searchName, searchName]
                    );

                    let reply = `🔍 **Client search results for "${searchClientMatch[1].trim()}":**\n\n`;
                    if (rows.length === 0) {
                        reply += "No matching clients found.";
                    } else {
                        rows.forEach((r, idx) => {
                            reply += `**${idx + 1}. ${r.name}**\n- Mobile: ${r.mobile || "N/A"}\n- Email: ${r.email || "N/A"}\n- Status: ${r.status === '1' ? 'Active' : 'Inactive'}\n\n`;
                        });
                    }
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply
                    });
                }

                // Search firm
                const searchFirmMatch = cleanMsg.match(/(?:search firm|find firm|search for firm|info on firm)\s+([a-zA-Z0-9_\s]+)/i);
                if (searchFirmMatch && searchFirmMatch[1]) {
                    const searchName = `%${searchFirmMatch[1].trim()}%`;
                    const [rows] = await pool.query(
                        `SELECT firm_name, gst_no, pan_no, status 
                         FROM firms 
                         WHERE branch_id = ? AND is_deleted = '0' AND firm_name LIKE ?
                         LIMIT 3`,
                        [branch_id, searchName]
                    );

                    let reply = `🏢 **Firm search results for "${searchFirmMatch[1].trim()}":**\n\n`;
                    if (rows.length === 0) {
                        reply += "No matching firms found.";
                    } else {
                        rows.forEach((r, idx) => {
                            reply += `**${idx + 1}. ${r.firm_name}**\n- GST No: ${r.gst_no || "N/A"}\n- PAN No: ${r.pan_no || "N/A"}\n- Status: ${r.status === '1' ? 'Active' : 'Inactive'}\n\n`;
                        });
                    }
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply
                    });
                }

                // Help menu
                if (lowerMsg.includes("help") || lowerMsg.includes("menu") || lowerMsg.includes("what can you do")) {
                    return res.json({
                        success: true,
                        session_id: activeSessionId,
                        state: session.state,
                        reply: `💡 **Here is what I can answer:**\n- Wallet balance: *What is my wallet balance?*\n- Tasks: *Show pending tasks* or *breakdown of tasks*\n- Outstanding Fees: *What are my pending/outstanding fees?*\n- Clients: *How many clients do we have?* or *who are the new clients?*\n- Firms: *Show total firms*\n- Custom Search: *Search client [name]* or *Search firm [name]*`
                    });
                }

                // Default
                return res.json({
                    success: true,
                    session_id: activeSessionId,
                    state: session.state,
                    reply: "Sorry, I didn't quite capture that query. I can help with wallet balance, outstanding fees, tasks, client lists, or firm details. Type **help** to see all available queries!"
                });
            }

            // Fallback
            return res.json({
                success: true,
                session_id: activeSessionId,
                state: "init",
                reply: "Hello! I am your OOMS Personal Assistant. What is your name to begin?"
            });

        } catch (error) {
            console.error("Bot chat error:", error);
            return res.status(500).json({
                success: false,
                message: "Bot error occurred",
                error: error.message
            });
        }
    },
    async resetSession(req, res) {
        try {
            const { session_id } = req.body || {};
            if (session_id && sessions.has(session_id)) {
                sessions.delete(session_id);
                return res.json({ success: true, message: "Session reset successfully" });
            }
            return res.json({ success: true, message: "Session already empty or not found" });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Reset error occurred",
                error: error.message
            });
        }
    }
};

export default botController;
