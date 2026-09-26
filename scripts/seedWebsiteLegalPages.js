/**
 * One-off / ops script: upsert full default legal page HTML into website_legal_pages.
 * Usage (from SERVER folder): node scripts/seedWebsiteLegalPages.js
 */
import { syncDefaultLegalPages } from "../helpers/websiteLegalPages.js";
import pool from "../db.js";

async function main() {
  console.log("Syncing default legal pages into database...");
  const results = await syncDefaultLegalPages("system-seed");
  for (const row of results) {
    console.log(`✓ ${row.slug} (${row.title}) — ${row.chars} chars — id=${row.page_id}`);
  }
  console.log(`Done. ${results.length} page(s) synced.`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {}
  });
