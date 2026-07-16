/**
 * Patch remaining tax-column SQL after drop-tax-rate-columns migration.
 * Run: node database/scripts/patch-gst-sql-refs.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function write(rel, transform) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
        console.log("MISSING", rel);
        return;
    }
    const before = fs.readFileSync(file, "utf8");
    const after = transform(before);
    if (after === before) {
        console.log("NOCHANGE", rel);
        return;
    }
    fs.writeFileSync(file, after);
    console.log("UPDATED", rel);
}

// --- billing.js list/search ---
write("routes/billing.js", (s) => {
    s = s.replace(/\s*OR CAST\(IFNULL\(t\.tax_value, 0\) AS CHAR\) LIKE \?\r?\n/, "\n");
    s = s.replace(
        /for \(let i = 0; i < 17; i\+\+\) \{\r?\n\s*params\.push\(searchPattern\);\r?\n\s*\}/,
        "for (let i = 0; i < 16; i++) {\n                params.push(searchPattern);\n            }"
    );
    s = s.replace(
        /t\.fees,\r?\n\s*t\.tax_rate,\r?\n\s*t\.tax_value,\r?\n\s*t\.total,/g,
        "t.fees,\n                t.total,"
    );
    s = s.replace(
        /`SELECT task_id, username, firm_id, service_id, fees, tax_rate, tax_value, total, status, billing_status/g,
        "`SELECT task_id, username, firm_id, service_id, fees, total, status, billing_status"
    );
    // enrich charges from helper — inject import already done; fix response mapping
    s = s.replace(
        /charges: \{\r?\n\s*fees: Number\(element\?\.fees\) \|\| 0,\r?\n\s*tax_rate: Number\(element\?\.tax_rate\) \|\| 0,\r?\n\s*tax_value: Number\(element\?\.tax_value\) \|\| 0,\r?\n\s*total: Number\(element\?\.total\) \|\| 0,\r?\n\s*\},/,
        `charges: (() => {
                    const feesNum = Number(element?.fees) || 0;
                    const g = resolveGst({ fees: feesNum, asOfDate: element?.create_date, settings: gstSettingsList });
                    return { fees: feesNum, tax_rate: g.tax_rate, tax_value: g.tax_value, total: g.total };
                })(),`
    );
    if (!s.includes("gstSettingsList")) {
        s = s.replace(
            /const listParams = \[\.\.\.params, limitNum, offset\];\r?\n\s*const \[rows\] = await pool\.query\(listQuery, listParams\);/,
            `const listParams = [...params, limitNum, offset];
        const [rows] = await pool.query(listQuery, listParams);
        const gstSettingsList = await fetchBranchGstSettings(pool, branch_id);`
        );
    }
    return s;
});

// --- purchase / expense / contra invoice inserts ---
for (const rel of ["routes/purchase.js", "routes/expense.js", "routes/contra.js"]) {
    write(rel, (s) => {
        s = s.replace(
            /discount_value, tax_rate, tax_value, additional_charge/g,
            "discount_value, additional_charge"
        );
        s = s.replace(
            /invoice\.discount_value, invoice\.tax_rate, invoice\.tax_value, invoice\.additional_charge/g,
            "invoice.discount_value, invoice.additional_charge"
        );
        // VALUES with tax zeros: common pattern after discount_value then 0, 0 for tax
        // Hard to generic — leave VALUES fixes for file-specific below
        return s;
    });
}

write("routes/purchase.js", (s) => {
    // Fix VALUES placeholder count for purchase invoice insert — read context via simpler replace of known 17 placeholders block
    s = s.replace(
        /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/g,
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    // If arrays still pass tax_rate, tax_value as 0,0 — remove two zeros after discount_value in common purchase pattern
    // Look for: discountValue, 0, 0, additionalCharge
    s = s.replace(
        /(pricing\.discountValue|\w*[Dd]iscount[Vv]alue),\s*0,\s*0,\s*(pricing\.additionalCharge|\w*[Aa]dditional)/g,
        "$1, $2"
    );
    return s;
});

write("routes/expense.js", (s) => {
    s = s.replace(
        /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/g,
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    s = s.replace(
        /(discount_value|discountValue),\s*0,\s*0,\s*(additional_charge|additionalCharge)/g,
        "$1, $2"
    );
    // column lists in multi-line INSERT
    s = s.replace(
        /tax_rate, tax_value, additional_charge/g,
        "additional_charge"
    );
    return s;
});

write("routes/contra.js", (s) => {
    s = s.replace(
        /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/g,
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    s = s.replace(
        /(discount_value|discountValue|0),\s*0,\s*0,\s*(additional_charge|additionalCharge|0)/g,
        (m, a, b) => {
            // only when clearly tax zeros
            if (m.includes("tax")) return m;
            return `${a}, ${b}`;
        }
    );
    // more direct: after discount_value in VALUES array
    s = s.replace(
        /discount_value, tax_rate, tax_value, additional_charge/g,
        "discount_value, additional_charge"
    );
    return s;
});

write("routes/sale.js", (s) => {
    if (!s.includes("from \"../helpers/gst.js\"") && !s.includes("from '../helpers/gst.js'")) {
        s = s.replace(
            /^(import .+?;\n)(?![\s\S]*helpers\/gst)/m,
            (m) => `${m}import { fetchBranchGstSettings, resolveGst, toDateOnly } from "../helpers/gst.js";\n`
        );
    }
    s = s.replace(
        /discount_value, tax_rate, tax_value, additional_charge/g,
        "discount_value, additional_charge"
    );
    s = s.replace(
        /invoice\.discount_value, invoice\.tax_rate, invoice\.tax_value, invoice\.additional_charge/g,
        "invoice.discount_value, invoice.additional_charge"
    );
    s = s.replace(
        /fees, tax_perc, tax_value, total, remark/g,
        "fees, total, remark"
    );
    s = s.replace(
        /si\.fees, si\.tax_perc, si\.tax_value, si\.total/g,
        "si.fees, si.total"
    );
    s = s.replace(
        /COALESCE\(SUM\(invoice\.tax_value\), 0\) AS amount_tax,\r?\n\s*COALESCE\(SUM\(invoice\.total - invoice\.tax_value\), 0\) AS amount_net/g,
        "COALESCE(SUM(invoice.grand_total), 0) AS amount_tax,\n                COALESCE(SUM(invoice.subtotal), 0) AS amount_net"
    );
    return s;
});

write("routes/quotation.js", (s) => {
    if (!s.includes("helpers/gst.js")) {
        s = `import { fetchBranchGstSettings, resolveGst, toDateOnly } from "../helpers/gst.js";\n` + s;
    }
    s = s.replace(
        /fees, tax_rate, tax_value, total/g,
        "fees, total"
    );
    s = s.replace(
        /create_by, modify_by, fees, tax_rate, tax_value, total/g,
        "create_by, modify_by, fees, total"
    );
    return s;
});

write("routes/compliance.js", (s) => {
    if (!s.includes("helpers/gst.js")) {
        s = `import { fetchBranchGstSettings, resolveGst, toDateOnly } from "../helpers/gst.js";\n` + s;
    }
    s = s.replace(
        /fees, tax_rate, tax_value, total/g,
        "fees, total"
    );
    s = s.replace(
        /fees, tax_rate, tax_value, staffs/g,
        "fees, staffs"
    );
    s = s.replace(
        /\(branch_id, service_id, username, firm_id, effective_from, fees, tax_rate, tax_value, staffs, ca, agent, due_date, visibility_offset, create_by, modify_by, is_deleted\)/g,
        "(branch_id, service_id, username, firm_id, effective_from, fees, staffs, ca, agent, due_date, visibility_offset, create_by, modify_by, is_deleted)"
    );
    s = s.replace(
        /has_ca, ca_id, has_agent, agent_id, fees, tax_rate, tax_value, total, create_by, is_recurring/g,
        "has_ca, ca_id, has_agent, agent_id, fees, total, create_by, is_recurring"
    );
    return s;
});

write("helpers/taskCreateHelper.js", (s) => {
    if (!s.includes("helpers/gst.js")) {
        s = s.replace(
            /import pool from "\.\.\/db\.js";/,
            `import pool from "../db.js";\nimport { fetchBranchGstSettings, resolveGst, toDateOnly } from "./gst.js";`
        );
    }
    s = s.replace(
        /`SELECT service_id, fees, tax_rate, tax_value, total/g,
        "`SELECT service_id, fees, total"
    );
    s = s.replace(
        /`SELECT request_id, username, firm_id, service_id, fees, tax_rate, tax_value, amount,/g,
        "`SELECT request_id, username, firm_id, service_id, fees, amount,"
    );
    return s;
});

write("helpers/saleStaticEmail.js", (s) => {
    if (!s.includes("helpers/gst.js") && !s.includes("./gst.js")) {
        s = `import { fetchBranchGstSettings, resolveGst, toDateOnly } from "./gst.js";\n` + s;
    }
    s = s.replace(
        /`SELECT si\.service_id, si\.fees, si\.tax_perc, si\.tax_value, si\.total, si\.remark,/g,
        "`SELECT si.service_id, si.fees, si.total, si.remark,"
    );
    return s;
});

write("routes/transactions.js", (s) => {
    s = s.replace(
        /"SELECT services\.name, sale_items\.tax_perc, sale_items\.fees, sale_items\.tax_value, sale_items\.total, sale_items\.remark FROM/g,
        '"SELECT services.name, sale_items.fees, sale_items.total, sale_items.remark FROM'
    );
    s = s.replace(
        /tax_rate, tax_value, additional_charge, total, round_off, grand_total/g,
        "additional_charge, total, round_off, grand_total"
    );
    return s;
});

write("routes/service.js", (s) => {
    if (!s.includes("helpers/gst.js")) {
        s = `import { fetchBranchGstSettings, resolveGst, toDateOnly } from "../helpers/gst.js";\n` + s;
    }
    s = s.replace(/gst_rate/g, (m, offset, str) => {
        // don't break comments about gst — only SQL/field usage; leave variable names that we will fix manually if needed
        return m;
    });
    // Remove gst_rate, gst_value from INSERT/UPDATE column lists for branch_services
    s = s.replace(/,\s*gst_rate,\s*gst_value/g, "");
    s = s.replace(/gst_rate,\s*gst_value,\s*/g, "");
    s = s.replace(/,\s*`gst_rate`,\s*`gst_value`/g, "");
    s = s.replace(/bs\.gst_rate|bs\.gst_value/g, "0");
    return s;
});

