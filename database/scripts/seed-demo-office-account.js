/**
 * Seed a CLIENT_WEB demo office account for sharing.
 *
 * Creates:
 *  - Software user (office) with mobile 9999999999
 *  - Demo branch owned by that user
 *  - BusinessPro (max) subscription for 1 year
 *  - Extra branch services
 *  - Sample clients + firms
 *  - Sample tasks
 *
 * Note: CLIENT_WEB login is OTP-only (password was removed). Password "123456"
 * cannot be used for login — use mobile OTP after registration/login.
 *
 * Usage:
 *   node database/scripts/seed-demo-office-account.js
 */
import "dotenv/config";
import pool from "../../db.js";
import {
    UNIQUE_RANDOM_STRING,
    ID_LENGTH,
    SHORT_ID_LENGTH,
    TODAY_DATE,
} from "../../helpers/function.js";
import { initializeBranchDefaults } from "../../services/branchSetupService.js";
import { assignPlanByAdmin } from "../../services/subscriptionService.js";

const DEMO_MOBILE = "9999999999";
const DEMO_NAME = "OOMS Demo Office";
const DEMO_EMAIL = "demo.office@ooms.in";
const BRANCH_NAME = "OOMS Demo Branch";
const BRANCH_LEGAL_NAME = "OOMS Demo Branch Private Limited";

const EXTRA_SERVICES = [
    { service_id: "gst-registration", fees: 2000, due_date: 10 },
    { service_id: "dsc", fees: 2000, due_date: 7 },
    { service_id: "accounting", fees: 5000, due_date: 15 },
    { service_id: "company-registration", fees: 20000, due_date: 30 },
    { service_id: "import_export", fees: 2500, due_date: 10 },
];

const SAMPLE_CLIENTS = [
    {
        full_name: "Rahul Sharma",
        care_of: "S/O",
        guardian_name: "Ramesh Sharma",
        mobile: "9811111111",
        email: "rahul.sharma@demo.ooms.in",
        pan: "AAAPR1111A",
        dob: "1990-05-15",
        gender: "male",
        address: {
            state: "Delhi",
            district: "New Delhi",
            town_or_village: "Connaught Place",
            pincode: "110001",
            address_line_1: "12 Demo Street",
        },
        business: {
            type: "individual",
            pan: "AAAPR1111A",
        },
    },
    {
        full_name: "Priya Patel",
        care_of: "D/O",
        guardian_name: "Suresh Patel",
        mobile: "9822222222",
        email: "priya.patel@demo.ooms.in",
        pan: "AAAPP2222B",
        dob: "1988-08-20",
        gender: "female",
        address: {
            state: "Gujarat",
            district: "Ahmedabad",
            town_or_village: "Navrangpura",
            pincode: "380009",
            address_line_1: "45 Business Park",
        },
        business: {
            type: "private limited",
            pan: "AABCP2222C",
            firm: "Priya Tech Private Limited",
            gst: "24AABCP2222C1Z5",
            address: {
                state: "Gujarat",
                district: "Ahmedabad",
                town: "Navrangpura",
                pincode: "380009",
                address_line_1: "45 Business Park",
            },
        },
    },
    {
        full_name: "Amit Verma",
        care_of: "S/O",
        guardian_name: "Kumar Verma",
        mobile: "9833333333",
        email: "amit.verma@demo.ooms.in",
        pan: "AAAPV3333C",
        dob: "1985-01-10",
        gender: "male",
        address: {
            state: "Maharashtra",
            district: "Mumbai",
            town_or_village: "Andheri",
            pincode: "400053",
            address_line_1: "88 Trade Centre",
        },
        business: {
            type: "partnership",
            pan: "AABCV3333D",
            firm: "Verma & Associates",
            gst: "27AABCV3333D1Z2",
            address: {
                state: "Maharashtra",
                district: "Mumbai",
                town: "Andheri",
                pincode: "400053",
                address_line_1: "88 Trade Centre",
            },
        },
    },
];

