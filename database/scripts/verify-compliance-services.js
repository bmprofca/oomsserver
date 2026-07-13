import "dotenv/config";
import pool from "../../db.js";

const checks = [];

async function check(label, fn) {
    try {
        const result = await fn();
        checks.push({ label, ok: true });
        console.log(`OK  ${label}: ${result}`);
    } catch (err) {
        checks.push({ label, ok: false });
        console.log(`FAIL ${label}: ${err.message}`);
    }
}

await check("8 active compliance services", async () => {
    const [r] = await pool.query(
        "SELECT COUNT(*) AS c FROM services WHERE type = 'compliance' AND status = 1"
    );
    if (Number(r[0].c) !== 8) throw new Error(`expected 8, got ${r[0].c}`);
    return r[0].c;
});

await check("no slug collisions with general catalog", async () => {
    const complianceIds = ['gstr-1', 'gstr-3b', 'gstr-9', 'gstr-04', 'gstr-10', 'cmp-08', 'professional-tax', 'tds'];
    const [rows] = await pool.query(
        `SELECT service_id, type, status FROM services WHERE service_id IN (${complianceIds.map(() => '?').join(',')})`,
        complianceIds
    );
    if (rows.length !== 8) throw new Error(`expected 8 rows, got ${rows.length}`);
    const bad = rows.filter((r) => r.type !== 'compliance' || Number(r.status) !== 1);
    if (bad.length) throw new Error(`invalid rows: ${JSON.stringify(bad)}`);
    return "all compliance type status 1";
});

await check("branch_services for all compliance services", async () => {
    const [rows] = await pool.query(
        `SELECT s.service_id, COUNT(bs.id) AS branch_count
         FROM services s
         LEFT JOIN branch_services bs ON bs.service_id = s.service_id AND bs.is_deleted = '0'
         WHERE s.type = 'compliance'
         GROUP BY s.service_id
         ORDER BY s.service_id`
    );
    const missing = rows.filter((r) => Number(r.branch_count) === 0);
    if (missing.length) throw new Error(`${missing.length} without branch mapping`);
    return rows.map((r) => `${r.service_id}:${r.branch_count}`).join(', ');
});

await check("general deactivated services unchanged", async () => {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS c FROM services
         WHERE service_id IN ('gstr-3b-monthly','ptax') AND type = 'general' AND status = 0`
    );
    if (Number(rows[0].c) !== 2) throw new Error(`expected 2, got ${rows[0].c}`);
    return "general archive intact";
});

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} failed` : "\nAll compliance seed checks passed");
await pool.end();
process.exit(failed.length ? 1 : 0);
