import { Server } from "socket.io";
import pool from "../db.js";

export function setupSocketIO(server) {
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 60000,
        pingInterval: 25000
    });

    io.on("connection", (socket) => {
        socket.on("auth", async ({ username, token, branch }) => {
            const [check_row] = await pool.query("SELECT * FROM `login_token` WHERE username = ? AND token = ? AND status = '1'", [username, token, '1']);
            if (check_row.length === 0) {
                socket.emit("auth_status", false);
                socket.disconnect();
                return;
            }
            socket.join(username);
            if (branch) {
                const [branchRows] = await pool.query(
                    `SELECT id FROM branch_mapping
                     WHERE username = ? AND branch_id = ?
                       AND is_accepted = '1' AND status = '1' AND is_deleted = '0'
                     LIMIT 1`,
                    [username, String(branch)]
                ).catch(() => [[]]);
                if (branchRows.length) socket.join(`branch:${String(branch)}`);
            }
            socket.join(`user:${username}`);
            socket.emit("auth_status", true);
        });
        socket.on("disconnect", (reason) => {
            // console.log(`❌ Socket ${socket.id} disconnected:`, reason);
        });
    });

    return io;
}