import "./utils/timezone.js";
import "dotenv/config";
import mysql from "mysql2/promise";
import { MYSQL_SESSION_TIME_ZONE } from "./utils/timezone.js";

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
    // Align JS Date <-> MySQL conversion with IST wall clock.
    timezone: MYSQL_SESSION_TIME_ZONE,
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

async function applySessionTimezone(conn) {
    if (!conn || conn.__oomsIstTz) return;
    await conn.query(`SET time_zone = '${MYSQL_SESSION_TIME_ZONE}'`);
    conn.__oomsIstTz = true;
}

function wrapPoolWithRetry(basePool, { retries, delayMs } = {}) {
    const maxRetries = retries ?? (Number(process.env.DB_QUERY_RETRIES) || 3);
    const retryDelayMs = delayMs ?? (Number(process.env.DB_QUERY_RETRY_DELAY_MS) || 1500);

    const originalExecute = basePool.execute?.bind(basePool);
    const originalGetConnection = basePool.getConnection.bind(basePool);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Always checkout a connection and force IST session timezone so NOW() /
    // CURRENT_TIMESTAMP match Indian wall clock without changing host DB TZ.
    basePool.query = async function queryWithRetry(sql, params) {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let conn;
            try {
                conn = await originalGetConnection();
                await applySessionTimezone(conn);
                const result = await conn.query(sql, params);
                releasePoolConnection(conn);
                return result;
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

    if (originalExecute) {
        basePool.execute = async function executeWithRetry(sql, params) {
            let lastError;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                let conn;
                try {
                    conn = await originalGetConnection();
                    await applySessionTimezone(conn);
                    const result = await conn.execute(sql, params);
                    releasePoolConnection(conn);
                    return result;
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
    }

    // Validate connections on checkout so stale sockets fail fast and retry.
    basePool.getConnection = async function getConnectionWithRetry() {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let conn;
            try {
                conn = await originalGetConnection();
                await conn.ping();
                await applySessionTimezone(conn);
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
    // Best-effort early set; query/getConnection wrappers also enforce IST.
    connection.query(`SET time_zone = '${MYSQL_SESSION_TIME_ZONE}'`, (err) => {
        if (!err) connection.__oomsIstTz = true;
    });
    connection.on("error", (err) => {
        console.warn("MySQL pooled connection error:", err?.code || err?.message || err);
    });
});

export async function poolQuery(sql, params) {
    return pool.query(sql, params);
}

export default pool;
