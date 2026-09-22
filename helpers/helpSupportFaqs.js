import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";

function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}

const DEFAULT_FAQS = [
    {
        question: "How do I recharge my wallet?",
        answer:
            "Go to Wallet Recharge from the header wallet balance or sidebar. You can pay online via the payment gateway or submit a bank transfer payment request with your UTR for admin approval.",
        sort_order: 1,
    },
    {
        question: "How do I switch between branches?",
        answer:
            "Open your profile menu and choose Switch Branch, or use the branch selector in the header. Select the branch you want to work in and confirm.",
        sort_order: 2,
    },
    {
        question: "How do I manage staff access and permissions?",
        answer:
            "Branch admins can invite staff and assign roles from Staff settings. Permissions control which modules each member can view or edit.",
        sort_order: 3,
    },
    {
        question: "Where can I view or change my subscription?",
        answer:
            "Open Subscription from the sidebar to see your current plan, renewals, and available upgrades.",
        sort_order: 4,
    },
    {
        question: "How do I contact support?",
        answer:
            "Use the contact details on this Help & Support page — email, phone, or WhatsApp during support hours. Share your username and branch name so we can assist faster.",
        sort_order: 5,
    },
];

export async function ensureHelpSupportFaqsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS help_support_faqs (
          id INT NOT NULL AUTO_INCREMENT,
          faq_id VARCHAR(50) NOT NULL,
          question VARCHAR(500) NOT NULL,
          answer TEXT NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          create_by VARCHAR(50) NULL DEFAULT NULL,
          create_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
          modify_by VARCHAR(50) NULL DEFAULT NULL,
          modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_help_support_faq_id (faq_id),
          KEY idx_help_support_faqs_status_sort (status, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function ensureHelpSupportIntroTextColumn() {
    try {
        await pool.query(`
            ALTER TABLE help_support_platform_config
            MODIFY COLUMN intro_text TEXT NULL DEFAULT NULL
        `);
    } catch (error) {
        if (error?.code !== "ER_NO_SUCH_TABLE") {
            // Ignore duplicate/no-op alter issues; surface real failures elsewhere
            if (
                !String(error?.sqlMessage || error?.message || "")
                    .toLowerCase()
                    .includes("duplicate")
            ) {
                // Column already TEXT or table missing — safe to continue
            }
        }
    }
}

export function serializeFaq(row) {
    if (!row) return null;
    return {
        faq_id: row.faq_id,
        question: trimStr(row.question),
        answer: trimStr(row.answer),
        sort_order: Number(row.sort_order) || 0,
        status: row.status === "inactive" ? "inactive" : "active",
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

export async function seedDefaultFaqsIfEmpty(actor = "system") {
    await ensureHelpSupportFaqsTable();
    const [[{ cnt }]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM help_support_faqs`
    );
    if (Number(cnt) > 0) return;

    for (const item of DEFAULT_FAQS) {
        const faq_id = await UNIQUE_RANDOM_STRING("help_support_faqs", "faq_id", {
            length: 12,
        });
        await pool.query(
            `INSERT INTO help_support_faqs
                (faq_id, question, answer, sort_order, status, create_by, modify_by)
             VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            [
                faq_id,
                item.question,
                item.answer,
                item.sort_order,
                actor,
                actor,
            ]
        );
    }
}

export async function listFaqs({ activeOnly = false } = {}) {
    await ensureHelpSupportFaqsTable();
    await seedDefaultFaqsIfEmpty();

    const where = activeOnly ? `WHERE status = 'active'` : "";
    const [rows] = await pool.query(
        `SELECT *
         FROM help_support_faqs
         ${where}
         ORDER BY sort_order ASC, id ASC`
    );
    return rows.map(serializeFaq);
}

export async function getFaqById(faqId) {
    await ensureHelpSupportFaqsTable();
    const [rows] = await pool.query(
        `SELECT * FROM help_support_faqs WHERE faq_id = ? LIMIT 1`,
        [faqId]
    );
    return rows[0] ? serializeFaq(rows[0]) : null;
}

export async function createFaq(body = {}, actor = null) {
    await ensureHelpSupportFaqsTable();
    const question = trimStr(body.question);
    const answer = trimStr(body.answer);
    if (!question) {
        const err = new Error("Question is required");
        err.status = 400;
        throw err;
    }
    if (!answer) {
        const err = new Error("Answer is required");
        err.status = 400;
        throw err;
    }

    let sort_order = Number(body.sort_order);
    if (!Number.isFinite(sort_order)) {
        const [[{ maxSort }]] = await pool.query(
            `SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM help_support_faqs`
        );
        sort_order = Number(maxSort) + 1;
    }

    const status =
        String(body.status || "active").toLowerCase() === "inactive"
            ? "inactive"
            : "active";

    const faq_id = await UNIQUE_RANDOM_STRING("help_support_faqs", "faq_id", {
        length: 12,
    });
    await pool.query(
        `INSERT INTO help_support_faqs
            (faq_id, question, answer, sort_order, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [faq_id, question, answer, sort_order, status, actor, actor]
    );
    return getFaqById(faq_id);
}

export async function updateFaq(faqId, body = {}, actor = null) {
    await ensureHelpSupportFaqsTable();
    const existing = await getFaqById(faqId);
    if (!existing) {
        const err = new Error("FAQ not found");
        err.status = 404;
        throw err;
    }

    const question = trimStr(body.question);
    const answer = trimStr(body.answer);
    if (!question) {
        const err = new Error("Question is required");
        err.status = 400;
        throw err;
    }
    if (!answer) {
        const err = new Error("Answer is required");
        err.status = 400;
        throw err;
    }

    const sort_order = Number.isFinite(Number(body.sort_order))
        ? Number(body.sort_order)
        : existing.sort_order;
    const status =
        String(body.status || existing.status).toLowerCase() === "inactive"
            ? "inactive"
            : "active";

    await pool.query(
        `UPDATE help_support_faqs
         SET question = ?, answer = ?, sort_order = ?, status = ?,
             modify_by = ?, modify_date = NOW()
         WHERE faq_id = ?`,
        [question, answer, sort_order, status, actor, faqId]
    );
    return getFaqById(faqId);
}

export async function deleteFaq(faqId) {
    await ensureHelpSupportFaqsTable();
    const [result] = await pool.query(
        `DELETE FROM help_support_faqs WHERE faq_id = ?`,
        [faqId]
    );
    if (!result?.affectedRows) {
        const err = new Error("FAQ not found");
        err.status = 404;
        throw err;
    }
    return true;
}