function addDaysYmd(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

async function ensureDemoUser(conn) {
    const [existing] = await conn.query(
        `SELECT p.username, p.name, p.mobile, p.email
         FROM profile p
         WHERE p.mobile = ?
           AND p.user_type = 'user'
           AND p.status = '1'
         ORDER BY p.id DESC
         LIMIT 1`,
        [DEMO_MOBILE]
    );

    if (existing.length > 0) {
        return { username: existing[0].username, created: false };
    }

    const username = await UNIQUE_RANDOM_STRING("users", "username", {
        conn,
        prefix: "usr_",
        length: ID_LENGTH,
    });
    const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", {
        conn,
        length: ID_LENGTH,
    });

    await conn.query(
        `INSERT INTO users (username, create_by, status, remark, create_date)
         VALUES (?, ?, '1', ?, NOW())`,
        [username, username, "Demo office account (seed)"]
    );

    await conn.query(
        `INSERT INTO profile (
            profile_id, username, create_by, user_type, name, mobile,
            country_code, email, status, create_date
         ) VALUES (?, ?, ?, 'user', ?, ?, '+91', ?, '1', NOW())`,
        [profile_id, username, username, DEMO_NAME, DEMO_MOBILE, DEMO_EMAIL]
    );

    return { username, created: true };
}

async function ensureDemoBranch(conn, username) {
    const [existing] = await conn.query(
        `SELECT branch_id, name
         FROM branch_list
         WHERE username = ?
           AND is_deleted = '0'
           AND name = ?
         ORDER BY id DESC
         LIMIT 1`,
        [username, BRANCH_NAME]
    );

    if (existing.length > 0) {
        return { branch_id: existing[0].branch_id, created: false };
    }

    const branch_id = await UNIQUE_RANDOM_STRING("branch_list", "branch_id", {
        length: SHORT_ID_LENGTH,
        conn,
        where: "is_deleted = '0'",
    });
    const map_id = await UNIQUE_RANDOM_STRING("branch_mapping", "map_id", {
        length: SHORT_ID_LENGTH,
        prefix: `MAP_${Date.now()}_`,
        conn,
    });
    const now = new Date();

    await conn.query(
        `INSERT INTO branch_list (
            branch_id, name, legal_name, username, logo, sign,
            create_by, modify_by, status,
            address_line_1, address_line_2, city, state, country, pincode,
            invoice_address, pan, is_pan_verified, gst, is_gst_verified,
            mobile_1, mobile_2, email_1, email_2,
            create_date, modify_date, is_deleted, deleted_by
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, '1',
                   ?, NULL, ?, ?, 'India', ?,
                   ?, ?, '0', NULL, '0',
                   ?, NULL, ?, NULL,
                   ?, ?, '0', NULL)`,
        [
            branch_id,
            BRANCH_NAME,
            BRANCH_LEGAL_NAME,
            username,
            username,
            username,
            "12 Demo Office Lane",
            "New Delhi",
            "Delhi",
            "110001",
            "12 Demo Office Lane, New Delhi",
            "AABCD1234E",
            DEMO_MOBILE,
            DEMO_EMAIL,
            now,
            now,
        ]
    );

    await conn.query(
        `INSERT INTO branch_mapping (
            map_id, branch_id, username, designation,
            create_by, modify_by, type, is_accepted,
            invitation_token, status, is_deleted, deleted_by,
            create_date, modify_date
         ) VALUES (?, ?, ?, NULL, ?, ?, 'admin', '1', NULL, '1', '0', NULL, ?, ?)`,
        [map_id, branch_id, username, username, username, now, now]
    );

    const setup = await initializeBranchDefaults({
        branchId: branch_id,
        createdBy: username,
        connection: conn,
    });

    return { branch_id, created: true, setup };
}

async function addExtraServices(conn, branchId, username) {
    const added = [];
    const now = TODAY_DATE();

    for (const svc of EXTRA_SERVICES) {
        const [exists] = await conn.query(
            `SELECT id, is_deleted
             FROM branch_services
             WHERE branch_id = ? AND service_id = ?
             LIMIT 1`,
            [branchId, svc.service_id]
        );

        if (exists.length > 0) {
            if (String(exists[0].is_deleted) === "1") {
                await conn.query(
                    `UPDATE branch_services
                     SET is_deleted = '0', deleted_by = NULL, fees = ?, due_date = ?,
                         modify_by = ?, modify_date = ?
                     WHERE id = ?`,
                    [svc.fees, svc.due_date, username, now, exists[0].id]
                );
                added.push({ ...svc, restored: true });
            } else {
                added.push({ ...svc, skipped: true });
            }
            continue;
        }

        const [catalog] = await conn.query(
            `SELECT service_id FROM services WHERE service_id = ? AND status = '1' LIMIT 1`,
            [svc.service_id]
        );
        if (!catalog.length) {
            added.push({ ...svc, skipped: true, reason: "not_in_catalog" });
            continue;
        }

        await conn.query(
            `INSERT INTO branch_services (
                branch_id, service_id, fees, due_date, remark,
                create_by, modify_by, is_deleted, create_date, modify_date
             ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`,
            [
                branchId,
                svc.service_id,
                svc.fees,
                svc.due_date,
                "Demo seed service",
                username,
                username,
                now,
                now,
            ]
        );
        added.push({ ...svc, created: true });
    }

    return added;
}

