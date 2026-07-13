import "dotenv/config";
import mysql from "mysql2/promise";
import { STAGING_DB_NAME, STAGING_TABLE_PREFIX } from "./config.js";

const TRANSIENT_DB_ERRORS = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "PROTOCOL_CONNECTION_LOST",
    "ER_CLIENT_INTERACTION_TIMEOUT",
]);

function baseConfig(database) {
    return {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
        queueLimit: 0,
        charset: "utf8mb4",
        dateStrings: true,
        connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 120000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
    };
}

let stagingPool;
let targetPool;

export function stagingTable(name) {
    return `${STAGING_TABLE_PREFIX}${name}`;
}

function wrapPool(pool) {
    const originalQuery = pool.query.bind(pool);
    pool.query = async function queryWithRetry(sql, params, { retries = 3, delayMs = 1000 } = {}) {
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await originalQuery(sql, params);
            } catch (error) {
                lastError = error;
                if (!TRANSIENT_DB_ERRORS.has(error.code) || attempt === retries) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
            }
        }
        throw lastError;
    };
    return pool;
}

export function getStagingPool() {
    if (!stagingPool) {
        stagingPool = wrapPool(mysql.createPool(baseConfig(STAGING_DB_NAME)));
    }
    return stagingPool;
}

export function getTargetPool() {
    if (!targetPool) {
        targetPool = wrapPool(mysql.createPool(baseConfig(process.env.DB_NAME)));
    }
    return targetPool;
}

export async function getRootConnection() {
    return mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 120000,
        multipleStatements: true,
    });
}

export async function closePools() {
    const closers = [];
    if (stagingPool) closers.push(stagingPool.end());
    if (targetPool) closers.push(targetPool.end());
    await Promise.all(closers);
    stagingPool = null;
    targetPool = null;
}
