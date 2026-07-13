import "dotenv/config";
import pool from "../../db.js";

const checks = [];

async function check(label, fn) {
    try {
        const result = await fn();
        checks.push({ label, ok: true, result });
        console.log(`OK  ${label}: ${result}`);
    } catch (err) {
        checks.push({ label, ok: false, error: err.message });
        console.log(`FAIL ${label}: ${err.message}`);
    }
}

await check("services count is 40", async () => {
    const [r] = await pool.query("SELECT COUNT(*) AS c FROM services");
    if (Number(r[0].c) !== 40) throw new Error(`expected 40, got ${r[0].c}`);
    return r[0].c;
});

await check("no APP2025 service_ids anywhere", async () => {
    const tables = [
        "services", "branch_services", "tasks", "sale_items", "purchase_items",
    ];
    let total = 0;
    for (const t of tables) {
        const [r] = await pool.query(
            `SELECT COUNT(*) AS c FROM \`${t}\` WHERE service_id LIKE 'APP2025_%'`
        );
        total += Number(r[0].c);
    }
    if (total > 0) throw new Error(`${total} opaque refs remain`);
    return "0 opaque refs";
});

await check("gstr-1-regular-monthly exists", async () => {
    const [r] = await pool.query(
        "SELECT service_id, name FROM services WHERE service_id = 'gstr-1-regular-monthly'"
    );
    if (!r.length) throw new Error("not found");
    return r[0].name;
});

await check("gstr-3b-monthly exists", async () => {
    const [r] = await pool.query(
        "SELECT service_id, name FROM services WHERE service_id = 'gstr-3b-monthly'"
    );
    if (!r.length) throw new Error("not found");
    return r[0].name;
});

await check("ptax exists", async () => {
    const [r] = await pool.query(
        "SELECT service_id, name FROM services WHERE service_id = 'ptax'"
    );
    if (!r.length) throw new Error("not found");
    return r[0].name;
});

await check("tasks join services (sample)", async () => {
    const [r] = await pool.query(
        `SELECT COUNT(*) AS c
         FROM tasks t
         INNER JOIN services s ON t.service_id = s.service_id
         WHERE t.service_id = 'gstr-1-regular-monthly'`
    );
    return `${r[0].c} gstr-1 tasks joined`;
});

await check("sale_items join services (sample)", async () => {
    const [r] = await pool.query(
        `SELECT COUNT(*) AS c
         FROM sale_items si
         INNER JOIN services s ON si.service_id = s.service_id
         WHERE si.service_id = 'gstr-3b-monthly'`
    );
    return `${r[0].c} gstr-3b sale_items joined`;
});

await check("unique index on service_id", async () => {
    const [r] = await pool.query(
        "SHOW INDEX FROM services WHERE Key_name = 'uq_services_service_id'"
    );
    if (!r.length) throw new Error("index missing");
    return "present";
});

await check("orphan tasks (no matching service)", async () => {
    const [r] = await pool.query(
        `SELECT COUNT(*) AS c FROM tasks t
         LEFT JOIN services s ON t.service_id = s.service_id
         WHERE s.service_id IS NULL`
    );
    if (Number(r[0].c) > 0) throw new Error(`${r[0].c} orphan tasks`);
    return "0 orphans";
});

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : "\nAll smoke checks passed");
await pool.end();
process.exit(failed.length ? 1 : 0);