async function seedClientsAndFirms(conn, branchId, username) {
    const created = [];

    for (const client of SAMPLE_CLIENTS) {
        const [existingPan] = await conn.query(
            `SELECT p.username
             FROM profile p
             JOIN clients c ON p.username = c.username
             WHERE p.pan_number = ?
               AND c.user_type = 'client'
               AND c.is_deleted = '0'
               AND c.branch_id = ?
             LIMIT 1`,
            [client.pan, branchId]
        );

        if (existingPan.length > 0) {
            const clientUsername = existingPan[0].username;
            const [firms] = await conn.query(
                `SELECT firm_id, firm_name FROM firms
                 WHERE username = ? AND branch_id = ? AND is_deleted = '0'`,
                [clientUsername, branchId]
            );
            created.push({
                username: clientUsername,
                name: client.full_name,
                skipped: true,
                firms,
            });
            continue;
        }

        const clientUsername = await UNIQUE_RANDOM_STRING("clients", "username", {
            length: ID_LENGTH,
            conn,
        });
        const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", {
            length: ID_LENGTH,
            conn,
        });

        await conn.query(
            `INSERT INTO clients (
                username, user_type, branch_id, create_by, status, is_deleted
             ) VALUES (?, 'client', ?, ?, '1', '0')`,
            [clientUsername, branchId, username]
        );

        const addr = client.address;
        await conn.query(
            `INSERT INTO profile (
                profile_id, username, create_by, user_type, name, care_of, guardian_name,
                date_of_birth, gender, mobile, country_code, email, pan_number,
                state, district, city, village_town, pincode, address_line_1, status, create_date
             ) VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, '91', ?, ?, ?, ?, ?, ?, ?, ?, '1', NOW())`,
            [
                profile_id,
                clientUsername,
                username,
                client.full_name,
                client.care_of,
                client.guardian_name,
                client.dob,
                client.gender,
                client.mobile,
                client.email,
                client.pan,
                addr.state,
                addr.district,
                addr.district,
                addr.town_or_village,
                addr.pincode,
                addr.address_line_1,
            ]
        );

        const biz = client.business;
        const isIndividual = String(biz.type).toLowerCase() === "individual";
        const firm_id = await UNIQUE_RANDOM_STRING("firms", "firm_id", {
            length: ID_LENGTH,
            conn,
        });
        const bizAddr = biz.address || {};

        await conn.query(
            `INSERT INTO firms (
                firm_id, branch_id, username, firm_name, firm_type, pan_no, gst_no,
                state, district, city, pincode, address_line_1,
                create_by, status, is_deleted
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', '0')`,
            [
                firm_id,
                branchId,
                clientUsername,
                isIndividual ? client.full_name : biz.firm,
                biz.type,
                biz.pan,
                isIndividual ? null : biz.gst || null,
                isIndividual ? null : bizAddr.state || null,
                isIndividual ? null : bizAddr.district || null,
                isIndividual ? null : bizAddr.town || null,
                isIndividual ? null : bizAddr.pincode || null,
                isIndividual ? null : bizAddr.address_line_1 || null,
                username,
            ]
        );

        created.push({
            username: clientUsername,
            name: client.full_name,
            firm_id,
            firm_name: isIndividual ? client.full_name : biz.firm,
            created: true,
        });
    }

    return created;
}

