import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";

function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}

function slugify(value) {
    return trimStr(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100);
}

export const DEFAULT_LEGAL_PAGES = [
    {
        slug: "privacy-policy",
        title: "Privacy Policy",
        sort_order: 10,
        content_html: `
<p><strong>Effective date:</strong> 26 September 2026</p>
<p>OneSaaS Technologies Private Limited ("OneSaaS", "OOMS", "we", "us", or "our") operates the OneSaaS Office Management System (OOMS) and related websites, portals, and applications. This Privacy Policy explains how we collect, use, store, share, and protect personal and business information when you use our products and services in India.</p>

<h3>1. Who We Are</h3>
<p>OneSaaS Technologies Private Limited is an Indian technology company providing cloud software for Chartered Accountants, Cost Accountants, Company Secretaries, Advocates, tax practitioners, and professional service firms. Our registered operations and primary processing for OOMS are oriented to customers in India.</p>

<h3>2. Information We Collect</h3>
<p>Depending on how you interact with OOMS, we may collect:</p>
<ul>
  <li><strong>Account &amp; identity data:</strong> name, mobile number, email address, username, firm/branch details, and profile information.</li>
  <li><strong>Business data you upload or create:</strong> client records, tasks, compliance assignments, documents, billing entries, staff details, and related operational records.</li>
  <li><strong>Billing &amp; subscription data:</strong> plan selection, invoices, payment references, and gateway transaction identifiers (card/bank secrets are handled by payment providers).</li>
  <li><strong>Technical &amp; usage data:</strong> IP address, device/browser type, login sessions, approximate location derived from IP, and product usage logs needed for security and support.</li>
  <li><strong>Communication data:</strong> messages you send to support, demo requests, and feedback submitted through our website or apps.</li>
</ul>

<h3>3. How We Use Information</h3>
<ul>
  <li>To create and manage user accounts, branches, roles, and subscriptions.</li>
  <li>To deliver OOMS features such as task management, compliance tracking, billing, messaging integrations, and reporting.</li>
  <li>To authenticate users (including OTP), prevent fraud, and protect the platform.</li>
  <li>To process payments, issue invoices/receipts, and manage renewals.</li>
  <li>To provide customer support and send service-related notifications (email, SMS, WhatsApp, or in-app, as configured).</li>
  <li>To improve reliability, performance, and product experience.</li>
  <li>To comply with applicable Indian laws and respond to lawful requests from authorities.</li>
</ul>

<h3>4. Legal Bases &amp; Compliance</h3>
<p>We process information to perform our contract with you, operate our legitimate business interests in providing secure SaaS, and meet legal obligations under applicable Indian law, including the Information Technology Act, 2000 and rules thereunder, and the Digital Personal Data Protection Act, 2023 (as applicable and notified).</p>

<h3>5. Sharing of Information</h3>
<p>We do <strong>not</strong> sell your personal data. We may share limited information with:</p>
<ul>
  <li><strong>Service providers</strong> who help us operate OOMS (hosting, email/SMS/WhatsApp gateways, payment gateways, analytics used for product reliability) under confidentiality and purpose limitations.</li>
  <li><strong>Your organisation's authorised users</strong> within the same OOMS branch/tenant, according to roles and permissions configured by your administrators.</li>
  <li><strong>Professional advisors or authorities</strong> when required by law, regulation, court order, or to protect rights, safety, and security.</li>
</ul>

<h3>6. Data Security</h3>
<p>We use administrative, technical, and organisational safeguards appropriate to the nature of the data, including access controls, encrypted transport (HTTPS/TLS), and monitoring. No method of transmission or storage is 100% secure; you are responsible for safeguarding login credentials and configuring staff access carefully.</p>

<h3>7. Retention</h3>
<p>We retain account and operational data for as long as your subscription remains active and thereafter as needed for backups, dispute resolution, audit, accounting, and legal retention requirements. You may request deletion subject to legal and contractual limits.</p>

<h3>8. Your Rights &amp; Choices</h3>
<p>Subject to applicable law, you may request access, correction, or deletion of personal data associated with your account, or withdraw consent where processing is consent-based. Account owners/admins control much of the business data stored in their tenant. Contact us using the details below to raise a privacy request.</p>

<h3>9. Children</h3>
<p>OOMS is intended for professional and business use. We do not knowingly collect personal data from children for consumer purposes.</p>

<h3>10. International Transfers</h3>
<p>OOMS is designed primarily for Indian customers. If any processing infrastructure or subprocessors are located outside India, we take steps consistent with applicable law to protect the data.</p>

<h3>11. Changes to This Policy</h3>
<p>We may update this Privacy Policy from time to time. Material changes will be reflected by updating the effective date on this page. Continued use of OOMS after changes means you acknowledge the updated policy.</p>

<h3>12. Contact</h3>
<p>For privacy questions or requests, contact OneSaaS Technologies Private Limited through the support channels published on <a href="https://ooms.in/contact">ooms.in/contact</a> or your account support email.</p>
`.trim(),
    },
    {
        slug: "terms-of-service",
        title: "Terms of Service",
        sort_order: 20,
        content_html: `
<p><strong>Effective date:</strong> 26 September 2026</p>
<p>These Terms of Service ("Terms") govern your access to and use of the OneSaaS Office Management System (OOMS) and related websites, portals, APIs, and services provided by OneSaaS Technologies Private Limited ("OneSaaS", "we", "us"). By creating an account, purchasing a subscription, or using OOMS, you agree to these Terms.</p>

<h3>1. Eligibility &amp; Account Registration</h3>
<ul>
  <li>You must be legally capable of entering into a binding contract under Indian law.</li>
  <li>You must provide accurate registration details and keep them updated.</li>
  <li>You are responsible for all activity under your organisation's accounts, including staff and invited users.</li>
  <li>You must keep credentials confidential and notify us promptly of suspected unauthorised access.</li>
</ul>

<h3>2. Licence to Use OOMS</h3>
<p>Subject to these Terms and a valid subscription, OneSaaS grants you a limited, non-exclusive, non-transferable, revocable licence to access and use OOMS for your internal professional and business operations. No ownership rights in the software are transferred to you.</p>

<h3>3. Acceptable Use</h3>
<p>You agree not to:</p>
<ul>
  <li>Reverse engineer, decompile, copy, resell, sublicense, or commercially exploit OOMS except as expressly permitted.</li>
  <li>Attempt to gain unauthorised access to systems, data, or other customers' tenants.</li>
  <li>Upload unlawful, infringing, defamatory, or malicious content.</li>
  <li>Use OOMS to send spam or abuse messaging/call channels.</li>
  <li>Interfere with platform integrity, security, or availability.</li>
</ul>
<p>Violation may result in suspension or termination without refund where permitted by law.</p>

<h3>4. Customer Data</h3>
<ul>
  <li>You retain ownership of data you and your users submit to OOMS ("Customer Data").</li>
  <li>You grant OneSaaS a limited licence to host, process, and display Customer Data solely to provide the service.</li>
  <li>You represent that you have all rights and consents required to upload and process Customer Data (including client and staff personal data) in OOMS.</li>
  <li>Our handling of personal data is described in the Privacy Policy.</li>
</ul>

<h3>5. Subscriptions, Fees &amp; Taxes</h3>
<ul>
  <li>Access is provided on subscription plans (monthly, quarterly, annual, or as published).</li>
  <li>Fees are payable in advance unless otherwise agreed in writing.</li>
  <li>Prices may change with notice for future billing cycles; published website pricing applies unless a separate written agreement exists.</li>
  <li>Applicable GST and other taxes may be charged as required under Indian law.</li>
</ul>

<h3>6. Third-Party Services</h3>
<p>OOMS may integrate with third-party services (payment gateways, SMS, WhatsApp, email, telephony, storage). Your use of those services may be subject to their terms. OneSaaS is not responsible for third-party outages or policy changes outside our reasonable control.</p>

<h3>7. Service Availability &amp; Support</h3>
<p>We aim to keep OOMS available and reliable, and to provide reasonable technical support during published support hours. Scheduled maintenance, force majeure events, or third-party failures may cause temporary interruptions. OOMS is provided on an "as available" basis unless a separate SLA is signed.</p>

<h3>8. Intellectual Property</h3>
<p>OOMS software, branding, documentation, and related IP remain the exclusive property of OneSaaS and its licensors. Feedback you provide may be used by us to improve products without obligation to you.</p>

<h3>9. Confidentiality</h3>
<p>Each party agrees to protect the other party's confidential information and use it only as needed to perform under these Terms, except where disclosure is required by law.</p>

<h3>10. Disclaimers</h3>
<p>Except as required by applicable law, OOMS is provided "as is" without warranties of uninterrupted operation, error-free performance, or fitness for a particular purpose. You remain responsible for professional judgments, statutory filings, and compliance decisions made using information in OOMS.</p>

<h3>11. Limitation of Liability</h3>
<p>To the maximum extent permitted by Indian law, OneSaaS shall not be liable for indirect, incidental, special, consequential, or punitive damages, or loss of profits, data, or goodwill. Our aggregate liability arising from OOMS in any twelve-month period shall not exceed the subscription fees paid by you to OneSaaS for OOMS in that period.</p>

<h3>12. Indemnity</h3>
<p>You agree to indemnify and hold harmless OneSaaS from claims arising out of your Customer Data, misuse of OOMS, or breach of these Terms, except to the extent caused by our wilful misconduct.</p>

<h3>13. Suspension &amp; Termination</h3>
<ul>
  <li>You may stop using OOMS and cancel as described in the Refund &amp; Cancellation Policy.</li>
  <li>We may suspend or terminate access for non-payment, security risk, or material breach.</li>
  <li>Upon termination, your licence ends. We may retain data as described in the Privacy Policy and for legal retention.</li>
</ul>

<h3>14. Governing Law &amp; Disputes</h3>
<p>These Terms are governed by the laws of India. Courts at Bengaluru, Karnataka shall have exclusive jurisdiction, subject to applicable law.</p>

<h3>15. Changes</h3>
<p>We may update these Terms by posting a revised version on this page. Continued use after the effective date constitutes acceptance of the updated Terms.</p>

<h3>16. Contact</h3>
<p>Questions about these Terms may be sent via <a href="https://ooms.in/contact">ooms.in/contact</a>.</p>
`.trim(),
    },
    {
        slug: "refund-policy",
        title: "Refund & Cancellation Policy",
        sort_order: 30,
        content_html: `
<p><strong>Effective date:</strong> 26 September 2026</p>
<p>This Refund &amp; Cancellation Policy applies to paid subscriptions for OneSaaS Office Management System (OOMS) sold by OneSaaS Technologies Private Limited to customers in India.</p>

<h3>1. Subscription Model</h3>
<p>OOMS is offered as a prepaid software subscription (monthly, quarterly, annual, or other published plans). Access is activated after successful payment confirmation from our payment gateway or after manual approval of an authorised bank transfer, as applicable.</p>

<h3>2. How to Cancel</h3>
<ul>
  <li>You may cancel renewal anytime before the next billing/renewal date from your account settings or by writing to support with your registered mobile/email and branch details.</li>
  <li>Cancellation stops future automatic renewals.</li>
  <li>Unless otherwise stated, you retain access until the end of the already-paid subscription period.</li>
</ul>

<h3>3. Cooling-off Refund (First-time Subscriptions)</h3>
<ul>
  <li>For a <strong>first-time paid subscription</strong>, you may request a refund within <strong>7 (seven) days</strong> of the initial successful payment.</li>
  <li>Refund requests must be raised through official support channels with payment proof and account details.</li>
  <li>If substantial usage has already consumed billable value (for example extensive data import, bulk messaging credits purchased separately, or custom implementation already delivered), we may adjust the refundable amount reasonably.</li>
</ul>

<h3>4. Non-Refundable Situations</h3>
<p>Except where required by law, refunds are <strong>not</strong> available for:</p>
<ul>
  <li>Renewals, upgrades mid-cycle (except unused prepaid balance expressly agreed in writing), or plan changes after the cooling-off window.</li>
  <li>Partial months/periods after the cooling-off window has expired.</li>
  <li>Services or add-ons already consumed (SMS/WhatsApp credits, custom development, onboarding packages marked non-refundable).</li>
  <li>Account suspension or termination due to violation of the Terms of Service.</li>
  <li>Dissatisfaction arising from third-party network/gateway outages outside OneSaaS reasonable control, after service has been delivered as contracted.</li>
</ul>

<h3>5. Service Disruption Claims</h3>
<ul>
  <li>If a material platform outage attributable to OneSaaS prevents core access, raise a ticket within <strong>48 hours</strong> of the disruption.</li>
  <li>We may offer service credits or, in exceptional cases, a partial refund at our discretion after investigation.</li>
</ul>

<h3>6. Refund Processing</h3>
<ul>
  <li>Approved refunds are processed to the original payment method where possible.</li>
  <li>Bank/UPI/card settlement timelines are controlled by payment gateways and banks; please allow a commercially reasonable period (typically 5–10 business days after approval).</li>
  <li>GST invoices already issued may require credit notes as per GST rules.</li>
</ul>

<h3>7. Chargebacks</h3>
<p>Please contact support before initiating a payment dispute. Unwarranted chargebacks may lead to account suspension while we investigate.</p>

<h3>8. Policy Changes</h3>
<p>We may update this policy by revising this page. The version published on the effective date applies to purchases made after that date.</p>

<h3>9. Contact</h3>
<p>For cancellation or refund requests, use <a href="https://ooms.in/contact">ooms.in/contact</a> or your registered support channel and include invoice/payment reference.</p>
`.trim(),
    },
    {
        slug: "business-policy",
        title: "Business Policy",
        sort_order: 40,
        content_html: `
<p><strong>Effective date:</strong> 26 September 2026</p>
<p>This Business Policy summarises how OneSaaS Technologies Private Limited operates and delivers the OneSaaS Office Management System (OOMS) to professional firms in India.</p>

<h3>1. Company Overview</h3>
<p>OneSaaS Technologies Private Limited develops web-based CRM and office management software. Our flagship product, OOMS, helps Chartered Accountants, Cost Accountants, Company Secretaries, Advocates, and professional service providers manage staff, clients, tasks, compliance calendars, documents, and finances through a centralised cloud platform.</p>

<h3>2. Products &amp; Services</h3>
<ul>
  <li>Subscription access to OOMS web applications (Office, Client, and CA portals as applicable).</li>
  <li>Task, compliance, billing, staff, and document workflows for professional practices.</li>
  <li>Technical support and product updates during the subscription term.</li>
  <li>Optional integrations (payment gateways, SMS, WhatsApp, email, telephony) subject to configuration and third-party availability.</li>
  <li>Optional custom development or onboarding services under separate commercial terms.</li>
</ul>

<h3>3. Pricing &amp; Payment</h3>
<ul>
  <li>Services are offered on published subscription plans (monthly / quarterly / annually or as listed on ooms.in).</li>
  <li>Payments are accepted online via integrated payment gateways and, where enabled, authorised bank transfer workflows.</li>
  <li>Invoices and receipts are generated electronically through the platform or billing process.</li>
  <li>Pricing may change with prior notice for future periods; taxes apply as per Indian law.</li>
</ul>

<h3>4. Customer Responsibilities</h3>
<ul>
  <li>Maintain accurate firm, staff, and client records and lawful consents for processing client data.</li>
  <li>Configure roles/permissions responsibly and secure login devices.</li>
  <li>Use OOMS only for legitimate professional purposes consistent with the Terms of Service.</li>
  <li>Ensure statutory and professional obligations to your clients remain your responsibility; OOMS is a productivity system, not a substitute for professional advice.</li>
</ul>

<h3>5. Service Levels &amp; Support</h3>
<p>We provide product support through published channels during business hours. Critical incidents are prioritised. Scheduled maintenance will be communicated when reasonably possible. Separate SLAs may apply for enterprise agreements.</p>

<h3>6. Data &amp; Confidentiality</h3>
<p>Customer operational data remains under the customer's control within their tenant. OneSaaS treats Customer Data as confidential and processes it to provide the service, as detailed in the Privacy Policy.</p>

<h3>7. Fair Use</h3>
<p>API, messaging, storage, and automation features must be used within fair and published limits. Abuse, scraping, or activities that degrade shared infrastructure may be throttled or suspended.</p>

<h3>8. Contact</h3>
<p>For commercial or policy questions, visit <a href="https://ooms.in/contact">ooms.in/contact</a>.</p>
`.trim(),
    },
    {
        slug: "cookie-policy",
        title: "Cookie Policy",
        sort_order: 50,
        content_html: `
<p><strong>Effective date:</strong> 26 September 2026</p>
<p>This Cookie Policy explains how OneSaaS Technologies Private Limited ("OneSaaS", "we") uses cookies and similar technologies on the public OOMS website (ooms.in) and related marketing pages. Product application sessions inside logged-in portals may use additional essential cookies/tokens required for authentication and security.</p>

<h3>1. What Are Cookies?</h3>
<p>Cookies are small text files stored on your device when you visit a website. Similar technologies include local storage, session storage, and pixels. They help sites remember preferences, keep sessions secure, and understand how pages are used.</p>

<h3>2. Types of Cookies We Use</h3>
<ul>
  <li><strong>Essential cookies:</strong> required for security, load balancing, consent preferences, and basic site functionality. These cannot be switched off in our systems if you want to use the site.</li>
  <li><strong>Preference cookies:</strong> remember choices such as theme (light/dark) where enabled.</li>
  <li><strong>Analytics cookies:</strong> help us understand traffic and improve content performance when analytics tools are enabled.</li>
  <li><strong>Marketing cookies:</strong> used only if we enable campaign measurement tools; not required for core browsing.</li>
</ul>

<h3>3. Why We Use Them</h3>
<ul>
  <li>To keep the website secure and functioning.</li>
  <li>To remember your interface preferences.</li>
  <li>To measure which pages are helpful so we can improve OOMS marketing content.</li>
</ul>

<h3>4. Managing Cookies</h3>
<p>You can control or delete cookies through your browser settings. Blocking essential cookies may affect site functionality (for example login redirects or preference persistence). Browser help pages for Chrome, Firefox, Safari, and Edge explain how to manage cookies.</p>

<h3>5. Third-Party Cookies</h3>
<p>If we embed third-party content (maps, videos, payment widgets, or analytics), those providers may set their own cookies subject to their policies. We encourage you to review their notices.</p>

<h3>6. Updates</h3>
<p>We may update this Cookie Policy when our practices or tools change. The effective date above will be revised accordingly.</p>

<h3>7. More Information</h3>
<p>Questions about cookies can be sent via <a href="https://ooms.in/contact">ooms.in/contact</a>.</p>
`.trim(),
    },
];

export async function ensureWebsiteLegalPagesTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS website_legal_pages (
          id INT NOT NULL AUTO_INCREMENT,
          page_id VARCHAR(50) NOT NULL,
          slug VARCHAR(100) NOT NULL,
          title VARCHAR(200) NOT NULL,
          content_html LONGTEXT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          create_by VARCHAR(50) NULL DEFAULT NULL,
          create_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
          modify_by VARCHAR(50) NULL DEFAULT NULL,
          modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_website_legal_page_id (page_id),
          UNIQUE KEY uk_website_legal_slug (slug)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function seedDefaultLegalPages(actor = "system") {
    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM website_legal_pages`
    );
    if (Number(total) > 0) return;

    for (const page of DEFAULT_LEGAL_PAGES) {
        const page_id = await UNIQUE_RANDOM_STRING("website_legal_pages", "page_id");
        await pool.query(
            `INSERT INTO website_legal_pages
              (page_id, slug, title, content_html, sort_order, status, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
            [
                page_id,
                page.slug,
                page.title,
                page.content_html,
                page.sort_order,
                actor,
                actor,
            ]
        );
    }
}

/** Force upsert default legal pages (insert missing, refresh content for existing). */
export async function syncDefaultLegalPages(actor = "system") {
    await ensureWebsiteLegalPagesTable();
    const results = [];
    for (const page of DEFAULT_LEGAL_PAGES) {
        const saved = await upsertWebsiteLegalPage(
            {
                slug: page.slug,
                title: page.title,
                content_html: page.content_html,
                sort_order: page.sort_order,
                status: "active",
            },
            actor
        );
        results.push({
            slug: saved.slug,
            title: saved.title,
            page_id: saved.page_id,
            chars: String(saved.content_html || "").length,
        });
    }
    return results;
}

