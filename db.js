import "dotenv/config";
import mysql from "mysql2/promise";

const TRANSIENT_DB_ERRORS = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "PROTOCOL_CONNECTION_LOST",
    "ER_CLIENT_INTERACTION_TIMEOUT",
    "EPIPE",
]);

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
    // Drop idle sockets before MySQL/server proxies close them, so we avoid
    // handing out half-open connections that fail with ECONNRESET.
    maxIdle: Number(process.env.DB_MAX_IDLE) || Number(process.env.DB_CONNECTION_LIMIT) || 10,
    idleTimeout: Number(process.env.DB_IDLE_TIMEOUT_MS) || 60000,
    queueLimit: 0,
    charset: "utf8mb4",
    dateStrings: true,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 20000,
    enableKeepAlive: true,
    keepAliveInitialDelay: Number(process.env.DB_KEEPALIVE_DELAY_MS) || 10000,
});

export function isTransientDbError(error) {
    if (!error) return false;
    if (TRANSIENT_DB_ERRORS.has(error.code)) return true;
    // mysql2 marks hard disconnects as fatal even when code is present
    return Boolean(error.fatal && error.code);
}

/** Release to pool, or destroy if the socket is dead so it is not reused. */
export function releasePoolConnection(conn, error) {
    if (!conn) return;
    try {
        if (error && (error.fatal || isTransientDbError(error))) {
            conn.destroy();
            return;
        }
        conn.release();
    } catch (_) {
        try {
            conn.destroy();
        } catch (_) {
            /* ignore */
        }
    }
}

function wrapPoolWithRetry(basePool, { retries, delayMs } = {}) {
    const maxRetries = retries ?? (Number(process.env.DB_QUERY_RETRIES) || 3);
    const retryDelayMs = delayMs ?? (Number(process.env.DB_QUERY_RETRY_DELAY_MS) || 1500);

    const originalQuery = basePool.query.bind(basePool);
    const originalExecute = basePool.execute?.bind(basePool);
    const originalGetConnection = basePool.getConnection.bind(basePool);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    basePool.query = async function queryWithRetry(sql, params) {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await originalQuery(sql, params);
            } catch (error) {
                lastError = error;
                if (!isTransientDbError(error) || attempt === maxRetries) {
                    throw error;
                }
                await sleep(retryDelayMs * (attempt + 1));
            }
        }
        throw lastError;
    };

    if (originalExecute) {
        basePool.execute = async function executeWithRetry(sql, params) {
            let lastError;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    return await originalExecute(sql, params);
                } catch (error) {
                    lastError = error;
                    if (!isTransientDbError(error) || attempt === maxRetries) {
                        throw error;
                    }
                    await sleep(retryDelayMs * (attempt + 1));
                }
            }
            throw lastError;
        };
    }

    // Validate connections on checkout so stale sockets fail fast and retry.
    basePool.getConnection = async function getConnectionWithRetry() {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let conn;
            try {
                conn = await originalGetConnection();
                await conn.ping();
                return conn;
            } catch (error) {
                lastError = error;
                releasePoolConnection(conn, error);
                if (!isTransientDbError(error) || attempt === maxRetries) {
                    throw error;
                }
                await sleep(retryDelayMs * (attempt + 1));
            }
        }
        throw lastError;
    };

    return basePool;
}

wrapPoolWithRetry(pool);

pool.on("connection", (connection) => {
    connection.on("error", (err) => {
        console.warn("MySQL pooled connection error:", err?.code || err?.message || err);
    });
});

export async function poolQuery(sql, params) {
    return pool.query(sql, params);
}

export default pool;