write("services/branchSetupService.js", (s) => {
    s = s.replace(/,\s*gst_rate,\s*gst_value/g, "");
    s = s.replace(/gst_rate:\s*0,?\s*/g, "");
    s = s.replace(/gst_value:\s*0,?\s*/g, "");
    return s;
});

for (const rel of [
    "routes_client/service.js",
    "routes_agent/service.js",
    "routes_ca/service.js",
    "routes_client/task.js",
    "routes_agent/task.js",
]) {
    write(rel, (s) => {
        s = s.replace(/,\s*tax_rate,\s*tax_value/g, "");
        s = s.replace(/tax_rate,\s*tax_value,\s*/g, "");
        s = s.replace(/,\s*gst_rate,\s*gst_value/g, "");
        s = s.replace(/gst_rate,\s*gst_value,\s*/g, "");
        s = s.replace(/bs\.gst_rate|t\.tax_rate|t\.tax_value/g, "0");
        return s;
    });
}

write("routes/report.js", (s) => {
    s = s.replace(/t\.tax_rate,\s*/g, "");
    s = s.replace(/t\.tax_value,\s*/g, "");
    s = s.replace(/si\.tax_value,\s*/g, "");
    s = s.replace(/bs\.gst_rate,\s*/g, "");
    s = s.replace(/invoice\.tax_rate,\s*/g, "");
    s = s.replace(/invoice\.tax_value,\s*/g, "");
    return s;
});

console.log("done");
