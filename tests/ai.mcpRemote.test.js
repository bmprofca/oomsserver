import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAiRouter } from "../routes/ai.js";
import { createConnectorLimiter, createMcpRemoteRouter } from "../routes/mcpRemote.js";
import { hashToken } from "../ai/mcpConnectors.js";
import { createFakeDb } from "./helpers/aiFakes.js";

/**
 * End-to-end: an admin creates a connector through the settings API, then a real MCP
 * client connects to the returned URL over HTTP — the way Claude's custom connector does.
 */

function memoryDb() {
    const connectors = [];
    const audits = [];
    let seq = 0;
    const members = { boss: "admin", staff1: "staff" };
    const db = createFakeDb([
        [/CREATE TABLE IF NOT EXISTS/, () => ({})],
        [/FROM branch_mapping\s+WHERE username = \? AND branch_id = \?/, ([u, b]) =>
            (b === "BR1" && members[u] ? [{ type: members[u], permission_role_id: null, custom_permissions: null }] : [])],
        [/FROM branch_mapping bm\s+WHERE bm.branch_id = \? AND bm.type IN/, ([b]) =>
            (b === "BR1" ? Object.entries(members).map(([username, type]) => ({ username, type, designation: null, name: username === "boss" ? "Office Boss" : "Staff One" })) : [])],
        [/FROM branch_mapping bm\s+LEFT JOIN profile/, () => [{ username: "usr_ARUN000001", type: "staff", name: "Arun Pawan", designation: "Accountant" }]],
        [/SELECT COUNT\(\*\) AS n FROM branch_mcp_connectors/, ([b]) => [{ n: connectors.filter((c) => c.branch_id === b).length }]],
        [/INSERT INTO branch_mcp_connectors/, ([connector_id, branch_id, label, token_hash, token_hint, run_as_username, access_mode]) => {
            connectors.push({ id: ++seq, connector_id, branch_id, label, token_hash, token_hint, run_as_username, enabled: "1", access_mode, last_used_at: null, last_client: null });
            return { affectedRows: 1 };
        }],
        [/DELETE FROM branch_mcp_connectors/, ([b, id]) => {
            const i = connectors.findIndex((c) => c.branch_id === b && c.connector_id === id);
            if (i >= 0) connectors.splice(i, 1);
            return { affectedRows: i >= 0 ? 1 : 0 };
        }],
        [/FROM branch_mcp_connectors WHERE token_hash = \?/, ([h]) => connectors.filter((c) => c.token_hash === h)],
        [/FROM branch_mcp_connectors c WHERE c.branch_id = \? AND c.connector_id = \?/, ([b, id]) => connectors.filter((c) => c.branch_id === b && c.connector_id === id)],
        [/FROM branch_mcp_connectors c WHERE c.branch_id = \? ORDER BY/, ([b]) => connectors.filter((c) => c.branch_id === b)],
        [/UPDATE branch_mcp_connectors SET last_used_at/, ([client, id]) => {
            const c = connectors.find((x) => x.connector_id === id);
            if (c) {
                c.last_used_at = "2026-10-19 12:00:00";
                c.last_client = client ?? c.last_client;
            }
            return { affectedRows: 1 };
        }],
        [/UPDATE branch_mcp_connectors SET/, (params, sql) => {
            const cols = [...sql.split(/\bWHERE\b/)[0].matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const [b, id] = params.slice(cols.length);
            const c = connectors.find((x) => x.branch_id === b && x.connector_id === id);
            if (c) cols.forEach((col, i) => { c[col] = params[i]; });
            return { affectedRows: c ? 1 : 0 };
        }],
        [/INSERT INTO ai_tool_calls/, (p) => {
            audits.push(p);
            return { affectedRows: 1 };
        }],
    ]);
    return { db, connectors, audits, members };
}

const fakeAuth = (req, res, next) => {
    if (req.headers.token !== "valid") return res.status(401).json({ success: false });
    req.branch_id = req.headers.branch;
    next();
};

async function startServer({ store = memoryDb(), limiter } = {}) {
    const app = express();
    // Same body parser settings as server.js.
    app.use(express.json({ strict: false, limit: "15mb" }));
    app.use("/api/v1/ai", createAiRouter({ db: store.db, deps: { db: store.db }, authMiddleware: [fakeAuth] }));
    app.use("/api/v1/mcp", createMcpRemoteRouter({ db: store.db, deps: { db: store.db }, ...(limiter ? { limiter } : {}) }));
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const admin = (path, { method = "GET", body, user = "boss" } = {}) =>
        fetch(`${origin}/api/v1/ai${path}`, {
            method,
            headers: { "content-type": "application/json", token: "valid", username: user, branch: "BR1", host: "server.ooms.in" },
            body: body ? JSON.stringify(body) : undefined,
        });
    return { server, origin, admin, store };
}

/** Rewrite the public URL the API returns to the local test server. */
const localUrl = (url, origin) => url.replace(/^https?:\/\/[^/]+/, origin);

async function createConnector(admin, origin, body = { label: "Claude — office", run_as: "boss" }) {
    const res = await admin("/mcp-connectors", { method: "POST", body });
    const json = await res.json();
    assert.equal(res.status, 201, JSON.stringify(json));
    return { ...json.data, localUrl: localUrl(json.data.url, origin) };
}

const rpc = (url, body, headers = {}) =>
    fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(body),
    });