async function seedTasks(conn, branchId, username, clients) {
    const created = [];
    const dueSoon = addDaysYmd(14);
    const dueLater = addDaysYmd(30);

    const taskPlan = [
        { service_id: "gst-registration", due_date: dueSoon, fees: 2000 },
        { service_id: "dsc", due_date: dueSoon, fees: 2000 },
        { service_id: "accounting", due_date: dueLater, fees: 5000 },
        { service_id: "company-registration", due_date: dueLater, fees: 20000 },
    ];

    const firmRows = [];
    for (const c of clients) {
        if (c.firm_id) {
            firmRows.push({
                firm_id: c.firm_id,
                client_username: c.username,
                firm_name: c.firm_name,
            });
            continue;
        }
        const [firms] = await conn.query(
            `SELECT firm_id, firm_name, username
             FROM firms
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [c.username, branchId]
        );
        if (firms[0]) {
            firmRows.push({
                firm_id: firms[0].firm_id,
                client_username: firms[0].username,
                firm_name: firms[0].firm_name,
            });
        }
    }

    let i = 0;
    for (const firm of firmRows) {
        const plan = taskPlan[i % taskPlan.length];
        i += 1;

        const [dup] = await conn.query(
            `SELECT task_id FROM tasks
             WHERE branch_id = ? AND firm_id = ? AND service_id = ?
               AND status NOT IN ('cancelled')
             LIMIT 1`,
            [branchId, firm.firm_id, plan.service_id]
        );
        if (dup.length > 0) {
            created.push({
                task_id: dup[0].task_id,
                firm_id: firm.firm_id,
                service_id: plan.service_id,
                skipped: true,
            });
            continue;
        }

        const task_id = await UNIQUE_RANDOM_STRING("tasks", "task_id", {
            length: ID_LENGTH,
            conn,
        });
        const status = "pending from department";

        await conn.query(
            `INSERT INTO tasks (
                branch_id, task_id, username, firm_id, service_id,
                has_ca, fees, total, create_by, is_recurring,
                due_date, target_date, billing_status, status, create_date
             ) VALUES (?, ?, ?, ?, ?, '0', ?, ?, ?, '0', ?, ?, '0', ?, NOW())`,
            [
                branchId,
                task_id,
                firm.client_username,
                firm.firm_id,
                plan.service_id,
                plan.fees,
                plan.fees,
                username,
                plan.due_date,
                plan.due_date,
                status,
            ]
        );

        await conn.query(
            `INSERT INTO task_status (branch_id, task_id, create_by, status)
             VALUES (?, ?, ?, ?)`,
            [branchId, task_id, username, status]
        );

        created.push({
            task_id,
            firm_id: firm.firm_id,
            firm_name: firm.firm_name,
            service_id: plan.service_id,
            due_date: plan.due_date,
            created: true,
        });
    }

    return created;
}

async function main() {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const user = await ensureDemoUser(conn);
        console.log(
            user.created
                ? `Created demo user: ${user.username}`
                : `Using existing demo user: ${user.username}`
        );

        const branch = await ensureDemoBranch(conn, user.username);
        console.log(
            branch.created
                ? `Created branch: ${branch.branch_id}`
                : `Using existing branch: ${branch.branch_id}`
        );

        await conn.commit();

        // Subscription uses its own connection / transaction
        const subscription = await assignPlanByAdmin({
            branchId: branch.branch_id,
            planName: "BusinessPro",
            billingCycle: "yearly",
            adminUsername: "demo_seed",
        });
        console.log(
            `Assigned BusinessPro yearly until ${subscription.expires_at.toISOString?.() || subscription.expires_at}`
        );

        await conn.beginTransaction();
        const services = await addExtraServices(conn, branch.branch_id, user.username);
        console.log(
            `Branch services: ${services.filter((s) => s.created || s.restored).length} added/restored, ${services.filter((s) => s.skipped).length} skipped`
        );

        const clients = await seedClientsAndFirms(conn, branch.branch_id, user.username);
        console.log(
            `Clients: ${clients.filter((c) => c.created).length} created, ${clients.filter((c) => c.skipped).length} existing`
        );

        const tasks = await seedTasks(conn, branch.branch_id, user.username, clients);
        console.log(
            `Tasks: ${tasks.filter((t) => t.created).length} created, ${tasks.filter((t) => t.skipped).length} existing`
        );

        await conn.commit();

        console.log("\n=== DEMO ACCOUNT READY ===");
        console.log(`Portal:        CLIENT_WEB (Office)`);
        console.log(`Mobile:        ${DEMO_MOBILE}`);
        console.log(`Login:         OTP only (no password — CLIENT_WEB removed password login)`);
        console.log(`Name:          ${DEMO_NAME}`);
        console.log(`Email:         ${DEMO_EMAIL}`);
        console.log(`Username:      ${user.username}`);
        console.log(`Branch ID:     ${branch.branch_id}`);
        console.log(`Branch name:   ${BRANCH_NAME}`);
        console.log(`Subscription:  BusinessPro / yearly`);
        console.log(`Expires:       ${subscription.expires_at.toISOString?.() || subscription.expires_at}`);
        console.log(`Clients:       ${clients.length}`);
        console.log(`Tasks:         ${tasks.length}`);
        console.log("\nHow to share:");
        console.log(`1. Open CLIENT_WEB login`);
        console.log(`2. Enter mobile ${DEMO_MOBILE}`);
        console.log(`3. Request OTP (or read latest unused OTP from otps table if SMS is off)`);
        console.log(`4. Select branch "${BRANCH_NAME}"`);
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) {
            /* ignore */
        }
        console.error("Demo seed failed:", error);
        process.exitCode = 1;
    } finally {
        conn.release();
        await pool.end();
    }
}

main();
