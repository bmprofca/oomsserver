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

export async function poolQuery(sql, params, { retries = 2, delayMs = 500 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await pool.query(sql, params);
        } catch (error) {
            lastError = error;
            if (!TRANSIENT_DB_ERRORS.has(error.code) || attempt === retries) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
        }
    }
    throw lastError;
}

export default pool;