/** Responses may be JSON or a single-event SSE stream; return the JSON-RPC message. */
async function readRpc(res) {
    const text = await res.text();
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
        const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        return JSON.parse(data);
    }
    return JSON.parse(text);
}

test("admin creates a connector; the URL works with a real MCP client (2025 protocol, like Claude today)", async () => {
    const { server, origin, admin, store } = await startServer();
    try {
        const created = await createConnector(admin, origin);
        process.env.BASE_DOMAIN && assert.match(created.url, /\/api\/v1\/mcp\/ooms_mcp_/);
        assert.match(created.url, /^https?:\/\/[^/]+\/api\/v1\/mcp\/ooms_mcp_[A-Za-z0-9_-]{43}$/);
        assert.equal(created.connectors.length, 1);
        assert.doesNotMatch(JSON.stringify(created.connectors), /ooms_mcp_[A-Za-z0-9_-]{43}/, "secret only returned once, as the url");
        assert.equal(store.connectors[0].token_hash, hashToken(created.url.split("/").pop()), "only the hash is stored");

        const client = new Client({ name: "claude-ai", version: "0.1.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(created.localUrl)));
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        assert.ok(names.includes("search_staff") && names.includes("get_party_balance"), "admin sees finance tools");
        assert.ok(!names.includes("ask_clarification"), "clarification tool is in-app only");
        assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), "every tool is marked read-only");
        assert.match(client.getInstructions() || "", /internal/i);

        const result = await client.callTool({ name: "search_staff", arguments: { search: "Arun" } });
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Arun Pawan/);

        const bad = await client.callTool({ name: "search_staff", arguments: { search: "Arun", branch_id: "BR2" } });
        assert.equal(bad.isError, true, "extra arguments (e.g. another branch) are rejected");
        await client.close();

        await new Promise((r) => setTimeout(r, 20));
        assert.ok(store.audits.length >= 1, "tool calls are audited");
        assert.match(String(store.audits[0][0]), /^mcp:/);
        assert.equal(store.connectors[0].last_client, "claude-ai 0.1.0");
    } finally {
        server.close();
    }
});

test("connector created as read & write exposes send tools in Claude; read-only does not", async () => {
    const { server, origin, admin, store } = await startServer();
    try {
        const noAck = await admin("/mcp-connectors", { method: "POST", body: { run_as: "boss", access_mode: "read_write" } });
        assert.equal(noAck.status, 400, "read & write needs the acknowledgement");
        assert.equal(store.connectors.length, 0);

        const listTools = async (url) => {
            const client = new Client({ name: "claude-ai", version: "0.1.0" });
            await client.connect(new StreamableHTTPClientTransport(new URL(url)));
            const { tools } = await client.listTools();
            const instructions = client.getInstructions() || "";
            await client.close();
            return { names: tools.map((t) => t.name), tools, instructions };
        };

        const rw = await createConnector(admin, origin, { run_as: "boss", access_mode: "read_write", acknowledge_write: true });
        assert.equal(rw.connectors[0].access_mode, "read_write");
        const write = await listTools(rw.localUrl);
        for (const name of ["send_whatsapp", "send_email", "share_client_documents", "share_ledger_statement", "confirm_action", "cancel_action"]) {
            assert.ok(write.names.includes(name), `${name} available in read & write`);
        }
        assert.equal(write.tools.find((t) => t.name === "confirm_action").annotations.readOnlyHint, false, "Claude asks before confirm");
        assert.match(write.instructions, /explicit approval/);

        const ro = await createConnector(admin, origin, { run_as: "boss" });
        const read = await listTools(ro.localUrl);
        assert.ok(!read.names.some((n) => /^(send_|share_|confirm_|cancel_)/.test(n)), "read-only has no write tools");
        assert.match(read.instructions, /read-only/i);

        // Switching an existing connector takes effect on the next request.
        await admin(`/mcp-connectors/${ro.id}`, { method: "PATCH", body: { access_mode: "read_write", acknowledge_write: true } });
        assert.ok((await listTools(ro.localUrl)).names.includes("confirm_action"));
    } finally {
        server.close();
    }
});

