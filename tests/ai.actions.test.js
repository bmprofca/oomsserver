import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAiRouter } from "../routes/ai.js";
import { createMcpRemoteRouter } from "../routes/mcpRemote.js";
import { createAiRateLimiter } from "../middleware/aiRateLimit.js";
import { toolsForContext } from "../ai/tools/index.js";
import { hashToken } from "../ai/mcpConnectors.js";
import { encryptSecret } from "../helpers/secretBox.js";
import { createFakeDb, createScriptedProvider, finalText, makeCtx, toolUse } from "./helpers/aiFakes.js";

/**
 * Read-write mode: the AI may only PREPARE sends; a person confirms; then it is sent once.
 * Fake senders record calls — no WhatsApp, email or file service is contacted.
 */

const KEY = "sk-ant-api03-TESTKEY-actions-0000000000001234";
const TOKEN = `ooms_mcp_${"W".repeat(43)}`;

function fakeSenders(overrides = {}) {
    const calls = [];
    const s = {
        calls,
        channel: "ooms web",
        plan: true,
        smtp: true,
        unsubscribed: [],
        fail: {},
        async whatsappChannel() { return s.channel; },
        async hasPlan() { return s.plan; },
        async hasActiveSmtp() { return s.smtp; },
        async isUnsubscribed(_b, email) { return s.unsubscribed.includes(email); },
        async sendWhatsappText(a) { calls.push(["whatsapp", a]); if (s.fail.whatsapp) throw new Error("WhatsApp Web session needs QR linking again at http://10.0.0.1"); },
        async sendEmail(a) { calls.push(["email", a]); if (s.fail.email) throw new Error("SMTP auth failed"); return { messageId: "m-1" }; },
        async loadDocument(a) { calls.push(["load", a]); return { buffer: Buffer.from("%PDF"), mimeType: "application/pdf" }; },
        async uploadPublic(a) { calls.push(["upload", a.filename]); return `https://files.example/${a.filename}`; },
        async buildLedgerPdf(a) { calls.push(["ledger", a]); return { buffer: Buffer.from("%PDF"), filename: "Ledger_Asish.pdf", firmName: "Asish & Co" }; },
        async shareDocumentEmail(a) { calls.push(["share_email", a.documentName]); },
        async shareDocumentWhatsapp(a) { calls.push(["share_whatsapp", a.documentName]); },
        ...overrides,
    };
    return s;
}

