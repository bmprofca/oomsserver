import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import apiRoutes from "./routes/index.js";
import adminRoutes from "./routes_admin/index.js";
import clientPortalRoutes from "./routes_client/index.js";
import caPortalRoutes from "./routes_ca/index.js";
import agentPortalRoutes from "./routes_agent/index.js";
import http from "http";
import { setupSocketIO } from "./helpers/Socket.js";
import { generateDatabaseContext } from "./helpers/DatabaseContext.js";
import { startEmailBroadcastCron } from "./cron/emailBroadcastCron.js";
import { startSmsBroadcastCron } from "./cron/smsBroadcastCron.js";
import publicRoutes from "./routes/public.js";

const PORT = Number(process.env.PORT) || 8877;

const app = express();

// Global CORS handling for all endpoints (including preflight requests)
app.use((req, res, next) => {
    const origin = req.headers.origin || "*";
    const requestHeaders = req.headers["access-control-request-headers"];

    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    res.header(
        "Access-Control-Allow-Headers",
        requestHeaders || "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    return next();
});

app.use(express.json({ strict: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use("/temp", express.static(path.join(__dirname, "media", "upload", "temp")));
app.use("/media/profile/image", express.static(path.join(__dirname, "media", "profile", "image")));

app.use("/media/profile", express.static(path.join(__dirname, "media", "profile")));
app.use("/media/note/file", express.static(path.join(__dirname, "media", "note", "file")));
app.use("/media/note/voice", express.static(path.join(__dirname, "media", "note", "voice")));
app.use("/media/format", express.static(path.join(__dirname, "media", "format")));
app.use("/media/invoice", express.static(path.join(__dirname, "media", "invoice")));
app.use("/media/logo", express.static(path.join(__dirname, "media", "logo")));
app.use("/media/sign", express.static(path.join(__dirname, "media", "sign")));
app.use("/media/quotation", express.static(path.join(__dirname, "media", "quotation")));
app.use("/media/wp_system", express.static(path.join(__dirname, "media", "wp_system")));

app.use("/api/v1", apiRoutes);
app.use("/admin", adminRoutes);
app.use("/client", clientPortalRoutes);
app.use("/ca", caPortalRoutes);
app.use("/agent", agentPortalRoutes);

app.use("/public", publicRoutes);

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString()
    });
});

const server = http.createServer(app);
const WsIo = setupSocketIO(server);


server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    generateDatabaseContext();
    startEmailBroadcastCron();
    startSmsBroadcastCron();
});

export { WsIo };