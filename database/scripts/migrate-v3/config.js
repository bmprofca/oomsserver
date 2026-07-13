import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OLD_APP_ID = process.env.MIGRATE_OLD_APP_ID || "APP2025";
export const OLD_BRANCH_ID = process.env.MIGRATE_OLD_BRANCH_ID || "BRN2025";
export const NEW_BRANCH_ID = process.env.MIGRATE_NEW_BRANCH_ID || "123456";

export const STAGING_DB_NAME = process.env.STAGING_DB_NAME || process.env.DB_NAME;
export const STAGING_TABLE_PREFIX = process.env.STAGING_TABLE_PREFIX || "v3staging_";
export const DEFAULT_SQL_DUMP =
    process.env.MIGRATE_SQL_DUMP ||
    path.resolve("C:/Users/rinku/Downloads/u278432002_ooms_v3.sql");

export const BATCH_SIZE = Number(process.env.MIGRATE_BATCH_SIZE) || 500;

export const PHASES = {
    a: "foundation",
    b: "crm",
    c: "tasks",
    d: "finance",
    e: "extras",
};

export const ALL_PHASE_KEYS = Object.keys(PHASES);