function memoryDb({ accessMode = "read_write", connectorMode = "read_write", permissions = { boss: "admin", staff1: "staff" } } = {}) {
    const actions = [];
    const conversations = [];
    const messages = [];
    const settings = { enabled: "1", rate_per_min: 100, rate_per_day: 1000, access_mode: accessMode };
    const connector = { connector_id: "c0nn0000-0000-4000-8000-000000000001", branch_id: "BR1", run_as_username: "boss", enabled: "1", access_mode: connectorMode, token_hash: hashToken(TOKEN) };
    const clients = {
        usr_ASISH00001: { name: "Asish Layek", mobile: "9876543210", country_code: "91", email: "asish@example.com" },
        usr_NOMAIL0001: { name: "No Mail", mobile: "", country_code: "91", email: "" },
    };
    const docs = [
        { document_id: "DOC0000001", username: "usr_ASISH00001", category_id: "IT", name: "ITR 2025-26", remark: "", file: "itr.pdf", mime_type: "application/pdf", firm_name: "Asish & Co" },
        { document_id: "DOC0000002", username: "usr_ASISH00001", category_id: "GST", name: "GSTR-3B Sep", remark: "", file: "g.pdf", mime_type: "application/pdf", firm_name: "Asish & Co" },
    ];
    const now = () => Date.now();
    const db = createFakeDb([
        [/CREATE TABLE IF NOT EXISTS/, () => ({})],
        [/information_schema\.COLUMNS/, () => [{ n: 1 }]],
        [/FROM branch_mapping\s+WHERE username = \? AND branch_id = \?/, ([u, b]) =>
            (b === "BR1" && permissions[u] ? [{ type: permissions[u], permission_role_id: null, custom_permissions: null }] : [])],
        [/SELECT enabled, access_mode FROM branch_ai_settings/, () => [settings]],
        [/FROM branch_ai_settings WHERE branch_id = \?/, () => [settings]],
        [/UPDATE branch_ai_settings/, ([enabled, rpm, rpd, mode]) => {
            Object.assign(settings, { enabled, rate_per_min: rpm, rate_per_day: rpd, access_mode: mode });
            return { affectedRows: 1 };
        }],
        [/SELECT enabled, access_mode FROM branch_mcp_connectors/, () => [connector]],
        [/FROM branch_mcp_connectors WHERE token_hash = \?/, ([h]) => (h === connector.token_hash ? [connector] : [])],
        [/UPDATE branch_mcp_connectors SET last_used_at/, () => ({ affectedRows: 1 })],
        [/FROM branch_ai_connections\s+WHERE branch_id = \? AND enabled = '1'/, () => [{ id: 1, connection_id: "00000000-0000-4000-8000-000000000001", provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", api_key_enc: encryptSecret(KEY), enabled: "1", priority: 1 }]],
        [/FROM branch_ai_connections WHERE branch_id = \? ORDER BY/, () => [{ id: 1, connection_id: "00000000-0000-4000-8000-000000000001", provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", enabled: "1", priority: 1 }]],
        [/UPDATE branch_ai_connections/, () => ({ affectedRows: 1 })],
        [/FROM clients c\s+LEFT JOIN profile p/, ([b, u]) => (b === "BR1" && clients[u] ? [{ username: u, ...clients[u] }] : [])],
        [/SELECT username FROM clients WHERE branch_id = \?/, ([b, u]) => (b === "BR1" && clients[u] ? [{ username: u }] : [])],
        [/FROM branch_mapping bm\s+LEFT JOIN profile p ON p.username = bm.username AND p.id/, ([b, u]) =>
            (b === "BR1" && permissions[u] ? [{ username: u, name: u === "boss" ? "Office Boss" : "Staff One", mobile: "9000000001", country_code: "91", email: `${u}@office.example` }] : [])],
        [/FROM documents d\s+LEFT JOIN firms f[\s\S]*document_id IN/, (p) => {
            const [b, u, ...ids] = p;
            return b === "BR1" ? docs.filter((d) => d.username === u && ids.includes(d.document_id)) : [];
        }],
        [/FROM documents d\s+LEFT JOIN firms f[\s\S]*document_categories/, ([b, u]) => (b === "BR1" ? docs.filter((d) => d.username === u).map((d) => ({ ...d, create_date: "2026-09-01" })) : [])],
        [/SELECT name FROM profile WHERE username = \?/, ([u]) => [{ name: u === "boss" ? "Office Boss" : "Staff One" }]],
        [/INSERT INTO ai_pending_actions/, ([action_id, branch_id, username, source, action_type, payload, preview]) => {
            actions.push({ action_id, branch_id, username, source, action_type, payload, preview, status: "pending", result: null, expires_at: new Date(now() + 15 * 60_000) });
            return { affectedRows: 1 };
        }],
        [/UPDATE ai_pending_actions SET status = 'executing'/, ([decidedBy, id, b, u]) => {
            const a = actions.find((x) => x.action_id === id && x.branch_id === b && x.username === u && x.status === "pending" && x.expires_at.getTime() > now());
            if (a) a.status = "executing";
            return { affectedRows: a ? 1 : 0 };
        }],
        [/UPDATE ai_pending_actions SET status = 'cancelled'/, ([decidedBy, id, b, u]) => {
            const a = actions.find((x) => x.action_id === id && x.branch_id === b && x.username === u && x.status === "pending");
            if (a) a.status = "cancelled";
            return { affectedRows: a ? 1 : 0 };
        }],
        [/UPDATE ai_pending_actions SET status = \?, result = \?/, ([status, result, id]) => {
            const a = actions.find((x) => x.action_id === id);
            if (a) Object.assign(a, { status, result });
            return { affectedRows: 1 };
        }],
        [/FROM ai_pending_actions WHERE action_id = \?/, ([id, b, u]) => actions.filter((x) => x.action_id === id && x.branch_id === b && x.username === u)],
        [/FROM ai_pending_actions WHERE branch_id = \?/, ([b, u, ...ids]) => actions.filter((x) => x.branch_id === b && x.username === u && ids.includes(x.action_id))],
        [/FROM branch_list/, () => [{ name: "Test Office" }]],
        [/INSERT INTO ai_conversations/, ([id, branch, user, title]) => {
            conversations.push({ conversation_id: id, branch_id: branch, username: user, title, is_deleted: "0" });
            return { affectedRows: 1 };
        }],
        [/UPDATE ai_conversations/, () => ({ affectedRows: 1 })],
        [/FROM ai_conversations\s+WHERE conversation_id = \?/, ([id, b, u]) => conversations.filter((c) => c.conversation_id === id && c.branch_id === b && c.username === u)],
        [/INSERT INTO ai_messages/, (p) => {
            messages.push({ message_id: p[0], conversation_id: p[1], branch_id: p[2], username: p[3], role: p[4], content: p[5], blocks: p[6], tool_calls: p[7], status: p[8] });
            return { affectedRows: 1 };
        }],
        [/FROM ai_messages/, ([id, b, u]) => messages.filter((m) => m.conversation_id === id && m.branch_id === b && m.username === u).map((m, i) => ({ ...m, id: i }))],
        [/INSERT INTO ai_tool_calls/, () => ({ affectedRows: 1 })],
    ]);
    return { db, actions, settings, connector, messages };
}

const fakeAuth = (req, res, next) => {
    if (req.headers.token !== "valid") return res.status(401).json({ success: false });
    req.branch_id = req.headers.branch;
    next();
};

async function startApp({ store = memoryDb(), senders = fakeSenders(), provider } = {}) {
    const app = express();
    app.use(express.json({ strict: false }));
    const deps = { db: store.db, senders };
    app.use("/api/v1/ai", createAiRouter({ db: store.db, deps, getProvider: () => provider, limiter: createAiRateLimiter(), authMiddleware: [fakeAuth] }));
    app.use("/api/v1/mcp", createMcpRemoteRouter({ db: store.db, deps }));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = (path, { method = "GET", body, user = "boss" } = {}) =>
        fetch(`${origin}/api/v1/ai${path}`, { method, headers: { "content-type": "application/json", token: "valid", username: user, branch: "BR1" }, body: body ? JSON.stringify(body) : undefined });
    return { server, origin, call, store, senders };
}

/** Run one tool directly with a context (no HTTP). */
async function runToolDirect(name, args, { ctx, store = memoryDb(), senders = fakeSenders() } = {}) {
    const tool = toolsForContext(ctx).find((t) => t.name === name);
    if (!tool) return { missing: true };
    try {
        return await tool.handler(ctx, tool.input.parse(args), { db: store.db, senders });
    } catch (err) {
        return { error: err };
    }
}

const adminCtx = (extra = {}) => makeCtx({ username: "boss", isAdmin: true, accessMode: "read_write", source: "chat", ...extra });

/* ------------------------------- tool exposure ------------------------------- */

test("read-only mode exposes no write tools; read-write exposes them per permission", () => {
    const names = (ctx) => toolsForContext(ctx).map((t) => t.name);
    const write = ["send_whatsapp", "send_email", "share_client_documents", "share_ledger_statement"];

    const readOnly = names(makeCtx({ isAdmin: true, source: "chat" }));
    assert.ok(write.every((n) => !readOnly.includes(n)), "nothing writable in read mode");
    assert.ok(readOnly.includes("list_client_documents"), "listing documents is a read tool");

    const admin = names(adminCtx());
    assert.ok(write.every((n) => admin.includes(n)));
    assert.ok(!admin.includes("confirm_action"), "in-app: only a person's click confirms, never the model");

    const staff = names(makeCtx({ username: "staff1", accessMode: "read_write", source: "chat" }));
    assert.ok(staff.includes("share_client_documents"), "document share: any member (as in the app)");
    assert.ok(!staff.includes("send_email") && !staff.includes("send_whatsapp"), "messages need broadcast_send");
    assert.ok(!staff.includes("share_ledger_statement"), "ledger needs finance_report");

    const connector = names(adminCtx({ source: "mcp:abc" }));
    assert.ok(connector.includes("confirm_action") && connector.includes("cancel_action"));
});

/* ------------------------------ prepare (no send) ----------------------------- */

test("prepare creates a pending action and a confirmation card — nothing is sent", async () => {
    const store = memoryDb();
    const senders = fakeSenders();
    const r = await runToolDirect("send_email", { recipient_type: "client", recipient_username: "usr_ASISH00001", subject: "Your ITR", body: "Dear Asish,\nYour ITR is filed.\nRegards" }, { ctx: adminCtx(), store, senders });
    assert.equal(r.data.status, "awaiting_confirmation");
    assert.match(r.data.instructions, /Nothing has been sent/);
    assert.equal(store.actions.length, 1);
    assert.equal(store.actions[0].status, "pending");
    const card = r.blocks[0];
    assert.equal(card.type, "action");
    assert.equal(card.title, "Send email");
    assert.deepEqual(card.fields.map((f) => f.label), ["To", "Email to", "Subject"]);
    assert.equal(card.fields[1].value, "asish@example.com");
    assert.equal(senders.calls.filter(([k]) => ["email", "whatsapp", "share_email", "share_whatsapp"].includes(k)).length, 0, "no delivery during prepare");
    assert.doesNotMatch(JSON.stringify(card), /usr_/, "card shows names, not internal IDs");
});

test("recipients and channels are validated up front", async () => {
    const ctx = adminCtx();
    const err = async (name, args, senders = fakeSenders()) => (await runToolDirect(name, args, { ctx, senders })).error;
    assert.equal((await err("send_email", { recipient_type: "client", recipient_username: "usr_OTHERBR01", subject: "x", body: "y" })).code, "NOT_FOUND", "only this branch's clients");
    assert.match((await err("send_email", { recipient_type: "client", recipient_username: "usr_NOMAIL0001", subject: "x", body: "y" })).message, /no valid email/);
    const unsub = fakeSenders();
    unsub.unsubscribed.push("asish@example.com");
    assert.match((await err("send_email", { recipient_type: "client", recipient_username: "usr_ASISH00001", subject: "x", body: "y" }, unsub)).message, /unsubscribed/);
    const noSmtp = fakeSenders();
    noSmtp.smtp = false;
    assert.match((await err("send_email", { recipient_type: "client", recipient_username: "usr_ASISH00001", subject: "x", body: "y" }, noSmtp)).message, /Email is not set up/);

    const oneChatting = fakeSenders();
    oneChatting.channel = "onechatting";
    assert.match((await err("send_whatsapp", { recipient_type: "client", recipient_username: "usr_ASISH00001", message: "Hi" }, oneChatting)).message, /OOMS Web/);
    const noPlan = fakeSenders();
    noPlan.plan = false;
    assert.equal((await err("send_whatsapp", { recipient_type: "client", recipient_username: "usr_ASISH00001", message: "Hi" }, noPlan)).code, "DENIED");
    assert.match((await err("send_whatsapp", { recipient_type: "client", recipient_username: "usr_NOMAIL0001", message: "Hi" })).message, /no mobile/);

    assert.equal((await err("share_client_documents", { client_username: "usr_ASISH00001", document_ids: ["DOC0000009"], channels: ["email"] })).code, "NOT_FOUND");

    // Schemas never accept a free phone number / email address.
    const tool = toolsForContext(ctx).find((t) => t.name === "send_email");
    assert.equal(tool.input.safeParse({ recipient_type: "client", recipient_username: "x", subject: "s", body: "b", to: "evil@x.com" }).success, false);
});

test("outgoing text may not contain internal IDs or system details", async () => {
    const ctx = adminCtx();
    const base = { recipient_type: "client", recipient_username: "usr_ASISH00001" };
    const e1 = (await runToolDirect("send_whatsapp", { ...base, message: "Ref usr_ASISH00001 please pay" }, { ctx })).error;
    assert.match(e1.message, /internal OOMS identifiers/);
    const e2 = (await runToolDirect("send_email", { ...base, subject: "Data", body: "SELECT * FROM branch_mapping" }, { ctx })).error;
    assert.match(e2.message, /system or technical details/);
});

/* ------------------------------ settings & chat ------------------------------- */

test("switching to read-write needs explicit acknowledgement and an admin", async () => {
    const store = memoryDb({ accessMode: "read" });
    const { server, call } = await startApp({ store });
    try {
        const base = { enabled: true, rate_per_min: 6, rate_per_day: 200 };
        const noAck = await call("/settings", { method: "PUT", body: { ...base, access_mode: "read_write" } });
        assert.equal(noAck.status, 400);
        assert.match((await noAck.json()).message, /acknowledge_write/);
        assert.equal((await call("/settings", { method: "PUT", user: "staff1", body: { ...base, access_mode: "read_write", acknowledge_write: true } })).status, 403);
        const ok = await call("/settings", { method: "PUT", body: { ...base, access_mode: "read_write", acknowledge_write: true } });
        assert.equal(ok.status, 200);
        assert.equal((await ok.json()).data.settings.access_mode, "read_write");
        // Saving other settings without access_mode keeps the mode.
        await call("/settings", { method: "PUT", body: { ...base, rate_per_min: 9 } });
        assert.equal(store.settings.access_mode, "read_write");
        assert.equal((await (await call("/status")).json()).data.access_mode, "read_write");
        const back = await call("/settings", { method: "PUT", body: { ...base, access_mode: "read" } });
        assert.equal((await back.json()).data.settings.access_mode, "read", "going back to read-only needs no acknowledgement");
    } finally {
        server.close();
    }
});

test("chat end to end: AI prepares, the user confirms once, it is sent once", async () => {
    const store = memoryDb();
    const senders = fakeSenders();
    const provider = createScriptedProvider([
        toolUse("u1", "send_email", { recipient_type: "client", recipient_username: "usr_ASISH00001", subject: "Documents received", body: "Dear Asish,\nWe received your documents.\nRegards" }),
        finalText("I've prepared the email. Please review and confirm below."),
    ]);
    const { server, call } = await startApp({ store, senders, provider });
    try {
        const res = await (await call("/chat", { method: "POST", body: { message: "Email Asish Layek that we received his documents", stream: false } })).json();
        const card = res.data.blocks.find((b) => b.type === "action");
        assert.ok(card, "confirmation card returned");
        assert.equal(senders.calls.filter(([k]) => k === "email").length, 0, "not sent before confirmation");
        assert.match(provider.requests[0].system, /PREPARE/, "read-write rules in the system prompt");

        assert.equal((await call(`/actions/${card.action_id}/confirm`, { method: "POST", user: "staff1" })).status, 404, "someone else cannot confirm it");

        const confirmed = await call(`/actions/${card.action_id}/confirm`, { method: "POST" });
        const body = await confirmed.json();
        assert.equal(confirmed.status, 200, JSON.stringify(body));
        assert.equal(body.data.status, "done");
        assert.match(body.data.message, /Email sent to Asish Layek/);
        const sent = senders.calls.filter(([k]) => k === "email");
        assert.equal(sent.length, 1);
        assert.equal(sent[0][1].to, "asish@example.com");
        assert.match(sent[0][1].html, /<p>Dear Asish,<br>We received your documents\.<br>Regards<\/p>/);

        const again = await call(`/actions/${card.action_id}/confirm`, { method: "POST" });
        assert.equal(again.status, 409, "an action can never run twice");
        assert.equal(senders.calls.filter(([k]) => k === "email").length, 1);

        // Reopening the conversation shows the card's final state.
        const conv = await (await call(`/conversations/${res.data.conversation_id}`)).json();
        const shown = conv.data.messages.flatMap((m) => m.blocks).find((b) => b.type === "action");
        assert.equal(shown.state.status, "done");
    } finally {
        server.close();
    }
});

test("cancel, expiry, mode switched off and lost permission all stop the send", async () => {
    const store = memoryDb();
    const senders = fakeSenders();
    const { server, call } = await startApp({ store, senders });
    const prepare = async () => (await runToolDirect("send_email", { recipient_type: "client", recipient_username: "usr_ASISH00001", subject: "S", body: "B" }, { ctx: adminCtx(), store, senders })).data.action_id;
    try {
        const a1 = await prepare();
        assert.equal((await call(`/actions/${a1}/cancel`, { method: "POST" })).status, 200);
        assert.equal((await call(`/actions/${a1}/confirm`, { method: "POST" })).status, 409);

        const a2 = await prepare();
        store.actions.find((a) => a.action_id === a2).expires_at = new Date(Date.now() - 1000);
        const expired = await call(`/actions/${a2}/confirm`, { method: "POST" });
        assert.equal(expired.status, 409);
        assert.match((await expired.json()).message, /expired/);

        const a3 = await prepare();
        store.settings.access_mode = "read";
        const off = await call(`/actions/${a3}/confirm`, { method: "POST" });
        assert.equal(off.status, 403);
        assert.equal((await off.json()).code, "AI_ACTION_MODE_OFF");
        store.settings.access_mode = "read_write";

        // Permission removed between prepare and confirm (boss demoted to staff without broadcast_send).
        const permissions = { boss: "admin", staff1: "staff" };
        const permStore = memoryDb({ permissions });
        const app2 = await startApp({ store: permStore, senders });
        try {
            const a4 = (await runToolDirect("send_email", { recipient_type: "client", recipient_username: "usr_ASISH00001", subject: "S", body: "B" }, { ctx: adminCtx(), store: permStore, senders })).data.action_id;
            permissions.boss = "staff";
            const denied = await app2.call(`/actions/${a4}/confirm`, { method: "POST" });
            assert.equal(denied.status, 403);
            assert.equal((await denied.json()).code, "AI_ACTION_DENIED");
        } finally {
            app2.server.close();
        }

        assert.equal(senders.calls.filter(([k]) => ["email", "share_email"].includes(k)).length, 0, "nothing was sent in any of these cases");
    } finally {
        server.close();
    }
});

test("delivery failures are reported briefly without internals", async () => {
    const store = memoryDb();
    const senders = fakeSenders();
    senders.fail.whatsapp = true;
    const { server, call } = await startApp({ store, senders });
    try {
        const id = (await runToolDirect("send_whatsapp", { recipient_type: "client", recipient_username: "usr_ASISH00001", message: "Hello" }, { ctx: adminCtx(), store, senders })).data.action_id;
        const r = await call(`/actions/${id}/confirm`, { method: "POST" });
        const body = await r.json();
        assert.equal(body.data.status, "failed");
        assert.match(body.data.message, /QR linking/);
        assert.doesNotMatch(JSON.stringify(body), /10\.0\.0\.1|http:/);
    } finally {
        server.close();
    }
});

test("document and ledger shares send each file on each channel after confirmation", async () => {
    const store = memoryDb();
    const senders = fakeSenders();
    const { server, call } = await startApp({ store, senders });
    try {
        const list = await runToolDirect("list_client_documents", { client_username: "usr_ASISH00001" }, { ctx: adminCtx(), store, senders });
        assert.deepEqual(list.data.documents.map((d) => d.category), ["Income Tax", "GST"]);
        assert.ok(!list.blocks[0].columns.some((c) => c.key === "document_id"), "table shows no IDs");

        const docs = await runToolDirect("share_client_documents", { client_username: "usr_ASISH00001", document_ids: ["DOC0000001", "DOC0000002"], channels: ["email", "whatsapp"] }, { ctx: adminCtx(), store, senders });
        assert.deepEqual(docs.blocks[0].items, ["ITR 2025-26", "GSTR-3B Sep"]);
        const r1 = await (await call(`/actions/${docs.data.action_id}/confirm`, { method: "POST" })).json();
        assert.equal(r1.data.status, "done");
        assert.equal(senders.calls.filter(([k]) => k === "share_email").length, 2);
        assert.equal(senders.calls.filter(([k]) => k === "share_whatsapp").length, 2);

        const ledger = await runToolDirect("share_ledger_statement", { client_username: "usr_ASISH00001", preset: "this_month", channels: ["email"] }, { ctx: adminCtx(), store, senders });
        assert.match(ledger.blocks[0].fields.find((f) => f.label === "Period").value, /^\d{4}-\d{2}-01 to /);
        const r2 = await (await call(`/actions/${ledger.data.action_id}/confirm`, { method: "POST" })).json();
        assert.equal(r2.data.status, "done");
        assert.equal(senders.calls.filter(([k]) => k === "ledger").length, 1);
    } finally {
        server.close();
    }
});

/* ------------------------------ connector (MCP) ------------------------------- */

test("connector in read-write mode: prepare then confirm_action; read mode has no write tools", async () => {
    const store = memoryDb();
    const senders = fakeSenders();
    const { server, origin } = await startApp({ store, senders });
    try {
        const client = new Client({ name: "claude-ai", version: "0.1.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp/${TOKEN}`)));
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        assert.equal(byName.send_email.annotations.readOnlyHint, false, "write tools are not advertised as read-only");
        assert.equal(byName.confirm_action.annotations.destructiveHint, true);
        assert.equal(byName.search_staff.annotations.readOnlyHint, true);
        assert.match(client.getInstructions(), /explicit approval/);

        const prepared = await client.callTool({ name: "send_email", arguments: { recipient_type: "client", recipient_username: "usr_ASISH00001", subject: "Hello", body: "Dear Asish, hello." } });
        const data = JSON.parse(prepared.content[0].text);
        assert.equal(data.status, "awaiting_confirmation");
        assert.match(data.instructions, /confirm_action/);
        assert.equal(senders.calls.filter(([k]) => k === "email").length, 0);

        const done = await client.callTool({ name: "confirm_action", arguments: { action_id: data.action_id } });
        assert.equal(JSON.parse(done.content[0].text).status, "done");
        assert.equal(senders.calls.filter(([k]) => k === "email").length, 1);
        const twice = await client.callTool({ name: "confirm_action", arguments: { action_id: data.action_id } });
        assert.equal(JSON.parse(twice.content[0].text).status, "not_pending");
        assert.equal(senders.calls.filter(([k]) => k === "email").length, 1, "still sent once");
        await client.close();

        // Same connector switched to read-only: write tools disappear.
        store.connector.access_mode = "read";
        const ro = new Client({ name: "claude-ai", version: "0.1.0" });
        await ro.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp/${TOKEN}`)));
        const roNames = (await ro.listTools()).tools.map((t) => t.name);
        assert.ok(!roNames.some((n) => ["send_email", "send_whatsapp", "confirm_action"].includes(n)));
        await ro.close();
    } finally {
        server.close();
    }
});