export async function listWebsiteLegalPages({ activeOnly = false } = {}) {
    await ensureWebsiteLegalPagesTable();
    await seedDefaultLegalPages();

    const where = activeOnly ? `WHERE status = 'active'` : "";
    const [rows] = await pool.query(
        `SELECT *
         FROM website_legal_pages
         ${where}
         ORDER BY sort_order ASC, title ASC, id ASC`
    );
    return rows;
}

export async function getWebsiteLegalPageBySlug(slug, { activeOnly = false } = {}) {
    await ensureWebsiteLegalPagesTable();
    await seedDefaultLegalPages();

    const normalized = slugify(slug);
    if (!normalized) return null;

    const whereActive = activeOnly ? `AND status = 'active'` : "";
    const [rows] = await pool.query(
        `SELECT *
         FROM website_legal_pages
         WHERE slug = ?
           ${whereActive}
         LIMIT 1`,
        [normalized]
    );
    return rows[0] || null;
}

export async function getWebsiteLegalPageById(pageId) {
    await ensureWebsiteLegalPagesTable();
    const [rows] = await pool.query(
        `SELECT *
         FROM website_legal_pages
         WHERE page_id = ?
         LIMIT 1`,
        [trimStr(pageId)]
    );
    return rows[0] || null;
}

export function serializeWebsiteLegalPage(row, { includeContent = true } = {}) {
    if (!row) return null;
    const base = {
        page_id: row.page_id,
        slug: row.slug,
        title: row.title,
        sort_order: Number(row.sort_order) || 0,
        status: row.status || "inactive",
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
        updated_at: row.modify_date || row.create_date || null,
    };
    if (includeContent) {
        base.content_html = row.content_html || "";
    }
    return base;
}