test("modern protocol negotiation (2026-07-28) works too", async () => {
    const { server, origin, admin } = await startServer();
    try {
        const created = await createConnector(admin, origin);
        const client = new Client({ name: "modern-client", version: "1.0.0" }, { versionNegotiation: "auto" });
        await client.connect(new StreamableHTTPClientTransport(new URL(created.localUrl)));
        const { tools } = await client.listTools();
        assert.ok(tools.length > 5);
        const result = await client.callTool({ name: "search_staff", arguments: { search: "Arun" } });
        assert.match(result.content[0].text, /Arun Pawan/);
        await client.close();
    } finally {
        server.close();
    }
});

test("raw HTTP exactly as a connector sends it: initialize, initialized, tools/list, tools/call; GET/DELETE 405", async () => {
    const { server, origin, admin } = await startServer();
    try {
        const { localUrl: url } = await createConnector(admin, origin);
        for (const protocolVersion of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
            const init = await rpc(url, {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion, capabilities: {}, clientInfo: { name: "claude-ai", version: "0.1.0" } },
            });
            assert.equal(init.status, 200, protocolVersion);
            const msg = await readRpc(init);
            assert.equal(msg.result.serverInfo.name, "ooms");
            assert.ok(msg.result.capabilities.tools, "tools capability advertised");
            assert.ok(msg.result.protocolVersion, "a protocol version is negotiated");
            assert.equal(init.headers.get("mcp-session-id"), null, "stateless: no session id");
        }

        const note = await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": "2025-06-18" });
        assert.equal(note.status, 202);

        const list = await readRpc(await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" }));
        assert.ok(list.result.tools.some((t) => t.name === "get_staff_tasks"));
        assert.ok(list.result.tools.every((t) => t.inputSchema?.type === "object"));

        const call = await readRpc(await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_staff", arguments: { search: "Arun" } } }, { "mcp-protocol-version": "2025-06-18" }));
        assert.match(call.result.content[0].text, /Arun Pawan/);

        const unknown = await readRpc(await rpc(url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "drop_everything", arguments: {} } }, { "mcp-protocol-version": "2025-06-18" }));
        assert.ok(unknown.error || unknown.result?.isError, "unknown tool is an error, not a crash");

        assert.equal((await fetch(url, { method: "GET", headers: { accept: "text/event-stream" } })).status, 405);
        assert.equal((await fetch(url, { method: "DELETE" })).status, 405);

        const notJson = await fetch(url, { method: "POST", headers: { "content-type": "text/plain", accept: "application/json, text/event-stream" }, body: "hello" });
        assert.ok([400, 406, 415].includes(notJson.status), `non-JSON body rejected (${notJson.status})`);
    } finally {
        server.close();
    }
});

test("bad, rotated, disabled and deleted connector URLs get 404; responses reveal nothing", async () => {
    const { server, origin, admin } = await startServer();
    const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    try {
        assert.equal((await rpc(`${origin}/api/v1/mcp/not-a-token`, initBody)).status, 404);
        assert.equal((await rpc(`${origin}/api/v1/mcp/ooms_mcp_${"A".repeat(43)}`, initBody)).status, 404);
        assert.equal((await rpc(`${origin}/api/v1/mcp`, initBody)).status, 404);

        const created = await createConnector(admin, origin);
        assert.equal((await rpc(created.localUrl, initBody)).status, 200);

        const rotated = await (await admin(`/mcp-connectors/${created.id}/rotate`, { method: "POST" })).json();
        const newUrl = localUrl(rotated.data.url, origin);
        assert.notEqual(newUrl, created.localUrl);
        const old = await rpc(created.localUrl, initBody);
        assert.equal(old.status, 404, "old URL stops working after regenerate");
        assert.deepEqual(Object.keys(await old.json()).sort(), ["error", "id", "jsonrpc"]);
        assert.equal((await rpc(newUrl, initBody)).status, 200);

        await admin(`/mcp-connectors/${created.id}`, { method: "PATCH", body: { enabled: false } });
        assert.equal((await rpc(newUrl, initBody)).status, 404, "switched off");
        await admin(`/mcp-connectors/${created.id}`, { method: "PATCH", body: { enabled: true } });
        assert.equal((await rpc(newUrl, initBody)).status, 200);

        await admin(`/mcp-connectors/${created.id}`, { method: "DELETE" });
        assert.equal((await rpc(newUrl, initBody)).status, 404, "deleted");
    } finally {
        server.close();
    }
});

