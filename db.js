import "dotenv/config";
import mysql from "mysql2/promise";

const TRANSIENT_DB_ERRORS = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "PROTOCOL_CONNECTION_LOST",
    "ER_CLIENT_INTERACTION_TIMEOUT",
]);

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
    queueLimit: 0,
    charset: "utf8mb4",
    dateStrings: true,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 20000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

function wrapPoolWithRetry(basePool, { retries, delayMs } = {}) {
    const maxRetries = retries ?? (Number(process.env.DB_QUERY_RETRIES) || 3);
    const retryDelayMs = delayMs ?? (Number(process.env.DB_QUERY_RETRY_DELAY_MS) || 1500);
    const originalQuery = basePool.query.bind(basePool);
    basePool.query = async function queryWithRetry(sql, params) {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await originalQuery(sql, params);
            } catch (error) {
                lastError = error;
                if (!TRANSIENT_DB_ERRORS.has(error.code) || attempt === maxRetries) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
            }
        }
        throw lastError;
    };
    return basePool;
}

wrapPoolWithRetry(pool);

export async function poolQuery(sql, params) {
    return pool.query(sql, params);
}

export default pool;