export function serializeWebsiteLegalListItem(row) {
    return serializeWebsiteLegalPage(row, { includeContent: false });
}

export async function upsertWebsiteLegalPage(body = {}, actor = null) {
    await ensureWebsiteLegalPagesTable();
    await seedDefaultLegalPages();

    const pageId = trimStr(body.page_id);
    const title = trimStr(body.title);
    let slug = slugify(body.slug || title);
    const contentHtml = typeof body.content_html === "string" ? body.content_html : "";
    const status = trimStr(body.status || "active") === "inactive" ? "inactive" : "active";
    const sortOrder = Number.isFinite(Number(body.sort_order))
        ? Number(body.sort_order)
        : 0;

    if (!title) {
        const err = new Error("Title is required");
        err.status = 400;
        throw err;
    }
    if (!slug) {
        const err = new Error("Slug is required");
        err.status = 400;
        throw err;
    }

    let existing = null;
    if (pageId) {
        existing = await getWebsiteLegalPageById(pageId);
    }
    if (!existing) {
        // Look up by slug regardless of status when upserting.
        const [rows] = await pool.query(
            `SELECT * FROM website_legal_pages WHERE slug = ? LIMIT 1`,
            [slug]
        );
        existing = rows[0] || null;
    }

    const [slugConflicts] = await pool.query(
        `SELECT page_id
         FROM website_legal_pages
         WHERE slug = ?
           AND (? = '' OR page_id <> ?)
         LIMIT 1`,
        [slug, existing?.page_id || "", existing?.page_id || ""]
    );
    if (slugConflicts.length) {
        const err = new Error("Another page already uses this slug");
        err.status = 409;
        throw err;
    }

    if (existing) {
        await pool.query(
            `UPDATE website_legal_pages
             SET slug = ?,
                 title = ?,
                 content_html = ?,
                 sort_order = ?,
                 status = ?,
                 modify_by = ?,
                 modify_date = CURRENT_TIMESTAMP
             WHERE page_id = ?`,
            [slug, title, contentHtml, sortOrder, status, actor, existing.page_id]
        );
        const updated = await getWebsiteLegalPageById(existing.page_id);
        return serializeWebsiteLegalPage(updated);
    }

    const newPageId = await UNIQUE_RANDOM_STRING("website_legal_pages", "page_id");
    await pool.query(
        `INSERT INTO website_legal_pages
          (page_id, slug, title, content_html, sort_order, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newPageId, slug, title, contentHtml, sortOrder, status, actor, actor]
    );
    const created = await getWebsiteLegalPageById(newPageId);
    return serializeWebsiteLegalPage(created);
}

export async function deleteWebsiteLegalPage(pageId) {
    await ensureWebsiteLegalPagesTable();
    const existing = await getWebsiteLegalPageById(pageId);
    if (!existing) {
        const err = new Error("Legal page not found");
        err.status = 404;
        throw err;
    }
    await pool.query(`DELETE FROM website_legal_pages WHERE page_id = ?`, [
        existing.page_id,
    ]);
    return true;
}