test("connectors run with the chosen member's permissions, checked on every request", async () => {
    const store = memoryDb();
    const { server, origin, admin } = await startServer({ store });
    try {
        const staff = await createConnector(admin, origin, { label: "Staff view", run_as: "staff1" });
        const client = new Client({ name: "t", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(staff.localUrl)));
        const names = (await client.listTools()).tools.map((t) => t.name);
        assert.ok(!names.includes("get_party_balance") && !names.includes("get_ledger_statement"), "no finance tools without finance permission");
        await client.close();

        // Member removed from the branch → connector stops working.
        delete store.members.staff1;
        const res = await rpc(staff.localUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
        assert.equal(res.status, 403);
        assert.match((await res.json()).error.message, /no longer has access/);
    } finally {
        server.close();
    }
});

test("admin API: only admins, valid members only, connector limit, rate limit per connector", async () => {
    const { server, origin, admin } = await startServer({ limiter: createConnectorLimiter({ perMinute: 3 }) });
    try {
        assert.equal((await admin("/mcp-connectors", { user: "staff1" })).status, 403);
        assert.equal((await admin("/mcp-connectors", { method: "POST", user: "staff1", body: { run_as: "staff1" } })).status, 403);
        const badMember = await admin("/mcp-connectors", { method: "POST", body: { run_as: "someone_else" } });
        assert.equal(badMember.status, 400);
        assert.equal((await badMember.json()).code, "INVALID_MEMBER");
        assert.equal((await admin("/mcp-connectors", { method: "POST", body: { run_as: "boss", label: "<b>" } })).status, 400);

        const list = await (await admin("/mcp-connectors")).json();
        assert.deepEqual(list.data.members.map((m) => m.name), ["Office Boss", "Staff One"]);
        assert.equal(list.data.limits.max_connectors, 20);
        assert.match(list.data.endpoint, /\/api\/v1\/mcp$/);

        const created = await createConnector(admin, origin);
        const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
        for (let i = 0; i < 3; i++) assert.equal((await rpc(created.localUrl, initBody)).status, 200);
        const limited = await rpc(created.localUrl, initBody);
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get("retry-after"), "60");

        for (let i = 1; i < 20; i++) await admin("/mcp-connectors", { method: "POST", body: { run_as: "boss" } });
        const over = await admin("/mcp-connectors", { method: "POST", body: { run_as: "boss" } });
        assert.equal(over.status, 400);
        assert.equal((await over.json()).code, "CONNECTOR_LIMIT");
    } finally {
        server.close();
    }
});

test("public URL detection: production https domain is public, localhost is not", async () => {
    const { connectorBaseUrl } = await import("../ai/mcpConnectors.js");
    const saved = process.env.BASE_DOMAIN;
    try {
        process.env.BASE_DOMAIN = "https://server.ooms.in/";
        assert.deepEqual(connectorBaseUrl({ headers: {} }), { base: "https://server.ooms.in", endpoint: "https://server.ooms.in/api/v1/mcp", public: true });
        process.env.BASE_DOMAIN = "http://localhost:8877";
        assert.equal(connectorBaseUrl({ headers: {} }).public, false);
        delete process.env.BASE_DOMAIN;
        assert.deepEqual(connectorBaseUrl({ headers: { "x-forwarded-proto": "https", host: "api.example.com" } }), { base: "https://api.example.com", endpoint: "https://api.example.com/api/v1/mcp", public: true });
        assert.equal(connectorBaseUrl({ headers: { host: "192.168.1.5:8877" }, protocol: "http" }).public, false);
    } finally {
        if (saved === undefined) delete process.env.BASE_DOMAIN;
        else process.env.BASE_DOMAIN = saved;
    }
});
